/**
 * src/modules/mime.test.js
 *
 * The MIME ↔ extension map is the contract between the two storage backends:
 * the native sync layer (nextcloudSync.js) writes `{fileId}{ext}` and the NC
 * WebDAV backend (storage.webdav.js) reads it back, inferring the type from the
 * extension alone because WebDAV GETs usually report application/octet-stream.
 *
 * A format missing from the map does not fail loudly — it uploads as
 * `{fileId}.bin` and returns typed application/octet-stream, so the file syncs
 * intact and is silently unplayable everywhere else. These tests exist to keep
 * every format the app can *produce* in the map.
 */

import { describe, expect, it } from "vitest";
import { extFromMime, MIME_TO_EXT, mimeFromExt } from "./mime.js";

describe("extFromMime", () => {
  it("maps every recording format the app can produce", () => {
    // Windows: AAC/MP4 normally, WAV where Media Foundation is unavailable.
    // Android: AAC/MP4 from both the AudioRecord engine and the MediaRecorder
    // fallback. None of these may fall through to .bin.
    expect(extFromMime("audio/mp4")).toBe(".m4a");
    expect(extFromMime("audio/wav")).toBe(".wav");
  });

  it("maps the image and document formats", () => {
    expect(extFromMime("image/jpeg")).toBe(".jpg");
    expect(extFromMime("image/png")).toBe(".png");
    expect(extFromMime("application/pdf")).toBe(".pdf");
  });

  it("falls back to .bin for an unknown type", () => {
    expect(extFromMime("application/x-unknown")).toBe(".bin");
    expect(extFromMime(undefined)).toBe(".bin");
  });
});

describe("mimeFromExt", () => {
  it("resolves .wav to the playable type, not the legacy one", () => {
    // Both audio/wav and audio/x-wav map to .wav; the reverse lookup takes the
    // first declared, and <audio> expects audio/wav.
    expect(mimeFromExt(".wav")).toBe("audio/wav");
  });

  it("resolves the recording extensions", () => {
    expect(mimeFromExt(".m4a")).toBe("audio/mp4");
  });

  it("falls back to octet-stream for an unknown extension", () => {
    expect(mimeFromExt(".xyz")).toBe("application/octet-stream");
  });
});

describe("round trip", () => {
  // The upload side calls extFromMime and the download side calls mimeFromExt.
  // A type that does not survive that round trip arrives at the other device
  // mistyped, which for audio means it will not play.
  it("every audio type survives mime → ext → mime as a playable audio type", () => {
    const audioTypes = Object.keys(MIME_TO_EXT).filter((m) => m.startsWith("audio/"));
    expect(audioTypes.length).toBeGreaterThan(0);

    for (const mime of audioTypes) {
      const ext = extFromMime(mime);
      expect(ext, `${mime} must not fall through to .bin`).not.toBe(".bin");
      expect(mimeFromExt(ext), `${ext} must resolve back to an audio type`).toMatch(/^audio\//);
    }
  });

  it("every mapped extension resolves to a type that maps back to it", () => {
    for (const ext of new Set(Object.values(MIME_TO_EXT))) {
      expect(extFromMime(mimeFromExt(ext))).toBe(ext);
    }
  });
});
