/**
 * Backup Archive — the only backup/restore file that knows Tauri exists.
 *
 * The archive lives in Rust (src-tauri/src/backup.rs): a zip writer streaming
 * to a real file, or a zip reader over one. JS drives it one entry at a time,
 * and binary entries cross in fixed-size chunks (CHUNK_BYTES), so the peak IPC
 * payload is one chunk — never a whole PDF, never the archive — and a cancel
 * is honoured between chunks rather than after the whole file. Media crosses
 * as base64 (about 1.33x); note JSON crosses as a plain string.
 *
 * Everything here is a thin wrapper: the domain logic in backup.js and
 * restore.js only sees the small interfaces below, and createMemoryArchive()
 * implements the same interfaces in memory for tests.
 *
 *   writer: { addText(name, text) → bytes, addBinary(name, blob) → bytes,
 *             finish() → {path, bytes}, abort() }
 *   reader: { entries, manifestText, unlock(password), readText(name),
 *             readBinary(name, mimeType) → Blob, close() }
 */

/** Binary payload per IPC call. Base64 makes the wire size ~1.33x this. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
/**
 * Android's IPC has no fetch-style transport: requests go through a
 * JavascriptInterface string and responses come back via evaluateJavascript,
 * both copied through JNI as one string. Smaller chunks keep those copies
 * and the WebView's transient heap modest; the extra round trips are cheap.
 */
export const ANDROID_CHUNK_BYTES = 2 * 1024 * 1024;

export function defaultChunkBytes() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return ua.includes("Android") ? ANDROID_CHUNK_BYTES : CHUNK_BYTES;
}

/**
 * Error from the archive layer with a stable `code` the UI can switch on:
 * wrong-password, password-required, not-a-backup, corrupt, entry-too-large,
 * no-space, cancelled, io.
 */
export class ArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ArchiveError";
    this.code = code;
  }
}

/** Codes the Rust side prefixes its error strings with. */
const RUST_ERROR_CODES = {
  WRONG_PASSWORD: "wrong-password",
  PASSWORD_REQUIRED: "password-required",
  NOT_A_ZIP: "not-a-backup",
  ENTRY_TOO_LARGE: "entry-too-large",
  NO_SPACE: "no-space",
  ENTRY_NOT_FOUND: "corrupt",
  CORRUPT: "corrupt",
  NO_SESSION: "io",
  IO: "io",
};

/** Map a rejected invoke() into an ArchiveError. */
export function mapArchiveError(err) {
  if (err instanceof ArchiveError) return err;
  const text = typeof err === "string" ? err : (err?.message ?? String(err));
  const match = /^([A-Z_]+)(?::\s*(.*))?$/s.exec(text);
  if (match && RUST_ERROR_CODES[match[1]]) {
    return new ArchiveError(RUST_ERROR_CODES[match[1]], match[2] || text);
  }
  return new ArchiveError("io", text);
}

export function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    (window.__TAURI_INTERNALS__ !== undefined || window.__TAURI__ !== undefined)
  );
}

async function invoke(command, args) {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  try {
    return await tauriInvoke(command, args);
  } catch (err) {
    throw mapArchiveError(err);
  }
}

const cancelledError = () => new ArchiveError("cancelled", "Cancelled");

// ─── Encoding ─────────────────────────────────────────────────────────────────

/** Blob → base64 without the data-URL prefix, via the browser's native encoder. */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read blob"));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/** base64 → bytes. */
export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** base64 → Blob of the given MIME type. */
export function base64ToBlob(base64, mimeType = "application/octet-stream") {
  return new Blob([base64ToBytes(base64)], { type: mimeType });
}

const textBytes = (text) => new TextEncoder().encode(text).length;

// ─── File pickers ─────────────────────────────────────────────────────────────

/**
 * Ask where to write the backup. Desktop shows a native save dialog and returns
 * the chosen path; Android shows the system document picker and returns a path
 * in the app cache that the finished archive is copied out of (see §3.4 of the
 * plan). Null when the user cancels.
 */
export async function chooseBackupDestination(suggestedName) {
  return (await invoke("backup_choose_destination", { suggestedName })) || null;
}

/** Ask which archive to restore. Null when the user cancels. */
export async function chooseRestoreSource() {
  return (await invoke("restore_choose_source")) || null;
}

/** Free bytes where the archive will be staged, or null where it is not knowable (desktop). */
export async function getBackupFreeSpace() {
  const bytes = await invoke("backup_free_space");
  return typeof bytes === "number" ? bytes : null;
}

// ─── Writer ───────────────────────────────────────────────────────────────────

/**
 * Open a zip writer on `path`. With a password, every entry except the manifest
 * is WinZip AES-256 encrypted (never legacy ZipCrypto, which is trivially
 * broken and would make the password feature misleading).
 *
 * @param {string} path
 * @param {string|null} [password]
 * @param {object} [options]
 * @param {() => boolean} [options.isCancelled] - polled between chunks of a binary entry
 * @param {(p: {name: string, written: number, total: number}) => void} [options.onProgress]
 * @param {number} [options.chunkBytes] - override of CHUNK_BYTES (tests)
 */
export async function openBackupWriter(path, password = null, options = {}) {
  const {
    isCancelled = () => false,
    onProgress = () => {},
    chunkBytes = defaultChunkBytes(),
  } = options;
  await invoke("backup_begin", { path, password: password || null });
  return {
    async addText(name, text) {
      await invoke("backup_add_text", { name, text });
      return textBytes(text);
    },
    async addBinary(name, blob) {
      await invoke("backup_begin_entry", { name });
      const shortName = name.split("/").pop();
      for (let offset = 0; offset < blob.size; offset += chunkBytes) {
        if (isCancelled()) throw cancelledError();
        const chunk = blob.slice(offset, offset + chunkBytes);
        await invoke("backup_write_chunk", { dataBase64: await blobToBase64(chunk) });
        onProgress({
          name: shortName,
          written: Math.min(offset + chunkBytes, blob.size),
          total: blob.size,
        });
      }
      return blob.size;
    },
    /** Finalize the central directory. Returns the final location and size. */
    finish() {
      return invoke("backup_finish");
    },
    /** Drop the writer and delete the partial file. */
    abort() {
      return invoke("backup_abort");
    },
  };
}

/**
 * Abandon a backup that never got a writer (the destination was chosen but
 * opening the file failed): deletes any staged file and, on Android, the
 * document the picker created. A no-op when nothing is in progress.
 */
export async function abortBackup() {
  await invoke("backup_abort");
}

// ─── Reader ───────────────────────────────────────────────────────────────────

/**
 * Open an archive for reading. The entry list and the (always unencrypted)
 * manifest are available immediately; encrypted entries need unlock() first.
 *
 * @param {string} path
 * @param {object} [options]
 * @param {() => boolean} [options.isCancelled] - polled between chunks of a binary entry
 * @param {(p: {name: string, read: number, total: number}) => void} [options.onProgress]
 * @param {number} [options.chunkBytes] - override of CHUNK_BYTES (tests)
 */
export async function openBackupReader(path, options = {}) {
  const {
    isCancelled = () => false,
    onProgress = () => {},
    chunkBytes = defaultChunkBytes(),
  } = options;
  const { entries, manifest } = await invoke("restore_open", { path });
  return {
    entries,
    manifestText: manifest ?? null,
    /** Verify the password against the archive; throws wrong-password. */
    unlock(password) {
      return invoke("restore_unlock", { password });
    },
    readText(name) {
      return invoke("restore_read_text", { name });
    },
    async readBinary(name, mimeType) {
      const total = await invoke("restore_read_begin", { name });
      const shortName = name.split("/").pop();
      const parts = [];
      try {
        for (let offset = 0; offset < total; offset += chunkBytes) {
          if (isCancelled()) throw cancelledError();
          const base64 = await invoke("restore_read_chunk", { offset, len: chunkBytes });
          // Wrap each chunk in a Blob at once: Blob bytes live outside the JS
          // heap, so a 300 MiB PDF never sits in it as typed arrays. This is
          // what keeps a low-end Android WebView from being OOM-killed.
          parts.push(new Blob([base64ToBytes(base64)]));
          onProgress({ name: shortName, read: Math.min(offset + chunkBytes, total), total });
        }
      } finally {
        await invoke("restore_read_end").catch(() => {});
      }
      return new Blob(parts, { type: mimeType });
    },
    /** Release the file; on Android also deletes the cache copy. */
    close() {
      return invoke("restore_close");
    },
  };
}

// ─── In-memory implementation ─────────────────────────────────────────────────

/**
 * Writer/reader pair over a Map, for tests and for exercising backup.js and
 * restore.js without Rust. Models the password contract of the real archive:
 * the manifest is always readable, everything else needs unlock() with the
 * password the writer was given. `isCancelled` models the real reader's
 * mid-file cancel.
 */
export function createMemoryArchive({ password = null } = {}) {
  const entries = new Map();
  let finished = false;
  let aborted = false;

  const writer = {
    async addText(name, text) {
      entries.set(name, { text, size: textBytes(text) });
      return textBytes(text);
    },
    async addBinary(name, blob) {
      entries.set(name, { blob, size: blob.size });
      return blob.size;
    },
    async finish() {
      finished = true;
      let bytes = 0;
      for (const e of entries.values()) bytes += e.size;
      return { path: "memory://backup.zip", bytes };
    },
    async abort() {
      aborted = true;
      entries.clear();
    },
  };

  function reader({ isCancelled = () => false } = {}) {
    let unlocked = password == null;
    const requireUnlocked = (name) => {
      if (name === "manifest.json") return;
      if (!unlocked) throw new ArchiveError("password-required", "Archive is encrypted");
    };
    const get = (name) => {
      const entry = entries.get(name);
      if (!entry) throw new ArchiveError("corrupt", `Entry not found: ${name}`);
      return entry;
    };
    return {
      entries: [...entries].map(([name, e]) => ({
        name,
        size: e.size,
        compressedSize: e.size,
        encrypted: password != null && name !== "manifest.json",
      })),
      manifestText: entries.get("manifest.json")?.text ?? null,
      async unlock(candidate) {
        if (password == null) return;
        if (candidate !== password) throw new ArchiveError("wrong-password", "Incorrect password");
        unlocked = true;
      },
      async readText(name) {
        requireUnlocked(name);
        const entry = get(name);
        return entry.text ?? (await entry.blob.text());
      },
      async readBinary(name, mimeType) {
        requireUnlocked(name);
        if (isCancelled()) throw cancelledError();
        const entry = get(name);
        if (entry.blob) return entry.blob;
        return new Blob([entry.text], { type: mimeType });
      },
      async close() {},
    };
  }

  return {
    writer,
    reader,
    entries,
    get finished() {
      return finished;
    },
    get aborted() {
      return aborted;
    },
  };
}
