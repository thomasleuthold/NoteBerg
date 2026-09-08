<?php

declare(strict_types=1);

namespace OCA\NoteBerg;

use OCA\NoteBerg\AppInfo\Application;
use OCP\IAppConfig;

/**
 * How this instance provides AI access: each user's own account, or the
 * administrator's.
 *
 * §9 of the design assumes every user brings their own provider account. That
 * assumption does not hold for the deployment an instance administrator is most
 * likely to want — the organisation holds one account and users share it — and
 * without a mode for it such an administrator must either have every user obtain
 * a personal token, which most will not do, or distribute one shared token, at
 * which point every user can select the most expensive model in the catalog
 * against the organisation's billing with no attribution and no cap.
 *
 * The two modes are exclusive, with no fallback. "Central settings where the
 * user has none" was rejected as unauditable rather than merely complex: an
 * administrator could not determine who is spending the organisation's money
 * without enumerating every user's configuration. Exclusive modes make "which
 * mode is this instance in" answerable from one value.
 *
 * BYO is the default, so upgrading an instance changes nothing.
 *
 * Nextcloud only. The native builds have no administrator; every setting there
 * is the user's own (recognition/aiProvider.js, recognition/recognitionSettings.js).
 */
class AiPolicy {
	/** Users bring their own provider account. The default. */
	public const MODE_BYO = 'byo';

	/** The administrator maintains provider, credential, model and task settings. */
	public const MODE_CENTRAL = 'central';

	/** Config key holding the mode. */
	public const CONFIG_KEY_MODE = 'ai_mode';

	/**
	 * Config key prefix for the central task settings.
	 *
	 * Per task, because each AI feature needs its own model — recognition needs
	 * a vision model, a summary feature would need a text one — so a single
	 * central "model" would be wrong the moment a second feature exists.
	 */
	public const CONFIG_PREFIX_TASK = 'ai_central_';

	/** Config key prefix for a task's monthly request cap. */
	public const CONFIG_PREFIX_LIMIT = 'ai_limit_';

	/** The only task today. Named so the shape generalises without a migration. */
	public const TASK_RECOGNITION = 'recognition';

	/** Tasks this instance knows how to configure. */
	public const TASKS = [self::TASK_RECOGNITION];

	/**
	 * A cap of zero means unlimited.
	 *
	 * Deliberately *not* deny-by-default, unlike EndpointPolicy: the endpoint
	 * allowlist decides whether the server may open outbound connections at all,
	 * whereas this bounds a feature the administrator has already permitted. An
	 * unset cap that blocked everything would make enabling central mode appear
	 * broken, and the destination control is what actually gates egress.
	 */
	public const LIMIT_UNLIMITED = 0;

	public function __construct(
		private IAppConfig $appConfig,
	) {
	}

	/** The configured mode; BYO unless an administrator chose otherwise. */
	public function mode(): string {
		$mode = $this->appConfig->getValueString(
			Application::APP_ID,
			self::CONFIG_KEY_MODE,
			self::MODE_BYO,
		);

		// An unrecognised value resolves to BYO rather than to central: reading
		// a typo as "the administrator's account pays for everything" is the
		// wrong direction to fail in.
		return $mode === self::MODE_CENTRAL ? self::MODE_CENTRAL : self::MODE_BYO;
	}

	/** Whether the administrator maintains the settings for every user. */
	public function isCentral(): bool {
		return $this->mode() === self::MODE_CENTRAL;
	}

	/**
	 * One central task setting, or '' when unset.
	 *
	 * @param string $task one of TASKS
	 * @param string $name setting name, e.g. 'model'
	 */
	public function taskSetting(string $task, string $name): string {
		if (!in_array($task, self::TASKS, true)) {
			return '';
		}
		return $this->appConfig->getValueString(
			Application::APP_ID,
			self::CONFIG_PREFIX_TASK . $task . '_' . $name,
			'',
		);
	}

	/**
	 * One numeric central task setting, or 0 when unset.
	 *
	 * Separate from taskSetting() because these are stored as ints and the
	 * client distinguishes "unset" from a value: 0 means fall back to the
	 * built-in default, since a zero-pixel image or a zero-token cap is the
	 * absence of a setting rather than one anyone chose.
	 *
	 * @param string $task one of TASKS
	 * @param string $name setting name, e.g. 'max_image_edge'
	 */
	public function taskNumber(string $task, string $name): int {
		if (!in_array($task, self::TASKS, true)) {
			return 0;
		}
		$value = $this->appConfig->getValueInt(
			Application::APP_ID,
			self::CONFIG_PREFIX_TASK . $task . '_' . $name,
			0,
		);
		return $value > 0 ? $value : 0;
	}

	/**
	 * A task's monthly request cap per user, or LIMIT_UNLIMITED.
	 *
	 * **Central mode only.** The cap is a spend control, and under BYO the
	 * account being charged is the user's own: an administrator limiting how
	 * much of the user's own money the user may spend is not what the setting
	 * says, and the field is not even offered in that mode. Reading the stored
	 * value regardless meant a cap set while trying out central mode kept
	 * refusing runs after switching back — with an "allowance used up" message
	 * naming a control the administrator could no longer see.
	 *
	 * Enforced here rather than at the call site so every reader agrees: the
	 * proxy that refuses a request and the settings screen that reports the
	 * remaining allowance must not disagree about whether a cap applies.
	 *
	 * Server load under BYO is already bounded by the per-user rate limit on the
	 * proxy routes (RecognitionController), which is the concern a cap would
	 * otherwise have covered there.
	 *
	 * @param string $task one of TASKS
	 */
	public function monthlyLimit(string $task): int {
		if (!in_array($task, self::TASKS, true)) {
			return self::LIMIT_UNLIMITED;
		}
		if (!$this->isCentral()) {
			return self::LIMIT_UNLIMITED;
		}
		$limit = $this->appConfig->getValueInt(
			Application::APP_ID,
			self::CONFIG_PREFIX_LIMIT . $task,
			self::LIMIT_UNLIMITED,
		);

		// A negative value is meaningless and must not read as a very large cap
		// through some later arithmetic; treat it as unset.
		return $limit > 0 ? $limit : self::LIMIT_UNLIMITED;
	}

	/**
	 * Whether a request body may run under the current policy.
	 *
	 * In BYO mode the model is the user's own choice and nothing is enforced.
	 * In central mode the model must match the administrator's, and restricting
	 * the settings UI is not sufficient to achieve that: the proxy forwards the
	 * body untouched, so a user could POST to /dispatch directly with any body.
	 * The check therefore lives on the path every request crosses.
	 *
	 * **Fails closed.** A body whose model cannot be located is refused rather
	 * than allowed, because a shape that escapes inspection is a shape that
	 * escapes the policy. The cost is that a provider added later must teach
	 * this method its body shape before it can run under central mode, which is
	 * the correct direction for a spend control.
	 *
	 * @param array|null $body the decoded request body
	 * @param string $task one of TASKS
	 */
	public function permitsModel(?array $body, string $task = self::TASK_RECOGNITION, string $path = ''): bool {
		if (!$this->isCentral()) {
			return true;
		}

		// Two identifiers, because the two providers address a model differently
		// and the client mirrors that split (recognitionSettings.js):
		//
		//   - OpenAI-compatible: the model name is in the body as `model`.
		//   - Replicate with a version: the body carries only `version`, and the
		//     model name is in the URL path — which resolveUrl() has already
		//     confined to the administrator's endpoint.
		//
		// So a version-addressed request is checked against the configured
		// version, not the configured model. Comparing it against the model
		// refused every Replicate community model, which is the case the version
		// field exists for.
		$model = $this->taskSetting($task, 'model');
		$version = $this->taskSetting($task, 'replicate_version');

		$named = self::modelOf($body);

		// A body carrying `version` is matched against the version; one carrying
		// `model` against the model.
		if (isset($body['version']) && is_string($body['version']) && $body['version'] !== '') {
			if ($version !== '') {
				return $named === $version;
			}
			// No version configured, but the administrator did name a model. The
			// request must NOT be waved through here: a version hash addresses a
			// model of the caller's choosing, so permitting an arbitrary one is
			// exactly the unattributed spend against the organisation's account
			// this mode exists to prevent. Fall through to the path check, which
			// is the only remaining evidence of *which* model is being run — and
			// which resolveUrl() has already confined to the admin's endpoint.
			//
			// Model-only central configurations are the ordinary Replicate case
			// (an official model, addressed by owner/name), and their requests
			// carry no `version` at all — so this costs them nothing.
			if ($model !== '') {
				return $path !== '' && self::pathNamesModel($path, $model);
			}
			// Neither a version nor a model is configured: there is genuinely
			// nothing to enforce for this form.
			return true;
		}
		if ($named !== null) {
			return $model === '' ? true : $named === $model;
		}

		// Neither field is present. That is not necessarily an evasion: a
		// Replicate model addressed by owner/name — the form used when no version
		// is pinned — puts the model in the URL path and sends only `input`. The
		// path is not the caller's to choose either, since resolveUrl() has
		// already confined it to the administrator's endpoint, so the model can
		// be read from there.
		//
		// Refusing this outright was a real defect: it blocked every central
		// Replicate configuration without a version hash, which is the ordinary
		// case for an official model.
		if ($model !== '' && $path !== '' && self::pathNamesModel($path, $model)) {
			return true;
		}

		// Fails closed: a shape naming no model anywhere is a shape that escapes
		// the policy. See the note above.
		return false;
	}

	/**
	 * The model a request body names, or null when it names none we recognise.
	 *
	 * Two shapes, because the two providers disagree:
	 *   - OpenAI-compatible: {"model": "...", "messages": [...]}
	 *   - Replicate:         {"version": "<hash>", "input": {...}}, or the model
	 *     in the URL path for an official model, which resolveUrl() has already
	 *     confined to the configured endpoint.
	 *
	 * Static so the test suite can exercise it without a policy instance.
	 */
	public static function modelOf(?array $body): ?string {
		if ($body === null) {
			return null;
		}
		foreach (['model', 'version'] as $field) {
			$value = $body[$field] ?? null;
			if (is_string($value) && $value !== '') {
				return $value;
			}
		}
		return null;
	}

	/**
	 * Whether a request path addresses exactly the configured model.
	 *
	 * Replicate's official-model form is "/v1/models/{owner}/{name}/predictions",
	 * so the model is the two segments before "predictions". Matched on the
	 * parsed segments rather than with a substring test, which would accept
	 * "/v1/models/evil/google/gemini-3-flash/predictions" — the same reasoning
	 * that makes EndpointPolicy compare URL components instead of raw strings.
	 */
	private static function pathNamesModel(string $path, string $model): bool {
		$path = (string)(parse_url($path, PHP_URL_PATH) ?: $path);
		$segments = array_values(array_filter(explode('/', $path), static fn ($s) => $s !== ''));

		$count = count($segments);
		if ($count < 4 || $segments[$count - 1] !== 'predictions') {
			return false;
		}
		// …/models/{owner}/{name}/predictions
		if ($segments[$count - 4] !== 'models') {
			return false;
		}

		return $segments[$count - 3] . '/' . $segments[$count - 2] === $model;
	}

	/**
	 * Whether a proxied call is one that spends money.
	 *
	 * The proxy carries three kinds of traffic and only one of them is billable:
	 * transcription dispatches, against model listings, schema lookups and
	 * prediction polls. Counting all of them would make a page count run several
	 * times high on the Replicate path, which issues a schema fetch and repeated
	 * polls per page.
	 *
	 * The discriminator is the method together with the path. Path alone is
	 * ambiguous — Replicate's billable ".../models/{owner}/{name}/predictions"
	 * has the free ".../models/{owner}/{name}" as a prefix — but every billable
	 * call is a POST and every free one is a GET, across both providers.
	 *
	 * Inferred here rather than taken from a client-supplied flag: a flag the
	 * client sets is a quota the client can evade.
	 */
	public static function isBillable(string $method, string $path): bool {
		if (strtoupper($method) !== 'POST') {
			return false;
		}

		$path = strtolower(parse_url($path, PHP_URL_PATH) ?: $path);

		// OpenAI-compatible transcription.
		if (str_ends_with($path, '/chat/completions') || str_ends_with($path, '/completions')) {
			return true;
		}
		// Replicate, both the versioned and the official-model forms.
		if (str_ends_with($path, '/predictions')) {
			return true;
		}

		// An unrecognised POST is not counted. Unlike permitsModel() this fails
		// *open*, and deliberately: over-counting an administrator's quota would
		// block a user for requests that cost nothing, which is a worse and far
		// more confusing failure than under-counting a call we do not yet know
		// to be billable. The destination allowlist still bounds what such a
		// request could reach.
		return false;
	}
}
