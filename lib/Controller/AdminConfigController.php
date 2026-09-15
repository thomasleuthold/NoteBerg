<?php

declare(strict_types=1);

namespace OCA\NoteBerg\Controller;

use OCA\NoteBerg\AiPolicy;
use OCA\NoteBerg\AppInfo\Application;
use OCA\NoteBerg\EndpointPolicy;
use OCA\NoteBerg\UsageCounter;
use OCA\NoteBerg\UsageReport;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\AuthorizedAdminSetting;
use OCP\AppFramework\Http\Attribute\OpenAPI;
use OCP\AppFramework\Http\DataResponse;
use OCP\IAppConfig;
use OCP\IRequest;

/**
 * Writes the instance-wide AI endpoint allowlist.
 *
 * Every route here carries AuthorizedAdminSetting rather than NoAdminRequired:
 * this is the control that decides what the server may connect to, so a user
 * being able to reach it would defeat the point of having it.
 *
 * @psalm-suppress UnusedClass
 */
class AdminConfigController extends Controller {
	/** Cap on the stored text, independent of the per-entry count. */
	private const MAX_BYTES = 16384;

	public function __construct(
		IRequest $request,
		private IAppConfig $appConfig,
		private AiPolicy $aiPolicy,
		private EndpointPolicy $endpointPolicy,
		private \OCP\Security\ICrypto $crypto,
		private UsageReport $usageReport,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	#[AuthorizedAdminSetting(settings: \OCA\NoteBerg\Settings\AdminSettings::class)]
	#[OpenAPI(OpenAPI::SCOPE_IGNORE)]
	public function show(): DataResponse {
		$raw = $this->appConfig->getValueString(Application::APP_ID, EndpointPolicy::CONFIG_KEY, '');

		return new DataResponse([
			'raw' => $raw,
			'entries' => EndpointPolicy::parse($raw),
			'allowReplicate' => $this->appConfig->getValueBool(
				Application::APP_ID,
				EndpointPolicy::CONFIG_KEY_REPLICATE,
				false,
			),
			'mode' => $this->aiPolicy->mode(),
			'monthlyLimit' => $this->aiPolicy->monthlyLimit(AiPolicy::TASK_RECOGNITION),
			// The central task settings, minus the credential: an admin panel
			// that echoed the key back would undo the reason it is stored
			// server-side. Presence is reported so the form can say "configured"
			// and offer to replace it.
			'central' => [
				'provider' => $this->aiPolicy->taskSetting(AiPolicy::TASK_RECOGNITION, 'provider'),
				'endpoint' => $this->aiPolicy->taskSetting(AiPolicy::TASK_RECOGNITION, 'endpoint'),
				'model' => $this->aiPolicy->taskSetting(AiPolicy::TASK_RECOGNITION, 'model'),
				'replicateVersion' => $this->aiPolicy->taskSetting(AiPolicy::TASK_RECOGNITION, 'replicate_version'),
				'systemPrompt' => $this->aiPolicy->taskSetting(AiPolicy::TASK_RECOGNITION, 'prompt'),
				'language' => $this->aiPolicy->taskSetting(AiPolicy::TASK_RECOGNITION, 'language'),
				'maxImageEdge' => $this->aiPolicy->taskNumber(AiPolicy::TASK_RECOGNITION, 'max_image_edge'),
				'maxTokens' => $this->aiPolicy->taskNumber(AiPolicy::TASK_RECOGNITION, 'max_tokens'),
				'timeoutSeconds' => $this->aiPolicy->taskNumber(AiPolicy::TASK_RECOGNITION, 'timeout_seconds'),
				'hasApiKey' => $this->aiPolicy->taskSetting(AiPolicy::TASK_RECOGNITION, 'api_key') !== '',
			],
		]);
	}

	/**
	 * Set the AI provisioning mode and the central settings that go with it.
	 *
	 * Separate from update() because the two answer different questions and an
	 * administrator changes them at different times: the allowlist decides what
	 * the server may reach at all, while this decides who pays and under what
	 * cap. Combining them would mean every mode change re-submitted the
	 * allowlist, and a partial save could leave the two disagreeing.
	 */
	#[AuthorizedAdminSetting(settings: \OCA\NoteBerg\Settings\AdminSettings::class)]
	#[OpenAPI(OpenAPI::SCOPE_IGNORE)]
	public function updateMode(): DataResponse {
		$mode = (string)$this->request->getParam('mode', AiPolicy::MODE_BYO);
		if (!in_array($mode, [AiPolicy::MODE_BYO, AiPolicy::MODE_CENTRAL], true)) {
			return new DataResponse(['error' => 'Unknown mode.'], Http::STATUS_BAD_REQUEST);
		}

		$limit = (int)$this->request->getParam('monthlyLimit', 0);
		if ($limit < 0) {
			return new DataResponse(['error' => 'The limit cannot be negative.'], Http::STATUS_BAD_REQUEST);
		}

		// The endpoint the administrator names is bound by the same allowlist
		// that binds a user's: switching to central mode must not become a way
		// to reach a host the allowlist would refuse, since the two controls
		// answer different questions and the destination control is the one that
		// gates egress.
		//
		// Only enforced when central mode is what is being saved. The form posts
		// every field regardless of mode — the central block is hidden, not
		// cleared — so validating unconditionally meant an administrator could
		// not switch *back* to BYO while a now-disallowed endpoint sat in the
		// hidden field, with an error naming a control they were turning off.
		//
		// Skipped for Replicate, whose endpoint field is hidden and whose value
		// is filled in below from the compiled-in constant: the stale value the
		// hidden field still carries is not what will be stored, so refusing on
		// it would block a provider the allowlist switch governs instead.
		$endpoint = (string)$this->request->getParam('endpoint', '');
		$isReplicate = $this->request->getParam('provider') === 'replicate';
		if (
			$mode === AiPolicy::MODE_CENTRAL && !$isReplicate
			&& $endpoint !== '' && !$this->endpointPolicy->permits($endpoint)
		) {
			return new DataResponse(['error' => 'endpoint-not-permitted'], Http::STATUS_FORBIDDEN);
		}

		// Replicate has no endpoint to check, so its own switch is the check.
		// The dropdown already disables an unpermitted provider, but that is a
		// guide rather than the control: the policy can be narrowed while this
		// form is open, and the client is not what decides.
		if ($mode === AiPolicy::MODE_CENTRAL && $isReplicate && !$this->endpointPolicy->allowsReplicate()) {
			return new DataResponse(['error' => 'provider-not-permitted'], Http::STATUS_FORBIDDEN);
		}

		$this->appConfig->setValueString(Application::APP_ID, AiPolicy::CONFIG_KEY_MODE, $mode);
		$this->appConfig->setValueInt(
			Application::APP_ID,
			AiPolicy::CONFIG_PREFIX_LIMIT . AiPolicy::TASK_RECOGNITION,
			$limit,
		);

		// The rendering parameters, stored as ints so the client can tell "unset"
		// (0, use the built-in default) from a chosen value. Negative and absurd
		// values are clamped rather than refused: they come from number inputs
		// with their own min/max, so a bad one is a typo, and rejecting the whole
		// save over it would lose the rest of the form.
		foreach (self::CENTRAL_NUMBERS as $param => $spec) {
			$raw = $this->request->getParam($param);
			if ($raw === null) {
				continue;
			}
			$value = (int)$raw;
			if ($value > 0) {
				$value = max($spec['min'], min($spec['max'], $value));
			}
			$this->appConfig->setValueInt(
				Application::APP_ID,
				AiPolicy::CONFIG_PREFIX_TASK . AiPolicy::TASK_RECOGNITION . '_' . $spec['key'],
				max(0, $value),
			);
		}

		// Replicate hides the endpoint field, because its host is a constant
		// rather than a choice — but the proxy resolves every request against a
		// stored endpoint, so one has to be there. Filled in here for the same
		// reason setProviderConfig() fills it in on the per-user path, and from
		// EndpointPolicy's copy of the constant so the value stored is exactly
		// the one permits() will later match against.
		$centralProvider = (string)$this->request->getParam('provider', '');
		if ($centralProvider === 'replicate') {
			$this->writeCentral('endpoint', EndpointPolicy::REPLICATE_BASE);
		}

		foreach (self::CENTRAL_FIELDS as $param => $key) {
			$value = $this->request->getParam($param);
			if ($value === null) {
				continue;
			}
			// Already written above from the compiled-in constant; whatever the
			// hidden field still held must not overwrite it.
			if ($key === 'endpoint' && $centralProvider === 'replicate') {
				continue;
			}
			if (!is_string($value) || strlen($value) > 8192) {
				return new DataResponse(["error" => "Invalid value for $param."], Http::STATUS_BAD_REQUEST);
			}
			$this->writeCentral($key, $value);
		}

		return $this->show();
	}

	/**
	 * Central task settings, by request parameter name.
	 *
	 * The stored keys carry the task, so a second AI feature adds its own set
	 * rather than colliding with this one.
	 */
	/**
	 * Numeric central task settings, with the bounds their inputs advertise.
	 *
	 * Separate from CENTRAL_FIELDS because these are stored as ints: the client
	 * reads 0 as "unset, use the built-in default", which a string store cannot
	 * express without conflating it with an empty field.
	 *
	 * The ceilings mirror what the code downstream can honour — the proxy clamps
	 * a requested timeout to 600s itself (RecognitionController), and an image
	 * edge beyond a few thousand pixels exceeds what any vision model accepts.
	 */
	private const CENTRAL_NUMBERS = [
		'maxImageEdge' => ['key' => 'max_image_edge', 'min' => 256, 'max' => 4096],
		'maxTokens' => ['key' => 'max_tokens', 'min' => 256, 'max' => 32000],
		'timeoutSeconds' => ['key' => 'timeout_seconds', 'min' => 5, 'max' => 600],
	];

	private const CENTRAL_FIELDS = [
		'provider' => 'provider',
		'endpoint' => 'endpoint',
		'model' => 'model',
		'replicateVersion' => 'replicate_version',
		'systemPrompt' => 'prompt',
		'language' => 'language',
		'apiKey' => 'api_key',
	];

	/**
	 * Store one central setting, encrypting the one that is a secret.
	 *
	 * Mirrors RecognitionConfigController::write(): only the credential is
	 * encrypted, since the rest are not secrets and leaving them readable keeps
	 * `occ config:app:get` useful for support. An empty api_key clears it, which
	 * is how an administrator removes a token.
	 */
	private function writeCentral(string $key, string $value): void {
		if ($key === 'api_key' && $value !== '') {
			$value = $this->crypto->encrypt($value);
		}
		$this->appConfig->setValueString(
			Application::APP_ID,
			AiPolicy::CONFIG_PREFIX_TASK . AiPolicy::TASK_RECOGNITION . '_' . $key,
			$value,
		);
	}

	/**
	 * One period's AI usage, per user.
	 *
	 * Read-only and admin-only, like everything else here. It reports spend
	 * against the instance's own account, which is why it sits behind the same
	 * authorisation as the cap that bounds it rather than being offered to the
	 * users it names.
	 *
	 * Scoped to recognition because that is the only task that spends anything
	 * today. A second AI task makes the task a parameter of this route and of
	 * the section's heading, which is why UsageCounter stores it as a column
	 * rather than assuming one.
	 */
	#[AuthorizedAdminSetting(settings: \OCA\NoteBerg\Settings\AdminSettings::class)]
	#[OpenAPI(OpenAPI::SCOPE_IGNORE)]
	public function usage(): DataResponse {
		$task = AiPolicy::TASK_RECOGNITION;
		$periods = $this->usageReport->periods($task);

		// An unknown period is answered with the current month rather than an
		// error: the only way to ask for one is the picker, whose options come
		// from the list above, so a value outside it is a stale page rather than
		// a mistake worth an error banner. It also keeps an arbitrary string
		// from reaching the query as a period key.
		$period = (string)$this->request->getParam('period', '');
		if (!in_array($period, $periods, true)) {
			$period = UsageCounter::periodKey();
		}

		$report = $this->usageReport->forPeriod($task, $period);

		return new DataResponse([
			'period' => $period,
			'label' => $this->usageReport->label($period),
			'periods' => array_map(fn (string $p): array => [
				'key' => $p,
				'label' => $this->usageReport->label($p),
			], $periods),
			'rows' => $report['rows'],
			'total' => $report['total'],
			'users' => $report['users'],
			'truncated' => $report['truncated'],
		]);
	}

	/**
	 * Replace the allowlist.
	 *
	 * Entries are validated for shape but not for reachability: an admin may
	 * legitimately permit a host that is not up yet, and a save that failed
	 * because a model server was restarting would be its own problem.
	 */
	#[AuthorizedAdminSetting(settings: \OCA\NoteBerg\Settings\AdminSettings::class)]
	#[OpenAPI(OpenAPI::SCOPE_IGNORE)]
	public function update(): DataResponse {
		// The Replicate switch travels with the list: the admin page saves both
		// at once, and a partial save would let the two disagree with what is on
		// screen. Absent means unchecked — an HTML checkbox sends nothing when
		// off, and this endpoint has exactly one writer.
		$allowReplicate = (bool)$this->request->getParam('allow_replicate', false);

		$raw = $this->request->getParam('allowed_endpoints');
		if (!is_string($raw)) {
			return new DataResponse(
				['error' => 'Missing allowed_endpoints.'],
				Http::STATUS_BAD_REQUEST,
			);
		}
		if (strlen($raw) > self::MAX_BYTES) {
			return new DataResponse(
				['error' => 'The list is too long.'],
				Http::STATUS_BAD_REQUEST,
			);
		}

		$entries = EndpointPolicy::parse($raw);
		foreach ($entries as $entry) {
			if (!self::isWellFormed($entry)) {
				return new DataResponse(
					['error' => sprintf('"%s" is not a host or a URL.', $entry)],
					Http::STATUS_BAD_REQUEST,
				);
			}
		}

		$this->appConfig->setValueString(Application::APP_ID, EndpointPolicy::CONFIG_KEY, $raw);
		$this->appConfig->setValueBool(
			Application::APP_ID,
			EndpointPolicy::CONFIG_KEY_REPLICATE,
			$allowReplicate,
		);

		return new DataResponse([
			'raw' => $raw,
			'entries' => $entries,
			'allowReplicate' => $allowReplicate,
			// Entries that resolve — or merely look like they resolve — to a
			// link-local address. Reported rather than rejected: an admin may
			// have a reason, and the check cannot be complete anyway (a name in
			// a zone they control can point anywhere). Refusing on an incomplete
			// check would imply a guarantee this does not make.
			'warnings' => self::linkLocalWarnings($entries),
		]);
	}

	/**
	 * Whether an entry is a bare host or an http(s) URL.
	 *
	 * Mirrors what EndpointPolicy::matches() will accept. Rejecting a malformed
	 * entry at save time matters more than usual here: an entry that never
	 * matches anything is invisible — the list looks configured, and every user
	 * is denied with no indication which line is at fault.
	 */
	private static function isWellFormed(string $entry): bool {
		if (strlen($entry) > 2048) {
			return false;
		}

		$candidate = str_contains($entry, '://') ? $entry : 'https://' . $entry;
		$parts = parse_url($candidate);
		if ($parts === false || !isset($parts['scheme'], $parts['host'])) {
			return false;
		}
		if (!in_array(strtolower($parts['scheme']), ['http', 'https'], true)) {
			return false;
		}
		// Credentials in an allowlist entry are always a mistake: they would
		// never be sent, and their presence suggests the admin believes this
		// field configures the connection rather than constraining it.
		if (isset($parts['user']) || isset($parts['pass'])) {
			return false;
		}
		// No wildcards, by design — see EndpointPolicy::matches(). Caught here so
		// an admin who tries one is told, rather than left with a line that
		// silently matches nothing.
		if (str_contains($parts['host'], '*')) {
			return false;
		}

		return preg_match('/^[a-z0-9._\-\[\]:]+$/i', $parts['host']) === 1;
	}

	/**
	 * @param list<string> $entries
	 * @return list<string>
	 */
	private static function linkLocalWarnings(array $entries): array {
		$warnings = [];
		foreach ($entries as $entry) {
			$candidate = str_contains($entry, '://') ? $entry : 'https://' . $entry;
			$host = strtolower((string)(parse_url($candidate, PHP_URL_HOST) ?: ''));
			if (str_starts_with($host, '169.254.') || $host === 'metadata.google.internal') {
				$warnings[] = sprintf(
					'"%s" is a link-local address. Cloud instance metadata lives there, '
						. 'and permitting it lets any user read this server\'s credentials.',
					$entry,
				);
			}
		}
		return $warnings;
	}
}
