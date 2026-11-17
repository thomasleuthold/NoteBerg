/**
 * The Nextcloud app's note-file worker (review P4, 4.7): runs noteFileOps.js
 * off the main thread. Requests carry `{id, op, payload}`; each answer is
 * `{id, result}` or `{id, error}`. Requests run concurrently; the main thread's
 * per-note write queue (storage.webdav.js) keeps writes of one note in order.
 */

import { DOMParser } from "linkedom";
import { NOTE_FILE_OPS } from "../noteFileOps.js";
import { useHtmlParser } from "../textMerge.js";

// No DOM in a worker: the text merge parses HTML with linkedom's parser
useHtmlParser(DOMParser);

self.onmessage = async (event) => {
  const { id, op, payload } = event.data ?? {};
  try {
    const run = NOTE_FILE_OPS[op];
    if (!run) throw new Error(`Unknown note-file operation ${op}`);
    self.postMessage({ id, result: await run(payload) });
  } catch (error) {
    self.postMessage({ id, error: { message: error?.message ?? String(error) } });
  }
};
