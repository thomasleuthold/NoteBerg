<?php

declare(strict_types=1);

namespace OCA\NoteBerg;

use OCA\NoteBerg\AppInfo\Application;
use OCP\IAppConfig;

/**
 * The instance-wide policy for which AI services this server may call.
 *
 * Two controls, because there are two kinds of destination:
 *
 *   - An **allowlist of OpenAI-compatible endpoints**, which users choose and
 *     type. This is the surface the control exists for.
 *   - A **switch for the built-in Replicate provider**, whose host is a constant
 *     compiled into the client and never entered by anyone. An admin's decision
 *     there is "may this provider be used", not "which URL may be reached", so a
 *     boolean tells the truth that a text entry would not — and no admin has to
 *     discover and transcribe a hostname that was never a user's to pick.
 *
 * Recognition makes the *server* open an outbound connection to a host the
 * *user* chose. Without this, every account on an instance can independently
 * point the server anywhere — an egress capability an administrator installing a
 * notes app has not agreed to, and one they had no way to see or revoke.
 *
 * Deny by default, both of them. An empty list and an unset switch permit
 * nothing, so an instance that never configures this makes no outbound AI calls
 * at all. The alternative — empty
 * means unrestricted — reduces to having no control: the state an admin reaches
 * by doing nothing is exactly the state the control exists to prevent.
 *
 * This supersedes the link-local (169.254.0.0/16) block that used to guard the
 * proxy. That check existed because *any* host was otherwise reachable, and the
 * cloud metadata address is what makes an SSRF worth exploiting. Under an
 * allowlist nothing is reachable until an admin names it, so the block is
 * redundant: a metadata address can only be reached by an admin typing one in.
 * AdminSettings warns when an entry looks link-local rather than refusing it —
 * see the note there on why that warning cannot be complete.
 *
 * Nextcloud only. The native builds have no administrator, and their
 * destinations are checked client-side by recognition/endpointValidation.js.
 */
class EndpointPolicy {
	/** Config key holding the allowlist, one entry per line. */
	public const CONFIG_KEY = 'allowed_endpoints';

	/** Config key for whether the built-in Replicate provider may be used. */
	public const CONFIG_KEY_REPLICATE = 'allow_replicate';

	/**
	 * Replicate's API base, mirrored from the client's REPLICATE_BASE.
	 *
	 * Duplicated rather than shared because PHP cannot read the JS constant, and
	 * the two must not drift: replicateBackend.js builds every request from its
	 * own copy, so a mismatch here would deny the exact requests the client is
	 * about to make. Changing one means changing the other.
	 */
	public const REPLICATE_BASE = 'https://api.replicate.com/v1';

	/** Cap on the stored list, so a paste accident cannot become a parse cost. */
	public const MAX_ENTRIES = 100;

	public function __construct(
		private IAppConfig $appConfig,
	) {
	}

	/**
	 * The configured entries, in the order and spelling the admin wrote them.
	 *
	 * The spelling is preserved because these are shown to users: the endpoint
	 * field on Nextcloud is a dropdown built from this list, so an entry is a
	 * label as much as it is a pattern. Normalizing here would show users a URL
	 * their administrator never typed.
	 *
	 * @return list<string>
	 */
	public function entries(): array {
		$raw = $this->appConfig->getValueString(Application::APP_ID, self::CONFIG_KEY, '');
		return self::parse($raw);
	}

	/**
	 * Split stored text into entries.
	 *
	 * Static so the admin controller can validate a submission before storing it,
	 * without a round trip through config.
	 *
	 * @return list<string>
	 */
	public static function parse(string $raw): array {
		$lines = preg_split('/\R/', $raw) ?: [];
		$entries = [];
		foreach ($lines as $line) {
			$line = trim($line);
			// Blank lines and comments, so an admin can annotate the list.
			if ($line === '' || str_starts_with($line, '#')) {
				continue;
			}
			$entries[] = $line;
			if (count($entries) >= self::MAX_ENTRIES) {
				break;
			}
		}
		return $entries;
	}

	/**
	 * Whether an endpoint is permitted by the current policy.
	 *
	 * An empty list denies everything — see the class comment.
	 */
	public function permits(string $endpoint): bool {
		// Replicate is not a user-chosen destination. Its host is a constant
		// compiled into the client, the settings form has no endpoint field for
		// it, and the URL is filled in by the app rather than typed — so the
		// administrator's decision about it is "may this provider be used", not
		// "which URL may be reached". A separate switch says exactly that, and
		// spares admins from having to discover and transcribe a hostname that
		// was never theirs to choose. See allowsReplicate().
		if (self::matches($endpoint, self::REPLICATE_BASE)) {
			return $this->allowsReplicate();
		}

		foreach ($this->entries() as $entry) {
			if (self::matches($endpoint, $entry)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Whether one endpoint matches one allowlist entry.
	 *
	 * Matching is on *parsed URL components*, never on the raw string. A string
	 * comparison is the obvious implementation and it is wrong in a way that is
	 * hard to see: "https://api.openai.com.evil.com/" has the permitted entry as
	 * a prefix, and "https://api.openai.com@evil.com/" has it as a substring.
	 * Both are defeated by comparing the host component alone, which is what
	 * parse_url() yields.
	 *
	 * Two entry forms, because admins reasonably write either:
	 *
	 *   - A bare host ("api.openai.com") permits https on the default port, any
	 *     path. This is the common case and the one an allowlist usually means.
	 *   - A URL ("https://api.openai.com/v1", "http://model.lan:8080") pins the
	 *     scheme and, when given, the port and a path prefix.
	 *
	 * There are deliberately no wildcards. Every entry names one host, which is
	 * what lets the Nextcloud settings field be a dropdown of permitted choices
	 * rather than a text box the user can get wrong. Subdomain wildcards would be
	 * additive if a deployment ever needs them (Azure OpenAI gives each resource
	 * its own host), at the cost of turning that dropdown into a combobox.
	 */
	public static function matches(string $endpoint, string $entry): bool {
		$url = parse_url($endpoint);
		if ($url === false || !isset($url['scheme'], $url['host'])) {
			return false;
		}

		$scheme = strtolower($url['scheme']);
		if ($scheme !== 'http' && $scheme !== 'https') {
			return false;
		}
		$host = strtolower($url['host']);
		$port = $url['port'] ?? self::defaultPort($scheme);
		$path = rtrim($url['path'] ?? '', '/');

		// A bare host: no "://" anywhere in the entry.
		if (!str_contains($entry, '://')) {
			// A port may still be pinned ("model.lan:8080"), which parse_url only
			// reads with a scheme in front of it.
			$pattern = parse_url('https://' . $entry);
			if ($pattern === false || !isset($pattern['host'])) {
				return false;
			}
			if (strtolower($pattern['host']) !== $host) {
				return false;
			}
			// A bare host with no port permits either scheme's default. Pinning
			// https here would silently exclude the plain-HTTP local model an
			// admin wrote "model.lan" for; that judgment is theirs to make, and
			// they make it by writing a scheme when they care.
			return !isset($pattern['port']) || $pattern['port'] === $port;
		}

		$pattern = parse_url($entry);
		if ($pattern === false || !isset($pattern['scheme'], $pattern['host'])) {
			return false;
		}

		$patternScheme = strtolower($pattern['scheme']);
		if ($patternScheme !== $scheme) {
			return false;
		}
		if (strtolower($pattern['host']) !== $host) {
			return false;
		}
		if (($pattern['port'] ?? self::defaultPort($patternScheme)) !== $port) {
			return false;
		}

		// The path is a prefix, but only at a segment boundary: "/v1" permits
		// "/v1/chat/completions" and must not permit "/v1beta/...". Same rule the
		// client-side check uses (recognition/endpointValidation.js).
		$base = rtrim($pattern['path'] ?? '', '/');
		if ($base === '') {
			return true;
		}
		return $path === $base || str_starts_with($path, $base . '/');
	}

	/**
	 * Whether the built-in Replicate provider is permitted.
	 *
	 * Deny by default, like the endpoint list: an administrator who configures
	 * nothing permits no outbound AI calls of any kind.
	 */
	public function allowsReplicate(): bool {
		return $this->appConfig->getValueBool(
			Application::APP_ID,
			self::CONFIG_KEY_REPLICATE,
			false,
		);
	}

	private static function defaultPort(string $scheme): int {
		return $scheme === 'https' ? 443 : 80;
	}
}
