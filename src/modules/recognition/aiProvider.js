/**
 * AI provider configuration — the connection and credential, shared by every
 * AI-backed feature.
 *
 * Split out of recognitionSettings.js because "which AI service do I reach, and
 * with what credential" is not a property of handwriting recognition. It is one
 * account-level fact that any future feature (note summary, tagging) consumes
 * on the same terms. Keeping it inside recognition made the two inseparable:
 * choosing Windows Ink for handwriting also meant having no model access for
 * anything else.
 *
 * What deliberately stays *out* of here is the model. A model identifier is only
 * meaningful for a task — recognition needs a vision model, a summary needs a
 * text model — so each feature owns its own `model` (and, on Replicate, its
 * version) and interprets it against whichever provider is configured here.
 */

import { getSecureCredential, saveSecureCredential } from "../secureStorage.js";
import { getSetting, setSetting } from "../storage.js";

const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

/** Provider identifiers. */
export const PROVIDER_OPENAI = "openai";
export const PROVIDER_REPLICATE = "replicate";

/** Base name for the per-provider credential slots. */
export const API_KEY_CREDENTIAL_PREFIX = "ai_api_key";

/**
 * Secure-storage name for a provider's API key. Never stored via setSetting().
 *
 * Keyed *per provider*. A single shared slot meant switching provider silently
 * carried the previous provider's secret over: selecting OpenAI-compatible after
 * configuring Replicate sent an `r8_...` token to the new endpoint, which
 * answers with an auth error about a credential the user never entered there.
 * The key field is blank whether or not a key is stored, so nothing on screen
 * revealed it.
 *
 * Deleting the old key on switch would also have prevented that, but destroys a
 * working credential on a toggle the user may be doing to compare providers.
 * Separate slots keep both usable, which is the same reasoning that already
 * keeps a per-provider endpoint (see the aiProviderSelect change handler).
 *
 * @param {string} provider
 * @returns {string}
 */
export function apiKeyCredential(provider) {
  return `${API_KEY_CREDENTIAL_PREFIX}:${provider}`;
}

/**
 * Fields the Nextcloud build keeps on the server rather than in the browser.
 *
 * Two different reasons, both specific to the NC build:
 *   - `apiKey` is a secret, and this build has no secure browser storage. The
 *     fallback in secureStorage.js encrypts with a constant compiled into the
 *     shipped bundle, so anything able to read localStorage can recover it.
 *   - `provider` and `endpoint` are *server-relative*: requests are issued by
 *     the Nextcloud server through the proxy, so the URL has to resolve from
 *     there, not from the user's device.
 *
 * This is now exactly the provider surface. Before the split the list also had
 * to carry `model`, which is a per-task preference and had no business being
 * server-side; it moved back to local storage with the feature that owns it.
 */
const SERVER_SIDE_FIELDS = ["provider", "endpoint"];

/** Cached server config, so a recognition run does not refetch per band. */
let _serverConfig = null;

function configUrl() {
  return (
    window.OC?.generateUrl?.("/apps/noteberg/api/recognition/config") ||
    "/apps/noteberg/api/recognition/config"
  );
}

async function fetchServerConfig() {
  if (_serverConfig) return _serverConfig;
  try {
    const res = await fetch(configUrl(), {
      headers: { "OCS-APIREQUEST": "true", requesttoken: window.OC?.requestToken || "" },
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`config read failed: ${res.status}`);
    _serverConfig = await res.json();
  } catch (err) {
    console.warn("[AI] Could not read server-side provider config:", err);
    // Treated as unconfigured rather than fatal — AI features no-op, exactly as
    // they do when nothing has been set up.
    //
    // Deliberately NOT cached. A cached failure has the same lifetime as a
    // cached success, so one transient error — the instance still booting, a
    // dropped connection, a 503 from a reverse proxy — disabled AI recognition
    // for the whole session on a correctly configured instance, explained only
    // by the warning above. Returning without assigning lets the next caller
    // retry; the cost of a genuinely unreachable server is one request per
    // call, and the callers are per recognition run, not per band.
    return {
      provider: "",
      endpoint: "",
      hasApiKey: false,
      allowedEndpoints: [],
      allowReplicate: false,
    };
  }
  return _serverConfig;
}

/**
 * The endpoints this Nextcloud instance's administrator permits.
 *
 * Deny by default: an empty list means none, not "unrestricted". The settings
 * UI renders these as a dropdown rather than a free-text field, so a user
 * cannot enter a destination the server would refuse — the check still runs
 * server-side (EndpointPolicy), but it should never be what a user meets.
 *
 * Empty off Nextcloud, where there is no administrator and the native builds
 * check destinations client-side instead (endpointValidation.js). Callers use
 * IS_NEXTCLOUD to decide which field to render, so the empty array here is
 * never mistaken for "an admin allowed nothing".
 *
 * @returns {Promise<string[]>}
 */
export async function getAllowedEndpoints() {
  if (!IS_NEXTCLOUD) return [];
  const server = await fetchServerConfig();
  // Absent on a server predating the allowlist. Treated as empty — which denies
  // — because the alternative is inferring "unrestricted" from a missing field,
  // and a security control must not fail open on a version mismatch.
  return Array.isArray(server?.allowedEndpoints) ? server.allowedEndpoints : [];
}

/**
 * Whether this Nextcloud instance's administrator permits the Replicate provider.
 *
 * A switch rather than an entry in the endpoint allowlist because Replicate has
 * no user-chosen URL: its host is REPLICATE_BASE, compiled in, and the settings
 * form shows no endpoint field for it. The admin decides whether the provider
 * may be used, not which address it reaches.
 *
 * Always true off Nextcloud, where there is no administrator to ask.
 *
 * @returns {Promise<boolean>}
 */
export async function isReplicateAllowed() {
  if (!IS_NEXTCLOUD) return true;
  const server = await fetchServerConfig();
  // Missing on a server predating the switch. Treated as denied for the same
  // reason as the endpoint list: a security control must not fail open on a
  // version mismatch.
  return !!server?.allowReplicate;
}

/**
 * Whether the Nextcloud server can run recognition without holding the browser
 * connection open for the whole transcription.
 *
 * False means the request is exposed to the web server's own idle timeout,
 * which this app cannot raise — so a slow model fails as an unexplained network
 * error. The settings UI warns rather than letting that be a surprise.
 *
 * Always true off Nextcloud: the native builds call the provider directly and
 * have no proxy to be limited by.
 *
 * @returns {Promise<boolean>}
 */
/**
 * Whether this Nextcloud instance's administrator maintains the AI settings for
 * every user, rather than each user bringing their own account.
 *
 * In central mode the provider, credential, model and task settings all come
 * from the server and the settings UI renders them read-only. The two modes are
 * exclusive: there is no "central where the user has none" fallback, because an
 * administrator could not then tell who is spending the organisation's money
 * without enumerating every user's configuration.
 *
 * Always false off Nextcloud — the native builds have no administrator, so every
 * setting is the user's own. This is what keeps the whole feature inert on
 * Windows and Android.
 *
 * @returns {Promise<boolean>}
 */
export async function isCentrallyManaged() {
  if (!IS_NEXTCLOUD) return false;
  const server = await fetchServerConfig();
  // Absent on a server predating the mode. BYO is the honest reading: an older
  // server has no central settings to apply, so claiming central would render an
  // empty read-only form.
  return server?.mode === "central";
}

/**
 * The administrator's task settings, when central mode is in force.
 *
 * Returned as-is from the server rather than merged here, so the caller decides
 * how to layer them — recognitionSettings.js does that, being the module that
 * owns what a task setting means.
 *
 * @returns {Promise<Object|null>} null when not centrally managed
 */
export async function getCentralSettings() {
  if (!IS_NEXTCLOUD) return null;
  const server = await fetchServerConfig();
  return server?.mode === "central" ? (server.central ?? {}) : null;
}

/**
 * Requests spent and allowed this period, or null when not reported.
 *
 * `limit: 0` means unlimited. Read from the server in both modes: a cap is
 * equally meaningful against a user's own account, and the UI needs the numbers
 * to explain a refusal rather than showing an unexplained failure.
 *
 * @returns {Promise<{used: number, limit: number, period: string}|null>}
 */
export async function getQuota() {
  if (!IS_NEXTCLOUD) return null;
  const server = await fetchServerConfig();
  return server?.quota ?? null;
}

export async function supportsAsyncRecognition() {
  if (!IS_NEXTCLOUD) return true;
  const server = await fetchServerConfig();
  // Absent on a server predating the capability, which is exactly the case the
  // warning is for — treat a missing flag as "cannot".
  return !!server?.asyncRecognition;
}

async function saveServerConfig(patch) {
  const body = {};
  for (const field of SERVER_SIDE_FIELDS) {
    if (patch[field] !== undefined) body[field] = patch[field];
  }
  if (patch.apiKey !== undefined) body.api_key = patch.apiKey;
  if (Object.keys(body).length === 0) return;

  const res = await fetch(configUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
    },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // The server refuses an endpoint outside the administrator's allowlist. The
    // Nextcloud settings field is a dropdown of exactly that list, so this is
    // normally unreachable — it fires when the policy was narrowed while the
    // form was open. Rethrown under a stable name so the UI can say which
    // decision blocked the save instead of showing a bare status code.
    if (res.status === 403) {
      const body = await res.json().catch(() => null);
      if (body?.error === "endpoint-not-permitted") {
        throw Object.assign(new Error("Endpoint not permitted by the administrator."), {
          code: "endpoint-not-permitted",
        });
      }
    }
    throw new Error(`Could not save AI provider settings: ${res.status}`);
  }
  _serverConfig = await res.json();
}

/** Drop the cached server config (after a settings change). */
export function invalidateProviderCache() {
  _serverConfig = null;
}

/**
 * Read the active AI provider configuration.
 *
 * No provider is configured by default: an AI service is contacted only when the
 * user has explicitly set one up (DESIGN §6).
 *
 * @returns {Promise<{
 *   provider: string,
 *   endpoint: string,
 *   apiKey: string,
 *   hasApiKey: boolean,
 * }>}
 */
export async function getProviderConfig() {
  // On Nextcloud the destination and the credential are the server's business;
  // see SERVER_SIDE_FIELDS. `apiKey` deliberately stays empty there — the proxy
  // attaches it, and the browser must never hold it.
  const server = IS_NEXTCLOUD ? await fetchServerConfig() : null;

  const provider = server ? server.provider || "" : (await getSetting("ai_provider")) || "";
  // Resolved against the provider, so the answer is always *this* provider's
  // credential and never the one left behind by a previous selection.
  const apiKey = server || !provider ? "" : (await getApiKey(provider)) || "";

  return {
    provider,
    endpoint: server ? server.endpoint || "" : (await getSetting("ai_endpoint")) || "",
    apiKey,
    // Whether a credential exists, without disclosing it. isProviderConfigured
    // needs to know a key is present; nothing on the client needs its value.
    hasApiKey: server ? !!server.hasApiKey : !!apiKey,
  };
}

/**
 * Persist provider configuration. Accepts a partial patch.
 * The API key is routed to secure storage, never to the plain settings store.
 *
 * @param {{provider?: string, endpoint?: string, apiKey?: string}} patch
 */
export async function setProviderConfig(patch) {
  const map = { provider: "ai_provider", endpoint: "ai_endpoint" };

  for (const [field, key] of Object.entries(map)) {
    if (patch[field] === undefined) continue;
    // Server-side fields never touch local storage on NC, or the two copies
    // would drift and the local one would silently win on read.
    if (IS_NEXTCLOUD && SERVER_SIDE_FIELDS.includes(field)) continue;
    await setSetting(key, patch[field]);
  }

  if (IS_NEXTCLOUD) {
    // Replicate has a fixed host and hides the endpoint field, so the user never
    // supplies one — but the server-side proxy resolves every request against a
    // stored endpoint. Fill it in so the two agree.
    const patched = { ...patch };
    if (patch.provider === PROVIDER_REPLICATE && patch.endpoint === undefined) {
      const { REPLICATE_BASE } = await import("./backends/replicateBackend.js");
      patched.endpoint = REPLICATE_BASE;
    }
    await saveServerConfig(patched);
    return;
  }

  if (patch.apiKey !== undefined) {
    // Against the provider the patch is establishing, not the stored one: a
    // save that switches provider and sets a key in the same step must file the
    // key under the provider it was typed for.
    const provider = patch.provider ?? (await getSetting("ai_provider")) ?? "";
    if (provider) await saveSecureCredential(apiKeyCredential(provider), patch.apiKey);
  }
}

/**
 * Read a provider's stored API key, or "" when none is set.
 *
 * @param {string} provider - which provider's credential to read
 * @returns {Promise<string>}
 */
export async function getApiKey(provider) {
  if (!provider) return "";
  try {
    return (await getSecureCredential(apiKeyCredential(provider))) || "";
  } catch (_e) {
    // Secure storage unavailable (e.g. locked, or not supported on platform)
    return "";
  }
}

/**
 * Whether a provider has enough configuration to be reached.
 *
 * Requirements differ by provider — Replicate has a fixed host and authenticates
 * with a token, so it needs no endpoint URL but cannot run without the token.
 * An OpenAI-compatible endpoint may be a local server needing no credential.
 *
 * Note this says nothing about whether a *feature* can run: a feature also needs
 * its own model. See isRecognitionReady() for that half.
 *
 * @param {Object} config - from getProviderConfig()
 * @returns {boolean}
 */
export function isProviderConfigured(config) {
  if (!config) return false;
  if (config.provider === PROVIDER_OPENAI) return !!config.endpoint;
  if (config.provider === PROVIDER_REPLICATE) {
    // hasApiKey rather than apiKey: on Nextcloud the key is held by the server
    // and never sent to the browser, so its value is not available to check.
    return !!config.apiKey || !!config.hasApiKey;
  }
  return false;
}

/** Whether a provider id is one this app knows how to talk to. */
export function isKnownProvider(provider) {
  return provider === PROVIDER_OPENAI || provider === PROVIDER_REPLICATE;
}
