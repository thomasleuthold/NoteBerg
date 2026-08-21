/**
 * Recognition endpoint validation.
 *
 * The Tauri HTTP allowlist (src/components/recognition.json) had to widen from
 * a single pinned sidecar URL to "localhost on any port, plus https" so users
 * can point recognition at their own local or cloud inference. That allowlist
 * is a coarse outer bound enforced by the runtime; it is NOT the check.
 *
 * This module is the check: before any request, the destination is verified to
 * be the endpoint the user actually configured. Without it, the widened
 * allowlist would let any code path in the frontend reach any https host.
 *
 * See documentation/roadmap/ai-recognition/DESIGN.md §8.
 */

/** Hosts that are always permitted for local inference. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Parse a URL, returning null rather than throwing.
 * @param {string} value
 * @returns {URL|null}
 */
function parseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return new URL(value);
  } catch (_e) {
    return null;
  }
}

/**
 * Normalize a user-entered endpoint to an OpenAI-compatible base URL.
 *
 * Users reasonably paste the server root ("http://localhost:1234"), the base
 * with the version ("…/v1"), or the full route ("…/v1/chat/completions").
 * Requiring exactly one of those and silently failing on the others produced a
 * confusing symptom: the request reached the server, which answered 200 with a
 * non-JSON body, so the error surfaced as "unparseable content" rather than as
 * a wrong URL.
 *
 * @param {string} endpoint
 * @returns {string} the base URL a request path can be appended to
 */
export function normalizeEndpoint(endpoint) {
  const url = parseUrl(endpoint);
  if (!url) return endpoint;

  let path = url.pathname.replace(/\/+$/, "");

  // Strip a trailing route the user pasted along with the base.
  path = path.replace(/\/(chat\/completions|completions|responses)$/, "");

  // Add the version segment when it is missing. Only "/v1" is assumed, since
  // that is what OpenAI-compatible servers expose; a non-empty custom path is
  // left as the user wrote it.
  if (path === "") path = "/v1";

  return `${url.origin}${path}`;
}

/**
 * Whether a configured endpoint is acceptable to store at all.
 *
 * Plain http is allowed only for loopback: an http endpoint on a remote host
 * would send handwriting — and an API key — over the network in clear text.
 *
 * @param {string} endpoint
 * @returns {{valid: boolean, reason?: string}}
 */
export function validateEndpoint(endpoint) {
  const url = parseUrl(endpoint);
  if (!url) return { valid: false, reason: "not-a-url" };

  if (url.protocol === "https:") return { valid: true };

  if (url.protocol === "http:") {
    if (LOCAL_HOSTS.has(url.hostname)) return { valid: true };
    return { valid: false, reason: "insecure-remote" };
  }

  return { valid: false, reason: "unsupported-protocol" };
}

/**
 * Whether a request URL belongs to the configured endpoint.
 *
 * Compares origin (protocol + host + port) and requires the request path to sit
 * beneath the endpoint's path. Matching on origin alone would let a path
 * traversal or an attacker-influenced suffix redirect the call elsewhere within
 * the same host; matching on a string prefix alone would let
 * `https://evil.com/?x=https://configured/` pass.
 *
 * @param {string} requestUrl - the URL about to be fetched
 * @param {string} configuredEndpoint - from recognition settings
 * @returns {boolean}
 */
export function isAllowedDestination(requestUrl, configuredEndpoint) {
  const req = parseUrl(requestUrl);
  const cfg = parseUrl(configuredEndpoint);
  if (!req || !cfg) return false;

  if (!validateEndpoint(configuredEndpoint).valid) return false;
  if (req.origin !== cfg.origin) return false;

  // Normalize so "/v1" and "/v1/" behave identically, then require the request
  // path to be the endpoint path or a child of it.
  const base = cfg.pathname.replace(/\/+$/, "");
  if (base === "") return true;

  return req.pathname === base || req.pathname.startsWith(`${base}/`);
}

/**
 * Assert a request destination, throwing if it is not the configured endpoint.
 *
 * Throwing rather than returning false is deliberate: a silent false would be
 * easy to ignore at a call site, and the failure mode this guards against —
 * handwriting and an API key sent to an unintended host — must be loud.
 *
 * @param {string} requestUrl
 * @param {string} configuredEndpoint
 * @throws {Error} when the destination is not permitted
 */
export function assertAllowedDestination(requestUrl, configuredEndpoint) {
  if (!isAllowedDestination(requestUrl, configuredEndpoint)) {
    throw new Error(
      `Refusing to send recognition request to ${requestUrl}: not the configured endpoint.`,
    );
  }
}
