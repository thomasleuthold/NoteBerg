/**
 * Transport concerns shared by the vision backends.
 *
 * The OpenAI-compatible and Replicate backends speak different APIs but reach
 * them the same way: pick an HTTP client that is not subject to CORS, and send
 * the rendered page inline as a base64 data URL. Both helpers previously existed
 * twice, near-identically — the kind of duplication that drifts, since a fix to
 * one copy leaves the other quietly broken.
 */

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
