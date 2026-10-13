/**
 * Restore Module
 *
 * Reads a backup archive (the layout documented in backup.js) back into local
 * storage in three explicit stages, so every decision is made before anything
 * is written:
 *
 *   1. indexArchive()  — validate every entry name and size; nothing is read.
 *   2. scanRestore()   — dry run: read each JSON entry's metadata and compare
 *                        with local storage by id. Produces the conflict summary.
 *   3. planRestore()   — turn the scan plus the user's mode/decisions into a
 *                        list of actions.
 *   4. applyRestore()  — execute the plan, reporting progress and honouring
 *                        cancellation between notes.
 *
 * Pure domain logic: no UI, no Tauri. The archive is an object with
 * `readText(name)` and `readBinary(name, mimeType)`; see backupArchive.js.
 *
 * Two invariants this module exists to hold:
 *
 *  - Non-destructive by construction. When the backup's version of a note
 *    wins, the local note is never overwritten in place: it is copied under a
 *    new id, renamed with a "(replaced)" suffix and moved to the recycle bin,
 *    and only then does the backup's note take the original id.
 *
 *  - Every restored item re-enters sync as a fresh local edit: synced=false,
 *    lastSyncedEtag=null, version bumped past the local value, modified=now.
 *    Restored notes also carry `restoredAt`, which makes the sync engine
 *    upload them as-is instead of merging the server copy back in (a merge
 *    would re-apply the server's strokes and stroke deletions and undo the
 *    restore). A restore that appears to succeed and is then undone by sync
 *    is worse than no restore at all.
 *
 *  - Archive JSON is data, not state. Sync-tracking fields and `purged` are
 *    stripped from every item before it is written, whatever the file claims.
 */

import { mimeFromExt } from "../mime.js";
import {
  checkFileExists,
  copyNote,
  DB_VERSION,
  getAllNotebooksForSync,
  getAllNotesForSync,
  getNoteIndex,
  restoreNotebook,
  saveFile,
  saveNote,
  saveNotebook,
} from "../storage.js";
import { assertSafeFilename, assertSafeId, parsePath, ROOT_FOLDER } from "../storagePaths.js";
import { BACKUP_SCHEMA, MANIFEST_NAME, SYNC_ONLY_FIELDS } from "./backup.js";

export const MODE_MISSING = "missing";
export const MODE_PREFER_BACKUP = "preferBackup";
export const MODE_REPLACE_ALL = "replaceAll";

/** Hard ceiling for one media entry's declared uncompressed size. */
export const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;
/**
 * JSON entries are read whole and cross the IPC boundary as one string, so
 * they get a far lower ceiling than media. No genuine note comes close; a
 * declared size above this is a hostile or corrupt file. Mirrored in
 * backup.rs (MAX_TEXT_ENTRY_BYTES).
 */
export const MAX_JSON_ENTRY_BYTES = 64 * 1024 * 1024;
/**
 * Deflate cannot exceed roughly 1032:1, so a larger declared ratio is a
 * malformed or hostile archive, not data. Only checked above a floor, where
 * a tiny highly-repetitive JSON entry could legitimately come close.
 */
export const MAX_COMPRESSION_RATIO = 1032;
const RATIO_CHECK_FLOOR = 1024 * 1024;

/**
 * Typed failure so the UI can pick the right message and next action.
 * Codes: not-a-backup, corrupt, schema-newer, db-newer, unsafe-entry,
 * entry-too-large, size-mismatch, wrong-password, password-required.
 */
export class RestoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RestoreError";
    this.code = code;
    this.details = details;
  }
}

export class RestoreCancelledError extends Error {
  constructor() {
    super("Restore cancelled");
    this.name = "RestoreCancelledError";
  }
}

// ─── Manifest ─────────────────────────────────────────────────────────────────

/** Parse manifest.json; anything that is not our manifest is "not a backup". */
export function parseManifest(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (_e) {
    throw new RestoreError("not-a-backup", "manifest.json is not valid JSON");
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !Number.isInteger(manifest.schema) ||
    !Number.isInteger(manifest.dbVersion) ||
    typeof manifest.counts !== "object"
  ) {
    throw new RestoreError("not-a-backup", "manifest.json does not describe a NoteBerg backup");
  }
  return manifest;
}

/**
 * Refuse archives this app cannot read. A newer schema or DB version means
 * shapes the running code does not understand — writing them would be worse
 * than refusing. Older is fine: shapes are forward-compatible within the line.
 */
export function checkCompatibility(
  manifest,
  { schema = BACKUP_SCHEMA, dbVersion = DB_VERSION } = {},
) {
  if (manifest.schema > schema) {
    throw new RestoreError("schema-newer", "Backup format is newer than this app", {
      appVersion: manifest.appVersion,
    });
  }
  if (manifest.dbVersion > dbVersion) {
    throw new RestoreError("db-newer", "Backup database version is newer than this app", {
      appVersion: manifest.appVersion,
    });
  }
}

// ─── Stage 1: index ───────────────────────────────────────────────────────────

/**
 * Classify every entry by name and validate it before anything is read.
 *
 * Entry names come from an untrusted file. Every id and filename parsed out of
 * them goes through the same validators the sync layer uses, and the archive is
 * rejected on the first violation rather than skipping the entry — a crafted
 * name is evidence about the whole file, not one bad entry. Entries the layout
 * has no use for (tombstones, stray files) are ignored: a NoteBerg folder
 * zipped straight from Nextcloud is a valid backup.
 *
 * @param {Array<{name: string, size: number, compressedSize?: number}>} entries
 * @param {object} manifest
 * @returns {{notebooks: Map<string, {name: string}>, notes: Map<string, {name: string, notebookId: string|null}>, media: Map<string, Array<{name: string, fileId: string, mimeType: string, size: number}>>}}
 */
export function indexArchive(entries, manifest) {
  const index = { notebooks: new Map(), notes: new Map(), media: new Map() };
  let declaredBytes = 0;

  for (const entry of entries) {
    const { name, size = 0, compressedSize } = entry;
    if (name === MANIFEST_NAME || name.endsWith("/")) continue;

    // A traversal sequence, an absolute path or a backslash anywhere in a name
    // is evidence about the whole file, even in an entry the layout would
    // otherwise ignore.
    if (
      name.includes("..") ||
      name.includes("\\") ||
      name.startsWith("/") ||
      name.includes("\u0000")
    ) {
      throw new RestoreError("unsafe-entry", `Rejected archive entry: ${name}`, { name });
    }

    const ceiling = name.endsWith(".json") ? MAX_JSON_ENTRY_BYTES : MAX_ENTRY_BYTES;
    if (size > ceiling) {
      throw new RestoreError("entry-too-large", `Entry exceeds the size ceiling: ${name}`, {
        name,
        size,
      });
    }
    if (
      size > RATIO_CHECK_FLOOR &&
      compressedSize > 0 &&
      size / compressedSize > MAX_COMPRESSION_RATIO
    ) {
      throw new RestoreError("corrupt", `Implausible compression ratio for entry: ${name}`, {
        name,
      });
    }

    const parsed = parsePath(`${ROOT_FOLDER}/${name}`);
    try {
      if (parsed.type === "notebook") {
        assertSafeId(parsed.notebookId, "notebook");
        index.notebooks.set(parsed.notebookId, { name });
      } else if (parsed.type === "note") {
        assertSafeId(parsed.noteId, "note");
        if (parsed.notebookId) assertSafeId(parsed.notebookId, "notebook");
        index.notes.set(parsed.noteId, { name, notebookId: parsed.notebookId ?? null });
      } else if (parsed.type === "media") {
        assertSafeId(parsed.noteId, "note");
        if (parsed.notebookId) assertSafeId(parsed.notebookId, "notebook");
        assertSafeFilename(parsed.filename);
        const dot = parsed.filename.lastIndexOf(".");
        const fileId = dot > 0 ? parsed.filename.slice(0, dot) : parsed.filename;
        const ext = dot > 0 ? parsed.filename.slice(dot) : "";
        assertSafeId(fileId, "file");
        const list = index.media.get(parsed.noteId) ?? [];
        list.push({ name, fileId, mimeType: mimeFromExt(ext), size });
        index.media.set(parsed.noteId, list);
      } else {
        continue; // tombstones and unknown files are not restored
      }
    } catch (e) {
      if (e instanceof RestoreError) throw e;
      throw new RestoreError("unsafe-entry", `Rejected archive entry: ${name}`, { name });
    }
    declaredBytes += size;
  }

  // The manifest's byte total was tallied from what was written; a listing that
  // claims far more is lying about something.
  const claimed = manifest?.totalBytes;
  if (Number.isFinite(claimed) && declaredBytes > claimed * 1.5 + RATIO_CHECK_FLOOR) {
    throw new RestoreError("size-mismatch", "Entry sizes do not match the manifest", {
      declaredBytes,
      claimed,
    });
  }

  return index;
}

// ─── Stage 2: scan (dry run) ──────────────────────────────────────────────────

function parseJsonEntry(text, name) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object") throw new Error("not an object");
    return value;
  } catch (_e) {
    throw new RestoreError("corrupt", `Entry is not valid JSON: ${name}`, { name });
  }
}

/**
 * An item lands in the review list only when it genuinely differs from the
 * local copy: both `modified` and `version` disagree. Same-version items are
 * the same note and need no decision.
 */
function noteStatus(backup, local) {
  if (!local || local.purged) return "new";
  const sameVersion = (backup.version ?? 0) === (local.version ?? 0);
  const sameModified = (backup.modified ?? 0) === (local.modified ?? 0);
  return sameVersion || sameModified ? "same" : "conflict";
}

/**
 * Dry run. Reads only the JSON entries (never media), compares by id against
 * local storage, and writes nothing.
 *
 * @param {{readText: (name: string) => Promise<string>}} archive
 * @param {ReturnType<typeof indexArchive>} index
 * @returns {Promise<object>} scan — see the shape assembled at the bottom
 */
export async function scanRestore(archive, index) {
  const localNotebooks = new Map((await getAllNotebooksForSync()).map((nb) => [nb.id, nb]));
  const localNotes = new Map((await getAllNotesForSync()).map((n) => [n.id, n]));

  const notebooks = [];
  for (const [id, { name }] of index.notebooks) {
    const nb = parseJsonEntry(await archive.readText(name), name);
    if (nb.id !== id)
      throw new RestoreError("corrupt", `Notebook id mismatch in ${name}`, { name });
    const local = localNotebooks.get(id);
    let status = "new";
    if (local && !local.purged) status = local.deleted ? "undelete" : "keep";
    notebooks.push({
      id,
      name,
      title: typeof nb.title === "string" ? nb.title : "",
      localTitle: local?.title ?? null,
      titleDiffers: status === "keep" && local?.title !== nb.title,
      // Includes a purged stub's version, so a re-created notebook bumps past
      // it the same way a restored note does.
      localVersion: local?.version ?? 0,
      status,
    });
  }

  const notes = [];
  for (const [id, { name, notebookId }] of index.notes) {
    const note = parseJsonEntry(await archive.readText(name), name);
    if (note.id !== id) throw new RestoreError("corrupt", `Note id mismatch in ${name}`, { name });
    const local = localNotes.get(id);
    const status = noteStatus(note, local);
    notes.push({
      id,
      name,
      notebookId,
      title: typeof note.title === "string" ? note.title : "",
      backup: {
        modified: note.modified ?? 0,
        version: note.version ?? 0,
        deleted: Boolean(note.deleted),
        strokes: Array.isArray(note.strokes) ? note.strokes.length : 0,
      },
      local:
        status === "new"
          ? null
          : {
              modified: local.modified ?? 0,
              version: local.version ?? 0,
              deleted: Boolean(local.deleted),
              notebookId: local.notebookId ?? null,
              title: local.title ?? "",
            },
      status,
      backupNewer: status === "conflict" && (note.modified ?? 0) > (local.modified ?? 0),
    });
  }

  const conflicts = notes.filter((n) => n.status === "conflict");
  const hasLocalData =
    [...localNotes.values()].some((n) => !n.purged) ||
    [...localNotebooks.values()].some((nb) => !nb.purged);

  return {
    notebooks,
    notes,
    conflicts,
    hasLocalData,
    counts: {
      notebooks: notebooks.length,
      notes: notes.length,
      newNotes: notes.filter((n) => n.status === "new").length,
      sameNotes: notes.filter((n) => n.status === "same").length,
      conflicts: conflicts.length,
      backupNewer: conflicts.filter((n) => n.backupNewer).length,
      localNewer: conflicts.filter((n) => !n.backupNewer).length,
    },
  };
}

// ─── Stage 3: plan ────────────────────────────────────────────────────────────

/**
 * Turn a scan into actions.
 *
 * Modes are named by intent, not mechanism:
 *  - missing:       only items absent locally are added. Conflicts are skipped.
 *  - preferBackup:  backup wins where it is newer, local wins otherwise, unless
 *                   a per-note decision from the review list says which.
 *                   Displaced local notes go to the recycle bin (applyRestore).
 *  - replaceAll:    the caller has already purged local data, so every item
 *                   is written; kept for completeness and for the summary.
 *
 * @param {object} scan
 * @param {{mode: string, decisions?: Record<string, "local"|"backup">}} options
 */
export function planRestore(scan, { mode = MODE_PREFER_BACKUP, decisions = {} } = {}) {
  const notebooks = scan.notebooks.map((nb) => ({
    id: nb.id,
    name: nb.name,
    localVersion: nb.localVersion ?? 0,
    action: nb.status === "new" ? "create" : nb.status === "undelete" ? "undelete" : "keep",
  }));

  const notes = scan.notes.map((n) => {
    let action = "skip";
    if (n.status === "new") action = "write";
    else if (n.status === "conflict") {
      if (mode === MODE_REPLACE_ALL) action = "write";
      else if (mode === MODE_PREFER_BACKUP) {
        const choice = decisions[n.id] ?? (n.backupNewer ? "backup" : "local");
        action = choice === "backup" ? "write" : "skip";
      }
    }
    return {
      id: n.id,
      name: n.name,
      notebookId: n.notebookId,
      action,
      // Displace whenever a local copy exists and the backup's takes its id.
      displace: action === "write" && n.local !== null,
    };
  });

  return {
    mode,
    notebooks,
    notes,
    counts: {
      write: notes.filter((n) => n.action === "write").length,
      skip: notes.filter((n) => n.action === "skip").length,
      displace: notes.filter((n) => n.displace).length,
      createNotebooks: notebooks.filter((nb) => nb.action === "create").length,
      undeleteNotebooks: notebooks.filter((nb) => nb.action === "undelete").length,
    },
  };
}

// ─── Stage 4: apply ───────────────────────────────────────────────────────────

/**
 * Append the "(replaced)" suffix unless the title already ends with it, so a
 * note restored three times does not become "Notes (replaced) (replaced)
 * (replaced)" — titles have no length cap and are ellipsised in lists, so a
 * chain fails silently, which is the opposite of the audit trail the suffix
 * exists to provide.
 */
export function withReplacedSuffix(title, suffix) {
  const base = (title ?? "").trimEnd();
  if (!suffix) return base;
  if (base.endsWith(suffix)) return base;
  return base ? `${base} ${suffix}` : suffix;
}

/**
 * Fields an archive item may carry but must never write: the sync-tracking
 * set backup.js strips on the way out, plus `purged`, which would turn a note
 * into an invisible stub. Applied to every item regardless of what the file
 * claims, because the file is untrusted.
 */
const RESTORE_STRIPPED_FIELDS = [...SYNC_ONLY_FIELDS, "purged"];

export function stripArchiveFields(item) {
  const copy = { ...item };
  for (const field of RESTORE_STRIPPED_FIELDS) delete copy[field];
  return copy;
}

/**
 * The sync-state fields every restored item is written with.
 *
 * version takes the max of the local and archived versions so a note that
 * already reached a high version elsewhere (server, other devices) doesn't
 * get rolled back to a low one just because this device has never seen it
 * before — a rollback would make the restored copy look like a stale fork
 * on the next sync.
 */
function reenterSync(item, localVersion, now) {
  return {
    ...item,
    synced: false,
    lastSyncedEtag: null,
    version: Math.max(localVersion ?? 0, item.version ?? 0) + 1,
    modified: now,
  };
}

/**
 * Execute a plan.
 *
 * Notebooks first, so notes always have a container to land in. Per note: the
 * displaced copy (if any), then media blobs, then the note JSON — a reader that
 * stops early never sees a note whose blobs are missing. Cancellation is
 * honoured between notes; already-written notes stay, because they are valid,
 * correctly re-dirtied notes, and re-running the restore skips them.
 *
 * @param {{readText: Function, readBinary: Function}} archive
 * @param {ReturnType<typeof indexArchive>} index
 * @param {ReturnType<typeof planRestore>} plan
 * @param {object} [options]
 * @param {(p: {current: number, total: number, phase: string, detail?: string}) => void} [options.onProgress]
 * @param {() => boolean} [options.isCancelled]
 * @param {string} [options.replacedSuffix] - translated "(replaced)"
 * @param {() => number} [options.now]
 */
export async function applyRestore(archive, index, plan, options = {}) {
  const {
    onProgress = () => {},
    isCancelled = () => false,
    replacedSuffix = "(replaced)",
    now = Date.now,
  } = options;

  const summary = {
    total: plan.counts.write,
    restored: 0,
    skipped: plan.counts.skip,
    replaced: 0,
    notebooksCreated: 0,
    notebooksRestored: 0,
    cancelled: false,
  };

  const notebookWork = plan.notebooks.filter((nb) => nb.action !== "keep");
  const total = notebookWork.length + plan.counts.write;
  let current = 0;

  for (const nb of notebookWork) {
    if (isCancelled()) return { ...summary, cancelled: true };
    onProgress({ current, total, phase: "notebook" });
    if (nb.action === "create") {
      const notebook = parseJsonEntry(await archive.readText(nb.name), nb.name);
      await saveNotebook(
        reenterSync(
          { ...stripArchiveFields(notebook), id: nb.id, deleted: Boolean(notebook.deleted) },
          nb.localVersion,
          now(),
        ),
      );
      summary.notebooksCreated++;
    } else if (nb.action === "undelete") {
      await restoreNotebook(nb.id);
      summary.notebooksRestored++;
    }
    current++;
  }

  for (const item of plan.notes) {
    if (item.action !== "write") continue;
    if (isCancelled()) return { ...summary, cancelled: true };
    onProgress({ current, total, phase: "note" });

    const local = await getNoteIndex(item.id);

    if (item.displace && local && !local.purged) {
      // Deep-copies blobs and mints a new id, freeing the original id for the
      // backup's note. The copy is renamed and binned so it is findable but
      // does not clutter the notebook.
      const copy = await copyNote(item.id, local.notebookId ?? null);
      await saveNote({
        ...copy,
        title: withReplacedSuffix(copy.title, replacedSuffix),
        deleted: true,
        modified: now(),
      });
      summary.replaced++;
    }

    for (const media of index.media.get(item.id) ?? []) {
      // fileIds are UUIDs: an existing key holds the same bytes.
      if (await checkFileExists(media.fileId)) continue;
      onProgress({ current, total, phase: "media", detail: media.name.split("/").pop() });
      let blob;
      try {
        blob = await archive.readBinary(media.name, media.mimeType);
      } catch (error) {
        // The archive layer polls the same cancel flag between chunks of a
        // large file; the note itself has not been written, so re-running
        // picks it up again.
        if (error?.code === "cancelled") return { ...summary, cancelled: true };
        throw error;
      }
      await saveFile(blob, media.fileId);
    }

    const note = parseJsonEntry(await archive.readText(item.name), item.name);
    const writtenAt = now();
    await saveNote({
      ...reenterSync(
        {
          ...stripArchiveFields(note),
          id: item.id,
          notebookId: item.notebookId,
          deleted: Boolean(note.deleted),
        },
        local?.version,
        writtenAt,
      ),
      // Tells the sync engine to upload this version as-is rather than merge
      // the server copy into it. Cleared by storage once the upload lands.
      restoredAt: writtenAt,
    });
    summary.restored++;
    current++;
  }

  onProgress({ current, total, phase: "done" });
  return summary;
}
