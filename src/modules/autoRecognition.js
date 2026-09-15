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

import { countWords } from "./recognition/breaks.js";
import { invalidateBackends, recognize } from "./recognition/recognitionService.js";
import { getAllNotes, getNote, updateNote } from "./storage.js";

// Configuration
const RECOGNITION_DEBOUNCE_MS = 2500; // 2.5 seconds inactivity

let recognitionTimer = null;

/**
 * Runs currently in flight, keyed by note id.
 *
 * The debounce timer only stops a *scheduled* second run; it does nothing about
 * a second call arriving while the first is still awaiting the backend. Three
 * entry points reach performRecognition independently — the drawing debounce,
 * note close, and the catch-up scan — so two runs for one note overlapped
 * routinely, and each one rasterizes and sends the same pages again.
 *
 * On Nextcloud that was not merely wasteful. Every band goes through the PHP
 * proxy, which holds the session lock for the length of the upstream call, so
 * the second run's request blocked behind the first until the web server cut
 * the connection — surfacing in the browser as a bare "NetworkError when
 * attempting to fetch resource" with no status code to explain it.
 *
 * @type {Map<string, Promise<Object|null>>}
 */
const inFlight = new Map();

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
 * Is a no-op when no recognition backend is available or configured, and when
 * the configured backend is an AI one: this scan would otherwise bill the user
 * for every unrecognized note in the library at app start (DESIGN §6).
 *
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<number>} Number of notes successfully recognized.
 */
export async function recognizeUnprocessedNotes(opts = {}) {
  const { isRecognitionAvailable } = await import("./recognition/recognitionService.js");
  // Checked with automatic:true so an AI-only configuration skips the whole
  // scan, rather than loading every candidate note to find nothing may run.
  if (!(await isRecognitionAvailable({ automatic: true }))) return 0;

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

      await performRecognition(index.id, strokes, { ...opts, automatic: true });
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
    // App-triggered while the user is still writing — local backends only.
    performRecognition(noteId, strokes, { automatic: true });
  }, RECOGNITION_DEBOUNCE_MS);
}

/**
 * Run recognition immediately, skipping the debounce (e.g. on note close, or
 * when the user asks for it explicitly).
 *
 * @param {string} noteId
 * @param {Array} strokes
 * @param {{ signal?: AbortSignal, onProgress?: Function, force?: boolean,
 *           automatic?: boolean }} [opts]
 *   force — write the result even if it matches what is already stored. Use for
 *   user-initiated runs; leave unset for background passes so unchanged
 *   recognition does not churn sync.
 *   automatic — this run was not requested by the user, so an AI backend must
 *   not be started for it. "Immediate" here means skipping the debounce, not
 *   that a person asked: note close uses this path too.
 * @returns {Promise<Object|null>} the stored recognition, or null when no
 *   backend ran or the attempt failed. The queue needs this to tell a finished
 *   job from a failed one.
 */
export async function forceRecognition(noteId, strokes, opts = {}) {
  if (recognitionTimer) {
    clearTimeout(recognitionTimer);
    recognitionTimer = null;
  }
  return performRecognition(noteId, strokes, opts);
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
 * Execute the recognition process, at most once per note at a time.
 *
 * A call arriving while the same note is already being recognized joins the run
 * in progress instead of starting a second one. Joining rather than refusing
 * matters for the callers that use the return value: forceRecognition's result
 * decides whether the queue marks a job done, and a bare null there would report
 * a note as failed while a perfectly good run was still finishing.
 *
 * The de-duplication is per note, not global. Two different notes recognizing at
 * once is legitimate — the catch-up scan is sequential by construction, and the
 * queue serializes its own jobs — and this must not serialize them further.
 *
 * `force` is deliberately not part of the key. A forced run that joins a
 * background run in progress still gets a fresh result for the same strokes; the
 * only difference is whether an unchanged result is rewritten, which is not
 * worth a duplicate transcription to the user paying per page.
 *
 * A joiner inherits the *first* caller's abort signal, which is why this is a
 * last-resort guard rather than the main defence. Cancelling the run that
 * started the work also ends it for everyone waiting on it — correct for the
 * paths that share one logical request, but not a substitute for callers not
 * issuing duplicates in the first place. The queue dedups on note id before it
 * ever reaches here (recognitionQueue.enqueue), so in practice only the
 * debounce/close/catch-up paths, which pass no signal, land in this branch.
 *
 * @param {string} noteId
 * @param {Array} strokes
 * @param {{ signal?: AbortSignal, onProgress?: Function, force?: boolean,
 *           automatic?: boolean }} [opts]
 * @returns {Promise<Object|null>} the stored recognition object, or null
 */
async function performRecognition(noteId, strokes, opts = {}) {
  if (!strokes || strokes.length === 0) return null;

  const existing = inFlight.get(noteId);
  if (existing) {
    console.log(`[Recognition] Note ${noteId} is already being recognized — joining that run.`);
    return existing;
  }

  const run = runRecognition(noteId, strokes, opts);
  inFlight.set(noteId, run);
  try {
    return await run;
  } finally {
    // Cleared here rather than inside runRecognition so the entry cannot outlive
    // the promise every joiner is awaiting.
    inFlight.delete(noteId);
  }
}

/**
 * The recognition process itself, with no concurrency control.
 *
 * @param {string} noteId
 * @param {Array} strokes
 * @param {{ signal?: AbortSignal, onProgress?: Function, force?: boolean,
 *           automatic?: boolean }} [opts]
 * @returns {Promise<Object|null>} the stored recognition object, or null
 */
async function runRecognition(noteId, strokes, opts = {}) {
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
        `[Recognition] Stored for note ${noteId}: ${countWords(result.words)} words, ` +
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
