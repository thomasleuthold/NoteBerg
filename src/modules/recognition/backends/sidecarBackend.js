/**
 * Windows sidecar recognition backend.
 *
 * Wraps the local recognition service that Tauri auto-starts on Windows. The
 * service runs UWP's InkAnalyzer, which consumes strokes directly and returns
 * true per-word bounding boxes — so this backend implements `recognizeStrokes`
 * rather than the image-based `transcribePage` the AI backends use.
 *
 * It deliberately does NOT go through rasterization: pushing exact stroke data
 * through a line-image pipeline would discard a working, more accurate, offline
 * and free path for the sake of interface symmetry.
 *
 * See documentation/ai_integration_design.md §2.
 */

import { fetch } from "@tauri-apps/plugin-http";

/** Identifies which engine produced a stored recognition (DESIGN §9). */
export const ENGINE_ID = "sidecar-uwp";

/**
 * The in-flight or completed resolution, or null before the first call.
 *
 * A *promise* rather than the resolved URL, so that concurrent callers share one
 * resolution instead of racing it. Caching only the result left a window between
 * the first caller entering the lookup and it assigning the cache, and a second
 * caller arriving inside that window ran the lookup a second time. Both then
 * wrote, and the loser's write was the one that stuck.
 *
 * That was not merely wasted work. `invoke` resolves once per call, so the
 * second lookup could fall through to the failure path and cache the empty
 * string — latching "no recognition service available" for the rest of the
 * session even though the sidecar was running and the first lookup had found
 * it. Recognizing two notes at once, which the queue and the catch-up scan both
 * do, was enough to trigger it.
 *
 * Resolves to the base URL, or to "" for "looked, found nothing" — a distinct
 * state from null, which means "not looked yet".
 *
 * @type {Promise<string>|null}
 */
let recognitionUrlPromise = null;

/**
 * Resolve the recognition service URL from the local Tauri sidecar.
 * Returns null on every other platform, which is how Android and the Nextcloud
 * app end up with no sidecar backend.
 *
 * @returns {Promise<string|null>} Base URL or null if unavailable
 */
export async function resolveUrl() {
  // Assigned before the first await inside lookUpUrl, so a second caller in the
  // same tick sees the promise rather than starting its own lookup.
  if (!recognitionUrlPromise) recognitionUrlPromise = lookUpUrl();
  return (await recognitionUrlPromise) || null;
}

/**
 * Ask the Tauri sidecar where the recognition service is listening.
 *
 * Separated from resolveUrl so the caching there is a single assignment with no
 * await before it — which is what makes the race impossible rather than merely
 * unlikely.
 *
 * @returns {Promise<string>} the base URL, or "" when unavailable
 */
async function lookUpUrl() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const sidecarUrl = await invoke("get_recognition_url");
    if (sidecarUrl) {
      console.log(`[Recognition] Using local sidecar: ${sidecarUrl}`);
      return sidecarUrl;
    }
  } catch (_e) {
    // Not in Tauri environment or command not available
  }

  console.log("[Recognition] No recognition service available");
  return "";
}

/** Force re-resolution of the recognition URL (e.g. after settings change). */
export function invalidateUrl() {
  recognitionUrlPromise = null;
}

/** Whether this backend can run right now. */
export async function isAvailable() {
  return (await resolveUrl()) !== null;
}

/**
 * Recognize strokes via the sidecar.
 *
 * Strokes are sent in temporal order — the service performs spatial analysis
 * internally to group them into words and lines. Sorting them spatially here
 * breaks stroke-to-character association and produces garbled output.
 *
 * @param {Array} strokes - active strokes (caller filters deleted ones)
 * @param {{ language?: string }} [opts]
 * @returns {Promise<Array<{text: string, boundingRect?: Object}>|null>}
 *   Raw word list from the service, or null when unavailable/failed.
 */
export async function recognizeStrokes(strokes, opts = {}) {
  const baseUrl = await resolveUrl();
  if (!baseUrl) return null;

  // The service ignores this: the Windows InkAnalyzer uses the system default
  // recognizer and exposes no language API (see the note above). It is still
  // sent so the request is self-describing, and so a future service that does
  // honour it needs no client change. "auto" — the default since the language
  // became a real instruction for the AI path — is simply another value the
  // service disregards.
  const language = opts.language || "auto";
  // Encoded: the language is a stored setting rather than a constant, and an
  // unescaped value would let it append query parameters of its own.
  const apiUrl = `${baseUrl.replace(/\/$/, "")}/recognize?language=${encodeURIComponent(language)}`;

  // Expected format: { id: "uuid", points: [{x, y, pressure}] }
  const formattedStrokes = strokes.map((s) => ({
    id: s.id,
    points: s.x.map((x, i) => ({
      x,
      y: s.y[i],
      pressure: s.pressure?.[i] || 0.5,
    })),
  }));

  console.log(
    `[Recognition] Sending ${formattedStrokes.length} of ${strokes.length} total strokes to recognition service.`,
  );

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formattedStrokes),
      connectTimeout: 15000, // 15 seconds
    });

    if (!response.ok) {
      const errorBody = await response.text(); // Try to get more details from the body
      throw new Error(
        `Service returned ${response.status} ${response.statusText}. Body: ${errorBody}`,
      );
    }
    return await response.json();
  } catch (err) {
    console.error("[Recognition] Service call failed.", err);
    return null;
  }
}
