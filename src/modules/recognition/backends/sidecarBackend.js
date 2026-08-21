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
 * See documentation/roadmap/ai-recognition/DESIGN.md §3.4.
 */

import { fetch } from "@tauri-apps/plugin-http";

/** Identifies which engine produced a stored recognition (DESIGN §9). */
export const ENGINE_ID = "sidecar-uwp";

/** Cached recognition base URL (resolved once, reused across calls) */
let cachedRecognitionUrl = null;

/**
 * Resolve the recognition service URL from the local Tauri sidecar.
 * Returns null on every other platform, which is how Android and the Nextcloud
 * app end up with no sidecar backend.
 *
 * @returns {Promise<string|null>} Base URL or null if unavailable
 */
export async function resolveUrl() {
  if (cachedRecognitionUrl !== null) return cachedRecognitionUrl || null;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const sidecarUrl = await invoke("get_recognition_url");
    if (sidecarUrl) {
      cachedRecognitionUrl = sidecarUrl;
      console.log(`[Recognition] Using local sidecar: ${sidecarUrl}`);
      return sidecarUrl;
    }
  } catch (_e) {
    // Not in Tauri environment or command not available
  }

  cachedRecognitionUrl = "";
  console.log("[Recognition] No recognition service available");
  return null;
}

/** Force re-resolution of the recognition URL (e.g. after settings change). */
export function invalidateUrl() {
  cachedRecognitionUrl = null;
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

  const language = opts.language || "en-US";
  const apiUrl = `${baseUrl.replace(/\/$/, "")}/recognize?language=${language}`;

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
