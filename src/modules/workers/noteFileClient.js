/**
 * Runs a note-file operation (noteFileOps.js) in the note-file worker, or inline
 * where there is no worker: in tests, and in a browser that refuses to start one
 * (a content security policy without `worker-src`). Both run the same code, so a
 * refused worker costs smoothness, never correctness.
 */

import { NOTE_FILE_OPS } from "../noteFileOps.js";

let worker = null;
let unavailable = typeof Worker === "undefined";
let nextId = 0;
const pending = new Map(); // id -> { op, payload, resolve, reject }

/** Give up on the worker; whatever it was asked is done inline instead. */
function fallBackInline(reason) {
  if (unavailable) return;
  console.warn("[NoteFile] Worker unavailable, working on the main thread:", reason);
  unavailable = true;
  worker = null;
  const waiting = [...pending.values()];
  pending.clear();
  for (const job of waiting) runInline(job.op, job.payload).then(job.resolve, job.reject);
}

function runInline(op, payload) {
  const run = NOTE_FILE_OPS[op];
  if (!run) return Promise.reject(new Error(`Unknown note-file operation ${op}`));
  return Promise.resolve().then(() => run(payload));
}

function getWorker() {
  if (unavailable) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./noteFileWorker.js", import.meta.url), { type: "module" });
  } catch (error) {
    fallBackInline(error);
    return null;
  }
  worker.onmessage = (event) => {
    const { id, result, error } = event.data ?? {};
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    if (error) job.reject(new Error(error.message));
    else job.resolve(result);
  };
  // A worker that cannot load (blocked by policy, a failed chunk) fails here
  worker.onerror = (event) => {
    event?.preventDefault?.();
    fallBackInline(event?.message ?? "worker error");
  };
  return worker;
}

/**
 * @param {keyof typeof NOTE_FILE_OPS} op
 * @param {object} payload - structured-cloneable
 * @returns {Promise<any>}
 */
export function runNoteFileOp(op, payload) {
  const target = getWorker();
  if (!target) return runInline(op, payload);
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { op, payload, resolve, reject });
    target.postMessage({ id, op, payload });
  });
}
