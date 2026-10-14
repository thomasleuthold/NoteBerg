/**
 * src/components/NoteCanvas/recordingRecovery.test.js
 * The last-chance flow for a recording the app could not store: the temp file
 * is the only copy, so it is deleted only after the user saved it elsewhere.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { offerRecordingRecovery, suggestedRecordingName } from "./recordingRecovery.js";

// Echo the key and its parameters, so what reaches the dialog is visible.
vi.mock("../../i18n/index.js", () => ({
  t: (key, params) => `${key} ${params ? Object.values(params).join(" ") : ""}`,
}));

const info = { path: "/tmp/noteberg_rec_1.m4a", mimeType: "audio/mp4", error: new Error("quota") };

let invoke;
let confirm;
let alert;

beforeEach(() => {
  invoke = vi.fn(() => Promise.resolve());
  confirm = vi.fn(() => Promise.resolve(true));
  alert = vi.fn(() => Promise.resolve());
});

const run = () => offerRecordingRecovery(info, { invoke, confirm, alert });

describe("offerRecordingRecovery", () => {
  it("exports the file, then deletes the temp copy", async () => {
    invoke.mockImplementation((cmd) =>
      Promise.resolve(cmd === "native_audio_export" ? "C:\\Users\\me\\rec.m4a" : undefined),
    );

    await expect(run()).resolves.toBe("exported");

    expect(invoke).toHaveBeenCalledWith("native_audio_export", {
      path: info.path,
      suggestedName: expect.stringMatching(/^recording-.*\.m4a$/),
      mimeType: "audio/mp4",
    });
    const exportAt = invoke.mock.calls.findIndex((c) => c[0] === "native_audio_export");
    const deleteAt = invoke.mock.calls.findIndex((c) => c[0] === "native_audio_delete");
    expect(deleteAt).toBeGreaterThan(exportAt);
    expect(invoke).toHaveBeenCalledWith("native_audio_delete", { path: info.path });
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("keeps the temp file when the user declines", async () => {
    confirm.mockResolvedValue(false);
    await expect(run()).resolves.toBe("declined");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps the temp file when the save picker is cancelled", async () => {
    invoke.mockResolvedValue(null);
    await expect(run()).resolves.toBe("cancelled");
    expect(invoke).not.toHaveBeenCalledWith("native_audio_delete", expect.anything());
  });

  it("keeps the temp file and says so when the export fails", async () => {
    invoke.mockImplementation((cmd) =>
      cmd === "native_audio_export"
        ? Promise.reject(new Error("IO: disk full"))
        : Promise.resolve(),
    );
    await expect(run()).resolves.toBe("failed");
    expect(invoke).not.toHaveBeenCalledWith("native_audio_delete", expect.anything());
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("escapes the error text it shows", async () => {
    confirm.mockResolvedValue(false);
    await offerRecordingRecovery(
      { ...info, error: new Error("<img src=x onerror=alert(1)>") },
      { invoke, confirm, alert },
    );
    expect(confirm.mock.calls[0][1]).not.toContain("<img");
  });
});

describe("suggestedRecordingName", () => {
  const date = new Date(2026, 9, 4, 9, 5);

  it("keeps the temp file's extension", () => {
    expect(suggestedRecordingName("/tmp/noteberg_rec_1.wav", date)).toBe(
      "recording-2026-10-04_09-05.wav",
    );
    expect(suggestedRecordingName("/cache/rec_1.mp4", date)).toBe("recording-2026-10-04_09-05.mp4");
  });

  it("falls back to .m4a for an unknown extension", () => {
    expect(suggestedRecordingName("/tmp/x", date)).toBe("recording-2026-10-04_09-05.m4a");
  });
});
