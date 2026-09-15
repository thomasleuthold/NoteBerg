/**
 * Recognition job queue.
 *
 * AI recognition takes minutes per note, so it cannot run inline: a user who
 * asked for it must be able to close the dialog, close the note, and keep
 * working. This module owns *scheduling* — what runs, in what order, and what
 * the UI is told about it. Execution and persistence stay in autoRecognition.js
 * (`forceRecognition`), which already re-reads the note and compares before
 * writing so a job landing after the note was edited elsewhere cannot clobber it.
 *
 * Jobs are persisted, so work survives the app closing, an Android app being
 * backgrounded, or a Nextcloud tab going away — uniformly on all three
 * platforms, which is why persistence was chosen over per-platform close
 * warnings that could never behave the same way.
 *
 * Resume quality still differs by provider, and that difference is in the API
 * shape rather than in anything we control:
 *   - Replicate dispatches a server-side *prediction* that keeps running with
 *     nobody listening. Its poll URL is persisted at dispatch, so an interrupted
 *     job collects a result it has already paid for.
 *   - OpenAI-compatible /chat/completions is synchronous: no server-side
 *     resource, no id, no retention. An interrupted band is simply re-sent.
 * Either way no completed band is ever lost — the cost of an interruption
 * differs, the behaviour does not.
 *
 * Serial by design. Two concurrent requests to a local model make both slower,
 * and against a cloud backend concurrency mainly buys a rate-limit error.
 *
 * The sidecar path does NOT go through here. It completes in well under a
 * second, so queueing it would add latency and UI noise to the common case for
 * no benefit — see autoRecognition.js, which still calls it directly.
 */

import { forceRecognition } from "../autoRecognition.js";
import {
  deleteRecognitionJob,
  getNote,
  getRecognitionJobs,
  saveRecognitionJob,
} from "../storage.js";
import { getRecognitionConfig } from "./recognitionSettings.js";

/** @typedef {"queued"|"running"|"done"|"failed"|"cancelled"} JobState */

/**
 * Public view of a job. `strokes`, the fingerprint and the AbortController are
 * held in a parallel private record: the UI has no use for them, and handing out
 * the stroke array invites a caller to mutate what we are about to render.
 *
 * @typedef {Object} Job
 * @property {string} id
 * @property {string} noteId
 * @property {string} title
 * @property {JobState} state
 * @property {string|null} phase - rasterize | transcribe | stitch
 * @property {number} current
 * @property {number} total
 * @property {number} words
 * @property {number|null} startedAt
 * @property {string|null} error
 * @property {string} fingerprint - stroke signature when the job was created
 * @property {string} backend - the AI provider id the bands were transcribed
 *   with; a resume into a different one is refused
 * @property {string} model
 * @property {number} bandIndex - next band to transcribe
 * @property {Array} bandResults - bands already transcribed, kept off the note
 * @property {string|null} predictionUrl - resumable handle (Replicate only)
 */

/** @type {Job[]} */
let jobs = [];
/** @type {Map<string, {strokes: Array, fingerprint: string, controller: AbortController}>} */
const privateData = new Map();

let nextId = 1;
let draining = false;

/** How long a successful job stays visible before it drops off the queue. */
const DONE_LINGER_MS = 10000;

/**
 * A cheap signature of the stroke set a job was created from.
 *
 * Used to detect that the note was edited while the job waited or ran. It is
 * deliberately not a hash of every point: the realistic case is the user drawing
 * more ink, which changes both count and last id. An edit that replaces strokes
 * without changing either is not detected — acceptable here, because the
 * consequence is a stale recognition rather than data loss, and the note stays
 * re-runnable.
 *
 * @param {Array} strokes
 * @returns {string}
 */
export function fingerprint(strokes) {
  const list = strokes || [];
  return `${list.length}:${list[list.length - 1]?.id ?? ""}`;
}

/**
 * The strokes a note actually has, using the same filter as every other caller
 * (autoRecognition.activeStrokes, NoteCanvas.destroy). A soft-deleted stroke is
 * not ink, so it must not count toward the fingerprint.
 *
 * @param {Object} note
 * @returns {Array}
 */
function activeStrokes(note) {
  return (note?.strokes || []).filter((s) => !s._deleted && !s.isDeleted);
}

/** Snapshot of the queue, oldest first. */
export function getJobs() {
  return jobs.map((j) => ({ ...j }));
}

/**
 * Position of a job among those still waiting, 0 = next to run.
 * Recomputed on demand: it changes for every waiting job whenever one finishes,
 * so storing it would mean rewriting most of the queue on every transition.
 *
 * @param {string} jobId
 * @returns {number} 0-based position, or -1 when not waiting
 */
export function queuePosition(jobId) {
  return jobs.filter((j) => j.state === "queued").findIndex((j) => j.id === jobId);
}

function emit(name, detail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Tell the footer the queue as a whole moved. */
function emitQueueChanged() {
  emit("recognition-queue-changed", { jobs: getJobs() });
}

/**
 * Announce a job's state. Carries queuePosition so a waiting job's dialog can
 * say *why* nothing is happening — a progress bar sitting at 0% because another
 * note is transcribing is indistinguishable from a hang.
 *
 * @param {Job} job
 */
function emitJobState(job) {
  emit("recognition-job-state", {
    jobId: job.id,
    noteId: job.noteId,
    state: job.state,
    error: job.error,
    queuePosition: queuePosition(job.id),
  });
  emitQueueChanged();
}

/**
 * Write a job to durable storage.
 *
 * Every state transition and every completed band goes through here: a
 * checkpoint that is not written is a checkpoint that does not exist. Failures
 * are logged and swallowed — losing persistence degrades to the old in-memory
 * behaviour, which must never take down the run in progress.
 *
 * @param {Job} job
 */
async function persist(job) {
  try {
    await saveRecognitionJob({ ...job });
  } catch (err) {
    console.warn(`[RecognitionQueue] Could not persist job ${job.id}:`, err);
  }
}

/** Forget a job entirely, in memory and on disk. */
async function forget(jobId) {
  try {
    await deleteRecognitionJob(jobId);
  } catch (err) {
    console.warn(`[RecognitionQueue] Could not delete job ${jobId}:`, err);
  }
}

/**
 * Restore unfinished jobs left by a previous session and continue them.
 *
 * Call on startup and whenever the app becomes visible again — the same path
 * covers a closed desktop app, a backgrounded Android app and a reloaded NC tab,
 * which is the point of persisting rather than warning.
 *
 * Jobs are re-validated rather than trusted: the note may have been edited or
 * deleted, and the configured backend may have changed, since they were written.
 *
 * @returns {Promise<number>} how many jobs were restored
 */
export async function resumePersistedJobs() {
  let stored;
  try {
    stored = await getRecognitionJobs();
  } catch (err) {
    console.warn("[RecognitionQueue] Could not read persisted jobs:", err);
    return 0;
  }
  if (!stored?.length) return 0;

  const config = await getRecognitionConfig();
  let restored = 0;

  for (const raw of stored) {
    // Already represented in memory (a double resume, or a job this session
    // created) — never queue it twice.
    if (jobs.some((j) => j.id === raw.id)) continue;

    // Finished jobs are only kept for the UI, and the UI is gone after a
    // restart. Nothing to resume.
    if (raw.state === "done" || raw.state === "cancelled") {
      await forget(raw.id);
      continue;
    }

    // Resuming into a different provider would stitch two engines' output
    // together, and a stored Replicate handle is meaningless to another backend.
    if (raw.backend !== config.provider || raw.model !== config.model) {
      console.log(`[RecognitionQueue] Job ${raw.id} was queued for a different backend or model.`);
      // Surfaced as a failure rather than deleted, exactly as a stale job is.
      // The bands already transcribed were paid for, and a configuration
      // mismatch is the user's to resolve — switching provider back, or
      // re-running deliberately. Silently discarding paid partial work on a
      // config comparison gave them no way to tell that had happened.
      const job = { ...raw, state: "failed", error: "backend-changed", phase: null };
      jobs.push(job);
      await persist(job);
      restored++;
      continue;
    }

    const note = await getNote(raw.noteId).catch(() => null);
    if (!note) {
      await forget(raw.id);
      continue;
    }

    // The note may have been edited while the app was closed. Page boundaries
    // derive from stroke bounds, so partial results from before the edit cannot
    // be stitched onto the note as it is now.
    if (fingerprint(activeStrokes(note)) !== raw.fingerprint) {
      console.log(`[RecognitionQueue] Job ${raw.id} is stale — note changed while away.`);
      const job = { ...raw, state: "failed", error: "stale", phase: null };
      jobs.push(job);
      await persist(job);
      restored++;
      continue;
    }

    // A failed job stays failed: it is shown so the user can decide, not
    // retried automatically. Retrying on every launch would bill them for a
    // note that may simply be unrecognizable.
    const job = { ...raw, state: raw.state === "failed" ? "failed" : "queued", phase: null };
    jobs.push(job);
    privateData.set(job.id, {
      strokes: activeStrokes(note),
      fingerprint: raw.fingerprint,
      controller: new AbortController(),
    });
    restored++;
  }

  if (restored > 0) {
    console.log(`[RecognitionQueue] Restored ${restored} job(s) from a previous session.`);
    emitQueueChanged();
    drain();
  }
  return restored;
}

/**
 * Queue a note for AI recognition.
 *
 * Re-queueing a note that is already waiting replaces its strokes rather than
 * adding a second job: closing a note repeatedly, or hitting recognize twice,
 * must not stack duplicate paid work for the same note.
 *
 * A note already *running* is returned as-is, for the same reason. Matching only
 * "queued" meant a second request while the first was in flight created a second
 * job, and the drain loop then ran the same note twice end to end — two full
 * transcriptions of the same pages, sequentially, which on a slow model reads to
 * the user as a hang and then a timeout. Superseding a running job means
 * cancelling it explicitly; that is what cancel() is for.
 *
 * @param {string} noteId
 * @param {Array} strokes - active strokes, captured now and owned by the job
 * @param {{title?: string, backend?: string, model?: string,
 *   punctuation?: boolean, breaks?: boolean}} [opts]
 *   punctuation / breaks — the prompt choices made in the confirmation dialog.
 *   Carried on the job rather than re-read from settings at run time: the run
 *   must use what the user agreed to when they pressed Start, including after a
 *   resume in a later session. Each defaults to the prompt's own default —
 *   punctuation on, layout off.
 * @returns {Job} the job, synchronously, so a caller can subscribe by id before
 *   anything awaits
 */
export function enqueue(noteId, strokes, opts = {}) {
  const fp = fingerprint(strokes);

  // A run already under way owns this note. Its strokes cannot be swapped
  // underneath it — the bands in flight describe the ink it started with — so
  // the caller gets the running job rather than a duplicate.
  const running = jobs.find((j) => j.noteId === noteId && j.state === "running");
  if (running) {
    console.log(`[RecognitionQueue] Note ${noteId} is already running as job ${running.id}.`);
    // `duplicate` tells the caller its request was absorbed rather than
    // accepted. Without it a UI could only compare ids — and would then attach a
    // progress dialog, with its own Cancel button, to a run it did not start:
    // cancelling the "second" recognition would kill the first one.
    return { ...running, duplicate: true };
  }

  const existing = jobs.find((j) => j.noteId === noteId && j.state === "queued");
  if (existing) {
    privateData.set(existing.id, {
      strokes: [...strokes],
      fingerprint: fp,
      controller: new AbortController(),
    });
    if (opts.title) existing.title = opts.title;
    // Re-queueing re-reads the configuration, so the provider may have changed
    // since the job was first created. Leaving the old one recorded would make
    // resumePersistedJobs drop the job as a backend mismatch after a restart —
    // discarding work the user explicitly asked for, with only a log line.
    if (opts.backend !== undefined) existing.backend = opts.backend;
    if (opts.model !== undefined) existing.model = opts.model;
    if (opts.punctuation !== undefined) existing.punctuation = opts.punctuation;
    if (opts.breaks !== undefined) existing.breaks = opts.breaks;
    // Replacing the strokes invalidates any partial work: the bands already
    // transcribed describe the previous ink.
    existing.fingerprint = fp;
    existing.bandIndex = 0;
    existing.bandResults = [];
    existing.predictionUrl = null;
    emitJobState(existing);
    persist(existing);
    return { ...existing };
  }

  /** @type {Job} */
  const job = {
    id: `rq_${Date.now()}_${nextId++}`,
    noteId,
    title: opts.title || "",
    state: "queued",
    phase: null,
    current: 0,
    total: 0,
    words: 0,
    startedAt: null,
    error: null,
    fingerprint: fp,
    // Recorded now so a resume can refuse to continue into a different provider
    // — half the bands from one engine and half from another is not a result.
    backend: opts.backend ?? "",
    model: opts.model ?? "",
    punctuation: opts.punctuation ?? true,
    breaks: opts.breaks ?? false,
    bandIndex: 0,
    bandResults: [],
    predictionUrl: null,
  };

  jobs.push(job);
  privateData.set(job.id, {
    strokes: [...strokes],
    fingerprint: fp,
    controller: new AbortController(),
  });

  emitJobState(job);
  persist(job);
  drain();
  return { ...job };
}

/**
 * Cancel a job, whether it is waiting or in flight.
 *
 * @param {string} jobId
 * @returns {boolean} whether a job was actually cancelled
 */
export function cancel(jobId) {
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return false;
  if (job.state !== "queued" && job.state !== "running") return false;

  // Abort first: for a running job this is what actually stops the request. The
  // drain loop sees the state and does not overwrite it with a result.
  privateData.get(jobId)?.controller.abort();
  job.state = "cancelled";
  job.phase = null;
  emitJobState(job);

  // A cancelled job carries no information worth keeping — unlike a failure,
  // the user already knows, because they did it.
  remove(jobId);
  forget(jobId);
  return true;
}

/** Drop finished rows (done/failed/cancelled) from the queue. */
export function clearFinished() {
  const finished = jobs.filter((j) => j.state !== "queued" && j.state !== "running");
  if (finished.length === 0) return;
  for (const j of finished) {
    privateData.delete(j.id);
    forget(j.id);
  }
  jobs = jobs.filter((j) => j.state === "queued" || j.state === "running");
  emitQueueChanged();
}

function remove(jobId) {
  jobs = jobs.filter((j) => j.id !== jobId);
  privateData.delete(jobId);
  emitQueueChanged();
}

/**
 * Run queued jobs one at a time until none remain.
 *
 * Re-entrancy is guarded rather than queued: enqueue() calls this on every add,
 * and a second concurrent drain would defeat the point of being serial.
 */
async function drain() {
  if (draining) return;
  draining = true;

  // The old binary indicator still means "recognition is happening" — emitted
  // around the whole drain rather than per job, so it does not flicker between
  // consecutive notes (footer.js:133, DESIGN §7 keeps this contract).
  emit("recognition-start");

  try {
    while (true) {
      const job = jobs.find((j) => j.state === "queued");
      if (!job) break;
      await runJob(job);
    }
  } finally {
    draining = false;
    emit("recognition-end");
    emitQueueChanged();
  }
}

/**
 * Execute one job.
 *
 * @param {Job} job
 */
async function runJob(job) {
  const data = privateData.get(job.id);
  if (!data) {
    remove(job.id);
    return;
  }

  job.state = "running";
  job.startedAt = Date.now();
  job.error = null;
  emitJobState(job);
  await persist(job);

  // The note may have been edited while this job waited. Recognizing the
  // strokes we captured would store text — and band-indexed regions — that
  // describe ink no longer on the page.
  //
  // This is not merely stale: page boundaries are derived from the note's
  // stroke bounds (pageRasterizer.planBands), so ink added above existing
  // content renumbers every page. A stored region index would then point at a
  // different page than the one it was transcribed from.
  //
  // Deliberately NOT re-queued automatically. A user who keeps writing would
  // re-queue forever, and on a paid backend every lap costs money. Failing
  // visibly lets them re-run when they are done writing.
  try {
    const current = await getNote(job.noteId);
    if (current && fingerprint(activeStrokes(current)) !== data.fingerprint) {
      fail(job, "stale");
      return;
    }
  } catch (err) {
    console.warn(`[RecognitionQueue] Could not verify note ${job.noteId}:`, err);
  }

  // Why the run failed, when it did. forceRecognition reports failure as a null
  // — it catches everything so the automatic and sidecar paths stay silent — so
  // the reason has to travel beside the result rather than as a throw.
  let failure = null;

  try {
    const result = await forceRecognition(job.noteId, data.strokes, {
      signal: data.controller.signal,
      onError: (err) => {
        failure = err;
      },
      // The prompt choice the user confirmed for this job, overriding the
      // stored setting for this run only. enqueue() always writes both as
      // explicit booleans, so these defaults only cover a job record that
      // somehow lacks them — and each matches enqueue's own default, so a run
      // can never transcribe under different options than the dialog offered.
      configOverride: {
        punctuation: job.punctuation ?? true,
        breaks: job.breaks ?? false,
      },
      // Resume state from a previous session, if any.
      startBand: job.bandIndex ?? 0,
      priorBands: job.bandResults ?? [],
      resumePrediction: job.predictionUrl ?? null,
      // Checkpoint after each page, so an interruption costs one page at most.
      onBandComplete: async (bandIndex, words, imageBounds) => {
        job.bandResults = [...(job.bandResults ?? []), { words, band: imageBounds }];
        job.bandIndex = bandIndex + 1;
        // The handle belongs to the page just finished; it is spent.
        job.predictionUrl = null;
        await persist(job);
      },
      // The resume state no longer fits the note, so the run restarted from the
      // first page. Drop the checkpoint with it — otherwise the restarted pages
      // append onto results describing ink that is no longer there.
      onResetBands: async () => {
        job.bandResults = [];
        job.bandIndex = 0;
        job.predictionUrl = null;
        await persist(job);
      },
      // Written before the backend waits on it. A prediction already dispatched
      // has already been paid for — this is what lets a later session collect
      // it instead of paying twice.
      onPredictionStarted: async (_bandIndex, url) => {
        job.predictionUrl = url;
        await persist(job);
      },
      // A deliberate, user-initiated run: replace the stored result even when
      // the text is identical, so re-running with a different model is not a
      // silent no-op.
      force: true,
      // Explicitly NOT automatic — this is exactly the user request that the
      // automatic gate in recognitionService.selectBackend() exists to
      // distinguish from app-triggered work.
      onProgress: (phase, current, total, detail) => {
        job.phase = phase;
        job.current = current;
        job.total = total;
        if (typeof detail?.words === "number") job.words = detail.words;
        emit("recognition-job-progress", {
          jobId: job.id,
          noteId: job.noteId,
          phase,
          current,
          total,
          words: job.words,
        });
      },
    });

    // cancel() already moved the job out of the queue; do not resurrect it with
    // a result the user asked us to throw away.
    if (job.state === "cancelled" || data.controller.signal.aborted) return;

    if (!result) {
      // forceRecognition returns null when the backend failed or produced
      // nothing. hasRecognition stays false, so the note remains re-runnable.
      //
      // The backend's own message where there is one: it usually names the
      // setting to change, which "failed" cannot.
      fail(job, failure?.message || "failed");
      return;
    }

    job.state = "done";
    job.phase = null;
    job.predictionUrl = null;
    emitJobState(job);
    // The result is on the note now; the job record has nothing left to protect.
    await forget(job.id);

    // The note may well be closed by now, and if it is open it will NOT reload:
    // handleExternalDataChange ignores source:"local" writes, which is what
    // recognition performs. So tell the canvas directly — it updates its
    // in-memory recognition and re-applies the active search without a reload,
    // which would otherwise clear the undo history.
    emit("recognition-job-complete", { noteId: job.noteId, recognition: result });

    // Successful jobs settle out of the footer on their own; a failure stays
    // until dismissed, because a failure nobody saw is the one that matters.
    setTimeout(() => {
      const still = jobs.find((j) => j.id === job.id);
      if (still?.state === "done") remove(job.id);
    }, DONE_LINGER_MS);
  } catch (err) {
    if (job.state === "cancelled" || data.controller.signal.aborted) return;
    if (err?.name === "AbortError") {
      job.state = "cancelled";
      emitJobState(job);
      remove(job.id);
      return;
    }
    console.error(`[RecognitionQueue] Job ${job.id} failed:`, err);
    fail(job, err?.message || "failed");
  }
}

/**
 * Mark a job failed and leave it in the queue for the user to see.
 * @param {Job} job
 * @param {string} message
 */
function fail(job, message) {
  job.state = "failed";
  job.phase = null;
  job.error = message;
  emitJobState(job);
  // Kept on disk: a failure the user has not seen must survive a restart, and
  // its partial bands are still worth resuming from if they retry.
  persist(job);
}

/** Test seam: drop all state. */
export function _reset() {
  jobs = [];
  privateData.clear();
  nextId = 1;
  draining = false;
}

/**
 * Start watching for chances to resume.
 *
 * One path for all three platforms: startup covers a relaunched desktop app and
 * a reloaded NC tab; visibilitychange covers an Android app returning to the
 * foreground, which is the case that has no close event at all.
 */
export function initRecognitionQueue() {
  resumePersistedJobs();

  if (typeof document === "undefined") return;
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;

    // A tab coming back to the foreground is exactly when the administrator's
    // policy may have changed in another one — switching to central mode, or
    // changing the model every queued job records. The cached server config
    // would otherwise keep a resumed job running against settings that are no
    // longer in force, and resumePersistedJobs compares against it to decide
    // whether a job is still valid.
    //
    // No-op off Nextcloud: there is no server config to cache there, so the
    // native builds skip the import entirely.
    if (import.meta.env.VITE_PLATFORM === "nextcloud") {
      try {
        const { invalidateProviderCache } = await import("./aiProvider.js");
        invalidateProviderCache();
      } catch (err) {
        // A failed refresh must not stop the resume: the stale policy is worse
        // than nothing only in the rare case it changed, whereas skipping the
        // resume loses queued work every time.
        console.warn("[RecognitionQueue] Could not refresh the AI policy:", err);
      }
    }

    resumePersistedJobs();
  });
}
