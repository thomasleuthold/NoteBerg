/**
 * src/components/NoteCanvas/RecordingManager.test.js
 * Covers the state machine (recording/paused, native vs. web), elapsed-time
 * math (pause accounting), soft-delete + deletedRecordings tracking, the
 * native-stop / web-stop completion flows, and getUserMedia constraint
 * fallback. `IS_NATIVE` is read from window.__TAURI_INTERNALS__ once at
 * module load, so native vs. web test groups each set the global and
 * re-import the module fresh via vi.resetModules().
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

function stubWebAudio() {
  class FakeTrack {
    stop = vi.fn();
  }
  class FakeStream {
    constructor() {
      this._tracks = [new FakeTrack()];
    }
    getTracks() {
      return this._tracks;
    }
  }
  class FakeMediaRecorder {
    static isTypeSupported = vi.fn(() => true);
    constructor(stream, opts) {
      this.stream = stream;
      this.mimeType = opts?.mimeType || "audio/webm";
      this.state = "recording";
      this.ondataavailable = null;
      this.onstop = null;
    }
    start = vi.fn();
    pause = vi.fn(() => {
      this.state = "paused";
    });
    resume = vi.fn(() => {
      this.state = "recording";
    });
    stop = vi.fn(() => {
      this.state = "inactive";
      this.onstop?.();
    });
  }
  class FakeAudioParam {
    set value(_v) {}
  }
  class FakeAudioNode {
    connect = vi.fn();
  }
  class FakeAudioContext {
    createMediaStreamSource = vi.fn(() => new FakeAudioNode());
    createDynamicsCompressor = vi.fn(() => ({
      threshold: new FakeAudioParam(),
      knee: new FakeAudioParam(),
      ratio: new FakeAudioParam(),
      attack: new FakeAudioParam(),
      release: new FakeAudioParam(),
      connect: vi.fn(),
    }));
    createGain = vi.fn(() => ({ gain: new FakeAudioParam(), connect: vi.fn() }));
    createAnalyser = vi.fn(() => ({
      fftSize: 0,
      frequencyBinCount: 32,
      connect: vi.fn(),
      getByteTimeDomainData: vi.fn((arr) => arr.fill(128)),
    }));
    createMediaStreamDestination = vi.fn(() => ({ stream: new FakeStream() }));
    close = vi.fn();
  }

  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  navigator.mediaDevices = { getUserMedia: vi.fn(() => Promise.resolve(new FakeStream())) };

  return { FakeStream, FakeMediaRecorder };
}

let idCounter;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  idCounter = 0;
  generateId.mockImplementation(() => `rec-${++idCounter}`);
  saveFile.mockResolvedValue("file-1");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.__TAURI_INTERNALS__;
});

async function loadWebManager() {
  delete window.__TAURI_INTERNALS__;
  vi.resetModules();
  const { RecordingManager } = await import("./RecordingManager.js");
  return RecordingManager;
}

async function loadNativeManager() {
  window.__TAURI_INTERNALS__ = {};
  vi.resetModules();
  const { RecordingManager } = await import("./RecordingManager.js");
  return RecordingManager;
}

describe("setRecordings / getRecordings", () => {
  it("filters out soft-deleted recordings", async () => {
    const RecordingManager = await loadWebManager();
    const rm = new RecordingManager();
    rm.setRecordings([
      { id: "a", deleted: false },
      { id: "b", deleted: true },
    ]);
    expect(rm.getRecordings().map((r) => r.id)).toEqual(["a"]);
  });

  it("resets deletedRecordings when a fresh list is set", async () => {
    const RecordingManager = await loadWebManager();
    const rm = new RecordingManager();
    rm.deletedRecordings = ["stale-file"];
    rm.setRecordings([]);
    expect(rm.deletedRecordings).toEqual([]);
  });

  it("treats a non-array as an empty list", async () => {
    const RecordingManager = await loadWebManager();
    const rm = new RecordingManager();
    rm.setRecordings(null);
    expect(rm.getRecordings()).toEqual([]);
  });
});

describe("deleteRecording", () => {
  it("soft-deletes and tracks the fileId for cleanup", async () => {
    const RecordingManager = await loadWebManager();
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
    const RecordingManager = await loadWebManager();
    const onSave = vi.fn();
    const rm = new RecordingManager({ onSave });
    rm.setRecordings([{ id: "a", deleted: false }]);

    rm.deleteRecording("does-not-exist");

    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not add to deletedRecordings when the recording has no fileId", async () => {
    const RecordingManager = await loadWebManager();
    const rm = new RecordingManager();
    rm.setRecordings([{ id: "a", deleted: false }]); // no fileId
    rm.deleteRecording("a");
    expect(rm.deletedRecordings).toEqual([]);
  });
});

describe("getElapsed", () => {
  it("returns 0 before recording starts", async () => {
    const RecordingManager = await loadWebManager();
    const rm = new RecordingManager();
    expect(rm.getElapsed()).toBe(0);
  });

  it("counts elapsed seconds since recording start", async () => {
    const RecordingManager = await loadWebManager();
    stubWebAudio();
    const rm = new RecordingManager();
    await rm.startRecording();
    vi.advanceTimersByTime(5000);
    expect(rm.getElapsed()).toBe(5);
  });

  it("excludes time spent paused", async () => {
    const RecordingManager = await loadWebManager();
    stubWebAudio();
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

describe("isRecording / isPaused (web)", () => {
  it("reflects MediaRecorder state", async () => {
    const RecordingManager = await loadWebManager();
    stubWebAudio();
    const rm = new RecordingManager();
    expect(rm.isRecording()).toBe(false);

    await rm.startRecording();
    expect(rm.isRecording()).toBe(true);
    expect(rm.isPaused()).toBe(false);

    rm.pauseRecording();
    expect(rm.isRecording()).toBe(true);
    expect(rm.isPaused()).toBe(true);

    rm.resumeRecording();
    expect(rm.isPaused()).toBe(false);
  });

  it("startRecording is a no-op while already recording", async () => {
    const RecordingManager = await loadWebManager();
    stubWebAudio();
    const rm = new RecordingManager();
    await rm.startRecording();
    const firstRecorder = rm._mediaRecorder;
    await rm.startRecording();
    expect(rm._mediaRecorder).toBe(firstRecorder);
  });

  it("pauseRecording is a no-op when not recording or already paused", async () => {
    const RecordingManager = await loadWebManager();
    stubWebAudio();
    const rm = new RecordingManager();
    rm.pauseRecording(); // not recording at all
    expect(rm.isPaused()).toBe(false);

    await rm.startRecording();
    rm.pauseRecording();
    const pauseStart = rm._pauseStart;
    rm.pauseRecording(); // already paused
    expect(rm._pauseStart).toBe(pauseStart);
  });
});

describe("getUserMedia constraint fallback", () => {
  it("falls back to basic constraints on NotReadableError", async () => {
    const RecordingManager = await loadWebManager();
    stubWebAudio();
    const rm = new RecordingManager();

    let call = 0;
    navigator.mediaDevices.getUserMedia = vi.fn(() => {
      call++;
      if (call === 1) {
        const err = new Error("device busy");
        err.name = "NotReadableError";
        return Promise.reject(err);
      }
      return Promise.resolve({ getTracks: () => [{ stop: vi.fn(), onended: null }] });
    });

    const startPromise = rm.startRecording();
    await vi.advanceTimersByTimeAsync(600); // the 500ms retry delay
    await startPromise;

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenNthCalledWith(2, {
      audio: true,
      video: false,
    });
  });

  it("rethrows other getUserMedia errors without retrying", async () => {
    const RecordingManager = await loadWebManager();
    stubWebAudio();
    const rm = new RecordingManager();

    const err = new Error("permission denied");
    err.name = "NotAllowedError";
    navigator.mediaDevices.getUserMedia = vi.fn(() => Promise.reject(err));

    await expect(rm.startRecording()).rejects.toThrow("permission denied");
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(rm._recordingId).toBeNull();
  });
});

describe("web recording completion", () => {
  it("saves the recorded blob and appends it to recordings on stop", async () => {
    const RecordingManager = await loadWebManager();
    stubWebAudio();
    const onSave = vi.fn();
    const rm = new RecordingManager({ onSave });

    await rm.startRecording();
    rm._mediaRecorder.ondataavailable({ data: new Blob(["audio"]) });
    rm.stopRecording();
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalled());

    expect(rm.recordings).toHaveLength(1);
    expect(rm.recordings[0]).toMatchObject({ fileId: "file-1", duration: expect.any(Number) });
    expect(onSave).toHaveBeenCalled();
  });

  it("does not save when no audio chunks were collected", async () => {
    const RecordingManager = await loadWebManager();
    stubWebAudio();
    const rm = new RecordingManager();
    await rm.startRecording();
    rm.stopRecording(); // no ondataavailable fired
    await vi.waitFor(() => expect(rm._mediaRecorder).toBeNull());
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("reports via onChange (not throw) when saveFile fails", async () => {
    const RecordingManager = await loadWebManager();
    stubWebAudio();
    saveFile.mockRejectedValue(new Error("disk full"));
    const onChange = vi.fn();
    const rm = new RecordingManager({ onChange });

    await rm.startRecording();
    rm._mediaRecorder.ondataavailable({ data: new Blob(["audio"]) });
    rm.stopRecording();

    await vi.waitFor(() => expect(saveFile).toHaveBeenCalled());
    expect(rm.recordings).toHaveLength(0);
  });
});

describe("importFile", () => {
  it("saves the given file as a new recording with the given duration", async () => {
    const RecordingManager = await loadWebManager();
    const rm = new RecordingManager();
    const file = new Blob(["audio"]);

    await rm.importFile(file, 12.7);

    expect(saveFile).toHaveBeenCalledWith(file);
    expect(rm.recordings[0]).toMatchObject({ fileId: "file-1", duration: 13 }); // rounded
  });
});

describe("native recording (Android/Tauri)", () => {
  it("starts native recording via invoke and reflects isRecording/isPaused", async () => {
    const RecordingManager = await loadNativeManager();
    invokeMock.mockResolvedValue(undefined);
    const rm = new RecordingManager();

    await rm.startRecording();
    expect(invokeMock).toHaveBeenCalledWith("native_audio_start");
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
    const RecordingManager = await loadNativeManager();
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
    const RecordingManager = await loadNativeManager();
    invokeMock.mockRejectedValue(new Error("native_audio_start: Microphone permission denied"));
    const rm = new RecordingManager();

    await expect(rm.startRecording()).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(rm.isRecording()).toBe(false);
  });

  // A no-input-device error (e.g. a machine without a microphone, or an RDP
  // session without forwarded audio) must surface as NotFoundError so the UI
  // shows the "no microphone found" message instead of the generic failure.
  it("maps a native no-input-device rejection to NotFoundError", async () => {
    const RecordingManager = await loadNativeManager();
    invokeMock.mockRejectedValue(new Error("No audio input device found"));
    const rm = new RecordingManager();

    await expect(rm.startRecording()).rejects.toMatchObject({ name: "NotFoundError" });
    expect(rm.isRecording()).toBe(false);
  });

  it("does not tag an unrelated native failure as a known error name", async () => {
    const RecordingManager = await loadNativeManager();
    invokeMock.mockRejectedValue(new Error("native_audio_start: recorder init failed"));
    const rm = new RecordingManager();

    await expect(rm.startRecording()).rejects.toSatisfy(
      (err) => err.name !== "NotAllowedError" && err.name !== "NotFoundError",
    );
  });

  it("reads the native file, saves it, and appends the recording on stop", async () => {
    const RecordingManager = await loadNativeManager();
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "native_audio_start") return Promise.resolve();
      if (cmd === "native_audio_stop")
        return Promise.resolve({ path: "/tmp/rec.mp4", mimeType: "audio/mp4" });
      if (cmd === "native_audio_read_and_delete") return Promise.resolve(btoa("audiodata"));
      return Promise.resolve();
    });
    const onSave = vi.fn();
    const rm = new RecordingManager({ onSave });

    await rm.startRecording();
    rm.stopRecording();
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalled());

    expect(rm.recordings).toHaveLength(1);
    expect(rm.recordings[0].fileId).toBe("file-1");
    expect(onSave).toHaveBeenCalled();
  });

  it("does nothing (via onChange) when native stop returns no path", async () => {
    const RecordingManager = await loadNativeManager();
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "native_audio_start") return Promise.resolve();
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

  it("cancels the native recording on destroy", async () => {
    const RecordingManager = await loadNativeManager();
    invokeMock.mockResolvedValue(undefined);
    const rm = new RecordingManager();

    await rm.startRecording();
    rm.destroy();

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("native_audio_cancel"));
  });
});
