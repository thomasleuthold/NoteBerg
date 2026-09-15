/**
 * Provider reachability check.
 *
 * Answers one question — can this device reach the configured AI service with
 * the configured credential — and deliberately nothing more. It does not run
 * inference, so it costs no tokens and cannot be billed, which is what lets it
 * be the button a user presses freely while setting things up.
 *
 * Scoped to the provider rather than to a feature: the endpoint and credential
 * are shared by every AI-backed feature, so "is the connection good" is the
 * same question whichever one asked. Whether a *model* can actually read
 * handwriting is a different question that only a real recognition run answers,
 * and that stays with the recognition section (see testAiRecognitionBackend).
 *
 * Both providers expose a metadata endpoint for this:
 *   OpenAI-compatible:  GET {endpoint}/models
 *   Replicate:          GET /v1/models   (account-scoped listing)
 */

import { getFetch } from "./backends/backendTransport.js";
import { REPLICATE_BASE } from "./backends/replicateBackend.js";
import { assertAllowedDestination, LOCAL_HOSTS, normalizeEndpoint } from "./endpointValidation.js";

/** Outcomes, so callers pick their own wording. */
export const CHECK_OK = "ok";
export const CHECK_OK_NO_LISTING = "okNoListing";
export const CHECK_UNAUTHORIZED = "unauthorized";
export const CHECK_UNREACHABLE = "unreachable";
export const CHECK_FAILED = "failed";
export const CHECK_NOT_CONFIGURED = "notConfigured";
/** Reachable, but a remote endpoint was configured without a credential. */
export const CHECK_KEY_REQUIRED = "keyRequired";

/** How long to wait before calling a silent endpoint unreachable. */
const TIMEOUT_MS = 15000;

/**
 * Interpret an HTTP status from a metadata request.
 *
 * 404 is deliberately *not* a failure. `/models` is near-universal among
 * OpenAI-compatible servers but not guaranteed — a server that routes
 * completions fine may simply not implement the listing. Reporting that as a
 * broken connection would send the user chasing a working configuration.
 *
 * @param {number} status
 * @returns {string} one of the CHECK_* outcomes
 */
function outcomeForStatus(status) {
  if (status === 401 || status === 403) return CHECK_UNAUTHORIZED;
  if (status === 404 || status === 405) return CHECK_OK_NO_LISTING;
  if (status >= 200 && status < 300) return CHECK_OK;
  return CHECK_FAILED;
}

/**
 * Whether an endpoint is a local model server.
 *
 * Local servers commonly need no credential, so they are the one case where a
 * keyless configuration is genuinely complete. Uses the same loopback set
 * endpointValidation.js exempts from the https requirement, for the same
 * reason: nothing leaves the device.
 *
 * @param {string} endpoint
 * @returns {boolean}
 */
function isLocalEndpoint(endpoint) {
  try {
    const { hostname } = new URL(endpoint);
    return LOCAL_HOSTS.has(hostname);
  } catch (_e) {
    return false;
  }
}

/**
 * Count the models a listing reported, when it is shaped in a way we recognise.
 *
 * Purely informational — the check passes either way. OpenAI-compatible servers
 * return {data: [...]}, Replicate returns {results: [...]}.
 *
 * @param {unknown} body
 * @returns {number|null}
 */
function countModels(body) {
  const list = body?.data ?? body?.results;
  return Array.isArray(list) ? list.length : null;
}

/**
 * Check that the configured provider answers.
 *
 * @param {Object} config - from getProviderConfig(); may carry a freshly typed
 *   apiKey that has not been saved yet, so the user can test before committing.
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{outcome: string, status?: number, modelCount?: number|null,
 *   message?: string}>}
 */
export async function checkProvider(config, opts = {}) {
  if (!config?.provider) return { outcome: CHECK_NOT_CONFIGURED };

  const httpFetch = await getFetch();

  let url;
  let base;
  if (config.provider === "replicate") {
    // Fixed host; the account-scoped listing is the cheapest authenticated call
    // Replicate offers, so it doubles as a token check.
    base = REPLICATE_BASE;
    url = `${REPLICATE_BASE}/models`;
    if (!config.apiKey && !config.hasApiKey) return { outcome: CHECK_NOT_CONFIGURED };
  } else {
    if (!config.endpoint) return { outcome: CHECK_NOT_CONFIGURED };
    base = normalizeEndpoint(config.endpoint);
    url = `${base}/models`;

    // A remote endpoint with no credential cannot be reported as working, even
    // when the listing answers. OpenRouter serves /models unauthenticated, so
    // this check returned "connected, 396 models" for a configuration whose
    // every actual request 401s — a green light that sent the user looking
    // anywhere but at the credential.
    //
    // Local servers are exempt: they legitimately need no key, and demanding one
    // would break the LM Studio and Ollama setups this check exists to confirm.
    if (!isLocalEndpoint(base) && !config.apiKey && !config.hasApiKey) {
      return { outcome: CHECK_KEY_REQUIRED };
    }
  }

  // The Tauri allowlist permits any https host, so the destination is confirmed
  // against the configured endpoint here rather than assumed from the URL we
  // just built — the same guard the real request paths use.
  assertAllowedDestination(url, base);

  // A local model server that is starting up can accept the socket and then say
  // nothing; without a deadline the button would spin indefinitely.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const signal = opts.signal ?? timeout.signal;

  try {
    const res = await httpFetch(url, {
      method: "GET",
      // Only where the client holds the credential. On Nextcloud the proxy
      // attaches it and the browser never sees it, so an empty header would be
      // dead weight that reads like a bug in the logs.
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      signal,
    });

    const outcome = outcomeForStatus(res.status);
    if (outcome !== CHECK_OK) return { outcome, status: res.status };

    let modelCount = null;
    try {
      modelCount = countModels(await res.json());
    } catch (_e) {
      // A 200 that is not JSON still proves the endpoint answered; the count is
      // a nicety, not the result.
    }
    return { outcome: CHECK_OK, status: res.status, modelCount };
  } catch (err) {
    // DNS failure, refused connection, TLS error, timeout — from the user's
    // point of view these are one thing: nothing answered at that address.
    return { outcome: CHECK_UNREACHABLE, message: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}
