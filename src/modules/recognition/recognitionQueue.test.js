/**
 * Covers the scheduling guarantees the queue exists to provide.
 *
 * The queue is what makes a minutes-long, paid operation survive the user
 * closing a dialog or a note. Its failure modes are expensive rather than
 * merely annoying — running two jobs at once against a local model, re-queueing
 * a note forever while the user keeps writing, or storing a transcription of ink
 * that has since moved — so each is pinned here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const forceRecognition = vi.fn();
vi.mock("../autoRecognition.js", () => ({
  forceRecognition: (...args) => forceRecognition(...args),
}));

const getNote = vi.fn();

/**
 * A stand-in for the persisted job store, faithful to the real one: writes are
 * visible to the next read, and a delete really removes. Tests assert against
 * this rather than against calls, so "the job survived" means what it says.
 */
let persisted = [];
const getRecognitionJobs = vi.fn(async () => persisted.map((j) => ({ ...j })));
const saveRecognitionJob = vi.fn(async (job) => {
  const i = persisted.findIndex((j) => j.id === job.id);
  if (i >= 0) persisted[i] = { ...job };
  else persisted.push({ ...job });
  return job;
});
const deleteRecognitionJob = vi.fn(async (id) => {
  persisted = persisted.filter((j) => j.id !== id);
});

vi.mock("../storage.js", () => ({
  getNote: (...args) => getNote(...args),
  getRecognitionJobs: (...args) => getRecognitionJobs(...args),
  saveRecognitionJob: (...args) => saveRecognitionJob(...args),
  deleteRecognitionJob: (...args) => deleteRecognitionJob(...args),
}));

const getRecognitionConfig = vi.fn(async () => ({
  method: "ai",
  provider: "replicate",
  model: "owner/name",
}));
vi.mock("./recognitionSettings.js", () => ({
  getRecognitionConfig: (...args) => getRecognitionConfig(...args),
}));

import * as queue from "./recognitionQueue.js";

/** A recognition result shaped like the real one. */
const RESULT = { fullText: "hello", engine: "replicate:x", words: [{ text: "hello" }] };

function stroke(id) {
  return { id, x: [0], y: [0] };
}

/** Capture events by name for assertions. */
function listen(name) {
  const seen = [];
  window.addEventListener(name, (e) => seen.push(e.detail));
  return seen;
}

/** A deferred promise, for holding a job in flight. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  queue._reset();
  persisted = [];
  getRecognitionConfig.mockResolvedValue({
    method: "ai",
    provider: "replicate",
    model: "owner/name",
  });
  // By default the note still holds exactly the strokes the job captured, so
  // the staleness check passes and tests exercise the path they mean to.
  getNote.mockImplementation(async () => ({ id: "n1", strokes: [stroke("s1")] }));
  forceRecognition.mockResolvedValue(RESULT);
});

describe("serial execution", () => {
  it("runs one job at a time", async () => {
    // Concurrency against a local model makes every request slower, and against
    // a cloud backend mainly buys a rate-limit error.
    const first = deferred();
    let inFlight = 0;
    let maxInFlight = 0;
    forceRecognition.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await first.promise;
      inFlight--;
      return RESULT;
    });

    queue.enqueue("n1", [stroke("s1")]);
    queue.enqueue("n2", [stroke("s1")]);
    queue.enqueue("n3", [stroke("s1")]);

    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalledTimes(1));
    first.resolve();
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalledTimes(3));

    expect(maxInFlight).toBe(1);
  });

  it("runs queued jobs in the order they were added", async () => {
    const order = [];
    forceRecognition.mockImplementation(async (noteId) => {
      order.push(noteId);
      return RESULT;
    });

    queue.enqueue("n1", [stroke("s1")]);
    queue.enqueue("n2", [stroke("s1")]);

    await vi.waitFor(() => expect(order).toEqual(["n1", "n2"]));
  });

  it("keeps draining after a job fails", async () => {
    // One bad note must not strand everything behind it.
    forceRecognition.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(RESULT);

    queue.enqueue("n1", [stroke("s1")]);
    queue.enqueue("n2", [stroke("s1")]);

    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalledTimes(2));
  });
});

describe("enqueue", () => {
  it("returns the job synchronously so a dialog can subscribe before awaiting", async () => {
    const job = queue.enqueue("n1", [stroke("s1")]);
    expect(job.id).toBeTruthy();
    expect(job.noteId).toBe("n1");
  });

  it("replaces a waiting job for the same note rather than stacking a duplicate", async () => {
    // Closing a note repeatedly, or double-clicking recognize, must not queue
    // the same paid work twice.
    const hold = deferred();
    forceRecognition.mockImplementationOnce(async () => {
      await hold.promise;
      return RESULT;
    });

    queue.enqueue("n1", [stroke("s1")]); // starts running
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalledTimes(1));

    const a = queue.enqueue("n2", [stroke("s1")]);
    const b = queue.enqueue("n2", [stroke("s2")]);

    expect(b.id).toBe(a.id);
    expect(queue.getJobs().filter((j) => j.noteId === "n2")).toHaveLength(1);

    hold.resolve();
  });

  it("does not disturb a job for the same note that is already running", async () => {
    // Superseding in-flight work needs an explicit cancel — silently swapping
    // the strokes under a running request would transcribe a mix of two states.
    const hold = deferred();
    forceRecognition.mockImplementationOnce(async () => {
      await hold.promise;
      return RESULT;
    });

    const first = queue.enqueue("n1", [stroke("s1")]);
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalledTimes(1));

    const second = queue.enqueue("n1", [stroke("s2")]);

    // The running job is returned as-is, with its original strokes intact.
    expect(second.id).toBe(first.id);
    expect(queue.getJobs().filter((j) => j.noteId === "n1")).toHaveLength(1);

    // Flagged so a caller can tell "your request was absorbed" from "your
    // request started this job" — the two need opposite UI, and comparing ids
    // cannot distinguish them on the very first call.
    expect(second.duplicate).toBe(true);
    expect(first.duplicate).toBeUndefined();

    hold.resolve();
  });

  it("does not queue a second run behind one already in flight for the note", async () => {
    // The expensive regression: matching only "queued" let a second request
    // arriving mid-run create a second job, which the drain loop then ran end to
    // end after the first — two full transcriptions of the same pages, billed
    // twice, and on a slow model long enough to read as a hang and then a
    // timeout. Reported from the field: two recognitions started in a row both
    // failed, and every attempt after them did too.
    const hold = deferred();
    forceRecognition.mockImplementation(async () => {
      await hold.promise;
      return RESULT;
    });

    queue.enqueue("n1", [stroke("s1")]);
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalledTimes(1));

    queue.enqueue("n1", [stroke("s1")]);
    queue.enqueue("n1", [stroke("s1")]);

    hold.resolve();
    await vi.waitFor(() => expect(queue.getJobs().every((j) => j.state !== "running")).toBe(true));

    // One run, not three.
    expect(forceRecognition).toHaveBeenCalledTimes(1);
  });

  it("refuses a duplicate even when both calls arrive in the same tick", async () => {
    // Two clicks landing together. enqueue() calls drain(), which is synchronous
    // up to its first await, so the first job is already "running" by the time
    // the second call looks — the same-tick case takes the running branch, not
    // the queued one, and is reported as an absorbed duplicate.
    const a = queue.enqueue("n1", [stroke("s1")]);
    const b = queue.enqueue("n1", [stroke("s1")]);

    expect(b.id).toBe(a.id);
    expect(b.duplicate).toBe(true);
    expect(queue.getJobs().filter((j) => j.noteId === "n1")).toHaveLength(1);

    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalledTimes(1));
  });

  it("still accepts a fresh run once the previous one has finished", async () => {
    // The guard must not latch: re-recognizing a note after a completed run is
    // exactly what a user does after editing it.
    queue.enqueue("n1", [stroke("s1")]);
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(queue.getJobs().every((j) => j.state !== "running")).toBe(true));

    // The same strokes the note holds: a second run is refused as "stale" when
    // the captured ink no longer matches the note, which is a different rule
    // from the duplicate guard under test here.
    queue.enqueue("n1", [stroke("s1")]);
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalledTimes(2));
  });
});

describe("cancel", () => {
  it("drops a waiting job without ever running it", async () => {
    const hold = deferred();
    forceRecognition.mockImplementationOnce(async () => {
      await hold.promise;
      return RESULT;
    });

    queue.enqueue("n1", [stroke("s1")]);
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalledTimes(1));
    const waiting = queue.enqueue("n2", [stroke("s1")]);

    expect(queue.cancel(waiting.id)).toBe(true);
    hold.resolve();

    // Gone from the queue immediately, and — the point of cancelling early —
    // never sent to the backend. n1 is still listed: a completed job lingers
    // briefly so the user sees it finish.
    expect(queue.getJobs().find((j) => j.id === waiting.id)).toBeUndefined();
    await vi.waitFor(() => {
      expect(queue.getJobs().find((j) => j.noteId === "n1")?.state).toBe("done");
    });
    expect(forceRecognition).toHaveBeenCalledTimes(1);
    expect(forceRecognition).not.toHaveBeenCalledWith("n2", expect.anything(), expect.anything());
  });

  it("aborts a running job through the signal it was given", async () => {
    // Cancelling must stop the actual HTTP request, not just hide the row.
    let seenSignal = null;
    const hold = deferred();
    forceRecognition.mockImplementationOnce(async (_id, _strokes, opts) => {
      seenSignal = opts.signal;
      await hold.promise;
      return RESULT;
    });

    const job = queue.enqueue("n1", [stroke("s1")]);
    await vi.waitFor(() => expect(seenSignal).not.toBeNull());
    expect(seenSignal.aborted).toBe(false);

    queue.cancel(job.id);
    expect(seenSignal.aborted).toBe(true);
    hold.resolve();
  });

  it("does not store a result for a job cancelled while in flight", async () => {
    // A backend that returns anyway after abort must not resurrect the job —
    // the user asked for the work to be thrown away.
    const complete = listen("recognition-job-complete");
    const hold = deferred();
    forceRecognition.mockImplementationOnce(async () => {
      await hold.promise;
      return RESULT;
    });

    const job = queue.enqueue("n1", [stroke("s1")]);
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalled());
    queue.cancel(job.id);
    hold.resolve();
    await vi.waitFor(() => expect(queue.getJobs()).toHaveLength(0));

    expect(complete).toHaveLength(0);
  });

  it("reports false for an unknown or finished job", () => {
    expect(queue.cancel("nope")).toBe(false);
  });
});

describe("staleness", () => {
  it("fails a job whose note gained strokes while it waited", async () => {
    // Page boundaries derive from stroke bounds, so ink added above existing
    // content renumbers every page — a stored region index would then point at
    // a different page than the one it was transcribed from.
    getNote.mockResolvedValue({ id: "n1", strokes: [stroke("s1"), stroke("s2")] });

    queue.enqueue("n1", [stroke("s1")]);

    await vi.waitFor(() => {
      const job = queue.getJobs().find((j) => j.noteId === "n1");
      expect(job?.state).toBe("failed");
    });
    expect(forceRecognition).not.toHaveBeenCalled();
  });

  it("does not re-queue a stale job, so writing does not loop forever", async () => {
    // Auto-re-queueing would bill the user for a lap every time they add a
    // stroke. The job fails visibly and waits to be re-run.
    getNote.mockResolvedValue({ id: "n1", strokes: [stroke("s1"), stroke("s2")] });

    queue.enqueue("n1", [stroke("s1")]);

    await vi.waitFor(() => {
      expect(queue.getJobs().find((j) => j.noteId === "n1")?.state).toBe("failed");
    });

    // Give a re-queue a chance to happen, then confirm it did not.
    await new Promise((r) => setTimeout(r, 20));
    expect(queue.getJobs().filter((j) => j.state === "queued")).toHaveLength(0);
    expect(forceRecognition).not.toHaveBeenCalled();
  });

  it("ignores soft-deleted strokes when comparing", async () => {
    // Erasing marks strokes deleted rather than removing them. Counting them
    // would fail every job on a note the user has ever erased on.
    getNote.mockResolvedValue({
      id: "n1",
      strokes: [stroke("s1"), { ...stroke("s2"), _deleted: true }],
    });

    queue.enqueue("n1", [stroke("s1")]);

    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalled());
  });

  it("runs anyway when the note cannot be read", async () => {
    // A failed verification must not block recognition — the compare-before-
    // write in performRecognition is the real guard against clobbering.
    getNote.mockRejectedValue(new Error("db down"));

    queue.enqueue("n1", [stroke("s1")]);

    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalled());
  });
});

describe("events", () => {
  it("announces queue position so a waiting job can explain itself", async () => {
    // A progress bar at 0% because another note is transcribing is
    // indistinguishable from a hang unless the dialog can say why.
    const states = listen("recognition-job-state");
    const hold = deferred();
    forceRecognition.mockImplementationOnce(async () => {
      await hold.promise;
      return RESULT;
    });

    queue.enqueue("n1", [stroke("s1")]);
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalled());
    const second = queue.enqueue("n2", [stroke("s1")]);

    const queuedEvent = states.find((d) => d.jobId === second.id && d.state === "queued");
    expect(queuedEvent.queuePosition).toBe(0);

    hold.resolve();
  });

  it("reports the note as complete so an open canvas can re-highlight", async () => {
    // The canvas ignores source:"local" datachange events, which is what a
    // recognition write is — so without this it would never learn.
    const complete = listen("recognition-job-complete");

    queue.enqueue("n1", [stroke("s1")]);

    await vi.waitFor(() => expect(complete).toHaveLength(1));
    expect(complete[0]).toEqual({ noteId: "n1", recognition: RESULT });
  });

  it("forwards progress with the running word count", async () => {
    const progress = listen("recognition-job-progress");
    forceRecognition.mockImplementationOnce(async (_id, _s, opts) => {
      opts.onProgress("transcribe", 1, 3, { words: 12 });
      return RESULT;
    });

    queue.enqueue("n1", [stroke("s1")]);

    await vi.waitFor(() => expect(progress).toHaveLength(1));
    expect(progress[0]).toMatchObject({ phase: "transcribe", current: 1, total: 3, words: 12 });
  });

  it("brackets the whole drain with start/end, not each job", async () => {
    // footer.js's existing binary indicator would otherwise flicker off and on
    // between consecutive notes.
    const starts = listen("recognition-start");
    const ends = listen("recognition-end");

    queue.enqueue("n1", [stroke("s1")]);
    queue.enqueue("n2", [stroke("s1")]);

    await vi.waitFor(() => expect(ends).toHaveLength(1));
    expect(starts).toHaveLength(1);
  });
});

describe("job requests", () => {
  it("runs as a forced, user-initiated recognition", async () => {
    // force:true so re-running with a different model is not a silent no-op,
    // and NOT automatic — the queue is only ever entered because a user asked.
    queue.enqueue("n1", [stroke("s1")]);

    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalled());
    const opts = forceRecognition.mock.calls[0][2];
    expect(opts.force).toBe(true);
    expect(opts.automatic).toBeUndefined();
  });

  it("sends the strokes captured at enqueue, not the note's current ones", async () => {
    // The job owns its array; later edits to the caller's array must not change
    // what gets rendered.
    const strokes = [stroke("s1")];
    queue.enqueue("n1", strokes);
    strokes.push(stroke("s2"));

    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalled());
    expect(forceRecognition.mock.calls[0][1]).toHaveLength(1);
  });
});

describe("finished jobs", () => {
  it("keeps a failure visible until dismissed", async () => {
    // A failure nobody saw is the one that matters.
    forceRecognition.mockResolvedValue(null);

    queue.enqueue("n1", [stroke("s1")]);

    await vi.waitFor(() => {
      expect(queue.getJobs().find((j) => j.noteId === "n1")?.state).toBe("failed");
    });

    queue.clearFinished();
    expect(queue.getJobs()).toHaveLength(0);
  });

  it("treats a null result as a failure rather than a success", async () => {
    // forceRecognition returns null when the backend failed or produced
    // nothing; reporting that as done would hide the problem.
    const complete = listen("recognition-job-complete");
    forceRecognition.mockResolvedValue(null);

    queue.enqueue("n1", [stroke("s1")]);

    await vi.waitFor(() => {
      expect(queue.getJobs().find((j) => j.noteId === "n1")?.state).toBe("failed");
    });
    expect(complete).toHaveLength(0);
  });
});

describe("persistence", () => {
  it("writes a job to durable storage when it is queued", async () => {
    queue.enqueue("n1", [stroke("s1")], { backend: "replicate", model: "owner/name" });
    await vi.waitFor(() => expect(persisted.some((j) => j.noteId === "n1")).toBe(true));
  });

  it("checkpoints each band as it lands", async () => {
    // The point of persisting: an interruption costs one page, not the note.
    forceRecognition.mockImplementationOnce(async (_id, _s, opts) => {
      await opts.onBandComplete(0, [{ text: "a" }], { contentY: 0, contentHeight: 10 });
      await opts.onBandComplete(1, [{ text: "b" }], { contentY: 10, contentHeight: 10 });
      return RESULT;
    });

    const job = queue.enqueue("n1", [stroke("s1")]);

    // Observed mid-run: after two bands the record must already name band 2 as
    // the resume point, before the job as a whole finishes.
    await vi.waitFor(() => {
      const seen = saveRecognitionJob.mock.calls.map(([j]) => j).filter((j) => j.id === job.id);
      const checkpoint = seen.find((j) => j.bandIndex === 2);
      expect(checkpoint?.bandResults).toHaveLength(2);
    });
  });

  it("drops the checkpoint when the run restarts from the first page", async () => {
    // The note shrank, so the resume state no longer fits it and the run starts
    // over. Left in place, the restarted pages would append onto results
    // describing ink the note no longer has — and an interruption mid-restart
    // would resume by stitching them onto it.
    forceRecognition.mockImplementationOnce(async (_id, _s, opts) => {
      await opts.onBandComplete(0, [{ text: "a" }], { contentY: 0, contentHeight: 10 });
      await opts.onBandComplete(1, [{ text: "b" }], { contentY: 10, contentHeight: 10 });
      await opts.onResetBands();
      await opts.onBandComplete(0, [{ text: "fresh" }], { contentY: 0, contentHeight: 10 });
      return RESULT;
    });

    const job = queue.enqueue("n1", [stroke("s1")]);

    await vi.waitFor(() => {
      const seen = saveRecognitionJob.mock.calls.map(([j]) => j).filter((j) => j.id === job.id);
      // The last checkpoint holds the restarted page only — not the two written
      // before the reset.
      const last = seen.filter((j) => j.bandResults?.length).at(-1);
      expect(last.bandResults).toHaveLength(1);
      expect(last.bandResults[0].words).toEqual([{ text: "fresh" }]);
      expect(last.bandIndex).toBe(1);
    });
  });

  it("persists a Replicate handle before the backend waits on it", async () => {
    // A dispatched prediction is already paid for. If the handle is only stored
    // after the wait, an interruption during the wait loses it — which is
    // exactly when it is needed.
    let sawHandle = false;
    forceRecognition.mockImplementationOnce(async (_id, _s, opts) => {
      await opts.onPredictionStarted(0, "https://api.replicate.com/v1/predictions/abc");
      sawHandle = persisted.some(
        (j) => j.predictionUrl === "https://api.replicate.com/v1/predictions/abc",
      );
      return RESULT;
    });

    queue.enqueue("n1", [stroke("s1")]);
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalled());
    expect(sawHandle).toBe(true);
  });

  it("removes the record once the result is on the note", async () => {
    // Nothing left to protect — keeping it would resume finished work.
    queue.enqueue("n1", [stroke("s1")]);
    await vi.waitFor(() => expect(persisted).toHaveLength(0));
  });

  it("reports the backend's own reason for a failure", async () => {
    // The backends raise messages that name the setting to change. Reducing
    // them all to "failed" throws away the only part the user can act on.
    forceRecognition.mockImplementationOnce(async (_id, _s, opts) => {
      opts.onError(new Error('Model output was cut off — raise "Max response length".'));
      return null;
    });

    queue.enqueue("n1", [stroke("s1")]);

    await vi.waitFor(() => {
      expect(persisted.find((j) => j.noteId === "n1")?.error).toBe(
        'Model output was cut off — raise "Max response length".',
      );
    });
  });

  it("keeps a failed job on disk so it survives a restart", async () => {
    forceRecognition.mockResolvedValue(null);
    queue.enqueue("n1", [stroke("s1")]);

    await vi.waitFor(() => {
      expect(persisted.find((j) => j.noteId === "n1")?.state).toBe("failed");
    });
  });

  it("discards partial work when the strokes are replaced", async () => {
    // Re-queueing with new ink invalidates bands transcribed from the old ink.
    const hold = deferred();
    forceRecognition.mockImplementationOnce(async () => {
      await hold.promise;
      return RESULT;
    });
    queue.enqueue("n1", [stroke("s1")]); // occupies the worker
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalled());

    const first = queue.enqueue("n2", [stroke("s1")]);
    // Simulate progress on the waiting job, then supersede it.
    const rec = jobsById(first.id);
    rec.bandIndex = 2;
    rec.bandResults = [{ words: [] }, { words: [] }];

    queue.enqueue("n2", [stroke("s1"), stroke("s2")]);
    expect(jobsById(first.id).bandIndex).toBe(0);
    expect(jobsById(first.id).bandResults).toHaveLength(0);

    hold.resolve();
  });

  it("adopts the provider the note was re-queued with", async () => {
    // Re-queueing re-reads the configuration, so the provider may have changed
    // since the job was created. Recording the old one would make a restart
    // drop the job as a backend mismatch — discarding work the user asked for.
    const hold = deferred();
    forceRecognition.mockImplementationOnce(async () => {
      await hold.promise;
      return RESULT;
    });
    queue.enqueue("n1", [stroke("s1")]); // occupies the worker
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalled());

    queue.enqueue("n2", [stroke("s1")], { backend: "replicate", model: "old" });
    queue.enqueue("n2", [stroke("s1")], { backend: "openai", model: "new" });

    const stored = persisted.find((j) => j.noteId === "n2");
    expect(stored.backend).toBe("openai");
    expect(stored.model).toBe("new");

    hold.resolve();
  });

  /** Reach into the live queue record for a job. */
  function jobsById(id) {
    return queue.getJobs().find((j) => j.id === id);
  }
});

describe("resume", () => {
  /** A persisted job as a previous session would have left it. */
  function storedJob(over = {}) {
    return {
      id: "rq_old",
      noteId: "n1",
      title: "Old note",
      state: "running",
      phase: null,
      current: 0,
      total: 0,
      words: 0,
      startedAt: 1,
      error: null,
      fingerprint: "1:s1",
      backend: "replicate",
      model: "owner/name",
      bandIndex: 1,
      bandResults: [{ words: [{ text: "a" }] }],
      predictionUrl: null,
      ...over,
    };
  }

  it("continues an interrupted job from the band it reached", async () => {
    // The whole point: pages already transcribed are not paid for twice.
    persisted = [storedJob()];

    await queue.resumePersistedJobs();
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalled());

    const opts = forceRecognition.mock.calls[0][2];
    expect(opts.startBand).toBe(1);
    expect(opts.priorBands).toHaveLength(1);
  });

  it("passes a stored Replicate handle back so the prediction is collected", async () => {
    persisted = [storedJob({ predictionUrl: "https://api.replicate.com/v1/predictions/abc" })];

    await queue.resumePersistedJobs();
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalled());

    expect(forceRecognition.mock.calls[0][2].resumePrediction).toBe(
      "https://api.replicate.com/v1/predictions/abc",
    );
  });

  it("drops a job whose note changed while the app was away", async () => {
    // Page boundaries derive from stroke bounds, so partial results cannot be
    // stitched onto ink that has since moved.
    persisted = [storedJob({ fingerprint: "9:sX" })];

    await queue.resumePersistedJobs();

    expect(forceRecognition).not.toHaveBeenCalled();
    expect(queue.getJobs().find((j) => j.id === "rq_old")?.state).toBe("failed");
  });

  it("refuses to resume into a different backend", async () => {
    // Half the bands from one engine and half from another is not a result, and
    // a Replicate handle means nothing to an OpenAI-compatible endpoint.
    getRecognitionConfig.mockResolvedValue({ method: "ai", provider: "openai", model: "other" });
    persisted = [storedJob()];

    await queue.resumePersistedJobs();

    expect(forceRecognition).not.toHaveBeenCalled();
  });

  it("shows a backend mismatch as a failure rather than deleting the work", async () => {
    // The bands already transcribed were paid for. Discarding them silently on
    // a config comparison left the user with no sign it had happened; surfacing
    // it as a failure — the same treatment a stale job gets — lets them switch
    // the provider back or re-run deliberately.
    getRecognitionConfig.mockResolvedValue({ method: "ai", provider: "openai", model: "other" });
    persisted = [storedJob()];

    await queue.resumePersistedJobs();

    const job = queue.getJobs().find((j) => j.id === "rq_old");
    expect(job?.state).toBe("failed");
    expect(job?.error).toBe("backend-changed");
    expect(persisted).toHaveLength(1);
  });

  it("drops a job whose note no longer exists", async () => {
    getNote.mockResolvedValue(null);
    persisted = [storedJob()];

    await queue.resumePersistedJobs();

    expect(forceRecognition).not.toHaveBeenCalled();
    expect(persisted).toHaveLength(0);
  });

  it("does not auto-retry a job that failed before the restart", async () => {
    // Retrying on every launch would bill the user repeatedly for a note that
    // may simply be unrecognizable. It is shown, not re-run.
    persisted = [storedJob({ state: "failed", error: "boom" })];

    await queue.resumePersistedJobs();

    expect(forceRecognition).not.toHaveBeenCalled();
    expect(queue.getJobs().find((j) => j.id === "rq_old")?.state).toBe("failed");
  });

  it("does not restore a job twice", async () => {
    persisted = [storedJob()];

    await queue.resumePersistedJobs();
    await queue.resumePersistedJobs();

    expect(queue.getJobs().filter((j) => j.id === "rq_old")).toHaveLength(1);
  });

  it("survives an unreadable job store", async () => {
    getRecognitionJobs.mockRejectedValueOnce(new Error("db gone"));
    await expect(queue.resumePersistedJobs()).resolves.toBe(0);
  });
});

describe("per-run prompt options", () => {
  /**
   * Whether punctuation is transcribed is chosen once, in the confirmation
   * dialog, and then has to survive everything the queue does to a job —
   * waiting behind other work, being re-queued, and being resumed in a later
   * session. Re-reading it from settings at run time would mean the run used
   * something other than what the user agreed to when they pressed Start.
   */
  function optsOfFirstRun() {
    return forceRecognition.mock.calls[0][2];
  }

  /** A job as a previous session would have left it on disk. */
  function interruptedJob(over = {}) {
    return {
      id: "rq_old",
      noteId: "n1",
      title: "Old note",
      state: "running",
      phase: null,
      current: 0,
      total: 0,
      words: 0,
      startedAt: 1,
      error: null,
      fingerprint: "1:s1",
      backend: "replicate",
      model: "owner/name",
      bandIndex: 1,
      bandResults: [{ words: [{ text: "a" }] }],
      predictionUrl: null,
      ...over,
    };
  }

  it("sends the confirmed choice into the run", async () => {
    queue.enqueue("n1", [stroke("s1")], { punctuation: false, breaks: true });
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalled());

    expect(optsOfFirstRun().configOverride).toEqual({ punctuation: false, breaks: true });
  });

  it("transcribes punctuation when the dialog said nothing", async () => {
    // The option is an opt-out. A caller that omits it must get the behaviour
    // every run had before the option existed, not the stripped one.
    queue.enqueue("n1", [stroke("s1")]);
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalled());

    // Punctuation on, layout off — each field's own default.
    expect(optsOfFirstRun().configOverride).toEqual({ punctuation: true, breaks: false });
  });

  it("keeps the choice across a resume in a later session", async () => {
    // The bands already transcribed were produced under this choice; finishing
    // the note under the other one would stitch two transcription styles into
    // a single result.
    persisted = [interruptedJob({ punctuation: false, breaks: true })];

    await queue.resumePersistedJobs();
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalled());

    expect(optsOfFirstRun().configOverride).toEqual({ punctuation: false, breaks: true });
  });

  it("falls back to the same defaults enqueue uses when a job record lacks them", async () => {
    // enqueue() always writes both as explicit booleans, so this only covers a
    // record that somehow arrives without them. The fallbacks match enqueue's
    // own defaults — punctuation on, layout off — so a run can never transcribe
    // under options the confirmation dialog never offered.
    persisted = [interruptedJob()];

    await queue.resumePersistedJobs();
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalled());

    expect(optsOfFirstRun().configOverride).toEqual({ punctuation: true, breaks: false });
  });

  it("applies the newer choice when a waiting job is re-queued", async () => {
    // Re-queueing re-reads the dialog, so the second answer is the operative
    // one — the same rule the backend and model fields already follow.
    const held = deferred();
    getNote.mockImplementation(async (id) => ({
      id,
      strokes: [stroke(id === "blocker" ? "sB" : "s1")],
    }));
    forceRecognition.mockImplementationOnce(async () => {
      await held.promise;
      return RESULT;
    });
    queue.enqueue("blocker", [stroke("sB")]);
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalledTimes(1));

    queue.enqueue("n1", [stroke("s1")], { punctuation: true, breaks: false });
    queue.enqueue("n1", [stroke("s1")], { punctuation: false, breaks: true });

    held.resolve();
    await vi.waitFor(() => expect(forceRecognition).toHaveBeenCalledTimes(2));
    expect(forceRecognition.mock.calls[1][2].configOverride).toEqual({
      punctuation: false,
      breaks: true,
    });
  });
});
