/**
 * Model catalog — what can this provider actually run.
 *
 * The reachability check (providerCheck.js) already asks each provider for its
 * model listing and throws the body away after counting it. That listing is the
 * only authoritative answer to "what may I type in the Model field", and until
 * now the user had to find it on a website and copy a slug by hand — a slug
 * whose exact form differs per provider and which fails silently when mistyped.
 *
 * So this module keeps the request and normalizes the answer instead.
 *
 * Deliberately separate from providerCheck: the check must stay a cheap, fixed,
 * single request that a user presses freely. Browsing is a different bargain —
 * it may page, it may be slow, and it may legitimately fail on a server that
 * simply has no listing. Folding the two together would make the check as
 * fragile as the catalog.
 *
 * The three listings this has to reconcile:
 *
 *   OpenRouter          GET {endpoint}/models  → {data: [{id, name, description,
 *                       architecture: {input_modalities, output_modalities}, ...}]}
 *   Plain OpenAI-compat GET {endpoint}/models  → {data: [{id}]}   (nothing else)
 *   Replicate           GET /v1/models         → {results: [{owner, name,
 *                       description, latest_version: {id}}], next}
 *
 * The second is why every descriptive field below is optional. LM Studio and
 * Ollama report an id and nothing more; a UI that assumed OpenRouter's shape
 * would show a table of blanks for the local servers this app was built around.
 *
 * Replicate additionally answers a fourth request:
 *
 *   Replicate search   GET /v1/search?query=…  → {models: [{model, metadata}],
 *                      collections, pages, query}
 *
 * It exists because Replicate's listing is the one that cannot be held in full.
 * The other two arrive complete, so filtering them in the browser answers for
 * the whole catalog; filtering Replicate's sample answers only for the sample,
 * and would tell a user their model does not exist when it does.
 */

import { PROVIDER_REPLICATE } from "./aiProvider.js";
import { getFetch } from "./backends/backendTransport.js";
import { REPLICATE_BASE } from "./backends/replicateBackend.js";
import { assertAllowedDestination, normalizeEndpoint } from "./endpointValidation.js";

/** Outcomes. Distinct from the CHECK_* set: browsing can fail where a check passes. */
export const CATALOG_OK = "ok";
export const CATALOG_UNSUPPORTED = "unsupported";
export const CATALOG_UNAUTHORIZED = "unauthorized";
export const CATALOG_UNREACHABLE = "unreachable";
export const CATALOG_FAILED = "failed";
export const CATALOG_NOT_CONFIGURED = "notConfigured";

/** Longer than the reachability check's: a full listing is a bigger response. */
const TIMEOUT_MS = 30000;

/**
 * How many Replicate pages to walk for the unsearched listing.
 *
 * Replicate lists every public model — tens of thousands — a page at a time.
 * Walking the whole listing to populate a picker would be hundreds of requests
 * for a list nobody scrolls to the end of.
 *
 * So the browse listing is explicitly a *sample*, and says so: `truncated`
 * travels with the result and the dialog reports the listing as partial. What
 * makes that acceptable rather than misleading is searchReplicateModels() —
 * a query reaches the whole catalog, so the sample is only ever the starting
 * view, never the limit of what can be found.
 */
const REPLICATE_MAX_PAGES = 8;

/**
 * Largest page the search endpoint will return (its own documented maximum).
 *
 * Asked for in full rather than tuned down: a search is one request against the
 * entire catalog, and a user who typed a query wants the matches, not a sample
 * of them.
 */
const REPLICATE_SEARCH_LIMIT = 50;

/**
 * Modality → the coarse type shown in the picker and used by its filter.
 *
 * Deliberately coarse. OpenRouter distinguishes a dozen modality strings, most
 * differing in ways that do not change whether a model can read a page of
 * handwriting. What the user is choosing between is "reads images" and "does
 * not", so the type collapses to the input→output pair.
 */
export const TYPE_TEXT_TEXT = "text->text";
export const TYPE_IMAGE_TEXT = "image->text";
export const TYPE_TEXT_IMAGE = "text->image";
export const TYPE_OTHER = "other";
export const TYPE_UNKNOWN = "unknown";

/** Capability tags. `vision` is the one recognition actually requires. */
export const CAP_VISION = "vision";
export const CAP_AUDIO = "audio";
export const CAP_VIDEO = "video";
export const CAP_FILES = "files";
export const CAP_TOOLS = "tools";
export const CAP_REASONING = "reasoning";

/**
 * Classify a model from its input and output modalities.
 *
 * @param {string[]} inputs
 * @param {string[]} outputs
 * @returns {string} one of the TYPE_* constants
 */
function classify(inputs, outputs) {
  if (!inputs.length && !outputs.length) return TYPE_UNKNOWN;

  const readsImages = inputs.includes("image");
  const writesText = outputs.includes("text");
  const writesImages = outputs.includes("image");

  // Image→text first: a model that both reads and writes images is still the
  // one recognition wants, and reporting it as an image *generator* would hide
  // it behind the filter the user is most likely to apply.
  if (readsImages && writesText) return TYPE_IMAGE_TEXT;
  if (writesImages) return TYPE_TEXT_IMAGE;
  if (writesText) return TYPE_TEXT_TEXT;
  return TYPE_OTHER;
}

/**
 * Read an OpenRouter-style entry into capability tags.
 *
 * Absent fields yield no tags rather than false ones: a plain OpenAI-compatible
 * server describes nothing here, and claiming "no vision" for a model the server
 * never described would steer the user away from one that works.
 *
 * @param {Object} model - one entry from the listing
 * @returns {string[]}
 */
function capabilitiesOf(model) {
  const caps = [];
  const inputs = model?.architecture?.input_modalities ?? [];
  const params = model?.supported_parameters ?? [];

  if (Array.isArray(inputs)) {
    if (inputs.includes("image")) caps.push(CAP_VISION);
    if (inputs.includes("audio")) caps.push(CAP_AUDIO);
    if (inputs.includes("video")) caps.push(CAP_VIDEO);
    if (inputs.includes("file")) caps.push(CAP_FILES);
  }
  if (Array.isArray(params)) {
    if (params.includes("tools")) caps.push(CAP_TOOLS);
    if (params.includes("reasoning")) caps.push(CAP_REASONING);
  }
  return caps;
}

/**
 * Normalize one OpenAI-compatible listing entry.
 *
 * Everything past `id` is optional, because on a local server everything past
 * `id` is absent.
 *
 * @param {Object} model
 * @returns {Object|null} a catalog entry, or null if it carries no usable id
 */
function fromOpenAiEntry(model) {
  const id = typeof model?.id === "string" ? model.id : "";
  if (!id) return null;

  const inputs = model?.architecture?.input_modalities ?? [];
  const outputs = model?.architecture?.output_modalities ?? [];

  return {
    id,
    // OpenRouter sends a display name ("Qwen: Qwen3-VL 8B"); a local server does
    // not, and there the id is the only name there is.
    name: typeof model.name === "string" && model.name ? model.name : id,
    description: typeof model.description === "string" ? model.description : "",
    type: classify(Array.isArray(inputs) ? inputs : [], Array.isArray(outputs) ? outputs : []),
    capabilities: capabilitiesOf(model),
    contextLength: Number(model.context_length) || null,
    // Replicate-only, but present on every entry so the picker has one shape.
    version: "",
  };
}

/**
 * Normalize one Replicate listing entry.
 *
 * Replicate describes no modalities at all, so the type is left unknown rather
 * than guessed from the description text. A blurb mentioning "vision" may belong
 * to a text model with a vision-related name, and a wrong capability badge is
 * worse than a missing one — the user acts on it.
 *
 * @param {Object} model
 * @returns {Object|null}
 */
function fromReplicateEntry(model) {
  const owner = typeof model?.owner === "string" ? model.owner : "";
  const name = typeof model?.name === "string" ? model.name : "";
  if (!owner || !name) return null;

  return {
    id: `${owner}/${name}`,
    name: `${owner}/${name}`,
    description: typeof model.description === "string" ? model.description : "",
    type: TYPE_UNKNOWN,
    capabilities: [],
    contextLength: null,
    // The version hash the Model version row also needs. Carrying it here is why
    // picking a Replicate model can fill in both fields at once, rather than
    // sending the user to the website for the half the picker already knew.
    version: typeof model?.latest_version?.id === "string" ? model.latest_version.id : "",
  };
}

/**
 * Interpret an HTTP status from a listing request.
 *
 * 404/405 is "this server has no listing", not "this server is broken" — the
 * same reading providerCheck takes, for the same reason. Here it gets its own
 * outcome so the dialog can say plainly that browsing is unavailable and the
 * model has to be typed.
 *
 * @param {number} status
 * @returns {string}
 */
function outcomeForStatus(status) {
  if (status === 401 || status === 403) return CATALOG_UNAUTHORIZED;
  if (status === 404 || status === 405 || status === 501) return CATALOG_UNSUPPORTED;
  if (status >= 200 && status < 300) return CATALOG_OK;
  return CATALOG_FAILED;
}

/**
 * Authorization header, only where this side holds the credential.
 *
 * On Nextcloud the proxy attaches it and the browser never sees the key, so an
 * empty header would be dead weight that reads like a bug in the logs — the same
 * reasoning as the backends' authHeader().
 *
 * @param {Object} config
 * @returns {Object}
 */
function authHeaders(config) {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

/**
 * Fetch and normalize the models a Replicate account can run.
 *
 * @param {Object} config
 * @param {Function} httpFetch
 * @param {AbortSignal} signal
 * @returns {Promise<Object>}
 */
async function listReplicateModels(config, httpFetch, signal) {
  const models = [];
  let url = `${REPLICATE_BASE}/models`;
  let truncated = false;

  for (let page = 0; page < REPLICATE_MAX_PAGES; page++) {
    // Re-checked every iteration, not just for the first URL: `next` is chosen
    // by the server, and this is the guard that stops a redirected cursor from
    // carrying the credential somewhere else.
    assertAllowedDestination(url, REPLICATE_BASE);

    const res = await httpFetch(url, { method: "GET", headers: authHeaders(config), signal });
    const outcome = outcomeForStatus(res.status);
    if (outcome !== CATALOG_OK) return { outcome, status: res.status };

    const body = await res.json();
    for (const entry of body?.results ?? []) {
      const model = fromReplicateEntry(entry);
      if (model) models.push(model);
    }

    if (typeof body?.next !== "string" || !body.next) break;
    url = body.next;
    // Budget exhausted with pages still to go — the caller has to say so.
    if (page === REPLICATE_MAX_PAGES - 1) truncated = true;
  }

  return { outcome: CATALOG_OK, models, truncated };
}

/**
 * Search Replicate's whole public catalog for a query.
 *
 * The reason this exists: the browse listing above is a bounded sample, and
 * filtering it client-side filters only the sample. A user whose model was not
 * in the first few hundred could type its exact name and be told there are no
 * matches — the catalog's own answer being the opposite. Searching server-side
 * is the only way the picker can answer for the whole catalog.
 *
 * `GET /v1/search` is used rather than the older `QUERY /v1/models`: a plain GET
 * with a query parameter is issuable by a normal fetch *and* passes the
 * Nextcloud proxy, which forwards GET and POST only. The QUERY verb is why this
 * was previously not attempted.
 *
 * The endpoint also returns matching collections and documentation pages. Both
 * are dropped: the picker fills in a model field, and a docs page is not
 * something that can be picked.
 *
 * @param {Object} config
 * @param {string} query
 * @param {Function} httpFetch
 * @param {AbortSignal} signal
 * @returns {Promise<Object>}
 */
async function searchReplicateModels(config, query, httpFetch, signal) {
  const url =
    `${REPLICATE_BASE}/search` +
    `?query=${encodeURIComponent(query)}&limit=${REPLICATE_SEARCH_LIMIT}`;
  assertAllowedDestination(url, REPLICATE_BASE);

  const res = await httpFetch(url, { method: "GET", headers: authHeaders(config), signal });
  const outcome = outcomeForStatus(res.status);
  if (outcome !== CATALOG_OK) return { outcome, status: res.status };

  let body;
  try {
    body = await res.json();
  } catch (_e) {
    return { outcome: CATALOG_UNSUPPORTED, status: res.status };
  }

  const models = [];
  for (const entry of body?.models ?? []) {
    // Each hit wraps the model beside its relevance metadata. The nested object
    // is the same shape the listing endpoint returns, latest_version included,
    // so the one normalizer serves both paths — and a searched pick still
    // carries the version hash that stops a community model failing at run time.
    const model = fromReplicateEntry(entry?.model);
    if (model) models.push(model);
  }

  // Capped by the endpoint, not by a budget of ours, so `truncated` says the
  // same thing it says for the browse listing: there may be more than this.
  return { outcome: CATALOG_OK, models, truncated: models.length >= REPLICATE_SEARCH_LIMIT };
}

/**
 * Fetch and normalize an OpenAI-compatible model listing.
 *
 * One request, no pagination: the de-facto spec defines none, and neither
 * OpenRouter nor any local server paginates this endpoint.
 *
 * @param {Object} config
 * @param {Function} httpFetch
 * @param {AbortSignal} signal
 * @returns {Promise<Object>}
 */
async function listOpenAiModels(config, httpFetch, signal) {
  const base = normalizeEndpoint(config.endpoint);
  const url = `${base}/models`;
  assertAllowedDestination(url, base);

  const res = await httpFetch(url, { method: "GET", headers: authHeaders(config), signal });
  const outcome = outcomeForStatus(res.status);
  if (outcome !== CATALOG_OK) return { outcome, status: res.status };

  let body;
  try {
    body = await res.json();
  } catch (_e) {
    // Answered, but not with a listing. From the user's side that is the same
    // situation as a server with no /models at all.
    return { outcome: CATALOG_UNSUPPORTED, status: res.status };
  }

  const list = body?.data ?? body?.models;
  if (!Array.isArray(list)) return { outcome: CATALOG_UNSUPPORTED, status: res.status };

  const models = [];
  for (const entry of list) {
    const model = fromOpenAiEntry(entry);
    if (model) models.push(model);
  }
  return { outcome: CATALOG_OK, models, truncated: false };
}

/**
 * List the models the configured provider offers.
 *
 * @param {Object} config - from getRecognitionConfig() or getProviderConfig();
 *   may carry a freshly typed apiKey that has not been saved yet, so the user
 *   can browse before committing — the same allowance the test button makes.
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{outcome: string, models?: Object[], truncated?: boolean,
 *   status?: number, message?: string}>}
 */
export async function listModels(config, opts = {}) {
  if (!config?.provider) return { outcome: CATALOG_NOT_CONFIGURED };
  if (config.provider === PROVIDER_REPLICATE) {
    if (!config.apiKey && !config.hasApiKey) return { outcome: CATALOG_NOT_CONFIGURED };
  } else if (!config.endpoint) {
    return { outcome: CATALOG_NOT_CONFIGURED };
  }

  const httpFetch = await getFetch();

  // A server that accepts the socket and then says nothing would otherwise leave
  // the dialog spinning with no way out but closing it.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const signal = opts.signal ?? timeout.signal;

  try {
    return config.provider === PROVIDER_REPLICATE
      ? await listReplicateModels(config, httpFetch, signal)
      : await listOpenAiModels(config, httpFetch, signal);
  } catch (err) {
    // DNS failure, refused connection, TLS error, timeout, or a rejected
    // destination — one thing from the user's point of view: no listing arrived.
    return { outcome: CATALOG_UNREACHABLE, message: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether this provider answers a query server-side.
 *
 * The picker asks before deciding what typing into the search box means: for a
 * provider that says no, the local filter over the loaded list is complete and
 * correct, and a round trip would be a slower way to get the same answer.
 *
 * @param {Object} config
 * @returns {boolean}
 */
export function supportsServerSearch(config) {
  return config?.provider === PROVIDER_REPLICATE;
}

/**
 * Search the provider's catalog server-side.
 *
 * Only meaningful where supportsServerSearch() is true; anywhere else the
 * caller should filter the listing it already has.
 *
 * Failure is reported rather than thrown so the picker can fall back to
 * filtering the loaded sample. A search that cannot be reached should narrow
 * the list the user can already see, not replace it with an error — the beta
 * endpoint going away must not take the picker with it.
 *
 * @param {Object} config
 * @param {string} query
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{outcome: string, models?: Object[], truncated?: boolean,
 *   status?: number, message?: string}>}
 */
export async function searchModels(config, query, opts = {}) {
  if (!supportsServerSearch(config)) return { outcome: CATALOG_UNSUPPORTED };
  if (!config.apiKey && !config.hasApiKey) return { outcome: CATALOG_NOT_CONFIGURED };

  const trimmed = (query || "").trim();
  if (!trimmed) return { outcome: CATALOG_OK, models: [], truncated: false };

  const httpFetch = await getFetch();

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const signal = opts.signal ?? timeout.signal;

  try {
    return await searchReplicateModels(config, trimmed, httpFetch, signal);
  } catch (err) {
    return { outcome: CATALOG_UNREACHABLE, message: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Filter a catalog by free text and type.
 *
 * Matches id, name and description together, so "qwen" finds both a model whose
 * id is `lucataco/qwen3-vl-8b-instruct` and one whose display name is
 * "Qwen: Qwen3-VL 8B". Terms are ANDed, so "qwen vl" narrows rather than widens —
 * with several hundred models an OR would return most of them.
 *
 * @param {Object[]} models
 * @param {{query?: string, type?: string, visionOnly?: boolean}} filters
 * @returns {Object[]}
 */
export function filterModels(models, filters = {}) {
  const terms = (filters.query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const type = filters.type || "";

  return (models ?? []).filter((model) => {
    if (type && model.type !== type) return false;
    if (filters.visionOnly && !model.capabilities?.includes(CAP_VISION)) return false;
    if (!terms.length) return true;

    const haystack = `${model.id} ${model.name} ${model.description}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/**
 * The types actually present in a catalog, in a stable display order.
 *
 * Built from the data rather than hardcoded so the filter never offers a type
 * that would return nothing: on a local server the only entry is "unknown", and
 * a dropdown listing four empty categories reads as a broken filter.
 *
 * @param {Object[]} models
 * @returns {string[]}
 */
export function availableTypes(models) {
  const order = [TYPE_IMAGE_TEXT, TYPE_TEXT_TEXT, TYPE_TEXT_IMAGE, TYPE_OTHER, TYPE_UNKNOWN];
  const present = new Set((models ?? []).map((model) => model.type));
  return order.filter((type) => present.has(type));
}
