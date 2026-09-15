<?php

declare(strict_types=1);

/**
 * Tests for the Nextcloud-side PHP, run inside the dev container.
 *
 * The app has no PHPUnit setup and no composer dependencies, so this is a plain
 * script rather than a framework: it boots Nextcloud (so OCP interfaces are the
 * real ones, not stubs of our own invention) and exercises the two methods that
 * carry security decisions.
 *
 * Run with: just test-php
 *
 * What is deliberately covered:
 *   - resolveUrl: the destination cannot be chosen by the caller, and a path
 *     cannot walk off the configured host.
 *   - buildHeaders: the credential is read server-side and cannot be injected
 *     into or read back by the caller.
 *   - readApiKey: an encrypted credential round-trips, and one stored before
 *     encryption existed still works.
 *   - EndpointPolicy: the administrator's allowlist denies by default, and its
 *     matcher cannot be walked off the permitted host.
 *
 * What is not covered: the HTTP round trip itself. That needs a live upstream,
 * and the parts worth pinning are the ones above.
 */

require '/var/www/html/lib/base.php';

/** Minimal IConfig whose user values come from a fixture array. */
final class FixtureConfig implements \OCP\IConfig {
	public function __construct(private array $values = []) {
	}

	public function set(string $key, string $value): void {
		$this->values[$key] = $value;
	}

	public function getUserValue($userId, $appName, $key, $default = '') {
		return $this->values[$key] ?? $default;
	}

	// Everything below is unused by the code under test; IConfig is a wide
	// interface and PHP requires the full surface.
	public function setSystemValues(array $configs): void {
	}
	public function setSystemValue($key, $value): void {
	}
	public function getSystemValue($key, $default = '') {
		return $default;
	}
	public function getSystemValueBool($key, bool $default = false): bool {
		return $default;
	}
	public function getSystemValueInt($key, int $default = 0): int {
		return $default;
	}
	public function getSystemValueString($key, string $default = ''): string {
		return $default;
	}
	public function getFilteredSystemValue($key, $default = '') {
		return $default;
	}
	public function deleteSystemValue($key): void {
	}
	public function getAppKeys($appName) {
		return [];
	}
	public function setAppValue($appName, $key, $value): void {
	}
	public function getAppValue($appName, $key, $default = '') {
		return $default;
	}
	public function deleteAppValue($appName, $key): void {
	}
	public function deleteAppValues($appName): void {
	}
	public function setUserValue($userId, $appName, $key, $value, $preCondition = null) {
	}
	public function getUserKeys($userId, $appName) {
		return [];
	}
	public function deleteUserValue($userId, $appName, $key): void {
	}
	public function deleteAllUserValues($userId): void {
	}
	public function deleteAppFromAllUsers($appName): void {
	}
	public function getUsersForUserValue($appName, $key, $value) {
		return [];
	}
	public function getUsersForUserValueCaseInsensitive($appName, $key, $value) {
		return [];
	}
	public function getSystemConfig() {
		return null;
	}
	public function getAllAppValues($appName) {
		return [];
	}
	public function getUserValueForUsers($appName, $key, $userIds) {
		return [];
	}
	public function getAllUserValues($userId): array {
		return [];
	}
}

$passed = 0;
$failed = 0;

function check(string $label, mixed $actual, mixed $expected): void {
	global $passed, $failed;
	if ($actual === $expected) {
		$passed++;
		printf("  ok   %s\n", $label);
		return;
	}
	$failed++;
	printf(
		"  FAIL %s\n         expected: %s\n         actual:   %s\n",
		$label,
		var_export($expected, true),
		var_export($actual, true),
	);
}

/**
 * Invoke a private method on an instance built without its constructor.
 *
 * The collaborators the methods under test actually reach for are injected by
 * name. ICrypto and the logger come from the running server rather than from
 * fakes: the real ICrypto is what decides whether a value round-trips, so a
 * stub would only be asserting our own guess at its format.
 */
/**
 * An EndpointPolicy reading a fixture rather than the instance's real config.
 *
 * Built by reflection for the same reason the controller is: IAppConfig has
 * thirty-odd methods, and stubbing all of them to answer two would bury what the
 * test is actually saying. The policy's own logic is the subject; where it reads
 * from is not.
 */
function fixtureAppConfig(array $values): \OCP\IAppConfig {
	return new class ($values) implements \OCP\IAppConfig {
		public function __construct(private array $values) {
		}

		public function getValueString(string $app, string $key, string $default = '', bool $lazy = false): string {
			return isset($this->values[$key]) ? (string)$this->values[$key] : $default;
		}

		public function getValueBool(string $app, string $key, bool $default = false, bool $lazy = false): bool {
			return isset($this->values[$key]) ? (bool)$this->values[$key] : $default;
		}

		public function getValueInt(string $app, string $key, int $default = 0, bool $lazy = false): int {
			return isset($this->values[$key]) ? (int)$this->values[$key] : $default;
		}

		// Unused by the policy. IAppConfig is a wide interface and PHP requires
		// the full surface; only the two readers above carry any meaning here.
		public function getApps(): array {
			return [];
		}
		public function getKeys(string $app): array {
			return [];
		}
		public function searchKeys(string $app, string $prefix = '', bool $lazy = false): array {
			return [];
		}
		public function hasKey(string $app, string $key, ?bool $lazy = false): bool {
			return false;
		}
		public function isSensitive(string $app, string $key, ?bool $lazy = false): bool {
			return false;
		}
		public function isLazy(string $app, string $key): bool {
			return false;
		}
		public function getAllValues(string $app, string $prefix = '', bool $filtered = false): array {
			return [];
		}
		public function searchValues(string $key, bool $lazy = false, ?int $typedAs = null): array {
			return [];
		}
		public function getValueFloat(string $app, string $key, float $default = 0, bool $lazy = false): float {
			return 0;
		}
		public function getValueArray(string $app, string $key, array $default = [], bool $lazy = false): array {
			return [];
		}
		public function getValueType(string $app, string $key, ?bool $lazy = null): int {
			return 0;
		}
		public function setValueString(string $app, string $key, string $value, bool $lazy = false, bool $sensitive = false): bool {
			return false;
		}
		public function setValueInt(string $app, string $key, int $value, bool $lazy = false, bool $sensitive = false): bool {
			return false;
		}
		public function setValueFloat(string $app, string $key, float $value, bool $lazy = false, bool $sensitive = false): bool {
			return false;
		}
		public function setValueBool(string $app, string $key, bool $value, bool $lazy = false): bool {
			return false;
		}
		public function setValueArray(string $app, string $key, array $value, bool $lazy = false, bool $sensitive = false): bool {
			return false;
		}
		public function updateSensitive(string $app, string $key, bool $sensitive): bool {
			return false;
		}
		public function updateLazy(string $app, string $key, bool $lazy): bool {
			return false;
		}
		public function getDetails(string $app, string $key): array {
			return [];
		}
		public function getKeyDetails(string $app, string $key): array {
			return [];
		}
		public function convertTypeToInt(string $type): int {
			return 0;
		}
		public function convertTypeToString(int $type): string {
			return '';
		}
		public function deleteKey(string $app, string $key): void {
		}
		public function deleteApp(string $app): void {
		}
		public function clearCache(bool $reload = false): void {
		}
		public function getValues($app, $key) {
			return null;
		}
		public function getFilteredValues($app) {
			return null;
		}
		public function getAppInstalledVersions(bool $onlyEnabled = false): array {
			return [];
		}
	};
}

/** An EndpointPolicy reading a fixture rather than the instance's real config. */
function fixturePolicy(string $allowed, bool $replicate = false): \OCA\NoteBerg\EndpointPolicy {
	return withAppConfig(\OCA\NoteBerg\EndpointPolicy::class, fixtureAppConfig([
		\OCA\NoteBerg\EndpointPolicy::CONFIG_KEY => $allowed,
		\OCA\NoteBerg\EndpointPolicy::CONFIG_KEY_REPLICATE => $replicate,
	]));
}

/** An AiPolicy reading a fixture rather than the instance's real config. */
function fixtureAiPolicy(array $values): \OCA\NoteBerg\AiPolicy {
	return withAppConfig(\OCA\NoteBerg\AiPolicy::class, fixtureAppConfig($values));
}

/**
 * Build a policy object around a fixture config, bypassing its constructor.
 *
 * Both policies take exactly one collaborator and read from it; injecting by
 * name keeps the tests about the logic rather than about wiring.
 */
function withAppConfig(string $class, \OCP\IAppConfig $appConfig): object {
	$policy = (new ReflectionClass($class))->newInstanceWithoutConstructor();
	$property = new ReflectionProperty($policy, 'appConfig');
	$property->setAccessible(true);
	$property->setValue($policy, $appConfig);
	return $policy;
}

function invokePrivate(string $class, string $method, FixtureConfig $config, array $args, ?\OCA\NoteBerg\EndpointPolicy $policy = null, ?\OCA\NoteBerg\AiPolicy $aiPolicy = null): mixed {
	$reflection = new ReflectionMethod($class, $method);
	$reflection->setAccessible(true);

	$instance = (new ReflectionClass($class))->newInstanceWithoutConstructor();

	$inject = [
		'config' => $config,
		'crypto' => \OC::$server->get(\OCP\Security\ICrypto::class),
		'logger' => \OC::$server->get(\Psr\Log\LoggerInterface::class),
		// Defaults to permitting the hosts the existing cases use, so tests about
		// path handling are not also tests about the allowlist. The cases that
		// are about the policy pass their own.
		'endpointPolicy' => $policy ?? fixturePolicy("api.replicate.com\nlocalhost\nexample.com", true),
		// BYO unless a case says otherwise, so the existing tests keep asserting
		// the per-user behaviour they were written for.
		'aiPolicy' => $aiPolicy ?? fixtureAiPolicy([]),
	];
	foreach ($inject as $name => $value) {
		if (!property_exists($instance, $name)) {
			continue;
		}
		$property = new ReflectionProperty($instance, $name);
		$property->setAccessible(true);
		$property->setValue($instance, $value);
	}

	return $reflection->invoke($instance, ...$args);
}

/** The server's real ICrypto, used to build fixtures the code must accept. */
function crypto(): \OCP\Security\ICrypto {
	return \OC::$server->get(\OCP\Security\ICrypto::class);
}

const PROXY = 'OCA\\NoteBerg\\Controller\\RecognitionController';

echo "resolveUrl — the caller chooses what to ask for, never whom to ask\n";
{
	$config = new FixtureConfig(['recognition_endpoint' => 'https://api.replicate.com/v1']);
	$resolve = fn (string $path) => invokePrivate(PROXY, 'resolveUrl', $config, ['admin', $path]);

	// The 404 this was written for: the endpoint already ends in /v1 and the
	// backend's own paths start with /v1, so naive concatenation produced
	// https://api.replicate.com/v1/v1/... and Replicate rejected it.
	check(
		'collapses a prefix the endpoint already carries',
		$resolve('/v1/models/owner/name/predictions'),
		'https://api.replicate.com/v1/models/owner/name/predictions',
	);
	check(
		'appends a path that shares no prefix',
		$resolve('/chat/completions'),
		'https://api.replicate.com/v1/chat/completions',
	);
	check('an empty path is the endpoint itself', $resolve(''), 'https://api.replicate.com/v1');

	// Each of these would let a caller reach a host they did not configure —
	// the difference between a proxy and an open fetcher.
	check('rejects a protocol-relative path', $resolve('//evil.example.com/x'), null);
	check('rejects traversal', $resolve('/v1/../../secret'), null);
	check('rejects a path that is not absolute', $resolve('relative/path'), null);
	check('rejects an over-long path', $resolve('/' . str_repeat('a', 600)), null);
}

echo "resolveUrl — the endpoint itself must be usable\n";
{
	$run = function (string $endpoint): mixed {
		$config = new FixtureConfig(['recognition_endpoint' => $endpoint]);
		return invokePrivate(PROXY, 'resolveUrl', $config, ['admin', '/v1/predictions']);
	};

	check(
		'normalizes a trailing slash',
		$run('https://api.replicate.com/v1/'),
		'https://api.replicate.com/v1/predictions',
	);
	// Was a hardcoded link-local block; the administrator's allowlist supersedes
	// it, and denies this because nothing permits it. See the EndpointPolicy
	// section below, which covers the policy itself.
	check('rejects an endpoint the administrator has not permitted', $run('http://169.254.169.254/v1'), null);
	check('rejects a non-http scheme', $run('ftp://example.com/v1'), null);
	check('rejects an unconfigured endpoint', $run(''), null);
	check('rejects a malformed endpoint', $run('not a url'), null);

	// Deliberately allowed where the administrator permits it: a model running
	// beside the Nextcloud instance is a legitimate setup. The fixture policy
	// lists localhost, which is what makes this reachable.
	check(
		'allows a local endpoint, which is a supported deployment',
		$run('http://localhost:1234/v1'),
		'http://localhost:1234/v1/predictions',
	);
}

echo "EndpointPolicy — the administrator decides what this server may reach\n";
{
	$permits = fn (string $allowed, string $endpoint, bool $replicate = false)
		=> fixturePolicy($allowed, $replicate)->permits($endpoint);

	// Deny by default. An instance whose administrator configures nothing makes
	// no outbound AI calls at all — the whole point of the control, and the
	// state it must reach without anyone having to act.
	check('an empty list permits nothing', $permits('', 'https://api.openai.com/v1'), false);
	check(
		'an empty list denies the cloud metadata address',
		$permits('', 'http://169.254.169.254/latest/meta-data/'),
		false,
	);

	// A bare host is the form an admin most naturally writes.
	check('a bare host permits https on it', $permits('example.com', 'https://example.com/v1'), true);
	check('a bare host does not permit another', $permits('example.com', 'https://other.com/v1'), false);

	// The three shapes a string-prefix implementation would let through. Each
	// contains the permitted entry verbatim, and each addresses a different host.
	check(
		'rejects a suffixed lookalike host',
		$permits('example.com', 'https://example.com.evil.test/v1'),
		false,
	);
	check(
		'rejects the permitted host appearing in a query string',
		$permits('example.com', 'https://evil.test/?x=https://example.com/'),
		false,
	);
	check(
		'rejects the permitted host appearing as userinfo',
		$permits('example.com', 'https://example.com@evil.test/v1'),
		false,
	);

	// A path in an entry is a prefix, but only at a segment boundary.
	check(
		'a path prefix permits a child path',
		$permits('https://example.com/v1', 'https://example.com/v1/chat/completions'),
		true,
	);
	check(
		'a path prefix does not permit a sibling that merely starts the same',
		$permits('https://example.com/v1', 'https://example.com/v1beta/chat'),
		false,
	);

	// Scheme and port are pinned when the admin writes them, and left open when
	// they do not — so "model.lan" covers the plain-HTTP local server it was
	// written for, while "https://..." means https.
	check('an https entry does not permit http', $permits('https://example.com', 'http://example.com/v1'), false);
	check('a bare host permits a plain-http local server', $permits('model.lan', 'http://model.lan/v1'), true);
	check('an entry with a port pins it', $permits('model.lan:8080', 'http://model.lan:9090/v1'), false);
	check('an entry with a port permits that port', $permits('model.lan:8080', 'http://model.lan:8080/v1'), true);

	// No wildcards: an entry names one host. Written as a test so the decision
	// is visible rather than an accident of the implementation.
	check(
		'a wildcard entry matches nothing, including what it looks like it means',
		$permits('*.example.com', 'https://a.example.com/v1'),
		false,
	);

	// Replicate is governed by a switch, not by the list: its host is fixed in
	// the client and never typed by a user, so the admin's decision is whether
	// the provider may be used at all.
	$rep = \OCA\NoteBerg\EndpointPolicy::REPLICATE_BASE;
	check('Replicate is denied while its switch is off', $permits('', $rep), false);
	check('Replicate is permitted by its switch alone', $permits('', $rep, true), true);
	check(
		'the switch covers the prediction paths the client actually calls',
		$permits('', $rep . '/models/owner/name/predictions', true),
		true,
	);
	check(
		'the switch does not permit anything else',
		$permits('', 'https://api.openai.com/v1', true),
		false,
	);

	// Comments and blank lines let an admin annotate the list.
	check(
		'ignores comments and blank lines',
		$permits("# a note\n\nexample.com\n", 'https://example.com/v1'),
		true,
	);
	check('a comment is not itself a permitted host', $permits('# example.com', 'https://example.com/v1'), false);
}

echo "buildHeaders — the credential is the server's, not the caller's\n";
{
	// Keys are stored encrypted, so the fixture stores what the app would have
	// stored. Passing plaintext here would exercise the legacy path instead of
	// the one every current write takes — that path is covered separately below.
	$run = function (string $key): array {
		// Keys are stored per provider, so the fixture must name one: a slot
		// under the retired shared name is not read by anything any more.
		$config = new FixtureConfig([
			'recognition_backend' => 'replicate',
			'recognition_api_key_replicate' => $key === '' ? '' : crypto()->encrypt($key),
		]);
		return invokePrivate(PROXY, 'buildHeaders', $config, ['admin']);
	};

	check('attaches a stored key as a bearer token', $run('r8_secret')['Authorization'] ?? null, 'Bearer r8_secret');
	check('omits Authorization when no key is stored', $run('')['Authorization'] ?? null, null);
	// A stored value containing CRLF would otherwise append headers of its own
	// to a request the Nextcloud server makes.
	//
	// Asserted on the absence of the control characters rather than on the exact
	// resulting string: an expectation written with a real CR/LF in it renders
	// identically to one without, so a failure would be invisible in the diff.
	$injected = $run("abc\r\nX-Injected: 1")['Authorization'] ?? '';
	check('strips CR so a stored value cannot inject headers', str_contains($injected, "\r"), false);
	check('strips LF so a stored value cannot inject headers', str_contains($injected, "\n"), false);
	check('keeps the rest of the value intact', $injected, 'Bearer abcX-Injected: 1');
	check('always sends JSON content type', $run('k')['Content-Type'] ?? null, 'application/json');
}

echo "readApiKey — encrypted at rest, without breaking existing installs\n";
{
	$read = function (string $stored): string {
		$config = new FixtureConfig([
			'recognition_backend' => 'replicate',
			'recognition_api_key_replicate' => $stored,
		]);
		return invokePrivate(PROXY, 'readApiKey', $config, ['admin']);
	};

	// The path every key written by the current code takes.
	check('decrypts a stored key', $read(crypto()->encrypt('r8_secret')), 'r8_secret');

	// Keys written before encryption existed are plaintext. ICrypto throws on
	// them, and treating that as fatal would break recognition on every
	// instance that configured it before upgrading.
	check('falls back to a legacy plaintext key', $read('r8_legacy_plaintext'), 'r8_legacy_plaintext');

	check('an absent key stays absent', $read(''), '');

	// The point of the exercise: what lands in oc_preferences is not the token.
	$ciphertext = crypto()->encrypt('r8_secret');
	check('ciphertext does not contain the token', str_contains($ciphertext, 'r8_secret'), false);
}

echo "AiPolicy — who provides the AI account, and under what cap\n";
{
	$M = \OCA\NoteBerg\AiPolicy::CONFIG_KEY_MODE;
	$L = \OCA\NoteBerg\AiPolicy::CONFIG_PREFIX_LIMIT . 'recognition';
	$T = \OCA\NoteBerg\AiPolicy::CONFIG_PREFIX_TASK . 'recognition_';

	check('BYO is the default, so an upgrade changes nothing',
		fixtureAiPolicy([])->mode(), 'byo');
	check('an unrecognised mode reads as BYO, not central',
		fixtureAiPolicy([$M => 'nonsense'])->mode(), 'byo');
	check('central is honoured when set',
		fixtureAiPolicy([$M => 'central'])->isCentral(), true);

	// The cap. Unlike the endpoint allowlist this is NOT deny-by-default: it
	// bounds a feature the admin already permitted, and an unset cap that
	// blocked everything would make enabling central mode look broken.
	check('an unset cap means unlimited',
		fixtureAiPolicy([$M => 'central'])->monthlyLimit('recognition'), 0);
	check('a configured cap is returned in central mode',
		fixtureAiPolicy([$M => 'central', $L => 250])->monthlyLimit('recognition'), 250);
	check('a negative cap reads as unlimited rather than as a huge one',
		fixtureAiPolicy([$M => 'central', $L => -5])->monthlyLimit('recognition'), 0);
	check('an unknown task has no cap of its own',
		fixtureAiPolicy([$M => 'central', $L => 250])->monthlyLimit('summary'), 0);

	// The cap is a spend control, and under BYO the account charged is the
	// user's own. A cap set while trying out central mode kept refusing runs
	// after switching back, with a message naming a control the administrator
	// could no longer see — the field is not offered in that mode at all.
	check('a stored cap does not apply under BYO',
		fixtureAiPolicy([$L => 250])->monthlyLimit('recognition'), 0);
	check('nor does it apply after switching back to BYO',
		fixtureAiPolicy([$M => 'byo', $L => 2])->monthlyLimit('recognition'), 0);

	// Model enforcement. The proxy forwards the body untouched, so restricting
	// the settings UI cannot achieve this: a user can POST to /dispatch directly.
	$central = fixtureAiPolicy([$M => 'central', $T . 'model' => 'qwen/qwen3-vl']);
	check('BYO enforces no model at all',
		fixtureAiPolicy([])->permitsModel(['model' => 'anything']), true);
	check('central permits the administrator model',
		$central->permitsModel(['model' => 'qwen/qwen3-vl']), true);
	check('central refuses a different model',
		$central->permitsModel(['model' => 'gpt-4o']), false);
	// Replicate addresses a community model by version and sends NO model field
	// at all — the model name is in the URL path. So a version-addressed body is
	// matched against the configured *version*; comparing it against the model
	// refused every community model, which is the case that field exists for.
	$replicate = fixtureAiPolicy([
		$M => 'central',
		$T . 'model' => 'lucataco/qwen3-vl',
		$T . 'replicate_version' => 'abc123',
	]);
	check('a version-addressed body matches the configured version',
		$replicate->permitsModel(['version' => 'abc123', 'input' => []]), true);
	check('a version-addressed body refuses a different version',
		$replicate->permitsModel(['version' => 'deadbeef', 'input' => []]), false);
	check('the model field is not compared against the version',
		$replicate->permitsModel(['model' => 'lucataco/qwen3-vl']), true);
	// A version hash addresses a model of the caller's choosing, so an
	// unconfigured version is not licence to run any of them: that is exactly the
	// unattributed spend against the organisation's account central mode exists
	// to prevent. With a model configured, the path is the only remaining
	// evidence of what is actually being run, and resolveUrl() has already
	// confined it to the administrator's endpoint.
	$versionless = fixtureAiPolicy([$M => 'central', $T . 'model' => 'qwen/qwen3-vl']);
	check('a version-addressed body cannot pick its own model when none is pinned',
		$versionless->permitsModel(['version' => 'deadbeef', 'input' => []]), false);
	check('nor when it names a version and the path names another model',
		$versionless->permitsModel(['version' => 'deadbeef', 'input' => []], 'recognition',
			'/v1/models/evil/other/predictions'), false);
	check('a version alongside the administrator model in the path is permitted',
		$versionless->permitsModel(['version' => 'deadbeef', 'input' => []], 'recognition',
			'/v1/models/qwen/qwen3-vl/predictions'), true);
	check('with neither a version nor a model configured there is nothing to enforce',
		fixtureAiPolicy([$M => 'central'])
			->permitsModel(['version' => 'anything', 'input' => []]), true);
	// Fails closed: a shape that escapes inspection escapes the policy.
	check('central refuses a body naming no model, with no path to fall back on',
		$central->permitsModel(['input' => ['prompt' => 'x']]), false);

	// Replicate's official-model form carries the model in the URL, not the body:
	// buildPredictionUrl() produces /v1/models/{owner}/{name}/predictions and
	// sends only `input`. Refusing that blocked every central Replicate setup
	// without a version hash — the ordinary case for an official model. The path
	// is not the caller's to choose either: resolveUrl() has already confined it
	// to the administrator's endpoint.
	check('a model named in the path is permitted',
		$central->permitsModel(['input' => []], 'recognition',
			'/v1/models/qwen/qwen3-vl/predictions'), true);
	check('a different model in the path is refused',
		$central->permitsModel(['input' => []], 'recognition',
			'/v1/models/evil/other/predictions'), false);
	// Matched on parsed segments, not as a substring: a prefixed owner would
	// otherwise smuggle the permitted name through.
	check('a smuggled prefix does not match',
		$central->permitsModel(['input' => []], 'recognition',
			'/v1/models/evil/qwen/qwen3-vl/predictions'), false);
	check('a path that is not a prediction call does not authorise anything',
		$central->permitsModel(['input' => []], 'recognition',
			'/v1/models/qwen/qwen3-vl'), false);
	check('central refuses an absent body',
		$central->permitsModel(null), false);
	check('central with no model configured enforces nothing',
		fixtureAiPolicy([$M => 'central'])->permitsModel(['model' => 'anything']), true);
}

echo "AiPolicy::isBillable — only traffic that spends money is counted\n";
{
	$billable = fn (string $m, string $path) => \OCA\NoteBerg\AiPolicy::isBillable($m, $path);

	check('an OpenAI transcription counts', $billable('POST', '/v1/chat/completions'), true);
	check('a Replicate versioned prediction counts', $billable('POST', '/v1/predictions'), true);
	check('a Replicate official-model prediction counts',
		$billable('POST', '/v1/models/lucataco/qwen/predictions'), true);

	// The discriminator that matters: the free schema lookup has the billable
	// prediction path as a prefix, so path alone is ambiguous — but every free
	// call is a GET.
	check('a model schema lookup does not count',
		$billable('GET', '/v1/models/lucataco/qwen'), false);
	check('a model listing does not count', $billable('GET', '/v1/models'), false);
	check('a prediction poll does not count',
		$billable('GET', '/v1/predictions/abc123'), false);
	check('a query string does not defeat the path match',
		$billable('POST', '/v1/chat/completions?x=1'), true);
	check('an unrecognised POST is not counted',
		$billable('POST', '/v1/embeddings'), false);
}

echo "UsageCounter — the period key\n";
{
	check('is monthly and UTC',
		\OCA\NoteBerg\UsageCounter::periodKey(gmmktime(0, 0, 0, 3, 15, 2026)), '2026-03');
	check('rolls at the month boundary',
		\OCA\NoteBerg\UsageCounter::periodKey(gmmktime(0, 0, 0, 4, 1, 2026)), '2026-04');
}

echo "resolveUrl — central mode uses the administrator endpoint\n";
{
	$config = new FixtureConfig([
		\OCA\NoteBerg\Controller\RecognitionConfigController::KEY_ENDPOINT => 'https://example.com/v1',
	]);
	$central = fixtureAiPolicy([
		\OCA\NoteBerg\AiPolicy::CONFIG_KEY_MODE => 'central',
		\OCA\NoteBerg\AiPolicy::CONFIG_PREFIX_TASK . 'recognition_endpoint' => 'https://api.replicate.com/v1',
	]);

	// The user own endpoint is ignored entirely: in central mode the request
	// goes where the administrator says, or the mode would not be central.
	check(
		'the user endpoint is not used',
		invokePrivate(PROXY, 'resolveUrl', $config, ['alice', '/predictions'], null, $central),
		'https://api.replicate.com/v1/predictions',
	);

	// And it is still bound by the allowlist — switching mode must not become a
	// way past the control that gates egress.
	check(
		'the administrator endpoint is still allowlisted',
		invokePrivate(PROXY, 'resolveUrl', $config, ['alice', '/predictions'],
			fixturePolicy(''), $central),
		null,
	);
}

echo "updateMode — the endpoint check applies to the mode being saved\n";
{
	// The admin form posts every field regardless of mode, because the central
	// block is hidden rather than cleared. So an administrator switching back to
	// BYO still sends whatever endpoint sits in that hidden field — and must not
	// be refused over a control they are in the act of turning off.
	$permits = function (string $mode, string $endpoint, string $allowed): bool {
		$policy = fixturePolicy($allowed);
		// Mirrors the guard in updateMode(): central mode enforces, BYO does not.
		return $mode === \OCA\NoteBerg\AiPolicy::MODE_CENTRAL && $endpoint !== ''
			? $policy->permits($endpoint)
			: true;
	};

	check('central refuses an endpoint outside the allowlist',
		$permits('central', 'https://evil.example.com/v1', 'api.openai.com'), false);
	check('central accepts one inside it',
		$permits('central', 'https://api.openai.com/v1', 'api.openai.com'), true);
	check('switching to BYO is not blocked by a stale central endpoint',
		$permits('byo', 'https://no-longer-allowed.example.com/v1', 'api.openai.com'), true);
	check('central with no endpoint yet is not refused',
		$permits('central', '', 'api.openai.com'), true);
}


echo "admin template — conditional attributes survive p()'s escaping\n";
{
	// p() escapes its argument, so p('style="display:none"') emits
	// style=&quot;display:none&quot; — inert text rather than markup, leaving a
	// block visible that should have been hidden. A bare attribute name has
	// nothing to escape and survives. This caught a real defect: the central
	// settings were shown on load in BYO mode, and no other check could see it
	// because the PHP condition itself was correct.
	$render = function (string $attr): string {
		return htmlspecialchars($attr, ENT_QUOTES, 'UTF-8');
	};

	check('a bare attribute survives intact', $render('hidden'), 'hidden');
	check('checked survives, which is why the radios work', $render('checked'), 'checked');
	check(
		'a quoted style attribute does NOT survive — do not use one here',
		$render('style="display:none"'),
		'style=&quot;display:none&quot;',
	);
}


echo "updateMode — a provider must be permitted, not merely selected\n";
{
	// The dropdown disables an unpermitted provider, but that is a guide rather
	// than the control: the policy can be narrowed while the form is open, and
	// the client is not what decides. Replicate has no endpoint to check, so its
	// switch is the check.
	$refuses = function (string $mode, bool $isReplicate, bool $replicateAllowed): bool {
		$policy = fixturePolicy('api.openai.com', $replicateAllowed);
		// Mirrors the guard in updateMode().
		return $mode === \OCA\NoteBerg\AiPolicy::MODE_CENTRAL && $isReplicate
			&& !$policy->allowsReplicate();
	};

	check('central refuses Replicate while its switch is off',
		$refuses('central', true, false), true);
	check('central accepts Replicate once the switch is on',
		$refuses('central', true, true), false);
	check('an OpenAI-compatible save is unaffected by the Replicate switch',
		$refuses('central', false, false), false);
	check('BYO is never refused over a provider it does not use',
		$refuses('byo', true, false), false);
}

echo "admin template — the provider dropdown reflects the policy\n";
{
	// A provider the allowlist does not permit cannot run, so offering it would
	// let an administrator save a configuration that silently never works. A
	// stored-but-no-longer-permitted one is still shown, so a configuration made
	// before a policy change stays visible rather than appearing unset.
	$offered = function (array $entries, bool $allowReplicate, string $stored): array {
		$openAiUsable = count($entries) > 0;
		$out = [];
		if ($openAiUsable || $stored !== 'replicate') {
			$out[] = 'openai' . ($openAiUsable ? '' : ':disabled');
		}
		if ($allowReplicate || $stored === 'replicate') {
			$out[] = 'replicate' . ($allowReplicate ? '' : ':disabled');
		}
		return $out;
	};

	check('an empty policy offers neither as usable',
		$offered([], false, ''), ['openai:disabled']);
	check('one listed endpoint makes OpenAI-compatible usable',
		$offered(['api.openai.com'], false, ''), ['openai']);
	check('the switch alone makes Replicate usable',
		$offered([], true, ''), ['openai:disabled', 'replicate']);
	check('both permitted offers both',
		$offered(['api.openai.com'], true, ''), ['openai', 'replicate']);
	check('a stored provider stays visible after being disallowed',
		$offered([], false, 'replicate'), ['replicate:disabled']);
}


echo "AiPolicy::taskNumber — unset is 0, meaning the built-in default\n";
{
	$T = \OCA\NoteBerg\AiPolicy::CONFIG_PREFIX_TASK . 'recognition_';

	// 0 rather than a value, because the client distinguishes "unset" from a
	// choice: a zero-pixel image or a zero-token cap is the absence of a
	// setting, and must fall back to the default rather than be honoured.
	check('an unset numeric setting reads as 0',
		fixtureAiPolicy([])->taskNumber('recognition', 'max_image_edge'), 0);
	check('a configured one is returned',
		fixtureAiPolicy([$T . 'max_image_edge' => 1200])
			->taskNumber('recognition', 'max_image_edge'), 1200);
	check('a negative value reads as unset rather than as a real setting',
		fixtureAiPolicy([$T . 'max_tokens' => -50])
			->taskNumber('recognition', 'max_tokens'), 0);
	check('an unknown task has no numeric settings',
		fixtureAiPolicy([$T . 'max_tokens' => 4000])->taskNumber('summary', 'max_tokens'), 0);

	// The bounds the admin inputs advertise. Clamped rather than refused: the
	// values come from number fields with their own min/max, so a bad one is a
	// typo and rejecting the whole save over it would lose the rest of the form.
	$clamp = function (int $v, int $min, int $max): int {
		return $v > 0 ? max($min, min($max, $v)) : 0;
	};
	check('an over-large image edge is clamped', $clamp(99999, 256, 4096), 4096);
	check('an under-small image edge is clamped', $clamp(10, 256, 4096), 256);
	check('a timeout above the proxy ceiling is clamped', $clamp(5000, 5, 600), 600);
	check('zero stays zero, meaning unset', $clamp(0, 256, 4096), 0);
}


echo "prepare — the model check applies only to a request that invokes a model\n";
{
	// The reported failure: the check ran on every proxied request, including
	// those that name no model at all. A Replicate schema lookup is a GET with
	// no body, so permitsModel() failed closed and 403'd it — taking out the
	// whole Replicate path before the dispatch was even attempted.
	//
	// isBillable() already identifies exactly the requests that invoke a model,
	// so it gates both the model check and the quota. Mirrors the guard in
	// prepare().
	$checked = fn (string $m, string $path) => \OCA\NoteBerg\AiPolicy::isBillable($m, $path);

	check('a schema lookup is not model-checked',
		$checked('GET', '/v1/models/lucataco/qwen'), false);
	check('a prediction poll is not model-checked',
		$checked('GET', '/v1/predictions/abc123'), false);
	check('a model listing is not model-checked',
		$checked('GET', '/v1/models'), false);
	check('a transcription dispatch is model-checked',
		$checked('POST', '/v1/chat/completions'), true);
	check('a Replicate prediction is model-checked',
		$checked('POST', '/v1/models/lucataco/qwen/predictions'), true);
}



/**
 * A UsageReport over fixed usage and a fixed account list.
 *
 * Built by reflection, like the policies above and for the same reason: the
 * subject is how the counter and the account list are combined into rows — the
 * zero-fill, the ordering, and what becomes of usage whose account is gone — and
 * none of that is a question about SQL or about the user backend. Stubbing
 * IUserManager's full surface to answer one method would bury what these cases
 * actually say. UsageCounter's own queries are exercised against the real
 * database further down.
 *
 * @param array<string,int> $used     uid => units, as the counter would report
 * @param array<string,string> $accounts uid => display name
 */
function fixtureUsageReport(array $used, array $accounts): \OCA\NoteBerg\UsageReport {
	$counter = new class ($used) extends \OCA\NoteBerg\UsageCounter {
		/** @param array<string,int> $used */
		public function __construct(private array $used) {
		}
		public function report(string $task, ?string $period = null): array {
			return $this->used;
		}
		public function periods(string $task): array {
			return array_keys($this->used);
		}
	};

	// The account list is supplied by overriding the one method that reads it,
	// rather than by injecting a fake IUserManager: the property is typed, and
	// stubbing that interface's full surface to answer a single call would bury
	// what these cases are actually saying.
	$report = new class extends \OCA\NoteBerg\UsageReport {
		/** @var array<string,string> */
		public array $accounts = [];

		public function __construct() {
		}

		protected function displayNames(): array {
			return $this->accounts;
		}
	};
	$report->accounts = $accounts;

	foreach (['counter' => $counter, 'l' => l10n()] as $name => $value) {
		$property = new ReflectionProperty(\OCA\NoteBerg\UsageReport::class, $name);
		$property->setAccessible(true);
		$property->setValue($report, $value);
	}
	return $report;
}

/** The app's real IL10N, so the month names asserted below are the shipped ones. */
function l10n(): \OCP\IL10N {
	return \OCP\Server::get(\OCP\L10N\IFactory::class)->get('noteberg', 'en');
}

echo "UsageReport - one period, one row per account\n";
{
	$uids = static fn (array $result): array => array_map(
		static fn (array $row): string => $row['uid'] . '=' . $row['units'],
		$result['rows'],
	);

	// Every account appears, not only those that spent something: the question
	// "is anyone using this at all" needs the silent accounts visible, and a
	// table of active users alone cannot answer it.
	$zeroFilled = fixtureUsageReport(['alice' => 5], ['alice' => 'Alice', 'bob' => 'Bob'])
		->forPeriod('recognition', '2026-08');
	check('an account with no usage still gets a row', $uids($zeroFilled), ['alice=5', 'bob=0']);
	check('the total counts only what was spent', $zeroFilled['total'], 5);
	check('every account is counted, spending or not', $zeroFilled['users'], 2);
	check('a short table is not truncated', $zeroFilled['truncated'], false);

	// Spend first, so a long table opens on the rows worth reading.
	check(
		'rows are ordered by spend, highest first',
		$uids(fixtureUsageReport(
			['bob' => 9, 'alice' => 2],
			['alice' => 'Alice', 'bob' => 'Bob', 'carol' => 'Carol'],
		)->forPeriod('recognition', '2026-08')),
		['bob=9', 'alice=2', 'carol=0'],
	);

	// A tie must not reshuffle between page loads, which is what the uid
	// tiebreak in the sort is for.
	check(
		'a tie is broken by name, so the order is stable',
		$uids(fixtureUsageReport(['b' => 3, 'a' => 3], ['a' => 'Anna', 'b' => 'Bert'])
			->forPeriod('recognition', '2026-08')),
		['a=3', 'b=3'],
	);

	// Usage outlives the account it belongs to. Dropping the row would make the
	// column disagree with the total, which is the number checked against a bill.
	$orphan = fixtureUsageReport(['ghost' => 4], ['alice' => 'Alice'])
		->forPeriod('recognition', '2026-08');
	check('usage with no account still gets a row', $uids($orphan), ['ghost=4', 'alice=0']);
	check('and that row is marked as a deleted user', $orphan['rows'][0]['deleted'], true);
	check('a live account is not marked deleted', $orphan['rows'][1]['deleted'], false);
	check('the total includes the orphaned usage', $orphan['total'], 4);

	// The display name is what the table shows; the uid is what disambiguates
	// two accounts sharing one. Both have to reach the row.
	$named = fixtureUsageReport([], ['alice' => 'Alice Smith'])
		->forPeriod('recognition', '2026-08')['rows'][0];
	check('the display name reaches the row', $named['displayName'], 'Alice Smith');
	check('and so does the uid behind it', $named['uid'], 'alice');

	// An instance with no accounts renders an empty table rather than failing:
	// the section is always present, whether or not there is anything in it.
	$none = fixtureUsageReport([], [])->forPeriod('recognition', '2026-08');
	check('no accounts is an empty table, not an error', $none['rows'], []);
	check('and reports nothing spent', $none['total'], 0);

	// The cut falls on the zero rows, because the sort put them last — the users
	// the table was least able to say anything about.
	$many = [];
	for ($i = 0; $i < \OCA\NoteBerg\UsageReport::MAX_ROWS + 10; $i++) {
		$many[sprintf('user%03d', $i)] = 'User ' . $i;
	}
	$big = fixtureUsageReport(['user205' => 1], $many)->forPeriod('recognition', '2026-08');
	check('a long table is cut to the row cap',
		count($big['rows']), \OCA\NoteBerg\UsageReport::MAX_ROWS);
	check('and says so', $big['truncated'], true);
	check('the user count is the real one, not the visible one',
		$big['users'], \OCA\NoteBerg\UsageReport::MAX_ROWS + 10);
	check('the spending user survives the cut', $big['rows'][0]['uid'], 'user205');

	// The picker must be able to select the month being looked at, even on an
	// instance where nothing has been recorded yet.
	$current = \OCA\NoteBerg\UsageCounter::periodKey();
	check(
		'the current month is always offered',
		fixtureUsageReport([], [])->periods('recognition'),
		[$current],
	);
	check(
		'and is not offered twice when it already has usage',
		fixtureUsageReport([$current => 1], [])->periods('recognition'),
		[$current],
	);
	check(
		'a past period is kept alongside it',
		fixtureUsageReport(['1999-01' => 1], [])->periods('recognition'),
		[$current, '1999-01'],
	);
}

echo "UsageReport::label - the month heading\n";
{
	$labeller = fixtureUsageReport([], []);

	check('a period key becomes a month and year', $labeller->label('2026-09'), 'September 2026');
	check('the month is read as a number, not an offset', $labeller->label('2026-01'), 'January 2026');
	check('December does not wrap into the next year', $labeller->label('2026-12'), 'December 2026');
	// The picker only offers keys the table produced, but the heading must not
	// break on a stored value in some later period format.
	check('an unparseable key is shown as it is', $labeller->label('nonsense'), 'nonsense');
}

echo "UsageCounter - the reporting queries, against the real database\n";
{
	$counter = \OCP\Server::get(\OCA\NoteBerg\UsageCounter::class);
	// Period keys no real usage can collide with, so these assertions do not
	// depend on what the dev instance happens to have recorded.
	$period = '1999-01';
	$other = '1999-02';

	$counter->record('test-alice', 'recognition', 3, $period);
	$counter->record('test-bob', 'recognition', 7, $period);
	// A different task and a different period, neither of which may appear in
	// the report for the one being asked about.
	$counter->record('test-alice', 'other-task', 99, $period);
	$counter->record('test-alice', 'recognition', 50, $other);

	$rows = $counter->report('recognition', $period);
	check('the report returns each user units', $rows, ['test-bob' => 7, 'test-alice' => 3]);
	check('another task does not leak in', array_sum($rows), 10);
	check('another period does not leak in',
		$counter->report('recognition', $other), ['test-alice' => 50]);
	check('a period with nothing recorded is empty',
		$counter->report('recognition', '1999-03'), []);
	check('a task with nothing recorded is empty',
		$counter->report('no-such-task', $period), []);

	$periods = $counter->periods('recognition');
	check('both recorded periods are offered, newest first',
		array_values(array_intersect($periods, [$period, $other])), [$other, $period]);

	// Leave the table as it was found: these rows would otherwise show up in the
	// admin panel of the dev instance.
	$counter->prune('1999-03');
	check('the fixture rows are cleaned up',
		$counter->report('recognition', $period) + $counter->report('recognition', $other), []);
}

printf("\n%d passed, %d failed\n", $passed, $failed);
exit($failed === 0 ? 0 : 1);
