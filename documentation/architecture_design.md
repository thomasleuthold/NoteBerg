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
| Desktop (Tauri) | *(unset)* | IndexedDB | Native (Windows) / browser | Local sidecar (Windows) + optional AI |
| Android (Tauri) | *(unset)* | IndexedDB | Native (Kotlin plugin) | Optional AI only |
| Nextcloud web app | `nextcloud` | WebDAV | Import + playback only — no recording | Optional AI only, via PHP proxy |

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

Authentication uses Login Flow v2 (OAuth-like browser redirect); the resulting credentials (`serverUrl`, `loginName`, `appPassword`, `userId`) are stored in the OS keychain, never in localStorage or IndexedDB.

`loginName` is what the user typed and is only used for Basic auth. WebDAV paths (`/remote.php/dav/files/{userId}/`, `/remote.php/dav/uploads/{userId}/`) need Nextcloud's internal user ID, which differs on LDAP/AD backends (UUIDs) and for email/alias logins. `userId` is read from `GET /ocs/v2.php/cloud/user` at login; credentials stored before it existed are backfilled on first use. While the lookup fails, the login name is used (the pre-`userId` behavior) and the lookup is retried after 5 minutes. All URL building goes through `getDavAccount()` in `nextcloudSync.js`. The NC app build is unaffected: it takes the user ID from `OC.currentUser`.

Sync itself is ETag-based (PROPFIND → compare ETags → download/upload deltas → update `lastSyncedEtag`), with per-field conflict merging, an ETag-oscillation workaround for a Nextcloud server-side versioning quirk, and `synced`/`version`/`deleted`/`purged` flags driving the whole state machine.

Full step-by-step engine behavior, conflict resolution rules, concurrency limits, and known edge cases: see **[sync_architecture.md](sync_architecture.md)**.

---

## Backup & Restore

Native builds only (Windows, Android): Settings → Backup writes the whole local corpus into one `.zip` (optionally WinZip AES-256) and restores it non-destructively. Rust (`src-tauri/src/backup.rs`) owns the archive, and JS streams one entry, or one chunk of an entry, per IPC call, so neither side ever holds the whole archive in memory. On Android, `BackupFilePlugin.kt` hands the archive to the Storage Access Framework through the app cache dir. Restored notes re-enter sync as fresh edits, with a `restoredAt` marker that makes the next sync upload them as-is instead of merging the server copy back in.

Archive layout, conflict modes, the sync interaction, and security guards: see **[backup_restore_design.md](backup_restore_design.md)**.

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

Two backends, on every platform. The bundled Windows sidecar is the default where it exists; an AI vision model is an opt-in alternative available everywhere. See [ai_integration_design.md](ai_integration_design.md) for the AI path in full.

| Backend | Platforms | Trigger | Geometry |
|---|---|---|---|
| Windows Ink sidecar | Windows | automatic, debounced | exact per-word boxes |
| AI vision model | Windows, Android, Nextcloud | manual only, queued | approximate — a coloured band, not a box |

The AI backend is off by default and sends nothing until the user configures a provider and consents to the destination host.

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

### AI Recognition Flow

1. User starts it from the note toolbar — never automatic (a page costs money and takes minutes)
2. A persisted, serial job is enqueued (`recognition/recognitionQueue.js`); the dialog can be closed
3. Ink is rasterized to one PNG per virtual A4 page, painted with six pale colour bands
4. One request per page to the configured provider (OpenAI-compatible or Replicate; on Nextcloud via the PHP proxy)
5. The band the model names per word is resolved to a content-space `yRange` at write time
6. Words are stored in the same `recognition` shape, tagged `precision: "approximate"` with `boundingRect: null`

Recognition text is used for full-text search across all notes, regardless of which backend produced it, and syncs to every device like any other note field.

---

## Audio Recording

### Shared DSP chain

Both native platforms apply the **same** chain, so a recording sounds the same
wherever it was made. Previously Windows ran a port of the browser Web Audio
chain (a downward compressor plus fixed +0.8 dB make-up, which could not raise a
quiet input at all) and Android had no app-side gain stage whatsoever — the
level came entirely from each device's VoIP HAL tuning, which is why one device
recorded usably and another far too quietly.

Chain, on mono samples:
1. **Downmix to mono** — halves file size; voice memos gain nothing from stereo
2. **High-pass, 80 Hz** (2nd-order Butterworth) — removes DC offset and rumble that would otherwise bias the level estimate
3. **Slow AGC** — targets -20 dBFS RMS over a 400 ms window; gain range -6 to +30 dB, rising at most 3 dB/s and falling at most 30 dB/s; gain is interpolated per sample across 10 ms blocks (no zipper noise) and frozen when the block is within 6 dB of the tracked noise floor (so silence is not amplified into hiss)
4. **Look-ahead peak limiter** — 5 ms delay line, -1 dBFS ceiling, ~80 ms release. Gain reduction is in place before the peak arrives, so nothing can exceed the ceiling and the old hard-clip-a-transient click is gone
5. **Pause/resume fades** — 5 ms, so a splice is not a step discontinuity

Implemented twice, deliberately: `src-tauri/src/audio_dsp.rs` (Rust, used by
Windows) and `AudioDsp.kt` (Kotlin, used by Android). The design's first choice
was one Rust implementation called over JNI; the Kotlin port is the documented
fallback, taken because the JNI hook-up could not be verified without a device
build. **The tuning constants must stay identical in both.** `AudioDspTest.kt`
mirrors the Rust unit tests — same assertions, same thresholds — so a divergence
fails the build rather than shipping as a level difference between platforms.

### Windows — Native WASAPI

`cpal` for WASAPI capture. The capture callback runs in a real-time context and
does **only**: a paused check and a push into a lock-free SPSC ring buffer
(`rtrb`, ~8 s of 48 kHz stereo). No allocation, no locks, no file I/O — these
were previously all in the callback and were the cause of clicks and drop-outs,
made invisible in logs because `cpal` swallows WASAPI's discontinuity flag.

A dedicated worker thread (`noteberg-audio`) drains the ring, runs the DSP, and
feeds the encoder. It publishes the post-DSP peak for the meter, so the meter
means the same thing as on Android. Shutdown is ordered so it cannot race: the
stream is dropped first (no producer can remain), then `running` is cleared; the
worker treats "ring empty and not running" as end-of-stream.

**Under load.** Both the capture thread and the worker register with MMCSS
("Pro Audio") for elevated scheduling, best-effort; neither cpal's thread nor a
plain `std::thread` gets a boost on Windows otherwise. The ring was 1 s and
proved too small: a parallel build starved the worker, the ring stayed full, and
audio was dropped continuously. Frames the callback cannot push are counted in
`lost_frames`, and the worker inserts the same span of silence into the encoded
stream, so a drop costs that span of audio but never shortens the timeline. (The
encoder's timestamps come from samples written; without the silence a lossy
recording played back sped up — e.g. 51 s recorded, ~20 s of audio.) Overruns
are also counted and logged at stop. A worker that dies on an encoder error sets
`worker_failed`, reported through the 100 ms amplitude poll, so the UI does not
go on "recording" into nothing.

**Gain boost.** The AGC's noise-floor margin (the "within 6 dB of the noise
floor → freeze gain" rule above) is scaled by an *aggressiveness* value, 0.0–1.0,
taking the margin from 6 dB down to 1.5 dB; the -20 dBFS target is unchanged.
The default for new recordings is per device (`audioSettings.js`, `localStorage`,
Settings → Appearance), defaulting to 0.0 (the previous behaviour). The sound
dialog's slider overrides it for the running recording only, through
`native_audio_set_aggressiveness`. The worker reads it at each chunk boundary
(~40 ms), so changes apply without restarting capture.

**Encoding**: AAC-LC in MP4 (`.m4a`, mono, 96 kbps — the Media Foundation
encoder's floor) via `IMFSinkWriter`. COM and `MFStartup` are owned by a guard
living on the worker thread. Falls back to WAV where Media Foundation is
unavailable (Windows N editions without the Media Feature Pack);
`native_audio_stop` derives the media type from the extension the encoder chose.
At ~43 MB/hour against ~691 MB/hour for the previous 48 kHz stereo WAV, a
multi-hour recording is now routine.

### Android — Kotlin Plugin

`AudioRecorderPlugin` prefers `AudioRecorderEngine`: `AudioRecord`
(`VOICE_RECOGNITION` — flat, unprocessed capture, bypassing OEM AGC and noise
gating; mono PCM16; 48 kHz with a 44.1 kHz fallback, since only 44.1 kHz capture
is guaranteed on every device) → the shared DSP → `MediaCodec` AAC-LC 48 kbps →
`MediaMuxer` MP4. Presentation timestamps derive from samples encoded, not the
wall clock, so a pause splices seamlessly.

The previous `MediaRecorder` path (VOICE_COMMUNICATION, 44.1 kHz, 32 kbps)
remains as an **automatic fallback** when the engine fails to start, kept for at
least one release because the engine is hand-driven and device-sensitive.

Commands: `start` (returns `{ pipeline: "audioRecord" | "mediaRecorder", fallbackReason? }`, logged by `RecordingManager` so a fallback is visible without logcat), `stop`, `pause`, `resume`, `cancel`, `getAmplitude` (also reports `failed`), `setAggressiveness` (a no-op under the MediaRecorder fallback, which has no gain stage).

**No foreground service, by design.** Recording is a while-you-take-notes
feature: the recorder belongs to an open note, and unattended background capture
is out of scope. A `microphone` foreground service would buy that at the cost of
a Play Console declaration (form plus demo video) gating every release on Google
Play review. Instead the app holds `FLAG_KEEP_SCREEN_ON` for the duration of a
recording, which keeps the process visible so the Android 9+ background
microphone restriction never engages. If the app is backgrounded anyway,
`NoteCanvas._onVisibilityChange` stops and saves the recording and the sound
dialog explains why. (`WAKE_LOCK` alone would not work: it keeps the CPU awake,
while the mic restriction keys off process importance — a wake-locked background
recording runs its full length and contains silence.)

### Handing the file to JS

`native_audio_stop` returns a path; JS then reads it in 4 MB binary chunks
(`native_audio_file_size` → `native_audio_read_chunk` → `native_audio_delete`).
`native_audio_read_chunk` returns `tauri::ipc::Response`, which `invoke`
resolves as an ArrayBuffer — no JSON body, no base64, no `atob` on the main
thread. The previous single base64 command peaked at 5-6x the file size in
transient memory and threw "Invalid string length" outright past ~403 MB
(V8's 2^29-character cap, ~35 min of stereo WAV).

The delete is separate from the read and fires only once the blob is stored, so
a storage failure does not destroy the temp file. When the read or the store
fails, `RecordingManager` calls `onSaveFailed`, which by default runs
`recordingRecovery.js`. It tells the user that the recording was not saved and
offers "Save as file…": `native_audio_export` copies the temp file to a
destination the user picks (an `rfd` save dialog on desktop; SAF
`createDocument` + `copyToUri` through `BackupFilePlugin` on Android), and only
then is the temp file deleted. The user can add the file to the note again with
"Import audio file". The dialog runs after the stop has settled, so it does not
hold up a note close. If the user declines, the temp file is left alone until
the next startup sweep. At startup, `sweep_orphaned_recordings()`
deletes recording temp files left by a run killed mid-write (an unfinalized MP4
has no `moov` index and is unplayable anyway). It matches `noteberg_rec_*` in
the shared OS temp dir, and the generic Android `rec_*` prefix only in the
app-private cache dir.

### Closing a note mid-recording

`RecordingManager.destroy()` stops and **saves** rather than cancelling, and
returns a promise that `NoteCanvas.destroy()` includes in the work it awaits, so
the note's save and sync see the new recording. Navigating away mid-sentence
previously discarded the audio silently.

### Browser (non-native, non-Nextcloud)

There is none. The `getUserMedia` + Web Audio + `MediaRecorder` path was removed:
`RecordingManager` takes the native path whenever `window.__TAURI_INTERNALS__`
exists — every Windows and Android build — and the only build without Tauri is
Nextcloud, which never renders the "New recording" button.

### Nextcloud — Import Only

The Nextcloud build has **no recording code path at all**. `SoundDialog.js` gates the "New recording" button behind a native-only check (`window.__TAURI_INTERNALS__` present), so in the Nextcloud build that button is never rendered. Only importing existing audio files and playback are available in the NC build's sound dialog — including playback of the `.m4a` files the native builds now produce.

### Backgrounding

On Android, `NoteCanvas._onVisibilityChange` calls
`RecordingManager.stopRecordingForBackground()` when the page becomes hidden,
and the sound dialog shows a notice (`stoppedInBackground`). It is Android-only
on purpose: on Windows the page is also hidden when the window is minimized or
fully covered (e.g. by slides during a lecture), while WASAPI capture carries on
unaffected, so stopping there would end a recording the user is still making.

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

Nextcloud credentials (`serverUrl`, `loginName`, `appPassword`, `userId`) are stored exclusively in the native OS keychain:
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
- **Handwriting recognition** — AI backend only, proxied through `lib/Controller/RecognitionController.php` (the browser cannot reach an AI endpoint directly: CORS, and HTTPS pages cannot call a plain-HTTP local model). Provider config and API key are stored server-side per user.
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
| Settings panel | Full (theme, language, sync, encryption, AI access, recognition, purge) | AI access + recognition only | Theme/language come from Nextcloud itself and the dropped subsystems have no settings to expose, but AI recognition needs a provider, model and key configured per user |
| Handwriting recognition | Sidecar (Windows) or AI vision model | AI vision model only, via a PHP passthrough proxy | The `InkAnalyzer` sidecar is Windows-native and cannot run here. The AI path works, but the browser cannot call an endpoint directly (CORS / mixed content), so requests go through the server — which also keeps the API key out of the browser |
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
| Local recognition sidecar as the Windows default | Offline, no API costs, exact word positions, uses Windows Ink Analysis (high quality) |
| AI recognition manual-only and queued | A page costs money and takes minutes; an automatic trigger would stall note closing and bill the user for the whole startup backlog unprompted |
| AI words localized to a colour band, not a box | Vision models' reported coordinates drift by more than a line height — asking which band a word sits on is perception, not measurement, and cannot overstate what is known |
| NC recognition via a PHP passthrough proxy | The browser cannot reach an AI endpoint (CORS / mixed content), and it keeps the API key server-side where an XSS on the NC origin cannot read it |
| OS keychain for credentials | No plaintext secrets on disk; leverages hardware-backed storage on Android |
| Nextcloud Login Flow v2 | User never enters main NC password into the app; app password can be revoked independently |
