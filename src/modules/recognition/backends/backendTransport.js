/**
 * Transport concerns shared by the vision backends.
 *
 * The OpenAI-compatible and Replicate backends speak different APIs but reach
 * them the same way: pick an HTTP client that is not subject to CORS, and send
 * the rendered page inline as a base64 data URL. Both helpers previously existed
 * twice, near-identically — the kind of duplication that drifts, since a fix to
 * one copy leaves the other quietly broken.
 */

const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

/**
 * Convert a Blob to a base64 data URL suitable for inline image input.
 *
 * Encodes in chunks because `String.fromCharCode.apply` passes the array as
 * arguments, and a full-page PNG has far more bytes than the engine's argument
 * limit accepts in a single call.
 *
 * @param {Blob} blob - PNG image data
 * @returns {Promise<string>} `data:image/png;base64,...`
 */
export async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

/**
 * Resolved HTTP client, or null before the first resolution.
 *
 * Which client to use cannot change during a session — either the Tauri plugin
 * is present or it is not — so the answer is cached. Without it, every request
 * re-entered the dynamic import, and a multi-page Replicate run does two
 * resolutions per page.
 */
let cachedFetch = null;

/**
 * Choose an HTTP client for talking to a recognition endpoint.
 *
 * Tauri's plugin issues requests from the native side, so it is not subject to
 * CORS or mixed-content rules and can reach a local model server or a cloud API
 * directly. Outside Tauri this falls back to the platform fetch; the Nextcloud
 * build cannot call these endpoints from the browser and goes through its own
 * PHP proxy instead (DESIGN §5).
 *
 * @returns {Promise<Function>} a fetch-compatible function
 */
export async function getFetch() {
  if (cachedFetch) return cachedFetch;

  // Nextcloud first, and deliberately not as a fallback.
  //
  // Importing @tauri-apps/plugin-http *succeeds* in the Nextcloud bundle —
  // Vite resolves and bundles the module like any other — so a try/catch around
  // the import proves nothing about the runtime. The failure only surfaces
  // later, when its fetch reaches for window.__TAURI_INTERNALS__ and finds it
  // undefined, by which point the request is already on the wrong path.
  //
  // The build target is known at compile time, so ask that instead of inferring
  // it from an import that cannot fail.
  if (IS_NEXTCLOUD) {
    cachedFetch = proxyFetch;
    return cachedFetch;
  }

  try {
    const mod = await import("@tauri-apps/plugin-http");
    if (mod?.fetch) {
      cachedFetch = mod.fetch;
      return cachedFetch;
    }
  } catch (_e) {
    // Not running under Tauri — fall through to the platform fetch.
  }

  cachedFetch = globalThis.fetch.bind(globalThis);
  return cachedFetch;
}

/**
 * How often to ask whether a dispatched transcription has finished.
 *
 * Each poll is a complete HTTP round trip that returns in milliseconds, so the
 * interval is about not hammering the server rather than about latency: a page
 * takes tens of seconds at best, and two seconds of granularity is invisible
 * against that.
 */
const POLL_INTERVAL_MS = 2000;

/**
 * Turn the proxy's envelope into the minimal Response the backends read.
 *
 * `error` and `status` are alternatives: the server sends the first when it
 * could not reach the endpoint at all, and the second when the endpoint
 * answered — including with a failure of its own, which is the backend's to
 * interpret rather than this transport's.
 *
 * @param {Object} envelope
 * @returns {{ok: boolean, status: number, text: Function, json: Function}}
 */
function envelopeToResponse(envelope) {
  if (envelope?.error) {
    // Raised rather than returned as a failed response: the backends read
    // res.status to decide what to retry, and there is no upstream status here
    // to give them. The message names what the user can change.
    throw new Error(envelope.error);
  }

  const status = envelope?.status ?? 502;
  const bodyText = envelope?.body ?? "";

  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText),
  };
}

/**
 * POST JSON to one of the app's recognition endpoints.
 *
 * @param {string} route - app-relative route, e.g. "/apps/noteberg/api/..."
 * @param {Object} payload
 * @param {AbortSignal} [signal]
 * @returns {Promise<Object>} the decoded reply
 */
async function postJson(route, payload, signal) {
  const url = window.OC?.generateUrl?.(route) || route;

  const res = await globalThis.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "OCS-APIREQUEST": "true",
      requesttoken: window.OC?.requestToken || "",
    },
    credentials: "same-origin",
    signal,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");

    // The app's own refusals, as opposed to an upstream provider's. Given their
    // own messages because the remedy is completely different: nothing about the
    // endpoint, the model or the network is wrong, and a user told to "check the
    // connection" would look everywhere except at the administrator's policy.
    if (detail.includes("quota-exceeded")) {
      throw new Error(
        "Your monthly recognition allowance is used up. It resets at the start of next month, " +
          "or your Nextcloud administrator can raise it.",
      );
    }
    if (detail.includes("model-not-permitted")) {
      throw new Error(
        "This model is not the one your Nextcloud administrator configured for recognition.",
      );
    }

    throw new Error(`Recognition proxy returned ${res.status}: ${detail.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * A fetch-compatible function that tunnels through the Nextcloud app's proxy.
 *
 * Presents the same interface as `fetch` — the backends build a provider
 * specific request and read `res.ok` / `res.status` / `res.text()` from it —
 * so neither the OpenAI-compatible nor the Replicate backend needs to know it
 * is being proxied. The proxy passes bodies through untouched for the same
 * reason: it would otherwise need updating for every provider added.
 *
 * The URL a backend builds is reduced to its *path* before being sent. The
 * server owns the destination — it reads the endpoint from the caller's stored
 * configuration — so the client chooses what to ask for, never whom to ask. The
 * Authorization header is dropped for the same reason: the credential lives on
 * the server and is attached there.
 *
 * Always calls `dispatch`, never `proxy`. The server decides which arrangement
 * it can offer and says so in the reply: `async:true` means the work outlived
 * the request and a token collects it, `async:false` means the result is right
 * there. Deciding on the server keeps the capability check in the one place
 * that can actually perform it — the client cannot know whether php-fpm and a
 * distributed cache are present.
 *
 * @param {string} url - the URL the backend would have called
 * @param {{method?: string, headers?: Object, body?: string, signal?: AbortSignal,
 *          timeoutSeconds?: number}} init
 * @returns {Promise<Response-like>}
 */
async function proxyFetch(url, init = {}) {
  // The absolute path the backend built. The server appends this to the
  // configured endpoint and reconciles any prefix the two share — see
  // RecognitionController::resolveUrl. Doing it there rather than here avoids a
  // config round-trip per request, and the server is the side that actually
  // knows the endpoint.
  let path = "";
  try {
    const parsed = new URL(url, window.location.origin);
    path = parsed.pathname + parsed.search;
  } catch (_e) {
    // A backend that produced no usable URL still has a path-less call to make
    // against the configured endpoint.
  }

  const dispatched = await postJson(
    "/apps/noteberg/api/recognition/dispatch",
    {
      path,
      method: init.method || "POST",
      // The proxy does the waiting, so it needs the caller's budget. A
      // client-side abort cannot lengthen a cap enforced in PHP: without this
      // the server's own default decided every request's fate, and a slow but
      // working model was cut off with no setting able to help it.
      timeoutSeconds: init.timeoutSeconds,
      // The backends serialize their own body; hand the proxy structured JSON
      // so it can re-encode without needing to understand it.
      body: init.body ? JSON.parse(init.body) : null,
    },
    init.signal,
  );

  // The server could not detach the work — no php-fpm, or no distributed cache
  // to hold the result between two requests — so it did the call inline and the
  // answer is already here.
  if (!dispatched?.async) {
    return envelopeToResponse(dispatched);
  }

  const { token } = dispatched;
  if (!token) {
    throw new Error("Recognition proxy accepted the request but returned no token.");
  }

  // Poll until the slot reaches a terminal state.
  //
  // Bounded by the same budget the server was given, plus a margin: the server
  // stops its own upstream call at `timeoutSeconds`, so a client still waiting
  // well past that is looking at a worker that died mid-transcription and a slot
  // that will never be written. Without a bound that becomes an endless poll.
  const budgetMs = Math.max(1, Number(init.timeoutSeconds) || 120) * 1000;
  const deadline = Date.now() + budgetMs + 30_000;

  while (true) {
    if (init.signal?.aborted) {
      // Nothing to cancel server-side: the work is already detached and will
      // finish into a slot nobody collects, which the TTL then reaps. Matching
      // the shape fetch() uses for an abort keeps the backends' handling
      // uniform across transports.
      throw Object.assign(new Error("Recognition cancelled"), { name: "AbortError" });
    }

    if (Date.now() > deadline) {
      throw new Error(
        "The recognition request was accepted but never completed. " +
          "The server may have been restarted mid-transcription.",
      );
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const slot = await postJson("/apps/noteberg/api/recognition/collect", { token }, init.signal);

    if (slot?.state === "pending") continue;

    return envelopeToResponse(slot);
  }
}
