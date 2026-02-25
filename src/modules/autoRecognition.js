/**
 * Auto Recognition Module
 * Handles background handwriting recognition scheduling.
 *
 * On Windows, a local sidecar recognition service is auto-started by Tauri.
 * On other platforms, a user-configured fallback URL is used.
 */

import { fetch } from "@tauri-apps/plugin-http";
import { getAllNotes, getNote, getSetting, setSetting, updateNote } from "./storage.js";

// Configuration
const RECOGNITION_DEBOUNCE_MS = 2500; // 2.5 seconds inactivity

let recognitionTimer = null;

/** Cached recognition base URL (resolved once, reused across calls) */
let cachedRecognitionUrl = null;

/**
 * Resolve the recognition service URL.
 * Prefers local sidecar (via Tauri command), falls back to user-configured URL.
 * @returns {Promise<string|null>} Base URL or null if unavailable
 */
async function resolveRecognitionUrl() {
  if (cachedRecognitionUrl !== null) return cachedRecognitionUrl || null;

  // 1. Try local sidecar (set by Rust on Windows)
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

  // 2. Fall back to user-configured URL
  // Migrate old setting key if present
  const legacyUrl = await getSetting("recognition_url");
  if (legacyUrl) {
    await setSetting("recognition_fallback_url", legacyUrl);
    await setSetting("recognition_url", null);
  }

  const fallbackUrl = (await getSetting("recognition_fallback_url")) || "";
  cachedRecognitionUrl = fallbackUrl;

  if (fallbackUrl) {
    console.log(`[Recognition] Using fallback URL: ${fallbackUrl}`);
    return fallbackUrl;
  }

  console.log("[Recognition] No recognition service available");
  return null;
}

/**
 * Force re-resolution of the recognition URL (e.g. after settings change).
 */
export function invalidateRecognitionUrl() {
  cachedRecognitionUrl = null;
}

/**
 * Find all notes with strokes but no recognition and process them sequentially.
 * Called once per app start on Windows (after startup sync completes).
 * Is a no-op when the recognition service is unavailable (mobile / no sidecar).
 * @returns {Promise<number>} Number of notes successfully recognized.
 */
export async function recognizeUnprocessedNotes() {
  const baseUrl = await resolveRecognitionUrl();
  if (!baseUrl) return 0;

  const allIndexes = await getAllNotes(); // index entries only — no content loaded
  const candidates = allIndexes.filter((n) => n.hasStrokes && !n.hasRecognition && !n.deleted);

  if (candidates.length === 0) {
    console.log("[Recognition] No unprocessed notes found.");
    return 0;
  }

  console.log(`[Recognition] Processing ${candidates.length} unrecognized note(s)...`);
  let processed = 0;

  for (const index of candidates) {
    try {
      const note = await getNote(index.id);
      if (!note) continue;

      const activeStrokes = (note.strokes || []).filter((s) => !s._deleted && !s.isDeleted);
      if (activeStrokes.length === 0) continue;

      await performRecognition(index.id, activeStrokes);
      processed++;
    } catch (err) {
      console.error(`[Recognition] Failed for note ${index.id}:`, err);
    }
  }

  console.log(`[Recognition] Finished: ${processed} note(s) recognized.`);
  return processed;
}

/**
 * Schedule recognition for a note
 * Call this whenever strokes are added/modified in the editor
 * @param {string} noteId
 * @param {Array} strokes - Current strokes array
 */
export function scheduleRecognition(noteId, strokes) {
  if (recognitionTimer) {
    clearTimeout(recognitionTimer);
  }

  recognitionTimer = setTimeout(() => {
    performRecognition(noteId, strokes);
  }, RECOGNITION_DEBOUNCE_MS);
}

/**
 * Force immediate recognition (e.g. on note close)
 * @param {string} noteId
 * @param {Array} strokes
 */
export async function forceRecognition(noteId, strokes) {
  if (recognitionTimer) {
    clearTimeout(recognitionTimer);
    recognitionTimer = null;
  }
  await performRecognition(noteId, strokes);
}

/**
 * Execute the recognition process
 */
async function performRecognition(noteId, strokes) {
  if (!strokes || strokes.length === 0) return;

  const baseUrl = await resolveRecognitionUrl();
  if (!baseUrl) return;

  // Notify start of recognition
  window.dispatchEvent(new CustomEvent("recognition-start"));

  try {
    console.log(`[Recognition] Processing note ${noteId}...`);

    const language = (await getSetting("recognition_language")) || "en-US";
    const apiUrl = `${baseUrl.replace(/\/$/, "")}/recognize?language=${language}`;

    // Format strokes for the Web Service
    // Expected format: { id: "uuid", points: [{x, y, pressure, ...}] }
    // Strokes are sent in temporal order — the recognition service handles
    // spatial analysis internally to group strokes into words/lines.
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

    // Call the web service
    let result;
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
      result = await response.json();
    } catch (err) {
      console.error("[Recognition] Service call failed.", err);
      return;
    }

    if (result) {
      // Update the note with recognition data
      // We fetch the note first to ensure we don't overwrite other concurrent changes
      const note = await getNote(noteId);
      if (note) {
        // Construct the recognition object
        // Flatten the words into a full text string for simple search
        const fullText = result.map((w) => w.text).join(" ");

        const newRecognitionData = {
          fullText,
          words: result,
        };

        // Only update if data actually changed to avoid unnecessary writes/syncs
        if (JSON.stringify(note.recognition) !== JSON.stringify(newRecognitionData)) {
          await updateNote(noteId, {
            recognition: newRecognitionData,
            // updateNote automatically updates 'modified' timestamp
            // This will trigger a sync, which is desirable so the search index propagates to other devices
          });
          console.log(`[Recognition] Success for note ${noteId}: ${result.length} words`);
        } else {
          console.log(`[Recognition] No change for note ${noteId}, skipping update`);
        }
      }
    }
  } catch (error) {
    console.error(`[Recognition] Failed for note ${noteId}:`, error);
  } finally {
    // Notify end of recognition
    window.dispatchEvent(new CustomEvent("recognition-end"));
  }
}
