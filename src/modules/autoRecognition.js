/**
 * Auto Recognition Module
 * Handles background handwriting recognition scheduling.
 *
 * Owns everything that is not backend-specific: debounce, the catch-up scan
 * over unrecognized notes, progress/lifecycle events, and the compare-before-
 * write that keeps recognition from causing sync churn.
 *
 * Which service actually performs recognition — the Windows sidecar or a
 * configured AI backend — is decided by recognitionService.js.
 */

import { invalidateBackends, recognize } from "./recognition/recognitionService.js";
import { getAllNotes, getNote, updateNote } from "./storage.js";

// Configuration
const RECOGNITION_DEBOUNCE_MS = 2500; // 2.5 seconds inactivity

let recognitionTimer = null;

/**
 * Force re-resolution of the recognition backend (e.g. after settings change).
 */
export function invalidateRecognitionUrl() {
  invalidateBackends();
}

/**
 * Filter a note's strokes down to the ones that should be recognized.
 * @param {Object} note
 * @returns {Array}
 */
function activeStrokes(note) {
  return (note.strokes || []).filter((s) => !s._deleted && !s.isDeleted);
}

/**
 * Find all notes with strokes but no recognition and process them sequentially.
 * Called once per app start (after startup sync completes).
 * Is a no-op when no recognition backend is available or configured.
 *
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<number>} Number of notes successfully recognized.
 */
export async function recognizeUnprocessedNotes(opts = {}) {
  const { isRecognitionAvailable } = await import("./recognition/recognitionService.js");
  if (!(await isRecognitionAvailable())) return 0;

  const allIndexes = await getAllNotes(); // index entries only — no content loaded
  const candidates = allIndexes.filter((n) => n.hasStrokes && !n.hasRecognition && !n.deleted);

  if (candidates.length === 0) {
    console.log("[Recognition] No unprocessed notes found.");
    return 0;
  }

  console.log(`[Recognition] Processing ${candidates.length} unrecognized note(s)...`);
  let processed = 0;

  for (let i = 0; i < candidates.length; i++) {
    if (opts.signal?.aborted) {
      console.log("[Recognition] Catch-up scan cancelled.");
      break;
    }

    const index = candidates[i];
    try {
      const note = await getNote(index.id);
      if (!note) continue;

      const strokes = activeStrokes(note);
      if (strokes.length === 0) continue;

      // Backlog progress is reported per note; per-note phases are reported by
      // performRecognition itself.
      window.dispatchEvent(
        new CustomEvent("recognition-backlog-progress", {
          detail: { current: i + 1, total: candidates.length, noteId: index.id },
        }),
      );

      await performRecognition(index.id, strokes, opts);
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
 * Run recognition immediately, skipping the debounce (e.g. on note close, or
 * when the user asks for it explicitly).
 *
 * @param {string} noteId
 * @param {Array} strokes
 * @param {{ signal?: AbortSignal, onProgress?: Function, force?: boolean }} [opts]
 *   force — write the result even if it matches what is already stored. Use for
 *   user-initiated runs; leave unset for background passes so unchanged
 *   recognition does not churn sync.
 */
export async function forceRecognition(noteId, strokes, opts = {}) {
  if (recognitionTimer) {
    clearTimeout(recognitionTimer);
    recognitionTimer = null;
  }
  await performRecognition(noteId, strokes, opts);
}

/**
 * Whether a freshly produced recognition differs meaningfully from the stored one.
 *
 * Compares the recognized *content* — text and geometry — rather than the whole
 * object. Metadata added by later versions (`engine`, and `precision` on each
 * word) must not by itself count as a change: notes recognized before those
 * fields existed would otherwise all be rewritten on their next pass, and every
 * such rewrite is a sync round-trip for no user-visible difference.
 *
 * Absent `precision` means "exact" (DESIGN §2.2), so an old sidecar result and a
 * new one compare equal.
 *
 * @param {Object|null} stored
 * @param {Object|null} fresh
 * @returns {boolean}
 */
function recognitionChanged(stored, fresh) {
  if (!stored || !fresh) return stored !== fresh;
  if (stored.fullText !== fresh.fullText) return true;

  const a = stored.words || [];
  const b = fresh.words || [];
  if (a.length !== b.length) return true;

  for (let i = 0; i < a.length; i++) {
    if (a[i]?.text !== b[i]?.text) return true;
    if ((a[i]?.precision ?? "exact") !== (b[i]?.precision ?? "exact")) return true;
    if (JSON.stringify(a[i]?.boundingRect ?? null) !== JSON.stringify(b[i]?.boundingRect ?? null)) {
      return true;
    }
  }

  return false;
}

/**
 * Execute the recognition process.
 *
 * @param {string} noteId
 * @param {Array} strokes
 * @param {{ signal?: AbortSignal, onProgress?: Function, force?: boolean }} [opts]
 * @returns {Promise<Object|null>} the stored recognition object, or null
 */
async function performRecognition(noteId, strokes, opts = {}) {
  if (!strokes || strokes.length === 0) return null;

  // Notify start of recognition
  window.dispatchEvent(new CustomEvent("recognition-start"));

  try {
    console.log(`[Recognition] Processing note ${noteId}...`);

    const onProgress = (phase, current, total, detail) => {
      opts.onProgress?.(phase, current, total, detail);
      window.dispatchEvent(
        new CustomEvent("recognition-progress", {
          detail: { phase, current, total, noteId, ...detail },
        }),
      );
    };

    const result = await recognize(strokes, { ...opts, onProgress });
    if (!result) {
      // No backend, or the backend failed. hasRecognition stays false so the
      // next catch-up scan retries; nothing is written and the note stays clean.
      console.warn(`[Recognition] No result for note ${noteId} — nothing stored.`);
      return null;
    }

    // Re-read the note so concurrent edits elsewhere are not overwritten.
    const note = await getNote(noteId);
    if (!note) return null;

    // Only update if data actually changed, to avoid unnecessary writes/syncs.
    // With several devices able to recognize the same note, an unconditional
    // write here would let two engines ping-pong edits at each other.
    //
    // `force` overrides that for a deliberate, user-initiated re-run: someone
    // who asks to recognize again expects the stored result to be replaced,
    // including when a different backend produces identical text.
    if (opts.force || recognitionChanged(note.recognition, result)) {
      await updateNote(noteId, {
        recognition: result,
        // updateNote automatically updates 'modified' timestamp.
        // This triggers a sync, which is desirable so the search index
        // propagates to other devices.
      });
      console.log(
        `[Recognition] Stored for note ${noteId}: ${result.words.length} words, ` +
          `fullText ${result.fullText.length} chars. Note marked unsynced.`,
      );
    } else {
      // Reached only on a background pass — a user-initiated run passes force.
      console.log(
        `[Recognition] No change for note ${noteId}, skipping update (note stays synced)`,
      );
    }

    return result;
  } catch (error) {
    console.error(`[Recognition] Failed for note ${noteId}:`, error);
    return null;
  } finally {
    // Notify end of recognition
    window.dispatchEvent(new CustomEvent("recognition-end"));
  }
}

export { performRecognition };
