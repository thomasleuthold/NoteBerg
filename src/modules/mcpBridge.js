/**
 * MCP Bridge.
 *
 * Registers window.__mcpBridge.handle(tool, requestId, args), called by the
 * Rust MCP server (src-tauri/src/mcp.rs) via webview.eval(). `args` arrives
 * as a real JS object (embedded as a literal by eval_bridge, not JSON-encoded
 * as a string — nothing to JSON.parse here). Each tool calls existing
 * storage.js functions — no new data *access* logic lives here (no new
 * IndexedDB reads/writes), only the format-selection branching get_note
 * needs to shape its various response formats.
 *
 * Also owns MCP settings (enabled flag + token metadata list in IndexedDB,
 * each token's secret under its own OS keyring entry) and is the single place
 * that pushes them into Rust's in-memory McpState via mcp_set_config — Rust
 * never generates or persists any token itself (see
 * documentation/mcp_design.md ADR-002/§2a and roadmap/mcp/PLAN.md Phase 2/5b). The
 * Settings UI (settingsMode.js) calls the exported functions below; it never
 * talks to `invoke("mcp_*")` directly, keeping all MCP logic contained here.
 *
 * Desktop (Tauri, Windows) only. Import this module conditionally from
 * main.js so bundlers tree-shake it out of the Nextcloud and Android builds
 * entirely (see isMcpSupportedPlatform() in main.js).
 */

import {
  deriveTaskLabel,
  extractTasksFromNote,
  searchAllNotes,
} from "../components/overviewMode.js";
import { fileToDataUrl } from "../utils/imageUtils.js";
import { drawStroke, getStrokeBounds, getThemePalette } from "../utils/noteRenderer.js";
import { exportNoteToPdf } from "./pdfExport.js";
import {
  deleteSecureCredential,
  getSecureCredential,
  saveSecureCredential,
} from "./secureStorage.js";
import {
  getAllNotebooks,
  getAllNotes,
  getFile,
  getNote,
  getNotebook,
  getNotesByNotebook,
  getSetting,
  setSetting,
} from "./storage.js";

const MCP_ENABLED_KEY = "mcp_enabled";
// List of {id, name} token metadata (storage.js setting) — each token's
// actual secret lives under its own keyring entry, MCP_TOKEN_CREDENTIAL_PREFIX
// + id, never alongside the name (see DESIGN.md §2a).
const MCP_TOKENS_KEY = "mcp_tokens";
const MCP_TOKEN_CREDENTIAL_PREFIX = "mcp_token_";

/**
 * `get_note` format handlers. Each receives the full merged+decrypted note
 * (from storage.js's getNote()) and returns the JSON-serializable payload for
 * that format. See documentation/mcp_design.md §1 for the rationale
 * behind each format's shape.
 */
const NOTE_FORMAT_HANDLERS = {
  // Unlike list_notes/list_notebooks (which only have the lightweight index,
  // no pdfSource — see summarizeNote's comment), this format receives the
  // full getNote() result, so attachments (including PDF) are already loaded
  // here at zero extra cost — reuses listAttachments' existing logic rather
  // than re-deriving "has a PDF" separately.
  metadata: (note) => ({
    id: note.id,
    notebookId: note.notebookId,
    title: note.title,
    tags: note.tags,
    created: note.created,
    modified: note.modified,
    hasStrokes: note.hasStrokes,
    hasContent: note.hasContent,
    hasRecognition: note.hasRecognition,
    attachments: listAttachments(note),
  }),
  // Raw HTML as-is — the editor's real output, not a derived plain-text
  // guess. Formatting (tables, colors, font sizes) is real user content;
  // stripping it would be lossy and not reconstructible from stripped text.
  text_html: (note) => ({ html: note.content ?? "" }),
  recognized_text: (note) => ({ fullText: note.recognition?.fullText ?? "" }),
  recognized_words: (note) => ({ words: note.recognition?.words ?? [] }),
  strokes_raw: (note) => ({ strokes: note.strokes ?? [] }),
  strokes_images: async (note) => renderStrokesToImage(note),
  note_pdf: async (note) => renderNoteToPdf(note),
  attachments_list: (note) => listAttachments(note),
  attachment: async (note, { attachment_id }) => {
    if (!attachment_id) throw new Error("format 'attachment' requires an attachment_id argument");
    return fetchAttachment(note, attachment_id);
  },
};

/**
 * Render a stroke array to a PNG data URL, scaled to fit within maxSize on
 * its longest side. The shared core behind both renderStrokesToImage (full
 * note, get_note's strokes_images format) and the task-marker stroke preview
 * below — follows the exact pattern already proven live in NoteCanvas.js's
 * _renderSelectionToPng (the copy-selection-to-system-clipboard-as-PNG
 * feature) and overviewMode.js's drawTaskStrokeCanvases (the Markers tab's
 * mini stroke-preview canvases), both of which use the same
 * getStrokeBounds+drawStroke primitive. Returns null if there's nothing to
 * render (caller decides whether that's an error or an omitted field).
 */
async function renderStrokeArrayToDataUrl(strokes, maxSize, padding = 20) {
  const activeStrokes = (strokes ?? []).filter((s) => !s._deleted && !s.isDeleted);
  if (activeStrokes.length === 0) return null;

  const bounds = getStrokeBounds(activeStrokes);
  if (!bounds) return null;

  const rawW = bounds.width + padding * 2;
  const rawH = bounds.height + padding * 2;
  const scale = Math.min(1, maxSize / Math.max(rawW, rawH));
  const canvasW = Math.round(rawW * scale);
  const canvasH = Math.round(rawH * scale);

  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvasW, canvasH);

  ctx.scale(scale, scale);
  ctx.translate(-bounds.minX + padding, -bounds.minY + padding);

  const palette = getThemePalette();
  const markers = activeStrokes.filter((s) => s.type === "marker");
  const pens = activeStrokes.filter((s) => s.type !== "marker");
  for (const s of [...markers, ...pens]) {
    drawStroke(ctx, s, palette);
  }

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;

  return fileToDataUrl(blob);
}

/**
 * Render only the note's strokes (no media, background, or typed text) to a
 * single PNG covering the note's full height — a source image for handwriting
 * recognition, not a visual snapshot of the note. Deliberately does not reuse
 * renderNoteSnapshot (noteRenderer.js): that renders background+media+
 * strokes+text into a fixed 360x500 thumbnail box, a scope mismatch for a
 * recognition-focused, strokes-only, full-height image.
 */
async function renderStrokesToImage(note) {
  const activeStrokes = note.strokes ?? [];
  // Taller cap than the clipboard's 2000, since notes can be much longer than a selection.
  const dataUrl = await renderStrokeArrayToDataUrl(activeStrokes, 4000);
  if (!dataUrl) throw new Error("This note has no strokes to render");
  return { __mcp_content_kind: "image", data: dataUrlToBase64(dataUrl), mimeType: "image/png" };
}

/**
 * Export the note to PDF via the existing pipeline, unchanged. mediaItems is
 * just note.media — confirmed via MediaManager.js that getItems() returns
 * this.mediaItems, built directly from initialMedia with no live editor/DOM
 * dependency, so this is callable directly with the already-fetched note.
 */
async function renderNoteToPdf(note) {
  const bytes = await exportNoteToPdf(note, note.media ?? []);
  return {
    __mcp_content_kind: "resource",
    uri: `noteberg://note/${note.id}/pdf-export`,
    mimeType: "application/pdf",
    blob: uint8ArrayToBase64(bytes),
  };
}

/**
 * Encode a Uint8Array as base64 (no Buffer in the webview — this isn't Node).
 * Chunked so a large PDF's bytes don't hit a call-stack/argument-count limit
 * from spreading the whole array into String.fromCharCode at once.
 */
function uint8ArrayToBase64(bytes) {
  let binary = "";
  const CHUNK_SIZE = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

/**
 * Every binary attachment a note can carry, unified into one list. A note has
 * three separate channels — images (note.media[]), audio recordings
 * (note.recordings[]), and a single imported PDF (note.pdfSource, one fileId,
 * not an array). `pdf-page` entries in note.media[] are excluded: they are
 * bitmap renders of the *same* PDF (they share pdfSource's fileId — see
 * NoteCanvas.js's dedup-by-fileId comment), not separate attachments; the
 * single `kind: "pdf"` entry below already covers that content, and returning
 * the original PDF is strictly better for a client than a flattened page image
 * (real text/structure vs. a raster it would have to OCR).
 */
function listAttachments(note) {
  // Note: media.type is the canvas-placement kind ("image" vs "pdf-page"),
  // not a MIME type — omitted here rather than exposed under a misleading
  // name. The real MIME type is only known once the blob is fetched (see
  // fetchAttachment's "attachment" format), so it isn't listed here.
  const images = (note.media ?? [])
    .filter((m) => !m.deleted && m.type !== "pdf-page")
    .map(({ id, name, size }) => ({ id, kind: "image", name, size }));

  const recordings = (note.recordings ?? [])
    .filter((r) => !r.deleted)
    .map(({ id, name, duration }) => ({ id, kind: "recording", name, duration }));

  const pdf = note.pdfSource ? [{ id: "pdf", kind: "pdf", name: "Imported PDF" }] : [];

  return [...images, ...recordings, ...pdf];
}

/**
 * Fetch one attachment's actual data, returning the shape mcp.rs's
 * to_mcp_content_block() expects: a `__mcp_content_kind` marker plus that
 * kind's fields. This is the JS side of the JS<->Rust content-block contract
 * — Rust interprets `__mcp_content_kind` to pick the MCP wire shape
 * (image/audio/resource), it never decides *what* to fetch.
 */
async function fetchAttachment(note, attachmentId) {
  if (attachmentId === "pdf") {
    if (!note.pdfSource) throw new Error("This note has no imported PDF");
    const blob = await getFile(note.pdfSource);
    if (!blob) throw new Error("PDF file not found");
    const dataUrl = await fileToDataUrl(blob);
    return {
      __mcp_content_kind: "resource",
      uri: `noteberg://note/${note.id}/pdf`,
      mimeType: "application/pdf",
      blob: dataUrlToBase64(dataUrl),
    };
  }

  const image = (note.media ?? []).find(
    (m) => m.id === attachmentId && !m.deleted && m.type !== "pdf-page",
  );
  if (image) {
    const blob = await getFile(image.fileId);
    if (!blob) throw new Error(`Image file not found for: ${attachmentId}`);
    // media.type is the canvas-placement kind ("image" vs "pdf-page" — see
    // MediaManager.js), NOT a MIME type — there is no MIME type stored on the
    // media item at all. The real MIME type only exists on the Blob itself
    // (getFile() reconstructs it from the files store's stored content-type).
    const dataUrl = await fileToDataUrl(blob);
    return {
      __mcp_content_kind: "image",
      data: dataUrlToBase64(dataUrl),
      mimeType: blob.type || "image/jpeg",
    };
  }

  const recording = (note.recordings ?? []).find((r) => r.id === attachmentId && !r.deleted);
  if (recording) {
    const blob = await getFile(recording.fileId);
    if (!blob) throw new Error(`Recording file not found for: ${attachmentId}`);
    const dataUrl = await fileToDataUrl(blob);
    // KNOWN ISSUE (tracked in PLAN.md Phase 4a/4b notes): blob.type is
    // unreliable here — recordings come from multiple capture paths (browser
    // MediaRecorder, native Windows WAV, and at least one path producing MP3
    // per a live test) that don't consistently tag the stored blob's real
    // type; a real MP3 recording was observed with blob.type falling through
    // to "application/octet-stream". The audio bytes themselves are fine —
    // only the reported mimeType is wrong, which will likely make MCP clients
    // reject or mishandle the "audio" content block. Needs magic-byte
    // sniffing (or normalizing the type at save-time in RecordingManager.js)
    // as a proper fix — not done here to avoid guessing at a fix under time
    // pressure. Do not trust this mimeType downstream without re-checking.
    return {
      __mcp_content_kind: "audio",
      data: dataUrlToBase64(dataUrl),
      mimeType: blob.type || "audio/webm",
    };
  }

  throw new Error(`Attachment not found: ${attachmentId}`);
}

/** Strip the "data:<mime>;base64," prefix fileToDataUrl() adds — MCP content
 * blocks want the raw base64 payload, not a data URI. */
function dataUrlToBase64(dataUrl) {
  const commaIndex = dataUrl.indexOf(",");
  return commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
}

/**
 * getNote() (storage.js) has no `deleted` filter — unlike every list path
 * (getAllNotes/getNotesByNotebook/getQuickNotes, which all filter
 * `!deleted`), it returns tombstones verbatim, since editing/sync code needs
 * to see soft-deleted records (e.g. to finish propagating a delete). Every
 * MCP entry point that fetches a single note by id goes through this helper
 * instead of calling getNote() directly, so a deleted (recycle-bin) note is
 * treated as "not found" everywhere — the correct read-only semantic: a user
 * who deleted a note reasonably expects it gone from an AI assistant's view,
 * even though the id is still discoverable from an earlier list_notes call
 * and the record physically remains in IndexedDB until purged. (readResource
 * below applies the same `deleted` check inline for both notes and
 * notebooks, rather than through this helper, so it can keep its own
 * uri-scoped "Resource not found" error message.)
 */
async function getNoteOrThrow(id) {
  const note = await getNote(id);
  if (!note || note.deleted) throw new Error(`Note not found: ${id}`);
  return note;
}

/**
 * Curate a note *index* record (already the lightweight, no-content/no-strokes
 * shape storage.js's getAllNotes()/getNotesByNotebook() return — see
 * storage.js's "notes index fields" comment) down to what's actually useful
 * to an MCP client browsing a list: drop internal sync/versioning plumbing
 * (synced, lastSyncedEtag, version, formatVersion, encrypted, background,
 * purged, previousNotebookId, and any stale legacy fields like hasThumbnail
 * that predate the current schema) that a note-taking assistant has no use
 * for and would otherwise have to ignore. Keeps hasStrokes/hasContent/
 * hasRecognition (already free — derived once at write time, see
 * storage.js's splitNote) and the media/recordings id lists (so a client can
 * go straight to get_note's attachment format without a second lookup).
 * Deliberately does NOT add a PDF flag here: pdfSource lives only in the
 * encrypted noteContent payload, not this index, so surfacing it would mean
 * loading full content per note — the exact cost this list is meant to avoid.
 */
function summarizeNote(note) {
  return {
    id: note.id,
    notebookId: note.notebookId,
    title: note.title,
    tags: note.tags ?? [],
    created: note.created,
    modified: note.modified,
    hasStrokes: note.hasStrokes,
    hasContent: note.hasContent,
    hasRecognition: note.hasRecognition,
    media: (note.media ?? [])
      .filter((m) => !m.deleted)
      .map(({ id, name, type }) => ({ id, name, type })),
    recordings: (note.recordings ?? [])
      .filter((r) => !r.deleted)
      .map(({ id, name, duration }) => ({ id, name, duration })),
  };
}

/**
 * Curate a notebook record the same way, plus noteCount/lastNoteModified —
 * cheap to add here since the caller already fetched every note's index for
 * this exact call (list_notes' summarizeNote pass reuses the same fetch, see
 * TOOL_HANDLERS.list_notebooks), so this is one extra in-memory filter/reduce
 * over already-loaded data, not a new IndexedDB read per notebook.
 */
function summarizeNotebook(notebook, allNotes) {
  const notesInThisNotebook = allNotes.filter((n) => n.notebookId === notebook.id);
  const lastNoteModified = notesInThisNotebook.reduce(
    (max, n) => Math.max(max, n.modified ?? 0),
    0,
  );
  return {
    id: notebook.id,
    title: notebook.title,
    description: notebook.description || undefined,
    color: notebook.color,
    created: notebook.created,
    modified: notebook.modified,
    noteCount: notesInThisNotebook.length,
    lastNoteModified: lastNoteModified || undefined,
  };
}

const TOOL_HANDLERS = {
  list_notebooks: async () => {
    const [notebooks, notes] = await Promise.all([getAllNotebooks(), getAllNotes()]);
    return notebooks.map((nb) => summarizeNotebook(nb, notes));
  },

  list_notes: async ({ notebook_id } = {}) => {
    const notes = notebook_id ? await getNotesByNotebook(notebook_id) : await getAllNotes();
    return notes.map(summarizeNote);
  },

  get_note: async ({ id, format, attachment_id } = {}) => {
    if (!id) throw new Error("get_note requires an id");
    const formatHandler = NOTE_FORMAT_HANDLERS[format];
    if (!formatHandler) throw new Error(`Unknown get_note format: ${format}`);

    const note = await getNoteOrThrow(id);

    return formatHandler(note, { attachment_id });
  },

  search_notes: async ({ query } = {}) => {
    if (!query) throw new Error("search_notes requires a query");
    const results = await searchAllNotes(query);
    // Trim to a lightweight summary — the full note (content/strokes/recognition)
    // can be large; a client that wants details calls get_note with the id.
    // modified is free here too — note is already the fetched object.
    return results.map(({ note, contentMatch, recognitionMatch, pdfMatch }) => ({
      id: note.id,
      notebookId: note.notebookId,
      title: note.title,
      modified: note.modified,
      contentMatch,
      recognitionMatch,
      pdfMatch,
    }));
  },

  get_task_markers: async ({ notebook_id } = {}) => getTaskMarkers(notebook_id),

  // Separate from get_task_markers deliberately: a marker list needs to stay
  // one lightweight JSON array (label, or label:null when recognition found
  // nothing usable). Embedding a base64 image as a plain field on a label:null
  // marker was tried and reverted — MCP clients only render images that arrive
  // as a real {type:"image"} content block, not a JSON string field, so a
  // client (observed live: Claude Desktop) gets stuck trying to bash-decode a
  // string it can't actually view. Call this tool per unresolved marker instead.
  get_task_marker_image: async ({ note_id, task_id } = {}) => getTaskMarkerImage(note_id, task_id),

  // Internal — reachable only via the MCP resources/list and resources/read
  // methods (mcp.rs routes those to these exact tool names), never advertised
  // in tools/list or callable via tools/call (see mcp.rs's KNOWN_TOOLS /
  // internal_bridge_tools_are_not_advertised_or_callable_via_tools_call test).
  // Unlike the tool handlers above, these return the exact top-level
  // {resources:[...]} / {contents:[...]} shape the MCP resources spec
  // expects — Rust uses the value as-is here, it does not wrap it via
  // to_mcp_content_block like a normal tools/call result.
  __resources_list: async () => listResources(),
  __resource_read: async ({ uri } = {}) => readResource(uri),
};

/**
 * List notebooks and notes as MCP resources. A lightweight, browsable index —
 * clients that want full content still go through get_note's format menu;
 * resources/read here returns a compact snapshot, not every representation.
 *
 * Each entry's description ends with a short pointer to the tool that
 * actually does more than this browsable index can: a real client (reported
 * live) started here, saw a flat list of notebook/note URIs with no
 * indication that a search_notes/get_note tool surface existed at all, and
 * had to rediscover it by trial and error. resources/list has no envelope-
 * level field for a general hint (only per-item name/description/mimeType),
 * so the hint rides on every item instead — a notebook's real user-authored
 * description (if any) is kept, with the hint appended after it, not
 * overwritten.
 */
async function listResources() {
  const notebooks = await getAllNotebooks();
  const notes = await getAllNotes();

  const notebookHint = "Call list_notes with this notebook's id to see its notes, or search_notes to find something by keyword across all notebooks.";
  const noteHint = "This is an index entry only. Call get_note with this note's id for its actual content (typed text, recognized handwriting, attachments, etc.) — see get_note's format parameter for the full menu, including recognized_text/strokes_images for handwriting.";

  const resources = [
    ...notebooks.map((nb) => ({
      uri: `noteberg://notebook/${nb.id}`,
      name: nb.title || "Untitled notebook",
      description: nb.description ? `${nb.description} — ${notebookHint}` : notebookHint,
      mimeType: "application/json",
    })),
    ...notes.map((n) => ({
      uri: `noteberg://note/${n.id}`,
      name: n.title || "Untitled note",
      description: noteHint,
      mimeType: "application/json",
    })),
  ];
  return { resources };
}

/**
 * Read one resource by URI. Notebooks resolve to their metadata; notes
 * resolve to a compact snapshot (metadata + typed text + recognized text) —
 * not every get_note format, which stays behind the get_note tool for
 * clients that explicitly ask for a specific representation.
 */
async function readResource(uri) {
  if (!uri) throw new Error("resources/read requires a uri");

  const notebookMatch = uri.match(/^noteberg:\/\/notebook\/(.+)$/);
  if (notebookMatch) {
    const notebook = await getNotebook(notebookMatch[1]);
    if (!notebook || notebook.deleted) throw new Error(`Resource not found: ${uri}`);
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({
            id: notebook.id,
            title: notebook.title,
            description: notebook.description,
            color: notebook.color,
            created: notebook.created,
            modified: notebook.modified,
          }),
        },
      ],
    };
  }

  const noteMatch = uri.match(/^noteberg:\/\/note\/(.+)$/);
  if (noteMatch) {
    const note = await getNote(noteMatch[1]);
    if (!note || note.deleted) throw new Error(`Resource not found: ${uri}`);
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({
            id: note.id,
            notebookId: note.notebookId,
            title: note.title,
            html: note.content ?? "",
            recognizedText: note.recognition?.fullText ?? "",
            _note: "This is a compact snapshot, not every representation. Call get_note with this note's id and format 'attachments_list', 'strokes_images', 'note_pdf', etc. for images, PDF export, or other formats.",
          }),
        },
      ],
    };
  }

  throw new Error(`Unrecognized resource uri: ${uri}`);
}

/**
 * Gather task markers across notes, optionally scoped to one notebook.
 * Mirrors overviewMode.js's renderMarkersTab candidate-filtering + per-note
 * extractTasksFromNote() call, minus the progressive-rendering/UI parts (no
 * container to paint incrementally here — just fetch and return).
 */
async function getTaskMarkers(notebookId) {
  const noteIndexes = notebookId ? await getNotesByNotebook(notebookId) : await getAllNotes();

  // Same heuristic as renderMarkersTab: skip notes that can't have tasks
  // without needing to fetch (and decrypt) their full content.
  const candidates = noteIndexes.filter(
    (n) => n.hasStrokes || n.hasContent || (n.tasks && n.tasks.length > 0) || n.content,
  );

  const fullNotes = await Promise.all(candidates.map((n) => getNote(n.id)));

  const allTasks = [];
  for (const note of fullNotes) {
    if (!note) continue;
    for (const task of extractTasksFromNote(note)) {
      allTasks.push({
        id: task.id,
        type: task.type,
        checked: task.checked,
        noteId: task.noteId,
        noteTitle: task.noteTitle,
        // Free to include — note is already fully fetched above; saves a
        // client from a separate list_notes/get_note round-trip just to sort
        // by recency or group by notebook.
        notebookId: note.notebookId,
        noteModified: note.modified,
        label: deriveTaskLabel(task) || null,
      });
    }
  }
  return allTasks;
}

/**
 * Render one task's strokes as a real MCP image content block (not a JSON
 * field — see get_task_marker_image's doc comment above the tool for why).
 * Looks up the task the same way extractTasksFromNote produces it: by id,
 * within the given note's tasks.
 */
async function getTaskMarkerImage(noteId, taskId) {
  if (!noteId || !taskId) throw new Error("get_task_marker_image requires note_id and task_id");

  const note = await getNoteOrThrow(noteId);

  const task = extractTasksFromNote(note).find((t) => t.id === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.type !== "stroke" || !task.strokes?.length) {
    throw new Error(`Task ${taskId} has no strokes to render (not a stroke task, or empty)`);
  }

  const dataUrl = await renderStrokeArrayToDataUrl(task.strokes, 600, 8);
  if (!dataUrl) throw new Error("Could not render this task's strokes");

  return { __mcp_content_kind: "image", data: dataUrlToBase64(dataUrl), mimeType: "image/png" };
}

// `args` arrives as a real JS object, not a JSON string: eval_bridge (mcp.rs)
// builds the eval script by embedding serde_json::to_string(arguments) directly
// as a JS literal (e.g. `handle("list_notes", "id123", {"notebook_id":"x"})`),
// not as a quoted string argument — so there is nothing to JSON.parse here.
//
// `args` also carries a reserved `_tokenName` field, injected by call_tool
// (mcp.rs) from the token that authenticated this request — mirrors the
// existing __mcp_content_kind convention but in the Rust->JS direction.
// Stripped here before the handler sees `args`, so TOOL_HANDLERS never has to
// know it exists; kept only for the audit log entry.
async function handle(tool, requestId, rawArgs) {
  const { invoke } = await import("@tauri-apps/api/core");
  const handler = TOOL_HANDLERS[tool];
  const startedAt = performance.now();
  const { _tokenName: tokenName, ...args } = rawArgs ?? {};

  // Footer's MCP indicator listens for this to pulse on real traffic — every
  // call (known tool or not) counts as activity, so this fires before the
  // handler lookup below, not just on success.
  window.dispatchEvent(new CustomEvent("mcp-activity"));

  if (!handler) {
    await logAuditEntry(
      tool,
      args,
      tokenName,
      { ok: false, errorMessage: `Unknown MCP tool: ${tool}` },
      startedAt,
    );
    await invoke("mcp_respond", {
      requestId,
      ok: false,
      json: JSON.stringify({ error: `Unknown MCP tool: ${tool}` }),
    });
    return;
  }

  try {
    const result = await handler(args);
    await logAuditEntry(tool, args, tokenName, { ok: true }, startedAt);
    await invoke("mcp_respond", { requestId, ok: true, json: JSON.stringify(result) });
  } catch (error) {
    console.error(`[MCP Bridge] Tool '${tool}' failed:`, error);
    const errorMessage = String(error?.message ?? error);
    await logAuditEntry(tool, args, tokenName, { ok: false, errorMessage }, startedAt);
    await invoke("mcp_respond", {
      requestId,
      ok: false,
      json: JSON.stringify({ error: errorMessage }),
    });
  }
}

/**
 * Record one call in the MCP access log. Never lets a logging failure break
 * the actual tool call — audit logging is an observability add-on, not a
 * gate. Internal bridge tools (__resources_list/__resource_read) are logged
 * under their real names too; they're just as much "what did the MCP
 * connection access" as any advertised tool. tokenName is recorded as a
 * plain string copy on the entry itself (not a foreign key to the token
 * list), so revoking or renaming a token later doesn't change history.
 */
async function logAuditEntry(tool, args, tokenName, { ok, errorMessage }, startedAt) {
  try {
    const { appendAuditEntry } = await import("./mcpAuditLog.js");
    await appendAuditEntry({
      tool,
      arguments: args ?? {},
      tokenName: tokenName ?? null,
      ok,
      errorMessage,
      durationMs: Math.round(performance.now() - startedAt),
    });
  } catch (logError) {
    console.error("[MCP Bridge] Failed to write audit log entry:", logError);
  }
}

/**
 * Cryptographically random, URL-safe token — 256 bits of entropy, comparable
 * in strength to how session/API tokens are generated elsewhere. Not reused
 * from storage.js's generateId(), which is a UUID (122 bits, meant for
 * uniqueness, not secrecy).
 */
function generateSecureToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Metadata list ({id, name}[]) for every currently-issued token. */
async function getTokenList() {
  return (await getSetting(MCP_TOKENS_KEY)) ?? [];
}

/**
 * Push the current enabled flag + every token's {value, name} into Rust's
 * McpState — Rust replaces its whole token map on each call (see
 * mcp_set_config in mcp.rs), so this always sends the complete current set,
 * not a delta.
 */
async function pushConfigToRust(enabled, tokenList) {
  const { invoke } = await import("@tauri-apps/api/core");
  const tokens = await Promise.all(
    tokenList.map(async ({ id, name }) => ({
      value: (await getSecureCredential(MCP_TOKEN_CREDENTIAL_PREFIX + id)) ?? "",
      name,
    })),
  );
  await invoke("mcp_set_config", { enabled, tokens });

  // Single funnel for every enable/disable/token mutation (setMcpEnabled,
  // generateAndStoreMcpToken, revokeMcpToken, syncMcpConfigToRust) — the
  // footer's MCP badge listens for this instead of each call site having to
  // remember to dispatch it separately.
  window.dispatchEvent(new CustomEvent("mcp-status-changed"));
}

export async function isMcpEnabled() {
  return (await getSetting(MCP_ENABLED_KEY)) ?? false;
}

/** Every currently-issued token's metadata (id + name), for the Settings UI's token list. Secrets never leave the keyring once generated — only shown once, at creation. */
export async function listMcpTokens() {
  return getTokenList();
}

/**
 * Enable/disable the MCP server. Does not touch tokens — enabling without any
 * token configured yet still leaves the Rust side fail-closed (see mcp.rs
 * handle_request).
 */
export async function setMcpEnabled(enabled) {
  await setSetting(MCP_ENABLED_KEY, enabled);
  await pushConfigToRust(enabled, await getTokenList());
}

/**
 * Generate a new named token, store its secret in the OS keyring under its
 * own entry, append its metadata to the token list, and push the full set to
 * Rust. Returns the plaintext token so the Settings UI can show it once — it
 * is never retrievable again after this (mirrors how master-password-derived
 * secrets are treated: write-mostly, not read back for display).
 */
export async function generateAndStoreMcpToken(name) {
  const id = crypto.randomUUID();
  const token = generateSecureToken();
  await saveSecureCredential(MCP_TOKEN_CREDENTIAL_PREFIX + id, token);

  const tokenList = await getTokenList();
  tokenList.push({ id, name: name || "Unnamed token" });
  await setSetting(MCP_TOKENS_KEY, tokenList);

  const enabled = await isMcpEnabled();
  await pushConfigToRust(enabled, tokenList);
  return token;
}

/**
 * Revoke one token by id: push the reduced set to Rust first (that's what
 * actually stops the token from authenticating), then persist the reduced
 * list, then best-effort delete the keyring entry last. Ordered this way
 * deliberately — the user sees a confirm dialog and a re-render and believes
 * revocation succeeded, so the step that actually revokes access can't be
 * last-and-unguarded: if the keyring delete throws (unlike
 * getSecureCredential, deleteSecureCredential does not swallow its own
 * errors), the token must already be inert rather than still live until an
 * app restart clears Rust's in-memory state anyway.
 */
export async function revokeMcpToken(id) {
  const tokenList = (await getTokenList()).filter((t) => t.id !== id);
  const enabled = await isMcpEnabled();
  await pushConfigToRust(enabled, tokenList);

  await setSetting(MCP_TOKENS_KEY, tokenList);

  try {
    await deleteSecureCredential(MCP_TOKEN_CREDENTIAL_PREFIX + id);
  } catch (error) {
    // Access is already revoked (Rust no longer has this token, and it's
    // gone from the persisted list) — a leftover keyring entry is just
    // orphaned storage, not a security exposure, so this is safe to log and
    // move on rather than fail the whole revoke.
    console.error(`[MCP Bridge] Failed to delete keyring entry for revoked token ${id}:`, error);
  }
}

export async function getMcpStatus() {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("mcp_get_status");
}

/**
 * Push persisted settings into Rust's in-memory state. Rust always boots
 * disabled/tokenless (fresh process, no persistence on that side) — JS
 * (IndexedDB + keyring) is the source of truth, pushed in once here.
 *
 * Awaited by main.js (not fire-and-forget) and retried once on failure: this
 * is the one push that makes the persisted "enabled" setting actually take
 * effect for the whole session, so a silent failure here would strand the
 * user with the Settings toggle showing "on" while the server is actually
 * still disabled, with nothing else to prompt a retry (this app has no
 * separate unlock step to hook — the vault auto-unlocks with no user
 * interaction). One retry covers the realistic failure mode (a transient
 * IPC hiccup right at startup); if it still fails, isMcpEnabled() and
 * getMcpStatus() disagreeing is left for the Settings UI to detect and
 * surface (see renderSettings' mcpStatusMismatch handling), rather than
 * looping indefinitely here.
 */
export async function syncMcpConfigToRust() {
  try {
    await pushConfigToRust(await isMcpEnabled(), await getTokenList());
  } catch (error) {
    console.error("[MCP Bridge] Failed to sync persisted config to Rust, retrying once:", error);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await pushConfigToRust(await isMcpEnabled(), await getTokenList());
  }
}

export function initMcpBridge() {
  window.__mcpBridge = { handle };
  console.log("[MCP Bridge] Initialized");
}
