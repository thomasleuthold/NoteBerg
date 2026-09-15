<?php

declare(strict_types=1);

namespace OCA\NoteBerg\Controller;

use OCA\NoteBerg\AiPolicy;
use OCA\NoteBerg\AppInfo\Application;
use OCA\NoteBerg\EndpointPolicy;
use OCA\NoteBerg\UsageCounter;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\OpenAPI;
use OCP\AppFramework\Http\Attribute\UserRateLimit;
use OCP\AppFramework\Http\DataResponse;
use OCP\Http\Client\IClientService;
use OCP\ICacheFactory;
use OCP\IConfig;
use OCP\IRequest;
use OCP\ISession;
use OCP\IUserSession;
use OCP\Security\ICrypto;
use Psr\Log\LoggerInterface;

/**
 * Passthrough proxy for AI handwriting recognition.
 *
 * The Nextcloud build runs in a browser, so it cannot call a recognition
 * endpoint directly: the provider does not send CORS headers for arbitrary
 * origins, and an NC instance served over HTTPS cannot reach a plain-HTTP local
 * model at all (DESIGN §5). The native builds sidestep both through Tauri's HTTP
 * plugin, which issues requests outside the browser's rules. This controller is
 * the NC equivalent.
 *
 * Deliberately a *passthrough*, not a job runner. Running transcription in a
 * background job would need a DB table, a QueuedJob and cron — and on instances
 * using AJAX cron it would not run reliably at all. Recognition is made durable
 * on the client instead, identically on every platform.
 *
 * There are two ways through, and which one runs is decided by what the server
 * can do (see canRunAsync):
 *
 *   - Asynchronous (dispatch + collect). The reply is sent and the browser
 *     connection closed *before* the upstream call is made, so the transcription
 *     outlives the request that started it. This is the only arrangement that
 *     survives a web server we do not control: proxy_read_timeout and
 *     request_terminate_timeout can only kill a request that is still open, and
 *     after fastcgi_finish_request() there is none. Without it a model slower
 *     than the server's own idle limit produced a connection closed with no HTTP
 *     response at all — reaching the browser as a bare "NetworkError" that named
 *     neither the endpoint nor the reason.
 *
 *   - Synchronous (proxy). The original behaviour, kept for servers that cannot
 *     do the above — no php-fpm, or no distributed cache to hold the result
 *     between the two requests. It works, and remains exposed to those same
 *     timeouts; the settings UI says so rather than letting it be a surprise.
 *
 * Slicing the upstream call across several short requests — the obvious way to
 * stay under a timeout — is not possible: an HTTP request to a chat-completions
 * endpoint is indivisible, so a slice that gave up would abandon the work and
 * the next slice would start over, billing the user each lap and never
 * finishing. Replicate's predictions API is genuinely resumable and the client
 * already exploits that (replicateBackend), but OpenAI-compatible endpoints are
 * synchronous by construction.
 *
 * The destination and the credential are NOT taken from the request. Both are
 * read from the user's server-side configuration (RecognitionConfigController),
 * which has two consequences worth stating:
 *
 *   - The API key never reaches the browser, so an XSS on the Nextcloud origin
 *     cannot steal it. That is the main security argument for this endpoint.
 *   - The URL is not client-supplied, so this is not an open fetcher. A caller
 *     can only reach the endpoint their own configuration names, which removes
 *     most of the SSRF surface a naive proxy would have.
 *
 * @psalm-suppress UnusedClass
 */
class RecognitionController extends Controller {
	/** Cap on the proxied request body. A rendered page is a few hundred KB. */
	private const MAX_BODY_BYTES = 12 * 1024 * 1024;

	/**
	 * Upstream timeout when the client asks for none.
	 *
	 * Deliberately below the 60s that php-fpm's request_terminate_timeout and
	 * nginx/Apache's proxy_read_timeout both commonly default to. A value above
	 * those cannot be reached on a default deployment: the web server kills the
	 * worker first, and the browser sees a connection closed with no HTTP
	 * response — a bare "NetworkError" naming neither the endpoint nor the
	 * reason. Timing out here instead produces the 502 below, which says what
	 * failed.
	 */
	private const DEFAULT_TIMEOUT_SECONDS = 55;

	/**
	 * Ceiling on a client-requested timeout.
	 *
	 * The client chooses the budget because only it knows what it is talking to:
	 * a hosted model answers in seconds, a reasoning model behind a gateway takes
	 * minutes, and a local model on CPU longer still. But the request occupies a
	 * PHP worker for the whole wait, and workers are shared with every other user
	 * of the instance — so the choice is bounded rather than free.
	 *
	 * Raising this above the web server's own limit does not help by itself:
	 * request_terminate_timeout and proxy_read_timeout must be raised to match,
	 * or the worker is killed first and the client sees an unexplained dropped
	 * connection again. Documented in the setting's own help text.
	 */
	private const MAX_TIMEOUT_SECONDS = 600;

	/**
	 * How long a dispatched job's slot survives in the cache.
	 *
	 * Comfortably longer than MAX_TIMEOUT_SECONDS so a job that runs to its full
	 * budget is still collectable afterwards, and short enough that abandoned
	 * slots — a closed tab, a browser that never polls again — expire on their
	 * own. Expiry is what keeps this store free of a cleanup job.
	 */
	private const SLOT_TTL_SECONDS = 900;

	/** Cache prefix. Namespaced so nothing else in the instance collides. */
	private const CACHE_PREFIX = 'noteberg_recognition';

	public function __construct(
		IRequest $request,
		private IClientService $clientService,
		private LoggerInterface $logger,
		private IConfig $config,
		private IUserSession $userSession,
		private ICrypto $crypto,
		private ISession $session,
		private ICacheFactory $cacheFactory,
		private EndpointPolicy $endpointPolicy,
		private AiPolicy $aiPolicy,
		private UsageCounter $usageCounter,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	/**
	 * Whether a proxied call spends money. Thin wrapper so the rule has one home
	 * (AiPolicy) while staying reachable from this controller's tests.
	 */
	private static function billableFor(string $method, string $path): bool {
		return AiPolicy::isBillable($method, $path);
	}

	/**
	 * Charge one unit against the caller's quota, or refuse.
	 *
	 * Returns a DataResponse when the request must not proceed, and null when it
	 * may. Accounting failures are logged and allowed through: a database problem
	 * must not take recognition down, and the alternative — refusing every
	 * request when the counter is unreadable — turns a storage fault into a
	 * total outage of the feature.
	 */
	private function checkAndRecordQuota(string $uid): ?DataResponse {
		$limit = $this->aiPolicy->monthlyLimit(AiPolicy::TASK_RECOGNITION);
		if ($limit === AiPolicy::LIMIT_UNLIMITED) {
			return null;
		}

		try {
			if ($this->usageCounter->used($uid, AiPolicy::TASK_RECOGNITION) >= $limit) {
				return new DataResponse(
					['error' => 'quota-exceeded'],
					Http::STATUS_TOO_MANY_REQUESTS,
				);
			}
			$this->usageCounter->record($uid, AiPolicy::TASK_RECOGNITION);
		} catch (\Throwable $e) {
			$this->logger->warning('NoteBerg AI usage accounting failed: ' . $e->getMessage(), [
				'app' => Application::APP_ID,
			]);
		}

		return null;
	}

	/**
	 * Whether this server can run recognition asynchronously.
	 *
	 * The one hard requirement is a distributed cache:
	 *
	 *   - A distributed cache must actually be configured. createDistributed()
	 *     returns a null cache that silently discards writes when it is not, so
	 *     asking the factory is not optional: dispatching into a store that
	 *     drops the slot would lose every result with no error anywhere.
	 *
	 * Public because the settings endpoint reports it to the client, which warns
	 * that recognition may be cut short by the web server's own timeout.
	 */
	public function canRunAsync(): bool {
		return self::supportsAsync($this->cacheFactory);
	}

	/**
	 * Static form, so the settings endpoint can report the capability without
	 * constructing this controller and its whole dependency list for one bool.
	 */
	public static function supportsAsync(ICacheFactory $cacheFactory): bool {
		// Only the cache is truly required. Releasing the client is possible on
		// both SAPIs that matter: php-fpm has fastcgi_finish_request(), and
		// mod_php is released by a Content-Length plus Connection: close, which
		// respondAndContinue() sends either way. Verified on apache2handler:
		// the client returned in 14ms while the script ran on for six seconds.
		//
		// The cache has no such workaround. createDistributed() hands back a
		// null cache that silently discards writes when none is configured, so
		// dispatching into it would lose every result with no error anywhere.
		return $cacheFactory->isAvailable();
	}

	/**
	 * Forward one recognition request upstream and return the reply verbatim.
	 *
	 * The body is passed through untouched so this proxy does not need to know
	 * whether it is speaking to an OpenAI-compatible endpoint or to Replicate —
	 * the client already builds a provider-specific request, and a proxy that
	 * re-encoded it would have to be updated for every provider added.
	 *
	 * The destination is derived from the caller's own stored configuration. The
	 * client sends a `path` (for example "/chat/completions", or a Replicate
	 * prediction path) which is appended to the configured endpoint — it can
	 * choose *what to ask for*, never *whom to ask*.
	 */
	#[NoAdminRequired]
	#[OpenAPI(OpenAPI::SCOPE_IGNORE)]
	// A caller can only reach the endpoint their own configuration names, with
	// their own credential, so this cannot be used as an open relay — but each
	// call occupies a PHP worker for up to MAX_TIMEOUT_SECONDS and spends the
	// server's outbound bandwidth, both of which are shared with every other
	// user of the instance. The cap is on that, not on abuse of someone else's
	// quota. Sized for the real workload: recognition is manual and per page,
	// so a user transcribing a long note in one sitting stays well inside it.
	#[UserRateLimit(limit: 60, period: 300)]
	public function proxy(): DataResponse {
		$prepared = $this->prepare();
		if ($prepared instanceof DataResponse) {
			return $prepared;
		}
		[$url, $method, $options] = $prepared;

		$this->closeSession();

		$result = $this->callUpstream($url, $method, $options);
		return new DataResponse(
			$result,
			isset($result['error']) ? Http::STATUS_BAD_GATEWAY : Http::STATUS_OK,
		);
	}

	/**
	 * Start a recognition request and return immediately with a token.
	 *
	 * The point of the exercise: the response is flushed and the browser
	 * connection closed *before* the upstream call begins, so the transcription
	 * is no longer racing the web server's idle timeout. Nothing downstream can
	 * kill a request that is no longer open.
	 *
	 * Falls through to the synchronous path when the server cannot do this, so a
	 * client may always call dispatch and read what it gets back: an async reply
	 * carries a token to collect, a synchronous one carries the result itself.
	 */
	#[NoAdminRequired]
	#[OpenAPI(OpenAPI::SCOPE_IGNORE)]
	#[UserRateLimit(limit: 60, period: 300)]
	public function dispatch(): DataResponse {
		$prepared = $this->prepare();
		if ($prepared instanceof DataResponse) {
			return $prepared;
		}
		[$url, $method, $options, $uid] = $prepared;

		if (!$this->canRunAsync()) {
			// Same work, same shape, just without the early return. `async:false`
			// tells the client not to wait for a token that will never come.
			$this->closeSession();
			$result = $this->callUpstream($url, $method, $options);
			return new DataResponse(['async' => false] + $result);
		}

		// Unguessable, and bound to the user below — a token is a capability to
		// read one transcription, so it must not be enumerable.
		$token = bin2hex(random_bytes(16));
		$cache = $this->cache();
		$cache->set($token, ['state' => 'pending', 'uid' => $uid], self::SLOT_TTL_SECONDS);

		$this->closeSession();

		// Answer now. Everything after this line runs with no browser waiting on
		// it, which is the entire reason this endpoint exists.
		$this->respondAndContinue(['async' => true, 'token' => $token]);

		$result = $this->callUpstream($url, $method, $options);
		$cache->set(
			$token,
			['state' => 'done', 'uid' => $uid] + $result,
			self::SLOT_TTL_SECONDS,
		);

		// The reply was written and the client released by respondAndContinue,
		// so there is nothing left to hand back. Returning a DataResponse here
		// would send NC's framework off to set headers on a response already on
		// the wire — "Cannot modify header information", once per request, with
		// the work itself unaffected but the log filling up.
		exit;
	}

	/**
	 * Collect a dispatched request's result, if it has one yet.
	 *
	 * Deliberately cheap and non-blocking: it reads the slot and returns. The
	 * waiting is the client's, in short polls, because a poll that blocked would
	 * reintroduce exactly the long-lived request this design removes.
	 */
	#[NoAdminRequired]
	#[OpenAPI(OpenAPI::SCOPE_IGNORE)]
	public function collect(): DataResponse {
		$user = $this->userSession->getUser();
		if ($user === null) {
			return new DataResponse(['error' => 'Not signed in.'], Http::STATUS_UNAUTHORIZED);
		}
		$uid = $user->getUID();

		$token = (string)$this->request->getParam('token', '');
		// Shape-checked before it is used as a cache key, so a crafted value
		// cannot address anything but a token this controller minted.
		if ($token === '' || preg_match('/^[0-9a-f]{32}$/', $token) !== 1) {
			return new DataResponse(['error' => 'Unknown recognition token.'], Http::STATUS_NOT_FOUND);
		}

		$slot = $this->cache()->get($token);
		if (!is_array($slot)) {
			// Expired, already collected, or never existed. The client treats
			// this as a failed run rather than retrying forever.
			return new DataResponse(['error' => 'Unknown recognition token.'], Http::STATUS_NOT_FOUND);
		}

		// A token is a capability, but ownership is checked anyway: guessing one
		// must not expose another user's transcription.
		if (($slot['uid'] ?? null) !== $uid) {
			return new DataResponse(['error' => 'Unknown recognition token.'], Http::STATUS_NOT_FOUND);
		}

		if (($slot['state'] ?? '') === 'pending') {
			return new DataResponse(['state' => 'pending']);
		}

		// Terminal: hand it over and drop it. The result is the client's now, and
		// leaving a copy in the cache serves nothing but the TTL.
		$this->cache()->remove($token);
		unset($slot['uid']);
		return new DataResponse($slot);
	}

	/**
	 * Validate a proxy request and build everything the upstream call needs.
	 *
	 * Shared by all three entry points so they cannot drift: the checks here are
	 * what confine the request to the user's own configured endpoint, and a
	 * second copy of them would be a second place to get that wrong.
	 *
	 * @return DataResponse|array{0:string,1:string,2:array,3:string} an error to
	 *   return, or [url, method, options, uid]
	 */
	private function prepare(): DataResponse|array {
		$user = $this->userSession->getUser();
		if ($user === null) {
			return new DataResponse(['error' => 'Not signed in.'], Http::STATUS_UNAUTHORIZED);
		}
		$uid = $user->getUID();

		$method = strtoupper((string)$this->request->getParam('method', 'POST'));
		$payload = $this->request->getParam('body');
		$path = (string)$this->request->getParam('path', '');

		$url = $this->resolveUrl($uid, $path);
		if ($url === null) {
			return new DataResponse(
				['error' => 'No recognition endpoint is configured for your account.'],
				Http::STATUS_BAD_REQUEST,
			);
		}

		if (!in_array($method, ['GET', 'POST'], true)) {
			return new DataResponse(['error' => 'Unsupported method.'], Http::STATUS_BAD_REQUEST);
		}

		// Clamped, not trusted. An unbounded value would let one request pin a PHP
		// worker for as long as it liked; a zero or negative one would mean "no
		// timeout" to Guzzle, which is the same failure by a different route.
		$requested = (int)$this->request->getParam('timeoutSeconds', 0);
		$timeout = $requested > 0
			? min($requested, self::MAX_TIMEOUT_SECONDS)
			: self::DEFAULT_TIMEOUT_SECONDS;

		$encodedBody = $payload === null ? null : json_encode($payload);
		if ($encodedBody !== null && strlen($encodedBody) > self::MAX_BODY_BYTES) {
			return new DataResponse(
				['error' => 'Request body is too large.'],
				Http::STATUS_REQUEST_ENTITY_TOO_LARGE,
			);
		}

		// The model check and the quota both apply only to a request that
		// actually invokes a model.
		//
		// The proxy also carries model listings, schema lookups and prediction
		// polls. Those name no model — a Replicate schema fetch is a GET with no
		// body at all — so running the check against them refused every one of
		// them, because permitsModel() fails closed by design. That took out the
		// Replicate path entirely: its schema lookup 403s, then its poll does.
		//
		// isBillable() already identifies exactly the requests that invoke a
		// model, so it is the right predicate for both. Reusing it also keeps
		// the two rules from disagreeing about what a "real" request is.
		if (self::billableFor($method, $path)) {
			// Central mode only: the model is the administrator's decision, and
			// restricting the settings UI cannot enforce it — the body is
			// forwarded untouched, so a user could POST here directly with any
			// model. Fails closed on a body shape it cannot read.
			// The path is passed too: a Replicate model addressed by owner/name
			// carries no model in the body, only in the URL — which resolveUrl()
			// has already confined to the administrator's endpoint.
			if (!$this->aiPolicy->permitsModel(
				is_array($payload) ? $payload : null,
				AiPolicy::TASK_RECOGNITION,
				$path,
			)) {
				return new DataResponse(
					['error' => 'model-not-permitted'],
					Http::STATUS_FORBIDDEN,
				);
			}

			// Counted before the upstream call.
			$quota = $this->checkAndRecordQuota($uid);
			if ($quota instanceof DataResponse) {
				return $quota;
			}
		}

		$options = [
			'timeout' => $timeout,
			'headers' => $this->buildHeaders($uid),
			// Never let an upstream redirect walk this request to a host the
			// user did not configure — the whole point of validating $url.
			'allow_redirects' => false,
			// A non-2xx upstream reply is data to hand back, not an exception:
			// the client renders provider error messages itself.
			'http_errors' => false,
		];
		if ($encodedBody !== null) {
			$options['body'] = $encodedBody;
		}

		return [$url, $method, $options, $uid];
	}

	/**
	 * Perform the upstream call and reduce it to the envelope the client reads.
	 *
	 * Never throws: a transport failure is data here, because on the async path
	 * there is no longer a request to fail. It has to be stored and collected
	 * like any other outcome.
	 *
	 * @return array{status?:int, body?:string, error?:string}
	 */
	private function callUpstream(string $url, string $method, array $options): array {
		try {
			$client = $this->clientService->newClient();
			$response = $method === 'GET'
				? $client->get($url, $options)
				: $client->post($url, $options);

			return [
				'status' => $response->getStatusCode(),
				'body' => (string)$response->getBody(),
			];
		} catch (\Throwable $e) {
			// The message can name the configured endpoint but never the
			// caller's credentials, which are not logged anywhere here.
			$this->logger->warning('NoteBerg recognition proxy failed: ' . $e->getMessage(), [
				'app' => Application::APP_ID,
			]);

			// A timeout and an unreachable endpoint call for opposite responses —
			// use a faster model or a smaller image, versus check the address — so
			// they are reported separately. Collapsing both into "could not reach"
			// would send the user looking at a configuration that is in fact
			// correct.
			//
			// Matched on the message rather than an exception class: IClientService
			// wraps Guzzle, but Guzzle's exception types are not part of the OCP
			// contract, so naming one here would be a hard dependency on an
			// implementation detail that NC is free to change.
			$timedOut = stripos($e->getMessage(), 'timed out') !== false
				|| stripos($e->getMessage(), 'timeout') !== false;

			return [
				'error' => $timedOut
					? 'The recognition endpoint did not respond within '
						. ($options['timeout'] ?? self::DEFAULT_TIMEOUT_SECONDS)
						. ' seconds. Raise Recognition timeout, use a faster model, or reduce Max image size.'
					: 'Could not reach the recognition endpoint.',
			];
		}
	}

	/**
	 * Release the session lock before a long upstream call.
	 *
	 * Nextcloud holds a per-session lock for the whole request, so two proxy
	 * calls from one browser session serialize: the second blocks in PHP until
	 * the first returns, which for a page of handwriting can be most of a minute.
	 * Recognition sends a request per page, so this is the normal case rather
	 * than an edge one, and the queued request routinely outlived the web
	 * server's own timeout — appearing in the browser as a connection that died
	 * with no response at all.
	 *
	 * Safe at every call site: the user is resolved, the endpoint read and the
	 * credential decrypted before this runs, nothing after it touches the
	 * session, and a DataResponse does not write back to one.
	 */
	private function closeSession(): void {
		$this->session->close();
	}

	/**
	 * Send a response now and keep executing.
	 *
	 * Isolated into one method because it is the load-bearing trick of the async
	 * path and the only part that is SAPI-specific — callers check canRunAsync()
	 * first, and this stays the single place that knows how the deed is done.
	 *
	 * Takes the payload rather than a DataResponse, and the caller exits rather
	 * than returning: once this has run, the reply is on the wire and NC's
	 * framework must not be given a response to send a second time.
	 */
	private function respondAndContinue(array $payload): void {
		$body = json_encode($payload);

		// The browser is about to go away, and the work that follows must not be
		// killed with it. Without this, aborting the connection can abort the
		// script — losing a transcription that was already paid for.
		ignore_user_abort(true);

		if (!headers_sent()) {
			header('Content-Type: application/json; charset=utf-8');
			// Both headers are what actually releases the client under mod_php:
			// Content-Length tells it the reply is complete, and Connection:close
			// stops it waiting for more on a keep-alive socket. Harmless under
			// php-fpm, which is released by fastcgi_finish_request() below.
			header('Content-Length: ' . strlen($body));
			header('Connection: close');
		}

		echo $body;

		// Empty PHP's own buffers: whichever mechanism releases the client sends
		// what has been written, and anything still sitting in an output buffer
		// would be held back until the script ends — precisely the wait being
		// removed here.
		while (ob_get_level() > 0) {
			@ob_end_flush();
		}
		flush();

		// php-fpm's explicit, reliable release. Absent under mod_php, where the
		// headers above have already done the job.
		if (function_exists('fastcgi_finish_request')) {
			fastcgi_finish_request();
		}
	}

	/** The slot store. Distributed so it survives across php-fpm workers. */
	private function cache(): \OCP\ICache {
		return $this->cacheFactory->createDistributed(self::CACHE_PREFIX);
	}

	/**
	 * Build the upstream URL from the user's configuration plus a client path.
	 *
	 * The host always comes from stored configuration, so a caller cannot point
	 * this proxy at a machine of their choosing. The path is theirs, because the
	 * two providers need different ones and the client is what knows which — but
	 * it is confined to a path: anything that could re-target the request
	 * (a scheme, an authority, or traversal) is rejected.
	 */
	private function resolveUrl(string $uid, string $path): ?string {
		$base = rtrim($this->effectiveEndpoint($uid), '/');

		if ($base === '') {
			return null;
		}

		$parts = parse_url($base);
		if ($parts === false || !isset($parts['scheme'], $parts['host'])) {
			return null;
		}
		if (!in_array(strtolower($parts['scheme']), ['http', 'https'], true)) {
			return null;
		}
		// The administrator's allowlist is the authority on what this server may
		// connect to, and it denies by default. This supersedes the link-local
		// block that stood here: that check existed because any host was
		// otherwise reachable and the cloud metadata address is what makes an
		// SSRF worth exploiting, but under an allowlist nothing is reachable
		// until an admin names it. See EndpointPolicy.
		//
		// Checked here and not only when the endpoint was saved, because the
		// policy can be narrowed after the fact: a value stored while it was
		// permitted must stop working the moment it no longer is.
		if (!$this->endpointPolicy->permits($base)) {
			return null;
		}

		if ($path === '') {
			return $base;
		}

		// Validate what the client actually sent, before any rewriting — a path,
		// and only a path. "//evil.com/x" and "../.." must not be able to walk
		// the request off the configured host.
		if (!str_starts_with($path, '/') || str_starts_with($path, '//')) {
			return null;
		}
		if (str_contains($path, '..') || strlen($path) > 512) {
			return null;
		}

		// The client sends the absolute path its backend built, which may repeat
		// a prefix the configured endpoint already carries: Replicate's base is
		// ".../v1" and its own paths start "/v1/", so naive concatenation
		// produced "/v1/v1/..." and a 404. Drop the shared prefix.
		//
		// Only ever removes a leading segment, so it cannot introduce anything
		// the checks above would have rejected.
		$basePath = rtrim((string)(parse_url($base, PHP_URL_PATH) ?: ''), '/');
		if ($basePath !== '' && str_starts_with($path, $basePath . '/')) {
			$path = substr($path, strlen($basePath));
		}

		return $base . $path;
	}

	/**
	 * Headers for the upstream call, including the credential.
	 *
	 * The API key is read here and never accepted from the request: that is the
	 * point of storing it server-side. Nothing a caller sends can add, override
	 * or read a header. It is stored encrypted, so it is decrypted here — the
	 * one place it exists in plaintext, in memory, for the length of one call.
	 *
	 * @return array<string, string>
	 */
	private function buildHeaders(string $uid): array {
		$headers = [
			'Content-Type' => 'application/json',
			// Replicate honours this to return a completed prediction inline;
			// endpoints that do not recognise it ignore it.
			'Prefer' => 'wait',
		];

		$apiKey = $this->readApiKey($uid);
		if ($apiKey !== '') {
			// Stripped of CR/LF so a stored value cannot inject further headers.
			$headers['Authorization'] = 'Bearer ' . str_replace(["\r", "\n"], '', $apiKey);
		}

		return $headers;
	}

	/**
	 * Read the stored credential, decrypting it.
	 *
	 * The counterpart to RecognitionConfigController::write(), which encrypts on
	 * the way in. Decryption lives here rather than being shared with that
	 * controller because this is the only caller: reading the key is what the
	 * proxy does, and the settings endpoint deliberately never reads it back.
	 *
	 * The plaintext fallback exists because keys stored before encryption was
	 * introduced are unencrypted, and ICrypto throws on them rather than
	 * returning them. Treating that as fatal would break recognition on every
	 * instance that had configured it before upgrading. Such a key is upgraded
	 * the next time the user saves their settings, which routes through write().
	 *
	 * The distinction is not perfectly decidable — a plaintext key that happened
	 * to parse as ciphertext would decrypt to garbage. In practice ICrypto's
	 * format is `hex|hex|hex` carrying an HMAC, which no provider token matches.
	 */
	private function readApiKey(string $uid): string {
		// Central mode: the administrator's credential, for every user. Read from
		// app config rather than the caller's, which is the whole point of the
		// mode — one account funds the instance.
		if ($this->aiPolicy->isCentral()) {
			$stored = $this->aiPolicy->taskSetting(AiPolicy::TASK_RECOGNITION, 'api_key');
			return $stored === '' ? '' : $this->decryptKey($stored);
		}

		// Scoped to the configured provider, with the retired shared slot as the
		// fallback. Resolved by the settings controller rather than re-derived
		// here: if the two disagreed, the UI could report a key as configured
		// while the proxy sent a different one — the failure this split fixes.
		$provider = $this->config->getUserValue(
			$uid,
			Application::APP_ID,
			RecognitionConfigController::KEY_PROVIDER,
			'',
		);
		$stored = RecognitionConfigController::resolveApiKey($this->config, $uid, $provider);
		return $stored === '' ? '' : $this->decryptKey($stored);
	}

	/**
	 * Decrypt a stored credential, tolerating one written before encryption.
	 *
	 * Shared by the per-user and the central paths so both treat a legacy value
	 * identically; two copies would eventually disagree about which stored forms
	 * are readable.
	 */
	private function decryptKey(string $stored): string {
		try {
			return $this->crypto->decrypt($stored);
		} catch (\Throwable $e) {
			// Neither the value nor the exception message is logged: both can
			// carry the ciphertext, and on a legacy row the token itself.
			$this->logger->debug(
				'NoteBerg: recognition API key is not encrypted, treating as legacy plaintext.',
				['app' => Application::APP_ID],
			);
			return $stored;
		}
	}

	/**
	 * The endpoint this request must go to.
	 *
	 * Central mode uses the administrator's for every user; BYO uses the
	 * caller's own. Resolved in one place so the two modes cannot diverge
	 * between the destination check and the credential lookup — a request
	 * carrying one mode's endpoint and the other's key would reach the wrong
	 * service with a token it should never have been sent.
	 */
	private function effectiveEndpoint(string $uid): string {
		if ($this->aiPolicy->isCentral()) {
			return $this->aiPolicy->taskSetting(AiPolicy::TASK_RECOGNITION, 'endpoint');
		}

		return $this->config->getUserValue(
			$uid,
			Application::APP_ID,
			RecognitionConfigController::KEY_ENDPOINT,
			'',
		);
	}
}
