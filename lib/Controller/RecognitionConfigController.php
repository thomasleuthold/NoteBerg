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
use OCP\AppFramework\Http\DataResponse;
use OCP\ICacheFactory;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IUserSession;
use OCP\Security\ICrypto;

/**
 * Server-side AI provider configuration, stored per user.
 *
 * Two settings live here rather than in the browser, for two different reasons:
 *
 *   - `api_key` is a secret. The Nextcloud build has no secure storage: the
 *     browser fallback in secureStorage.js encrypts with a constant compiled
 *     into the shipped bundle, which is obfuscation rather than encryption. Any
 *     XSS anywhere on the Nextcloud origin — including in another app — could
 *     read it, and a leaked provider token is a billing liability. Kept here,
 *     it never reaches the browser at all.
 *
 *     It is additionally encrypted at rest with ICrypto, which keys off the
 *     `secret` in config.php. Server-side storage alone already defeats the
 *     XSS threat above; encryption addresses the different one of a database
 *     dump or a backup leaking `oc_preferences` in cleartext.
 *
 *   - `endpoint` is *server-relative*. Requests are issued by the Nextcloud
 *     server through the proxy, so the URL must resolve and be reachable from
 *     the server, not from the user's device. Storing it per browser would
 *     store it in the wrong frame of reference — "localhost" in a browser
 *     setting means the user's machine, but the request would reach the
 *     server's.
 *
 * `model` used to live here too and no longer does. It is a per-task preference
 * — recognition needs a vision model, a summary would need a text one — with no
 * server frame of reference, so it moved back to local storage alongside the
 * feature that owns it. The key is still cleared by destroy() so an upgraded
 * instance does not keep a stale copy nothing reads.
 *
 * Per user (IConfig::setUserValue) rather than instance-wide (IAppConfig):
 * each user brings their own provider account, and this needs no admin settings
 * page. An admin-configured instance-wide endpoint is a later addition.
 *
 * @psalm-suppress UnusedClass
 */
class RecognitionConfigController extends Controller {
	/**
	 * Base name for the per-provider credential slots.
	 *
	 * Never a storage key on its own. It was one before: a single slot held the
	 * key for whichever provider was selected, so switching provider carried the
	 * previous provider's token to the new endpoint — an auth error naming a
	 * credential the user never entered there. destroy() still clears the old
	 * name so an instance configured before the change does not keep a token
	 * nothing reads.
	 */
	public const KEY_API = 'recognition_api_key';

	public const KEY_ENDPOINT = 'recognition_endpoint';
	public const KEY_PROVIDER = 'recognition_backend';

	/**
	 * Retired: the model moved to per-device storage with the config split.
	 * Retained only so destroy() can clear a value written before the split.
	 */
	public const KEY_LEGACY_MODEL = 'recognition_model';

	/** Providers that can hold their own credential. */
	private const PROVIDERS = ['openai', 'replicate'];

	/**
	 * Storage key for one provider's API key.
	 *
	 * Per provider for the same reason as the native builds: two accounts, two
	 * tokens, and a switch between them must not carry a foreign secret.
	 */
	public static function apiKeyFor(string $provider): string {
		return self::KEY_API . '_' . $provider;
	}

	/** Settings this endpoint reads and writes. */
	private const KEYS = [self::KEY_PROVIDER, self::KEY_ENDPOINT, self::KEY_API];

	/**
	 * Request parameter names, by storage key.
	 *
	 * An explicit map rather than a prefix trim: the stored key for the provider
	 * is still "recognition_backend" (renaming it would need a migration for no
	 * gain), while the client sends it as "provider".
	 */
	private const PARAMS = [
		self::KEY_PROVIDER => 'provider',
		self::KEY_ENDPOINT => 'endpoint',
		self::KEY_API => 'api_key',
	];

	public function __construct(
		IRequest $request,
		private IConfig $config,
		private IUserSession $userSession,
		private ICrypto $crypto,
		private ICacheFactory $cacheFactory,
		private EndpointPolicy $endpointPolicy,
		private AiPolicy $aiPolicy,
		private UsageCounter $usageCounter,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	/**
	 * What the caller has spent and what they are allowed, this period.
	 *
	 * The usage figure is reported in both modes — it is a fact about what the
	 * account did — but the limit only applies under central administration, so
	 * monthlyLimit() returns 0 (unlimited) under BYO whatever is stored. The
	 * client needs both numbers to say why a run was refused rather than showing
	 * an unexplained failure.
	 *
	 * `limit` of 0 means unlimited, matching AiPolicy::LIMIT_UNLIMITED.
	 *
	 * @return array{used:int, limit:int, period:string}
	 */
	private function quotaState(string $uid): array {
		$limit = $this->aiPolicy->monthlyLimit(AiPolicy::TASK_RECOGNITION);
		try {
			$used = $this->usageCounter->used($uid, AiPolicy::TASK_RECOGNITION);
		} catch (\Throwable $e) {
			// Accounting is unavailable. Reporting zero is honest about what is
			// known and keeps the settings screen rendering; the proxy makes the
			// same choice and lets requests through rather than failing them.
			$used = 0;
		}

		return ['used' => $used, 'limit' => $limit, 'period' => UsageCounter::periodKey()];
	}

	/**
	 * Report what is configured, without disclosing the secret.
	 *
	 * The API key is never returned — not even masked beyond a length hint.
	 * Returning it would undo the reason it is stored here: a single XSS that
	 * can call this endpoint would otherwise recover the token.
	 */
	#[NoAdminRequired]
	#[OpenAPI(OpenAPI::SCOPE_IGNORE)]
	public function show(): DataResponse {
		$uid = $this->userId();
		if ($uid === null) {
			return new DataResponse(['error' => 'Not signed in.'], Http::STATUS_UNAUTHORIZED);
		}

		$central = $this->aiPolicy->isCentral();

		// In central mode every value the client renders is the administrator's,
		// including the task settings it would otherwise hold locally. Reported
		// from here so the client mirrors rather than re-derives: the server is
		// the authority on what is in force, and a client that assembled its own
		// view of the policy would be a second place for it to be wrong.
		if ($central) {
			return new DataResponse([
				'mode' => AiPolicy::MODE_CENTRAL,
				'provider' => $this->aiPolicy->taskSetting(AiPolicy::TASK_RECOGNITION, 'provider'),
				'endpoint' => $this->aiPolicy->taskSetting(AiPolicy::TASK_RECOGNITION, 'endpoint'),
				// Whether the administrator supplied one, never the value.
				'hasApiKey' => $this->aiPolicy->taskSetting(AiPolicy::TASK_RECOGNITION, 'api_key') !== '',
				// The task settings the client must use rather than its own.
				'central' => [
					'model' => $this->aiPolicy->taskSetting(AiPolicy::TASK_RECOGNITION, 'model'),
					'replicateVersion' => $this->aiPolicy->taskSetting(AiPolicy::TASK_RECOGNITION, 'replicate_version'),
					'systemPrompt' => $this->aiPolicy->taskSetting(AiPolicy::TASK_RECOGNITION, 'prompt'),
					'language' => $this->aiPolicy->taskSetting(AiPolicy::TASK_RECOGNITION, 'language'),
					// Rendering parameters. Per-device while users configure
					// their own account, but under central management the whole
					// configuration is the administrator's — leaving three
					// editable fields behind a form that is otherwise theirs was
					// the confusing state this moved away from. 0 means unset,
					// and the client falls back to its built-in default.
					'maxImageEdge' => $this->aiPolicy->taskNumber(AiPolicy::TASK_RECOGNITION, 'max_image_edge'),
					'maxTokens' => $this->aiPolicy->taskNumber(AiPolicy::TASK_RECOGNITION, 'max_tokens'),
					'timeoutSeconds' => $this->aiPolicy->taskNumber(AiPolicy::TASK_RECOGNITION, 'timeout_seconds'),
				],
				'quota' => $this->quotaState($uid),
				// Unused in this mode — the endpoint is not the user's to pick —
				// but reported so the client's shape does not change per mode.
				'allowedEndpoints' => [],
				'allowReplicate' => false,
				'asyncRecognition' => RecognitionController::supportsAsync($this->cacheFactory),
			]);
		}

		$provider = $this->get($uid, self::KEY_PROVIDER);

		return new DataResponse([
			'mode' => AiPolicy::MODE_BYO,
			'quota' => $this->quotaState($uid),
			'provider' => $provider,
			'endpoint' => $this->get($uid, self::KEY_ENDPOINT),
			// A boolean, deliberately. The settings UI shows "configured" and
			// offers to replace it; it never displays the value.
			//
			// Scoped to the current provider: reporting a key that belongs to a
			// different one is what let the UI claim "configured" while the
			// request went out with a token the endpoint would reject.
			'hasApiKey' => self::resolveApiKey($this->config, $uid, $provider) !== '',
			// The endpoints this instance's administrator permits. Reported so
			// the settings UI can offer them as a dropdown rather than a text
			// box: a user cannot then enter a destination that will be refused,
			// which is the difference between a field that guides and one that
			// fails after the fact. An empty list means none are permitted, and
			// the UI says so — it does not mean unrestricted.
			//
			// Not a secret: it names hosts the admin chose to allow, and every
			// user needs it to configure the feature at all.
			'allowedEndpoints' => $this->endpointPolicy->entries(),
			// Whether the built-in Replicate provider may be used. Reported
			// separately from the endpoint list because it is a different kind of
			// decision — see EndpointPolicy — and the settings UI hides the
			// provider outright rather than offering a choice that cannot run.
			'allowReplicate' => $this->endpointPolicy->allowsReplicate(),
			// Whether this server can run recognition without holding the browser
			// connection open for the whole transcription. Reported so the
			// settings UI can warn when it cannot: on such a server a slow model
			// is cut off by a timeout neither the user nor this app can raise,
			// and the failure looks like a network fault rather than a limit.
			'asyncRecognition' => RecognitionController::supportsAsync($this->cacheFactory),
		]);
	}

	/**
	 * Update configuration. Accepts a partial patch.
	 *
	 * An absent field is left unchanged, so the settings form can save the
	 * endpoint without having to re-send a key the user did not retype. An
	 * explicitly empty api_key clears it — that is how a user removes a token.
	 */
	#[NoAdminRequired]
	#[OpenAPI(OpenAPI::SCOPE_IGNORE)]
	public function update(): DataResponse {
		$uid = $this->userId();
		if ($uid === null) {
			return new DataResponse(['error' => 'Not signed in.'], Http::STATUS_UNAUTHORIZED);
		}

		// Central mode: these settings are the administrator's. The client
		// already renders them read-only, so reaching here means a caller went
		// around the UI — refused rather than ignored, because a save that
		// reported success and changed nothing is worse than a stated refusal.
		if ($this->aiPolicy->isCentral()) {
			return new DataResponse(
				['error' => 'centrally-managed'],
				Http::STATUS_FORBIDDEN,
			);
		}

		// The provider the key belongs to: the one this same request establishes
		// if it carries one, otherwise the stored one. A patch that switches
		// provider and sets a key together must file the key under the new
		// provider, not the outgoing one.
		$provider = $this->request->getParam(self::PARAMS[self::KEY_PROVIDER]);
		if (!is_string($provider) || $provider === '') {
			$provider = $this->get($uid, self::KEY_PROVIDER);
		}

		foreach (self::KEYS as $key) {
			$param = self::PARAMS[$key];
			$value = $this->request->getParam($param);
			if ($value === null) {
				continue;
			}
			if (!is_string($value) || strlen($value) > 4096) {
				return new DataResponse(
					['error' => "Invalid value for $param."],
					Http::STATUS_BAD_REQUEST,
				);
			}

			// An unknown provider gets no credential slot: writing one would
			// store a secret under a name nothing ever reads back.
			if ($key === self::KEY_API) {
				if (!in_array($provider, self::PROVIDERS, true)) {
					return new DataResponse(
						['error' => 'Cannot store an API key without a known provider.'],
						Http::STATUS_BAD_REQUEST,
					);
				}
				$this->write($uid, self::apiKeyFor($provider), $value);
				continue;
			}

			// Refuse a destination the administrator has not permitted. The proxy
			// checks this again before every request — that is the boundary — but
			// storing a value that can never be used would leave the user with a
			// settings form that saved cleanly and a feature that silently never
			// works. Fail here, where there is a field to point at.
			if ($key === self::KEY_ENDPOINT && $value !== '' && !$this->endpointPolicy->permits($value)) {
				return new DataResponse(
					['error' => 'endpoint-not-permitted'],
					Http::STATUS_FORBIDDEN,
				);
			}

			$this->write($uid, $key, $value);
		}

		return $this->show();
	}

	/** Remove every stored provider setting for this user. */
	#[NoAdminRequired]
	#[OpenAPI(OpenAPI::SCOPE_IGNORE)]
	public function destroy(): DataResponse {
		$uid = $this->userId();
		if ($uid === null) {
			return new DataResponse(['error' => 'Not signed in.'], Http::STATUS_UNAUTHORIZED);
		}

		$keys = [...self::KEYS, self::KEY_LEGACY_MODEL];
		// Every per-provider slot too, or "remove my settings" would leave the
		// tokens behind — the one thing a user removing them most wants gone.
		foreach (self::PROVIDERS as $provider) {
			$keys[] = self::apiKeyFor($provider);
		}

		foreach ($keys as $key) {
			$this->config->deleteUserValue($uid, Application::APP_ID, $key);
		}

		return new DataResponse(['ok' => true]);
	}

	private function userId(): ?string {
		return $this->userSession->getUser()?->getUID();
	}

	private function get(string $uid, string $key): string {
		return $this->config->getUserValue($uid, Application::APP_ID, $key, '');
	}

	/**
	 * The stored (still encrypted) key for one provider.
	 *
	 * Static, and taking IConfig, so the proxy resolves the credential through
	 * this exact rule without instantiating a controller: two copies of it would
	 * be a way for "configured" and "what actually gets sent" to disagree, which
	 * is the failure per-provider storage exists to remove.
	 *
	 * A key stored under the retired shared name is not read. Anyone who
	 * configured one before this change re-enters it once.
	 */
	public static function resolveApiKey(IConfig $config, string $uid, string $provider): string {
		if ($provider === '') {
			return '';
		}

		return $config->getUserValue($uid, Application::APP_ID, self::apiKeyFor($provider), '');
	}

	/**
	 * Store one setting, encrypting the one that is a secret.
	 *
	 * Only the API key is encrypted. The provider and endpoint are not secrets,
	 * and leaving them readable keeps `occ config:user:get` useful for support.
	 */
	private function write(string $uid, string $key, string $value): void {
		// Matches the shared slot and every per-provider one, so a key stored
		// under any of those names is encrypted. A prefix test rather than an
		// equality test: the per-provider names are KEY_API . '_' . $provider.
		if (str_starts_with($key, self::KEY_API) && $value !== '') {
			$value = $this->crypto->encrypt($value);
		}
		$this->config->setUserValue($uid, Application::APP_ID, $key, $value);
	}
}
