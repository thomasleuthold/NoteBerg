# NoteBerg — Architecture & Design

## Overview

NoteBerg is a cross-platform note-taking app built with **Tauri v2** (Rust backend + Vite/Vanilla JS frontend). It runs as a native desktop app (Windows, macOS, Linux), an Android app, and a Nextcloud web app — sharing almost all frontend code across all three platforms.

```
┌───────────────────────────────────────────────────────┐
│              Frontend (Vite + Vanilla JS)             │
│  ┌──────────────┐  ┌─────────────┐  ┌─────────────┐   │
│  │  NoteCanvas  │  │  Sync/Store │  │  UI/Router  │   │
│  │  (drawing,   │  │  (IndexedDB │  │  (overview, │   │
│  │   text, lasso│  │  / WebDAV)  │  │   modals)   │   │
│  └──────────────┘  └─────────────┘  └─────────────┘   │
│  ┌──────────────────────────────────────────────────┐ │
│  │         StorageWorker.js (Web Worker)            │ │
│  └──────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────┘
                         │ Tauri commands
┌────────────────────────▼──────────────────────────────┐
│                 Tauri Backend (Rust)                  │
│  ┌───────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │ OS Keyring│  │  Native  │  │  Recognition       │  │
│  │ (keychain)│  │  Audio   │  │  Sidecar (Windows) │  │
│  └───────────┘  └──────────┘  └────────────────────┘  │
└───────────────────────────────────────────────────────┘
```

---

## Platform Variants

The build target is controlled by the `VITE_PLATFORM` environment variable:

| Platform | Value | Storage | Audio | Recognition |
|---|---|---|---|---|
| Desktop (Tauri) | *(unset)* | IndexedDB | Native (Windows) / browser | Local sidecar (Windows) |
| Android (Tauri) | *(unset)* | IndexedDB | Native (Kotlin plugin) | External URL |
| Nextcloud web app | `nextcloud` | WebDAV | Browser only | External URL |

---

## Data Layer

### IndexedDB Schema (Tauri builds, v4)

The schema is split into two stores for performance — the index is small and fast to scan; heavy content is only loaded when a note is opened.

**`notes` store** — lightweight index, never encrypted:
```
id, notebookId, title, created, modified, version,
synced, lastSyncedEtag, deleted, purged, previousNotebookId,
encrypted, background, formatVersion, tags,
hasStrokes, hasContent, hasRecognition, hasThumbnail,
media[]  (snapshot: id, name, type, size, deleted — no fileIds),
recordings[]  (snapshot: id, name, duration, deleted — no fileIds)
```

**`noteContent` store** — full payload, encrypted when `note.encrypted = true`:
```
id, content (HTML), strokes[], deletedStrokes[],
media[] (full: id, fileId, name, type, size, x, y, width, height,
         rotation, cropData, pdfPage, deleted),
deletedMedia[], tasks[], recognition,
penPresets[], pdfSource (fileId),
recordings[] (full: id, fileId, name, duration, created, deleted),
deletedRecordings[], thumbnail (base64 JPEG, 360×500px)
```

**`notebooks` store:**
```
id, title, description, color, created, modified,
version, synced, lastSyncedEtag, deleted, purged
```

**`files` store** — binary blobs for images, audio, PDFs:
```
id (fileId), data (ArrayBuffer), type (MIME), created
```

**`settings` store** — key/value app configuration.

### Web Worker (StorageWorker.js)

All IndexedDB writes from the canvas go through a dedicated Web Worker to keep the drawing loop on the main thread smooth. The worker processes a sequential message queue to avoid read-modify-write races.

Message types: `SAVE_STROKES`, `SAVE_MEDIA`, `SAVE_PRESETS`, `SAVE_THUMBNAIL`, `SAVE_TASKS`, `SAVE_CONTENT`, `SAVE_RECORDINGS`

Each message updates both the `noteContent` store (full data) and the `notes` index (derived flags + metadata snapshot). `SAVE_THUMBNAIL` intentionally does **not** touch `modified`, `version`, or `synced` — thumbnails are UI-only metadata and must not trigger a sync upload.

The worker receives the encryption key when encryption is enabled and encrypts content in-place before writing.

**Disabled in the Nextcloud build** — replaced by the WebDAV storage layer.

### WebDAV Storage (Nextcloud build)

`storage.webdav.js` replaces `storage.js` entirely via a Vite alias when `VITE_PLATFORM=nextcloud`. All data is stored on the Nextcloud server using the WebDAV API. File layout:

```
/NoteBerg/
  notebooks/
    {notebookId}/
      _notebook.json
      notes/
        {noteId}.json
        {noteId}_media/
          {fileId}.{ext}
      _tombstones.json
  quickNotes/
    {noteId}.json
    {noteId}_media/{fileId}.{ext}
    _tombstones.json
```

---

## Nextcloud Sync

### Authentication

Login Flow v2 (OAuth-like browser redirect). The resulting credentials (`serverUrl`, `loginName`, `appPassword`) are stored in the OS keychain — never in localStorage or IndexedDB.

### ETag-based Incremental Sync

Each note/notebook file is tracked by its WebDAV ETag (`lastSyncedEtag`). On sync:

1. **PROPFIND** all remote files → compare ETags
2. **Download** files where remote ETag ≠ `lastSyncedEtag`
3. **Upload** files where `synced = false` (local edits pending)
4. Update `lastSyncedEtag` after successful upload or download

**ETag oscillation fix:** Nextcloud can alternate between two ETags for the same file (server-side versioning). When a file appears modified remotely but local content is clean (`synced = true`), the remote `mtime` is compared against local `modified`. If `remote.modified ≤ local.modified + 2s`, the remote ETag is accepted without downloading.

### Conflict Resolution

- Upload conflict (HTTP 412): retry without `If-Match` header (force overwrite)
- Stroke merge: local changes take priority
- Media merge: deduplicated by `fileId`, deletion markers respected
- Manual resolution UI for structural conflicts

### Sync Flags

- `synced = false` — set on any local edit; cleared after successful upload
- `version` — incremented on each save; used for ordering during merge
- `deleted` / `purged` — soft delete then hard delete lifecycle

---

## Drawing System

### Stroke Format

```javascript
{
  id: "uuid",
  x: [x0, x1, ...],          // X coordinates
  y: [y0, y1, ...],          // Y coordinates
  pressure: [p0, p1, ...],   // 0.0–1.0
  time: [t0, t1, ...],       // milliseconds
  colorIndex: 0,             // index into theme palette
  width: 2,                  // stroke width in content pixels
  pointerType: "pen",        // "pen" | "touch" | "mouse"
  type: "pen",               // "pen" | "marker" (semi-transparent)
  _deleted: false,
}
```

Arrays of coordinates are used rather than arrays of point objects for compact storage and efficient serialisation.

### Canvas Layers

The canvas uses multiple stacked layers:
1. **Background layer** — ruled lines / grid pattern
2. **PDF layer** — rendered PDF pages (if note has a PDF source)
3. **Stroke layer** — freehand strokes (HTML5 Canvas)
4. **Media layer** — images, with resize/rotate/crop handles
5. **Text layer** — WYSIWYG text editor (Trumbowyg) overlay
6. **Lasso layer** — selection rectangle and handles

### Drawing Modes

| Mode | Description |
|---|---|
| `pan` | Scroll/zoom (default) |
| `draw` | Freehand strokes with current pen settings |
| `eraser` | Stroke eraser (whole stroke) or part eraser (pixel-level) |
| `lasso` | Freehand selection — move, resize, rotate, copy, delete |
| `text` | Text editing via WYSIWYG overlay |
| `insert-space` | Shift content downward to create blank space |

Auto-switching: stylus detected → switch to `draw`; text area clicked → switch to `text`.

### Pen Presets

Named presets store pen type, color, and width. Saved per-note in `noteContent.penPresets`.

---

## Handwriting Recognition

**Windows only**, via a bundled local sidecar. Not available on any other platform — hosting the recognition service yourself is not a supported scenario, so no URL configuration exists outside Windows.

### Sidecar Service

A .NET sidecar (`NoteBerg.Recognition`) is bundled with the app and auto-started by Tauri on launch. It exposes a local HTTP endpoint and uses `Windows.UI.Input.Inking.Analysis.InkAnalyzer` for recognition.

- `InkAnalyzer` performs spatial grouping into words/lines regardless of stroke input order
- `SetStrokeDataKind(Writing)` ensures all strokes are treated as handwriting (not drawings)
- Strokes are sent in **temporal order** — do not sort spatially on the client

### Recognition Flow

1. Strokes sent as `[{ id, points: [{x, y, pressure}] }]` (POST `/recognize`)
2. Response: `{ fullText, lines: [{text, boundingBox, words}], words: [{text, boundingBox}] }`
3. Result stored in `noteContent.recognition`
4. Debounced 2.5s after last stroke modification
5. Batch recognition on app startup for all unrecognised notes (Windows)

Recognition text is used for full-text search across all notes.

---

## Audio Recording

### Windows — Native WASAPI

Uses the `cpal` crate for WASAPI capture and `hound` for WAV encoding. WAV format stores duration in the file header, enabling correct playback time display.

**DSP chain** (mirrors the browser Web Audio API chain):
1. DynamicsCompressor: threshold -18 dB, knee 12 dB, ratio 3:1, attack 50 ms, release 300 ms
2. Make-up gain: 1.1×
3. Limiter: threshold -1 dB, ratio 20:1, attack 1 ms, release 100 ms

The compressor uses a per-sample peak detector with attack/release smoothing and a soft-knee gain computer following the WebKit/Chromium DynamicsCompressor spec.

### Android — Kotlin Plugin

`AudioRecorderPlugin` uses Android `MediaRecorder` (MP4/AAC, 44.1 kHz). Communicated via Tauri mobile plugin commands: `start`, `stop`, `pause`, `resume`, `cancel`, `getAmplitude`.

### Browser (Nextcloud / non-native)

`getUserMedia` with `echoCancellation`, `noiseSuppression`, `autoGainControl` constraints → Web Audio API processing chain → `MediaRecorder`. The same compressor/limiter parameters as the native Windows chain are applied via the Web Audio API.

Recording and new recording are disabled in the Nextcloud build UI — only import of existing audio files is available.

### Recording Storage

Completed recordings are stored as blobs in the `files` IndexedDB store (or WebDAV for NC). Metadata is stored in `noteContent.recordings`:

```javascript
{ id, fileId, name, duration, created, deleted }
```

---

## Media & File Storage

Images, audio recordings, and PDF sources are stored as binary blobs in the `files` IndexedDB store keyed by a `fileId` UUID. On Nextcloud sync, files are uploaded to the per-note media folder.

MIME → file extension mapping used for WebDAV uploads:
`image/jpeg→.jpg`, `image/png→.png`, `audio/mp4→.m4a`, `audio/wav→.wav`, `application/pdf→.pdf`, etc.

Media items in notes carry positioning metadata (content coordinates):
```javascript
{ id, fileId, name, type, size, x, y, width, height, rotation, cropData, pdfPage, deleted }
```

---

## Security

### Credentials

Nextcloud credentials (`serverUrl`, `loginName`, `appPassword`) are stored exclusively in the native OS keychain:
- **Windows:** Windows Credential Manager (`keyring` crate)
- **macOS:** Keychain Services
- **Linux:** Secret Service daemon
- **Android:** Android Keystore-backed AES-256-GCM (`DeviceKeyPlugin` Kotlin plugin)

### Local Encryption (Master Password)

Optional per-note encryption using:
- **Key derivation:** PBKDF2-SHA256, 100,000 iterations, 16-byte random salt
- **Encryption:** AES-256-GCM, 12-byte random IV per operation
- **Encrypted fields:** `content`, `strokes`, `media`, `tasks`, `recognition`, `thumbnail`, `recordings`
- The master password itself is stored in the OS keychain for auto-unlock

The `notes` index store is **never** encrypted — only `noteContent` is — so the overview can render without decryption.

### End-to-End Encryption (Nextcloud)

Optionally encrypts note JSON before upload to Nextcloud, using the same PBKDF2 + AES-256-GCM scheme. Can be enabled independently of local encryption.

---

## Platform-Specific Details

### Windows

- **WebView2** (Chromium-based) as the app webview
- **Microphone permissions:** Pre-granted via WebView2 profile `SetPermissionState` + `PermissionRequested` handler; consent registry entries written on startup
- **Recognition sidecar:** Auto-started, polled for readiness, URL passed to frontend via `get_recognition_url` command
- **Native audio:** WASAPI capture via `cpal` crate
- **PDF save:** Native save dialog via `rfd` crate
- **Keychain:** Windows Credential Manager via `keyring` crate

### Android

- **AudioRecorderPlugin** — native audio recording (MP4/AAC)
- **DeviceKeyPlugin** — Android Keystore credential storage
- **PdfSavePlugin** — FileProvider + `ACTION_VIEW` Intent for PDF viewing
- **Build:** `patch-android` task removes an auto-generated `MODIFY_AUDIO_SETTINGS` permission that causes issues
- Min SDK: 24 (Android 7.0)

### Nextcloud App

- **PHP app** (`appinfo/`, `lib/`, `templates/`) bootstrapped as a standard NC app
- **App ID:** `noteberg`
- **Frontend:** Vite bundle served via `templates/index.php`
- **CSP:** Allows `worker-src 'self' blob:` for the StorageWorker
- **No native audio recording** — import only
- **No handwriting recognition** — Windows-sidecar-only feature; not shown in NC settings
- **Storage:** `storage.webdav.js` replaces `storage.js` entirely via Vite alias
- **Build:** `just build-nc` → Vite build → `occ integrity:sign-app` → tar.gz + archive signature

---

## Nextcloud App — Design Rationale

The Nextcloud app shares the same `src/` frontend as the Tauri desktop/Android app (see Platform Variants above), but deliberately drops several subsystems rather than porting them:

| Subsystem | Tauri | Nextcloud | Why dropped |
|---|---|---|---|
| Authentication | App password stored in OS keychain | None — Nextcloud session cookie | User is already logged in to Nextcloud; `@nextcloud/axios` sends session headers automatically |
| Local encryption / master password | Active | Always off | Nextcloud already controls server-side access; no separate local secret to protect |
| Sync engine (`nextcloudSync.js`, `autoSync.js`) | Active — etag tracking, conflict resolution, three-way merge | None — `storage.webdav.js` reads/writes WebDAV directly | There is nothing to reconcile: the NC app **is** the server, so every read/write is already the source of truth |
| Settings panel | Full (theme, language, sync, encryption, recognition, purge) | Hidden entirely | Theme/language come from Nextcloud itself; the dropped subsystems above have no settings to expose |
| Handwriting recognition | Sidecar-based (Windows only) | Not available — hint text only | Recognition depends on the Windows `InkAnalyzer` sidecar; there is no supported way to self-host the service, so non-Windows platforms show no setting at all |
| Tombstones | Written to IndexedDB + WebDAV | Written to WebDAV only | Still required so Tauri fat clients sharing the same `/NoteBerg/` folder see deletions from the NC app |

`storage.webdav.js` keeps the exact same exported function signatures as the IndexedDB `storage.js` (`getAllNotes`, `getNote`, `saveNote`, `deleteNote`, `saveMedia`, etc.) so every caller above the storage layer is platform-agnostic; only the module swapped via the Vite alias differs.

### Open questions (unresolved as of this writing)

- **Handwriting recognition** — the Windows `InkAnalyzer` sidecar doesn't translate to a web app; recognition is simply unavailable on the NC app (no self-hosting option is offered).
- **Offline support** — out of scope; the NC app requires a live connection to the Nextcloud server.
- **Card size setting** — fixed default; no per-user setting yet.
- **Nextcloud App Store publishing** — the app currently ships as an `-rc` (release candidate) version intentionally, to keep it out of the main store listing until more testing has happened.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Split `notes`/`noteContent` schema | Overview renders without decrypting or loading heavy content |
| Web Worker for IndexedDB writes | Keeps drawing loop smooth; avoids jank during saves |
| ETag-based sync | Avoids re-downloading unchanged files; works with standard WebDAV |
| Stroke arrays `x[], y[], pressure[]` | Compact storage; faster serialisation than array-of-objects |
| WAV for Windows recording | WAV header stores duration; playback time display works correctly (WebM does not) |
| Native audio on Windows/Android | Browser `getUserMedia` + WebM has no duration metadata and unreliable quality |
| Local recognition sidecar | Offline, no API costs, uses Windows Ink Analysis (high quality) |
| OS keychain for credentials | No plaintext secrets on disk; leverages hardware-backed storage on Android |
| Nextcloud Login Flow v2 | User never enters main NC password into the app; app password can be revoked independently |
