/**
 * src/modules/workers/noteFileClient.test.js
 * The note-file worker is a performance measure, never a point of failure: a
 * browser that refuses to start it (a content security policy without
 * `worker-src`) gets the same work done on the main thread.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../noteFileOps.js", () => ({
  NOTE_FILE_OPS: { double: async ({ n }) => ({ where: "inline", n: n * 2 }) },
}));

let workers;

class AnsweringWorker {
  constructor() {
    workers.push(this);
  }

  postMessage({ id, payload }) {
    queueMicrotask(() =>
      this.onmessage({ data: { id, result: { where: "worker", n: payload.n * 2 } } }),
    );
  }
}

class BlockedWorker {
  constructor() {
    workers.push(this);
  }

  postMessage() {
    // The script never loads: the browser reports an error instead of answering
    queueMicrotask(() => this.onerror({ message: "blocked by CSP", preventDefault() {} }));
  }
}

beforeEach(() => {
  workers = [];
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("note-file operations", () => {
  it("run in the worker when there is one", async () => {
    vi.stubGlobal("Worker", AnsweringWorker);
    const { runNoteFileOp } = await import("./noteFileClient.js");
    await expect(runNoteFileOp("double", { n: 2 })).resolves.toEqual({ where: "worker", n: 4 });
    expect(workers).toHaveLength(1);
  });

  it("are done on the main thread when the worker cannot start, the waiting ones too", async () => {
    vi.stubGlobal("Worker", BlockedWorker);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runNoteFileOp } = await import("./noteFileClient.js");

    await expect(runNoteFileOp("double", { n: 3 })).resolves.toEqual({ where: "inline", n: 6 });
    // From then on without trying the worker again
    await expect(runNoteFileOp("double", { n: 4 })).resolves.toEqual({ where: "inline", n: 8 });
    expect(workers).toHaveLength(1);
    warn.mockRestore();
  });

  it("are done on the main thread where workers do not exist (tests, old browsers)", async () => {
    vi.stubGlobal("Worker", undefined);
    const { runNoteFileOp } = await import("./noteFileClient.js");
    await expect(runNoteFileOp("double", { n: 5 })).resolves.toEqual({ where: "inline", n: 10 });
  });
});
