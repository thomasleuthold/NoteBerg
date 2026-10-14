/**
 * src/components/NoteCanvas/RecordingManager.test.js
 * Covers the state machine (recording/paused), elapsed-time math (pause
 * accounting), soft-delete + deletedRecordings tracking, and the native-stop
 * completion flow including its failure paths.
 *
 * There is only a native path: the Nextcloud build, the one build without
 * Tauri, never renders the "New recording" button, so the browser
 * getUserMedia/MediaRecorder path was unreachable everywhere and has been
 * removed. Every test therefore loads the module with
 * window.__TAURI_INTERNALS__ set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args) => invokeMock(...args),
}));

const generateId = vi.fn();
const saveFile = vi.fn();
vi.mock("../../modules/storage.js", () => ({
  generateId: (...args) => generateId(...args),
  saveFile: (...args) => saveFile(...args),
}));

const getAutoGainAggressiveness = vi.fn();
vi.mock("../../modules/audioSettings.js", () => ({
  getAutoGainAggressiveness: (...args) => getAutoGainAggressiveness(...args),
}));

const loggerWarning = vi.fn();
vi.mock("../../utils/logger.js", () => ({
  logger: {
    warning: (...args) => loggerWarning(...args),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

let idCounter;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  idCounter = 0;
  generateId.mockImplementation(() => `rec-${++idCounter}`);
  saveFile.mockResolvedValue("file-1");
  invokeMock.mockResolvedValue(undefined);
  getAutoGainAggressiveness.mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.__TAURI_INTERNALS__;
});

async function loadManager() {
  window.__TAURI_INTERNALS__ = {};
  vi.resetModules();
  const { RecordingManager } = await import("./RecordingManager.js");
  return RecordingManager;
}

/**
 * invoke stub for a recording that stops successfully and yields a file.
 * Models the chunked read the way Rust serves it: `native_audio_file_size`
 * reports the length, and each `native_audio_read_chunk` returns the requested
 * slice as an ArrayBuffer (what invoke() resolves a tauri::ipc::Response to).
 */
function stubSuccessfulStop({
  path = "/tmp/rec.mp4",
  mimeType = "audio/mp4",
  bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
} = {}) {
  invokeMock.mockImplementation((cmd, args) => {
    if (cmd === "native_audio_stop") return Promise.resolve({ path, mimeType });
    if (cmd === "native_audio_file_size") return Promise.resolve(bytes.length);
    if (cmd === "native_audio_read_chunk") {
      const { offset, len } = args;
      return Promise.resolve(bytes.slice(offset, offset + len).buffer);
    }
    return Promise.resolve();
  });
}

describe("setRecordings / getRecordings", () => {
  it("filters out soft-deleted recordings", async () => {
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();
    rm.setRecordings([
      { id: "a", deleted: false },
      { id: "b", deleted: true },
    ]);
    expect(rm.getRecordings().map((r) => r.id)).toEqual(["a"]);
  });

  it("resets deletedRecordings when a fresh list is set", async () => {
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();
    rm.deletedRecordings = ["stale-file"];
    rm.setRecordings([]);
    expect(rm.deletedRecordings).toEqual([]);
  });

  it("treats a non-array as an empty list", async () => {
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();
    rm.setRecordings(null);
    expect(rm.getRecordings()).toEqual([]);
  });
});

describe("deleteRecording", () => {
  it("soft-deletes and tracks the fileId for cleanup", async () => {
    const RecordingManager = await loadManager();
    const onSave = vi.fn();
    const onChange = vi.fn();
    const rm = new RecordingManager({ onSave, onChange });
    rm.setRecordings([{ id: "a", fileId: "f1", deleted: false }]);

    rm.deleteRecording("a");

    expect(rm.getRecordings()).toEqual([]);
    expect(rm.deletedRecordings).toEqual(["f1"]);
    expect(onSave).toHaveBeenCalledWith({
      recordings: [{ id: "a", fileId: "f1", deleted: true }],
      deletedRecordings: ["f1"],
    });
    expect(onChange).toHaveBeenCalled();
  });

  it("is a no-op for an unknown id", async () => {
    const RecordingManager = await loadManager();
    const onSave = vi.fn();
    const rm = new RecordingManager({ onSave });
    rm.setRecordings([{ id: "a", deleted: false }]);

    rm.deleteRecording("does-not-exist");

    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not add to deletedRecordings when the recording has no fileId", async () => {
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();
    rm.setRecordings([{ id: "a", deleted: false }]); // no fileId
    rm.deleteRecording("a");
    expect(rm.deletedRecordings).toEqual([]);
  });
});

describe("getElapsed", () => {
  it("returns 0 before recording starts", async () => {
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();
    expect(rm.getElapsed()).toBe(0);
  });

  it("counts elapsed seconds since recording start", async () => {
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();
    await rm.startRecording();
    vi.advanceTimersByTime(5000);
    expect(rm.getElapsed()).toBe(5);
  });

  it("excludes time spent paused", async () => {
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();
    await rm.startRecording();
    vi.advanceTimersByTime(3000);
    rm.pauseRecording();
    vi.advanceTimersByTime(4000); // paused time should not count
    rm.resumeRecording();
    vi.advanceTimersByTime(2000);
    expect(rm.getElapsed()).toBe(5); // 3s + 2s, not the 4s paused gap
  });
});

describe("start/pause/resume guards", () => {
  it("startRecording is a no-op while already recording", async () => {
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();

    await rm.startRecording();
    const firstId = rm._recordingId;
    const startCalls = invokeMock.mock.calls.filter((c) => c[0] === "native_audio_start").length;

    await rm.startRecording();

    expect(rm._recordingId).toBe(firstId);
    expect(invokeMock.mock.calls.filter((c) => c[0] === "native_audio_start")).toHaveLength(
      startCalls,
    );
  });

  it("pauseRecording is a no-op when not recording or already paused", async () => {
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();

    rm.pauseRecording(); // not recording at all
    expect(rm.isPaused()).toBe(false);

    await rm.startRecording();
    rm.pauseRecording();
    const pauseStart = rm._pauseStart;
    rm.pauseRecording(); // already paused
    expect(rm._pauseStart).toBe(pauseStart);
  });

  it("resumeRecording is a no-op when not paused", async () => {
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();

    await rm.startRecording();
    rm.resumeRecording(); // recording, but never paused

    expect(rm.isPaused()).toBe(false);
    expect(rm._pausedDuration).toBe(0);
    expect(invokeMock).not.toHaveBeenCalledWith("native_audio_resume", undefined);
  });

  it("stopRecording is a no-op when not recording", async () => {
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();

    rm.stopRecording();

    expect(invokeMock).not.toHaveBeenCalledWith("native_audio_stop");
  });
});

describe("amplitude meter", () => {
  it("polls the native amplitude while recording and reports it", async () => {
    const RecordingManager = await loadManager();
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "native_audio_get_amplitude") return Promise.resolve({ amplitude: 0.42 });
      return Promise.resolve();
    });
    const rm = new RecordingManager();

    expect(rm.getAmplitude()).toBe(0);

    await rm.startRecording();
    await vi.advanceTimersByTimeAsync(150); // one 100ms poll tick

    expect(rm.getAmplitude()).toBeCloseTo(0.42);
  });

  it("reports zero amplitude while paused and stops polling", async () => {
    const RecordingManager = await loadManager();
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "native_audio_get_amplitude") return Promise.resolve({ amplitude: 0.42 });
      return Promise.resolve();
    });
    const rm = new RecordingManager();

    await rm.startRecording();
    await vi.advanceTimersByTimeAsync(150);
    rm.pauseRecording();

    expect(rm.getAmplitude()).toBe(0);

    const pollsBefore = invokeMock.mock.calls.filter(
      (c) => c[0] === "native_audio_get_amplitude",
    ).length;
    await vi.advanceTimersByTimeAsync(500);
    expect(invokeMock.mock.calls.filter((c) => c[0] === "native_audio_get_amplitude")).toHaveLength(
      pollsBefore,
    );
  });
});

describe("importFile", () => {
  it("saves the given file as a new recording with the given duration", async () => {
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();
    const file = new Blob(["audio"]);

    await rm.importFile(file, 12.7);

    expect(saveFile).toHaveBeenCalledWith(file);
    expect(rm.recordings[0]).toMatchObject({ fileId: "file-1", duration: 13 }); // rounded
  });

  it("reports via onChange (not throw) when saveFile fails on import", async () => {
    const RecordingManager = await loadManager();
    saveFile.mockRejectedValue(new Error("disk full"));
    const onChange = vi.fn();
    const rm = new RecordingManager({ onChange });

    await expect(rm.importFile(new Blob(["audio"]), 5)).resolves.toBeUndefined();

    expect(rm.recordings).toHaveLength(0);
    expect(onChange).toHaveBeenCalled();
  });
});

describe("native recording (Android/Tauri)", () => {
  it("starts native recording via invoke and reflects isRecording/isPaused", async () => {
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();

    await rm.startRecording();
    expect(invokeMock).toHaveBeenCalledWith("native_audio_start", { aggressiveness: 0 });
    expect(rm.isRecording()).toBe(true);

    rm.pauseRecording();
    expect(rm.isPaused()).toBe(true);
    // _fireAndForget resolves the dynamic invoke import asynchronously, and
    // calls invoke(cmd, undefined) since no args are passed for pause/resume.
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("native_audio_pause", undefined),
    );

    rm.resumeRecording();
    expect(rm.isPaused()).toBe(false);
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("native_audio_resume", undefined),
    );
  });

  it("clears recording state and rethrows when native_audio_start fails", async () => {
    const RecordingManager = await loadManager();
    invokeMock.mockRejectedValue(new Error("mic unavailable"));
    const rm = new RecordingManager();

    await expect(rm.startRecording()).rejects.toThrow("mic unavailable");
    expect(rm._recordingId).toBeNull();
    expect(rm.isRecording()).toBe(false);
  });

  // M-02: a fresh install must request the microphone permission at runtime.
  // When the native plugin reports the permission was denied, RecordingManager
  // must surface it as NotAllowedError so the UI shows the actionable
  // "permission denied" message rather than the generic failure text.
  it("maps a native permission-denied rejection to NotAllowedError", async () => {
    const RecordingManager = await loadManager();
    invokeMock.mockRejectedValue(new Error("native_audio_start: Microphone permission denied"));
    const rm = new RecordingManager();

    await expect(rm.startRecording()).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(rm.isRecording()).toBe(false);
  });

  // A no-input-device error (e.g. a machine without a microphone, or an RDP
  // session without forwarded audio) must surface as NotFoundError so the UI
  // shows the "no microphone found" message instead of the generic failure.
  it("maps a native no-input-device rejection to NotFoundError", async () => {
    const RecordingManager = await loadManager();
    invokeMock.mockRejectedValue(new Error("No audio input device found"));
    const rm = new RecordingManager();

    await expect(rm.startRecording()).rejects.toMatchObject({ name: "NotFoundError" });
    expect(rm.isRecording()).toBe(false);
  });

  it("does not tag an unrelated native failure as a known error name", async () => {
    const RecordingManager = await loadManager();
    invokeMock.mockRejectedValue(new Error("native_audio_start: recorder init failed"));
    const rm = new RecordingManager();

    await expect(rm.startRecording()).rejects.toSatisfy(
      (err) => err.name !== "NotAllowedError" && err.name !== "NotFoundError",
    );
  });

  it("reads the native file, saves it, and appends the recording on stop", async () => {
    const RecordingManager = await loadManager();
    stubSuccessfulStop();
    const onSave = vi.fn();
    const rm = new RecordingManager({ onSave });

    await rm.startRecording();
    rm.stopRecording();
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalled());

    expect(rm.recordings).toHaveLength(1);
    expect(rm.recordings[0].fileId).toBe("file-1");
    expect(onSave).toHaveBeenCalled();
  });

  // F4: the old base64 hand-off threw "Invalid string length" past ~403 MB and
  // cost 5-6x the file size in transient memory well before that. The file now
  // crosses in 4 MB binary pieces, so a file larger than one chunk must be
  // reassembled in order and completely.
  it("reassembles a multi-chunk file in order", async () => {
    const RecordingManager = await loadManager();
    const CHUNK = 4 * 1024 * 1024;
    // Two full chunks plus a partial one, each filled with a distinct byte so
    // out-of-order or dropped pieces are detectable.
    const bytes = new Uint8Array(CHUNK * 2 + 1234);
    bytes.fill(0xaa, 0, CHUNK);
    bytes.fill(0xbb, CHUNK, CHUNK * 2);
    bytes.fill(0xcc, CHUNK * 2);
    stubSuccessfulStop({ bytes });
    const rm = new RecordingManager();

    await rm.startRecording();
    rm.stopRecording();
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalled());

    const reads = invokeMock.mock.calls.filter((c) => c[0] === "native_audio_read_chunk");
    expect(reads).toHaveLength(3);
    expect(reads.map((c) => c[1].offset)).toEqual([0, CHUNK, CHUNK * 2]);
    expect(reads[2][1].len).toBe(1234);

    const blob = saveFile.mock.calls[0][0];
    expect(blob.size).toBe(bytes.length);
    const got = new Uint8Array(await blob.arrayBuffer());
    expect(got[0]).toBe(0xaa);
    expect(got[CHUNK]).toBe(0xbb);
    expect(got[CHUNK * 2]).toBe(0xcc);
    expect(got[got.length - 1]).toBe(0xcc);
  });

  it("deletes the temp file only after the blob is stored", async () => {
    const RecordingManager = await loadManager();
    stubSuccessfulStop({ path: "/tmp/rec.mp4" });
    const rm = new RecordingManager();

    await rm.startRecording();
    rm.stopRecording();
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("native_audio_delete", { path: "/tmp/rec.mp4" }),
    );

    // Ordering is the point: deleting before the save would destroy the only
    // copy if saveFile rejected.
    const saveOrder = invokeMock.mock.calls.findIndex((c) => c[0] === "native_audio_delete");
    const lastRead = invokeMock.mock.calls.map((c) => c[0]).lastIndexOf("native_audio_read_chunk");
    expect(saveOrder).toBeGreaterThan(lastRead);
  });

  it("keeps the temp file and tells the user when saving the blob fails", async () => {
    const RecordingManager = await loadManager();
    stubSuccessfulStop({ path: "/tmp/rec.mp4", mimeType: "audio/mp4" });
    const diskFull = new Error("disk full");
    saveFile.mockRejectedValue(diskFull);
    const onSaveFailed = vi.fn();
    const rm = new RecordingManager({ onSaveFailed });

    await rm.startRecording();
    rm.stopRecording();
    await vi.waitFor(() => expect(onSaveFailed).toHaveBeenCalled());

    // The temp file is the only copy left: it must survive, and the user must
    // be offered to keep it, or the startup sweep deletes it unseen.
    expect(invokeMock).not.toHaveBeenCalledWith("native_audio_delete", expect.anything());
    expect(onSaveFailed).toHaveBeenCalledWith({
      path: "/tmp/rec.mp4",
      mimeType: "audio/mp4",
      error: diskFull,
    });
  });

  it("tells the user when the recording file cannot be read", async () => {
    const RecordingManager = await loadManager();
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "native_audio_stop") {
        return Promise.resolve({ path: "/tmp/rec.m4a", mimeType: "audio/mp4" });
      }
      if (cmd === "native_audio_file_size") return Promise.reject(new Error("io error"));
      return Promise.resolve();
    });
    const onSaveFailed = vi.fn();
    const rm = new RecordingManager({ onSaveFailed });

    await rm.startRecording();
    rm.stopRecording();
    await vi.waitFor(() => expect(onSaveFailed).toHaveBeenCalled());

    expect(saveFile).not.toHaveBeenCalled();
    expect(onSaveFailed.mock.calls[0][0]).toMatchObject({ path: "/tmp/rec.m4a" });
  });

  it("does not report a failure when the recording is stored", async () => {
    const RecordingManager = await loadManager();
    stubSuccessfulStop();
    const onSaveFailed = vi.fn();
    const rm = new RecordingManager({ onSaveFailed });

    await rm.startRecording();
    rm.stopRecording();
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("native_audio_delete", expect.anything()),
    );
    expect(onSaveFailed).not.toHaveBeenCalled();
  });

  it("stores the blob with the mime type the native side reported", async () => {
    const RecordingManager = await loadManager();
    stubSuccessfulStop({ path: "/tmp/noteberg_rec_1.wav", mimeType: "audio/wav" });
    const rm = new RecordingManager();

    await rm.startRecording();
    rm.stopRecording();
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalled());

    expect(saveFile.mock.calls[0][0].type).toBe("audio/wav");
  });

  it("records the elapsed duration, excluding paused time, on the saved recording", async () => {
    const RecordingManager = await loadManager();
    stubSuccessfulStop();
    const rm = new RecordingManager();

    await rm.startRecording();
    vi.advanceTimersByTime(6000);
    rm.pauseRecording();
    vi.advanceTimersByTime(10000); // paused — must not count
    rm.resumeRecording();
    vi.advanceTimersByTime(2000);
    rm.stopRecording();
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalled());

    expect(rm.recordings[0].duration).toBe(8);
  });

  it("does nothing (via onChange) when native stop returns no path", async () => {
    const RecordingManager = await loadManager();
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "native_audio_stop") return Promise.resolve({});
      return Promise.resolve();
    });
    const onChange = vi.fn();
    const rm = new RecordingManager({ onChange });

    await rm.startRecording();
    rm.stopRecording();
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("native_audio_stop"));

    expect(saveFile).not.toHaveBeenCalled();
  });

  it("reports via onChange (not throw) when reading the native file fails", async () => {
    const RecordingManager = await loadManager();
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "native_audio_stop")
        return Promise.resolve({ path: "/tmp/rec.mp4", mimeType: "audio/mp4" });
      if (cmd === "native_audio_file_size") return Promise.resolve(1024);
      if (cmd === "native_audio_read_chunk")
        return Promise.reject(new Error("Failed to read recording file"));
      return Promise.resolve();
    });
    const onChange = vi.fn();
    const rm = new RecordingManager({ onChange });

    await rm.startRecording();
    rm.stopRecording();
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("native_audio_read_chunk", {
        path: "/tmp/rec.mp4",
        offset: 0,
        len: 1024,
      }),
    );

    expect(saveFile).not.toHaveBeenCalled();
    expect(rm.recordings).toHaveLength(0);
    expect(rm.isRecording()).toBe(false);
  });

  it("reports via onChange (not throw) when saveFile fails after a native stop", async () => {
    const RecordingManager = await loadManager();
    stubSuccessfulStop();
    saveFile.mockRejectedValue(new Error("disk full"));
    const onChange = vi.fn();
    const rm = new RecordingManager({ onChange, onSaveFailed: vi.fn() });

    await rm.startRecording();
    rm.stopRecording();
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalled());

    expect(rm.recordings).toHaveLength(0);
    expect(onChange).toHaveBeenCalled();
  });

  it("clears recording state when native_audio_stop itself fails", async () => {
    const RecordingManager = await loadManager();
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "native_audio_stop") return Promise.reject(new Error("recorder gone"));
      return Promise.resolve();
    });
    const rm = new RecordingManager();

    await rm.startRecording();
    rm.stopRecording();
    await vi.waitFor(() => expect(rm._recordingId).toBeNull());

    expect(rm.isRecording()).toBe(false);
    expect(saveFile).not.toHaveBeenCalled();
  });

  // Closing a note used to send native_audio_cancel, discarding an in-progress
  // recording silently. Navigating away mid-sentence must keep the audio.
  it("stops and saves an in-progress recording on destroy", async () => {
    const RecordingManager = await loadManager();
    stubSuccessfulStop();
    const rm = new RecordingManager();

    await rm.startRecording();
    const destroyed = rm.destroy();
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalled());
    await destroyed;

    expect(rm.recordings).toHaveLength(1);
    expect(invokeMock).not.toHaveBeenCalledWith("native_audio_cancel");
  });

  it("resolves the destroy promise only once the recording is saved", async () => {
    const RecordingManager = await loadManager();
    let releaseSave;
    saveFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSave = () => resolve("file-1");
        }),
    );
    stubSuccessfulStop();
    const rm = new RecordingManager();

    await rm.startRecording();
    let settled = false;
    const destroyed = rm.destroy().then(() => {
      settled = true;
    });

    // The save is still in flight: NoteCanvas.destroy() must keep waiting, or
    // the note's own save and sync would run without the new recording.
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalled());
    expect(settled).toBe(false);

    releaseSave();
    await destroyed;
    expect(settled).toBe(true);
    expect(rm.recordings).toHaveLength(1);
  });

  it("resolves the destroy promise when there is no recording to save", async () => {
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();

    await expect(rm.destroy()).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalledWith("native_audio_stop");
  });

  it("resolves the destroy promise even when the native stop fails", async () => {
    const RecordingManager = await loadManager();
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "native_audio_stop") return Promise.reject(new Error("recorder gone"));
      return Promise.resolve();
    });
    const rm = new RecordingManager();

    await rm.startRecording();
    // Must not hang: note close would otherwise wait for the full timeout.
    await expect(rm.destroy()).resolves.toBeUndefined();
  });
});

describe("auto-gain aggressiveness", () => {
  it("starts a recording with the global default and exposes it", async () => {
    getAutoGainAggressiveness.mockReturnValue(0.7);
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();

    await rm.startRecording();

    expect(invokeMock).toHaveBeenCalledWith("native_audio_start", { aggressiveness: 0.7 });
    expect(rm.getAggressiveness()).toBe(0.7);
  });

  it("live-updates the current recording without touching the global default", async () => {
    getAutoGainAggressiveness.mockReturnValue(0.2);
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();
    await rm.startRecording();

    rm.setAggressiveness(0.9);

    expect(rm.getAggressiveness()).toBe(0.9);
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("native_audio_set_aggressiveness", {
        aggressiveness: 0.9,
      }),
    );
    // The slider is a per-recording override, made by ear while watching the
    // meter — it must not change what the *next* recording starts with.
    expect(getAutoGainAggressiveness).toHaveBeenCalledTimes(1);
  });

  it("clamps out-of-range values", async () => {
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();
    await rm.startRecording();

    rm.setAggressiveness(5);
    expect(rm.getAggressiveness()).toBe(1);

    rm.setAggressiveness(-3);
    expect(rm.getAggressiveness()).toBe(0);
  });

  it("is a no-op when nothing is recording", async () => {
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();

    rm.setAggressiveness(0.8);

    expect(rm.getAggressiveness()).toBe(0);
    expect(invokeMock).not.toHaveBeenCalledWith(
      "native_audio_set_aggressiveness",
      expect.anything(),
    );
  });
});

describe("stopping because the app was backgrounded", () => {
  // Android silences the mic for a background process, so a recording that
  // continued would run on and contain silence. It is stopped and kept, and
  // the user is told why.
  it("stops, saves and flags that it was not the user's doing", async () => {
    const RecordingManager = await loadManager();
    stubSuccessfulStop();
    const rm = new RecordingManager();

    await rm.startRecording();
    expect(rm.stoppedInBackground).toBe(false);

    rm.stopRecordingForBackground();
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalled());

    expect(rm.isRecording()).toBe(false);
    expect(rm.recordings).toHaveLength(1);
    expect(rm.stoppedInBackground).toBe(true);
  });

  it("is a no-op when nothing is recording", async () => {
    const RecordingManager = await loadManager();
    const rm = new RecordingManager();

    rm.stopRecordingForBackground();

    expect(rm.stoppedInBackground).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith("native_audio_stop");
  });

  it("clears the notice when it is acknowledged", async () => {
    const RecordingManager = await loadManager();
    stubSuccessfulStop();
    const onChange = vi.fn();
    const rm = new RecordingManager({ onChange });

    await rm.startRecording();
    rm.stopRecordingForBackground();
    await vi.waitFor(() => expect(rm.stoppedInBackground).toBe(true));

    rm.clearBackgroundNotice();
    expect(rm.stoppedInBackground).toBe(false);
  });

  it("clears the notice when a new recording starts", async () => {
    const RecordingManager = await loadManager();
    stubSuccessfulStop();
    const rm = new RecordingManager();

    await rm.startRecording();
    rm.stopRecordingForBackground();
    await vi.waitFor(() => expect(rm.stoppedInBackground).toBe(true));

    await rm.startRecording();
    expect(rm.stoppedInBackground).toBe(false);
  });
});

describe("capture pipeline reporting", () => {
  // On a phone that is not plugged into a development machine logcat is out of
  // reach, and a recording made by the Android MediaRecorder fallback is
  // indistinguishable from one made by the AudioRecord engine. The pipeline is
  // therefore logged at warning level, which the logger shows by default.
  it("logs which pipeline started, at warning level", async () => {
    const RecordingManager = await loadManager();
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "native_audio_start") return Promise.resolve({ pipeline: "audioRecord" });
      return Promise.resolve();
    });
    const rm = new RecordingManager();

    await rm.startRecording();

    expect(loggerWarning).toHaveBeenCalledWith(
      "RecordingManager",
      "Recording pipeline: audioRecord",
      expect.objectContaining({ pipeline: "audioRecord" }),
    );
  });

  it("includes why the engine was rejected when the fallback ran", async () => {
    const RecordingManager = await loadManager();
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "native_audio_start")
        return Promise.resolve({
          pipeline: "mediaRecorder",
          fallbackReason: "AudioRecord unavailable at any sample rate",
        });
      return Promise.resolve();
    });
    const rm = new RecordingManager();

    await rm.startRecording();

    expect(loggerWarning).toHaveBeenCalledWith(
      "RecordingManager",
      "Recording pipeline: mediaRecorder",
      expect.objectContaining({
        pipeline: "mediaRecorder",
        fallbackReason: "AudioRecord unavailable at any sample rate",
      }),
    );
  });

  it("omits the fallback reason when the preferred pipeline ran", async () => {
    const RecordingManager = await loadManager();
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "native_audio_start") return Promise.resolve({ pipeline: "windowsAac" });
      return Promise.resolve();
    });
    const rm = new RecordingManager();

    await rm.startRecording();

    const [, , data] = loggerWarning.mock.calls[0];
    expect(data).not.toHaveProperty("fallbackReason");
  });

  // The command returned nothing before this reporting existed, and an older
  // native binary paired with a newer frontend must not break recording.
  it("starts normally when the native side reports no pipeline", async () => {
    const RecordingManager = await loadManager();
    invokeMock.mockResolvedValue(undefined);
    const rm = new RecordingManager();

    await rm.startRecording();

    expect(rm.isRecording()).toBe(true);
    expect(loggerWarning).not.toHaveBeenCalled();
  });
});

describe("destroy awaits a stop it did not start", () => {
  // isRecording() goes false the moment stopRecording() is called, so a destroy
  // arriving while the stop is still reading and saving used to return
  // immediately. The recording then landed via onSave after
  // NoteCanvas.destroy() had finished, and the note's save and sync missed it.
  it("waits for a user-initiated stop that is still saving", async () => {
    const RecordingManager = await loadManager();
    let releaseSave;
    saveFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSave = () => resolve("file-1");
        }),
    );
    stubSuccessfulStop();
    const rm = new RecordingManager();

    await rm.startRecording();
    rm.stopRecording(); // the user pressed stop
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalled());
    expect(rm.isRecording()).toBe(false);

    let settled = false;
    const destroyed = rm.destroy().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSave();
    await destroyed;
    expect(settled).toBe(true);
    expect(rm.recordings).toHaveLength(1);
  });

  it("waits for a background stop that is still saving", async () => {
    const RecordingManager = await loadManager();
    let releaseSave;
    saveFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSave = () => resolve("file-1");
        }),
    );
    stubSuccessfulStop();
    const rm = new RecordingManager();

    await rm.startRecording();
    rm.stopRecordingForBackground();
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalled());

    let settled = false;
    const destroyed = rm.destroy().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSave();
    await destroyed;
    expect(settled).toBe(true);
    expect(rm.recordings).toHaveLength(1);
  });

  it("resolves immediately when no stop is in flight", async () => {
    const RecordingManager = await loadManager();
    stubSuccessfulStop();
    const rm = new RecordingManager();

    await rm.startRecording();
    rm.stopRecording();
    await vi.waitFor(() => expect(rm.recordings).toHaveLength(1));

    // The stop has fully settled; destroy must not wait on a stale handle.
    await expect(rm.destroy()).resolves.toBeUndefined();
  });
});
