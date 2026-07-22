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
| Android (Tauri) | *(unset)* | IndexedDB | Native (Kotlin plugin) | not available |
| Nextcloud web app | `nextcloud` | WebDAV | Import + playback only — no recording | not available |

---

## Data Layer

### IndexedDB Schema (Tauri builds, v4)

The schema is split into two stores for performance — the index is small and fast to scan; heavy content is only loaded when a note is opened.

**`notes` store** — lightweight index, never encrypted:
```
id, notebookId, title, created, modified, version,
synced, lastSyncedEtag, deleted, purged, previousNotebookId,
encrypted, background, formatVersion, tags,
hasStrokes, hasContent, hasRecognition,
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
deletedRecordings[]
```

Note: there is no stored/persisted thumbnail. A `thumbnailFileId`/`hasThumbnail` scheme existed previously but was removed (see `_migrateThumbnailsToNoteContent()` in `storage.js`, a one-time v5 migration that deletes the old blobs and stale index fields). Overview cards are rendered on demand instead — see [Overview Thumbnails](#overview-thumbnails) below.

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

All IndexedDB writes from the canvas go through a dedicated Web Worker to keep the drawing loop on the main thread smooth, processing a sequential message queue to avoid read-modify-write races. It also encrypts content in-place before writing, when encryption is enabled.

**Disabled in the Nextcloud build** — replaced by the WebDAV storage layer.

Full message-type list and per-message trigger/behavior breakdown: see **[note_editor_architecture.md § Storage Handoff](note_editor_architecture.md#storage-handoff)**.

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

Authentication uses Login Flow v2 (OAuth-like browser redirect); the resulting credentials (`serverUrl`, `loginName`, `appPassword`) are stored in the OS keychain, never in localStorage or IndexedDB.

Sync itself is ETag-based (PROPFIND → compare ETags → download/upload deltas → update `lastSyncedEtag`), with per-field conflict merging, an ETag-oscillation workaround for a Nextcloud server-side versioning quirk, and `synced`/`version`/`deleted`/`purged` flags driving the whole state machine.

Full step-by-step engine behavior, conflict resolution rules, concurrency limits, and known edge cases: see **[sync_architecture.md](sync_architecture.md)**.

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

For the full stroke-recording pipeline, canvas/rendering architecture (2 canvases + DOM overlays, sliding-buffer rendering), undo/redo, media, and text-editing internals: see **[note_editor_architecture.md](note_editor_architecture.md)**.

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

1. Strokes sent as `[{ id, points: [{x, y, pressure}] }]` (POST `/recognize?language=...`)
2. Response: a bare array of `{ text, boundingBox }` word objects (no `lines`, no wrapping object)
3. Client derives `{ fullText, words }` (`fullText` = words joined with spaces) and stores that shape in `noteContent.recognition`
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

### Browser (non-native, non-Nextcloud)

`getUserMedia` with `echoCancellation`, `noiseSuppression`, `autoGainControl` constraints → Web Audio API processing chain → `MediaRecorder`. The same compressor/limiter parameters as the native Windows chain are applied via the Web Audio API.

### Nextcloud — Import Only

The Nextcloud build has **no recording code path at all**, browser-based or otherwise. `SoundDialog.js` gates the "New recording" button behind a native-only check (`window.__TAURI_INTERNALS__` present) — in the Nextcloud build that button is never rendered, so the `getUserMedia`/Web Audio chain above is never invoked there. Only importing existing audio files and playback are available in the NC build's sound dialog.

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

### Overview Thumbnails

Overview cards are **not** backed by a stored thumbnail blob. `renderNoteSnapshot(canvas, note)` (`src/utils/noteRenderer.js`) renders a 360×500px preview on demand at overview-render time: it mounts a detached `CanvasRenderer` to draw the background/pattern, then layers in media (images and the first PDF page) and strokes directly from the note's live content. A one-time migration (`_migrateThumbnailsToNoteContent()` in `storage.js`) removed the old `thumbnailFileId`/`thumbnailTimestamp` index fields and their blobs — thumbnails used to be persisted and synced, but this was replaced because it caused ETag churn on Nextcloud (see the etag-oscillation history in [sync_architecture.md](sync_architecture.md)).

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
- **Key derivation:** PBKDF2-SHA256, 600,000 iterations for new keys, 16-byte random salt (100,000 iterations retained only to decrypt keys derived before the bump, via a stored per-user `iterations` field)
- **Encryption:** AES-256-GCM, 12-byte random IV per operation
- **Encrypted fields:** `content`, `strokes`, `media`, `tasks`, `recognition`, `recordings`
- The master password itself is stored in the OS keychain for auto-unlock
- If the app is locked (no key available) when a save fires for an encrypted note, `StorageWorker.js` drops that save and logs an error rather than writing plaintext — the edit is lost from persistence until the app is unlocked and the action is repeated

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
| Audio recording | Native (Windows/Android) or browser `MediaRecorder` | Import + playback only — no recording UI at all | `SoundDialog.js` gates the "New recording" button behind a native-only (`__TAURI_INTERNALS__`) check; the button isn't rendered in the NC build, so even the browser `getUserMedia` path is never reached there |
| Tombstones | Written to IndexedDB + WebDAV | Written to WebDAV only | Still required so Tauri fat clients sharing the same `/NoteBerg/` folder see deletions from the NC app |

`storage.webdav.js` keeps the exact same exported function signatures as the IndexedDB `storage.js` (`getAllNotes`, `getNote`, `saveNote`, `deleteNote`, `saveMedia`, etc.) so every caller above the storage layer is platform-agnostic; only the module swapped via the Vite alias differs.

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
