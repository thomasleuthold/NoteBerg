/**
 * src/modules/backup_restore/backupArchive.test.js
 *
 * The encoding that carries media across the IPC boundary, the error-code
 * mapping the UI depends on to tell "wrong password" from "corrupt file", and
 * the in-memory archive's fidelity to the real one's contract.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake of the Rust side, faithful to its command contract: one open entry
// at a time for writing, one decoded entry served in slices for reading.
const rust = {
  entries: new Map(),
  current: null,
  pending: null,
  calls: [],
  reset() {
    this.entries.clear();
    this.current = null;
    this.pending = null;
    this.calls = [];
  },
};
const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const encode = (bytes) => btoa(String.fromCharCode(...bytes));
const commands = {
  backup_begin: () => undefined,
  backup_begin_entry: ({ name }) => {
    rust.current = name;
    rust.entries.set(name, []);
  },
  backup_write_chunk: ({ dataBase64 }) => {
    rust.entries.get(rust.current).push(decode(dataBase64));
  },
  backup_add_text: ({ name, text }) => {
    rust.entries.set(name, [new TextEncoder().encode(text)]);
  },
  backup_finish: () => ({ path: "x.zip", bytes: 1 }),
  backup_abort: () => undefined,
  restore_open: () => ({ entries: [], manifest: null }),
  restore_read_begin: ({ name }) => {
    const parts = rust.entries.get(name);
    if (!parts) throw "ENTRY_NOT_FOUND: x";
    const total = parts.reduce((n, p) => n + p.length, 0);
    rust.pending = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      rust.pending.set(p, off);
      off += p.length;
    }
    return total;
  },
  restore_read_chunk: ({ offset, len }) => encode(rust.pending.subarray(offset, offset + len)),
  restore_read_end: () => {
    rust.pending = null;
  },
};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command, args) => {
    rust.calls.push(command);
    const fn = commands[command];
    if (!fn) throw new Error(`unexpected command ${command}`);
    return fn(args ?? {});
  }),
}));

import {
  ANDROID_CHUNK_BYTES,
  ArchiveError,
  base64ToBlob,
  blobToBase64,
  CHUNK_BYTES,
  createMemoryArchive,
  defaultChunkBytes,
  isTauriRuntime,
  mapArchiveError,
  openBackupReader,
  openBackupWriter,
} from "./backupArchive.js";

beforeEach(() => rust.reset());

describe("base64 encoding", () => {
  it("round-trips arbitrary bytes and keeps the MIME type", async () => {
    const bytes = new Uint8Array(300).map((_, i) => (i * 7) & 0xff);
    const blob = new Blob([bytes], { type: "application/pdf" });

    const encoded = await blobToBase64(blob);
    expect(encoded).not.toContain(",");
    expect(encoded).not.toContain("data:");

    const back = base64ToBlob(encoded, "application/pdf");
    expect(back.type).toBe("application/pdf");
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(bytes);
  });

  it("encodes an empty blob to an empty string", async () => {
    expect(await blobToBase64(new Blob([]))).toBe("");
    expect(base64ToBlob("", "image/png").size).toBe(0);
  });
});

describe("mapArchiveError", () => {
  it("maps the Rust error prefixes to stable codes and keeps the detail", () => {
    expect(mapArchiveError("WRONG_PASSWORD")).toMatchObject({ code: "wrong-password" });
    expect(mapArchiveError("PASSWORD_REQUIRED")).toMatchObject({ code: "password-required" });
    expect(mapArchiveError("NOT_A_ZIP: bad header")).toMatchObject({
      code: "not-a-backup",
      message: "bad header",
    });
    expect(mapArchiveError("ENTRY_TOO_LARGE: x")).toMatchObject({ code: "entry-too-large" });
    expect(mapArchiveError("ENTRY_NOT_FOUND: x")).toMatchObject({ code: "corrupt" });
    expect(mapArchiveError("IO: disk full")).toMatchObject({ code: "io", message: "disk full" });
    // Android staging pre-flight: "<needed> <available>" in bytes.
    expect(mapArchiveError("NO_SPACE: 1048576 524288")).toMatchObject({
      code: "no-space",
      message: "1048576 524288",
    });
  });

  it("treats anything unrecognised as an I/O failure without losing the text", () => {
    expect(mapArchiveError(new Error("boom"))).toMatchObject({ code: "io", message: "boom" });
    expect(mapArchiveError("Something else")).toMatchObject({ code: "io" });
  });

  it("passes an ArchiveError through unchanged", () => {
    const err = new ArchiveError("corrupt", "x");
    expect(mapArchiveError(err)).toBe(err);
  });
});

describe("isTauriRuntime", () => {
  it("is false in a plain browser", () => {
    expect(isTauriRuntime()).toBe(false);
  });
});

describe("createMemoryArchive", () => {
  it("reports written byte counts the way the real writer does", async () => {
    const { writer } = createMemoryArchive();
    expect(await writer.addText("a.json", "héllo")).toBe(6); // é is two bytes
    expect(await writer.addBinary("b.bin", new Blob([new Uint8Array(5)]))).toBe(5);
    expect(await writer.finish()).toEqual({ path: "memory://backup.zip", bytes: 11 });
  });

  it("abort discards every entry", async () => {
    const archive = createMemoryArchive();
    await archive.writer.addText("a.json", "{}");
    await archive.writer.abort();
    expect(archive.aborted).toBe(true);
    expect(archive.entries.size).toBe(0);
  });

  it("lists entries with sizes and the encrypted flag, manifest excepted", async () => {
    const archive = createMemoryArchive({ password: "pw" });
    await archive.writer.addText("manifest.json", "{}");
    await archive.writer.addText("quickNotes/n.json", "{}");
    const reader = archive.reader();
    expect(reader.entries).toEqual([
      { name: "manifest.json", size: 2, compressedSize: 2, encrypted: false },
      { name: "quickNotes/n.json", size: 2, compressedSize: 2, encrypted: true },
    ]);
  });

  it("returns binaries as Blobs of the requested type and fails on a missing entry", async () => {
    const archive = createMemoryArchive();
    await archive.writer.addBinary("x.png", new Blob([new Uint8Array([1])], { type: "image/png" }));
    const reader = archive.reader();
    expect((await reader.readBinary("x.png", "image/png")).type).toBe("image/png");
    await expect(reader.readText("missing")).rejects.toMatchObject({ code: "corrupt" });
  });
});

describe("chunked binary transfer", () => {
  // Two and a half chunks, with a recognisable byte pattern. Small chunks:
  // jsdom's base64 is slow, and the mechanics do not depend on the size.
  const chunkBytes = 1000;
  const size = Math.floor(chunkBytes * 2.5);
  const bytes = new Uint8Array(size).map((_, i) => (i * 31 + 7) & 0xff);

  it("defaults to 8 MiB chunks, 2 MiB on Android", () => {
    expect(CHUNK_BYTES).toBe(8 * 1024 * 1024);
    expect(defaultChunkBytes()).toBe(CHUNK_BYTES);
    const ua = vi
      .spyOn(navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Linux; Android 14) wv");
    expect(defaultChunkBytes()).toBe(ANDROID_CHUNK_BYTES);
    ua.mockRestore();
  });

  it("splits a large blob into CHUNK_BYTES pieces, in order, and reports progress", async () => {
    const progress = [];
    const writer = await openBackupWriter("x.zip", null, {
      chunkBytes,
      onProgress: (p) => progress.push(p),
    });
    const written = await writer.addBinary("quickNotes/n_media/f.pdf", new Blob([bytes]));

    expect(written).toBe(size);
    expect(rust.calls.filter((c) => c === "backup_write_chunk")).toHaveLength(3);
    const parts = rust.entries.get("quickNotes/n_media/f.pdf");
    expect(parts.map((p) => p.length)).toEqual([chunkBytes, chunkBytes, size - 2 * chunkBytes]);
    const joined = new Uint8Array(size);
    let off = 0;
    for (const p of parts) {
      joined.set(p, off);
      off += p.length;
    }
    expect(joined).toEqual(bytes);
    expect(progress.map((p) => p.written)).toEqual([chunkBytes, 2 * chunkBytes, size]);
    expect(progress[0]).toMatchObject({ name: "f.pdf", total: size });
  });

  it("stops writing at the next chunk once cancelled", async () => {
    let cancelled = false;
    const writer = await openBackupWriter("x.zip", null, {
      chunkBytes,
      isCancelled: () => cancelled,
      onProgress: ({ written }) => {
        if (written >= chunkBytes) cancelled = true;
      },
    });
    await expect(writer.addBinary("q/f.pdf", new Blob([bytes]))).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(rust.calls.filter((c) => c === "backup_write_chunk")).toHaveLength(1);
  });

  it("reads a large entry back in chunks and reassembles it with the MIME type", async () => {
    const writer = await openBackupWriter("x.zip", null, { chunkBytes });
    await writer.addBinary("q/f.pdf", new Blob([bytes]));
    const progress = [];
    const reader = await openBackupReader("x.zip", {
      chunkBytes,
      onProgress: (p) => progress.push(p),
    });

    const blob = await reader.readBinary("q/f.pdf", "application/pdf");

    expect(blob.type).toBe("application/pdf");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(rust.calls.filter((c) => c === "restore_read_chunk")).toHaveLength(3);
    expect(rust.calls.at(-1)).toBe("restore_read_end");
    expect(progress.map((p) => p.read)).toEqual([chunkBytes, 2 * chunkBytes, size]);
  });

  it("releases the entry on the Rust side even when cancelled mid-read", async () => {
    const writer = await openBackupWriter("x.zip", null, { chunkBytes });
    await writer.addBinary("q/f.pdf", new Blob([bytes]));
    let cancelled = false;
    const reader = await openBackupReader("x.zip", {
      chunkBytes,
      isCancelled: () => cancelled,
      onProgress: () => {
        cancelled = true;
      },
    });

    await expect(reader.readBinary("q/f.pdf", "application/pdf")).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(rust.pending).toBeNull();
    expect(rust.calls.at(-1)).toBe("restore_read_end");
  });

  it("reads a small entry in one chunk", async () => {
    const writer = await openBackupWriter("x.zip");
    await writer.addBinary("q/s.png", new Blob([new Uint8Array([1, 2, 3])]));
    const reader = await openBackupReader("x.zip");
    const blob = await reader.readBinary("q/s.png", "image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(rust.calls.filter((c) => c === "restore_read_chunk")).toHaveLength(1);
  });
});
