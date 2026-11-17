# Android share target for PDFs: design

Status: **Proposed** (2026-10-28), not started. Plan: [PLAN.md](PLAN.md).

Origin: same feedback as [pdf_pages](../pdf_pages/DESIGN.md) (getting PDFs into
a note more easily). Sharing a PDF from a mail, a download or a file manager
to the app is how people expect to do that on a phone.

## Decision record

**Context.** Getting a PDF into a note means opening the app and using the
picker. On a phone, people expect to share the file to the app from a mail, a
download or a file manager. Android offers this through intent filters; Tauri
has no support for it, so it needs a small native plugin.

**Decisions**

- **D1** The app registers for `ACTION_SEND` and `ACTION_VIEW` with
  `application/pdf`, so it shows in the share sheet and in "Open with".
- **D2** On arrival, a dialog offers **New note**, **Add to a note...** or
  **Cancel**. The import afterwards is the normal one (`importPdf`).
- **D3** The incoming stream is copied to the app cache at once (the URI grant
  is temporary) and handed to the web side through one pending-file state in
  Rust; the file name is only a title hint, never a path.
- **D4** The web side shows the dialog only when the app is *ready* (a named
  signal) and no blocker is active (import, modal, stroke, text editing).
- **D5** A new note goes into the notebook currently shown (none when all notes
  are shown). Its title is the PDF's own title if present, else the file name
  without extension. The size ceiling is the one already used for media.
- **D6** Android only; one file per share; PDFs only.

**Consequences**

- A plaintext copy of the PDF sits in the app cache until the import has saved
  it; a startup sweep deletes leftovers older than a day (§7).
- `NoteCanvas.insertPdf` is split so importing a given `File` exists once
  (`importPdfFile`); [pdf_pages](../pdf_pages/DESIGN.md) later generalises it.
- Two points are unverified and decided by spikes: how a cold-start intent
  reaches the plugin (S1) and how large PDFs cross the IPC boundary (S2).

**Rejected alternatives**

- *Copy into the web layer as one base64 string*: too large for big PDFs.
- *Declaring `ACTION_SEND_MULTIPLE` now*: needs a multi-file dialog; contained
  extension later (§6).
- *Asking for storage permissions*: the intent's `content://` grant is enough.

## 1. Goal

- NoteBerg appears in Android's **share sheet** and in **"Open with"** for PDF
  files.
- When a PDF arrives, the app comes to the front and asks what to do with it:
  **create a new note** with the PDF, or **add it to an existing note**.
- It works on a cold start (app not running) and when the app is already
  running, including with a note open.
- The import afterwards is the normal one: all pages, full width, original
  file kept (`importPdf`).

Not goals (first version): images or other file types (§8), several files in
one share (§6), Windows "Open with", the Nextcloud app (it runs in a browser
and cannot be a share target), choosing pages while sharing.

## 2. What exists today (found in the code, 2026-10-28)

- [AndroidManifest.xml](../../../src-tauri/gen/android/app/src/main/AndroidManifest.xml)
  has only the launcher intent filter. No `SEND` or `VIEW` handling.
- `MainActivity` is `singleTask` and extends `TauriActivity`, which forwards
  `onNewIntent` to the plugins (`PluginManager.onNewIntent`) and to Rust
  (`Rust.onNewIntent`). A shared PDF to a running app therefore arrives as a
  new intent, not a new activity.
- Kotlin plugins exist and are registered from Rust: `PdfSavePlugin` (opens a
  cached PDF through a `FileProvider`), `BackupFilePlugin` (Storage Access
  Framework, **copies between a `content://` URI and the app cache** so Rust
  works with a plain path), others. The FileProvider is already declared.
- Backup moves large data across the IPC boundary one entry at a time, never
  whole (`backup.rs` header). The same discipline applies to a PDF that can be
  hundreds of megabytes.
- `importPdf(file)` takes a `File`; `insertPdf` in `NoteCanvas` ties it to a
  picker and to the open note, so the shared-file path needs the import part
  split from the picker part.
- `createNote({title, notebookId})` in `storage.js` creates a note; the
  notebook is optional.
- The app is always unlocked (no locked state), so no unlock step sits between
  the intent and the dialog.

## 3. Behaviour

1. User shares a PDF (or opens one with NoteBerg).
2. The app comes up. When the UI is ready, a dialog appears over whatever is
   showing (overview, or an open note):

   > **Shared PDF: contract.pdf**  (36 pages, 2.4 MB)
   > [New note]  [Add to a note...]  [Cancel]

3. **New note:** creates a note titled after the file name (without `.pdf`),
   in the notebook currently shown (or none), imports the PDF into it and
   opens the note.
4. **Add to a note:** opens a note picker (title, notebook, search). Choosing
   a note:
   - **without a PDF:** the PDF is imported into it, then the note opens;
   - **with a PDF:** the pages are added at the end through the shared
     `addPdfPages(noteCanvas, file, all pages, end)`
     ([pdf_pages](../pdf_pages/DESIGN.md) §5.2, phase 4 there); until that exists these notes are
     shown disabled with the reason "This note already has a PDF". Read-only
     notes (shared read-only) are disabled too.
5. **Cancel:** the staged file is deleted. Nothing else changes.

The import uses the same progress dialog and the same save path as the toolbar
import, so everything that follows (thumbnail, sync, recognition) is the
usual one.

If a note is open when the intent arrives, the dialog is shown on top of it.
Choosing "New note" or another note navigates away through the normal
navigation (the `destroy()` promise is awaited before `syncOnNoteClose()`, as
for any note switch). Choosing "Add to a note" with the open note as target
imports into it directly, without navigating.

## 4. Architecture

```
Android intent (SEND / VIEW, application/pdf, content:// URI)
   -> MainActivity (onCreate: cold start, onNewIntent: running)
   -> SharedFilePlugin.kt  copies the stream to the app cache at once
   -> Rust: holds one "pending shared file" {path, name, size}
   -> JS: asks on startup and on an event: takePendingSharedFile()
   -> dialog -> importPdf(File from the staged file) -> note
```

### 4.1 Native side

- **Intent filters** on `MainActivity`: `ACTION_SEND` and `ACTION_VIEW`
  (`DEFAULT` and `BROWSABLE` categories for `VIEW`), `mimeType`
  `application/pdf`. `VIEW` additionally for the `content` and `file`
  schemes. The activity stays `singleTask`.
- **`SharedFilePlugin.kt`:** reads the intent (`EXTRA_STREAM` for `SEND`,
  `data` for `VIEW`), opens it through the `ContentResolver` and copies it into
  the cache directory under a generated name (never the incoming file name).
  The copy happens in `onCreate` / `onNewIntent` before anything else, because
  the read permission granted with the URI is temporary. **Unverified:**
  Tauri forwards `onNewIntent` to plugins, but a cold-start intent arrives in
  `onCreate`, which plugins are not told about; the plugin may have to read
  `activity.intent` itself when it loads. Spike S1 decides; the design does not
  depend on which way it goes, only the Kotlin does. The display name
  comes from `OpenableColumns.DISPLAY_NAME` and is kept only as a title hint.
- **Checks before staging:** the type is `application/pdf` (the extension
  alone is not trusted); the first bytes are `%PDF-`; a size ceiling (the
  media ceiling the app already has for other media, to be confirmed in the
  plan); the cache has room. Failing checks produce a short message, not a
  dialog with options.
- **One pending file.** A second share replaces the first if the first was not
  handled yet (and deletes its staged copy). The plugin clears the intent
  after reading it so a rotation or a resume does not import it again.
- **Rust:** a small state (`pending_shared_file`) and two commands:
  `take_pending_shared_file()` returns and clears it, `discard_shared_file()`
  deletes the staged copy. An event `shared-file` is emitted when a file
  arrives while the UI is running.
- **Reading the bytes into JS:** the intent is that the PDF never travels as
  one giant string: a Rust command reads from the staged path in pieces, as
  backup does per entry. **Unverified:** this pattern is taken from the header of
  `backup.rs` (one entry per IPC call, base64), not from the restore code, and
  a single PDF can be larger than any backup entry the app handles today. Spike
  S2 measures it; if one blob is too large, the alternatives are reading in
  slices into a `Blob` on the JS side, or letting `saveFile` take the staged
  path (so only the page structure pdf.js needs is read).

### 4.2 Web side

- `src/modules/sharedFile.js` (new): on startup and on the `shared-file`
  event it asks for the pending file once the app is **ready** and no blocker
  is active. A handled file is cleared; an unhandled one stays pending, so it
  is not lost.
  - **Ready** is a named signal from app init (`appInit.js`): storage open,
    first view rendered. Not a timer.
  - **Blockers** (checked by one function, each covered by a test): an import
    is running, a modal dialog is open (settings, backup, master password,
    another import), a stroke is in progress (pen or touch down), a text box
    is being edited with the on-screen keyboard open (the dialog waits for the
    keyboard to close or for the next view change). The check repeats on each
    state change, not on a polling loop.
  - Outside the Android build the module does nothing and registers no
    listener.
- `src/components/sharedPdfDialog.js` (new): the dialog of §3 and the note
  picker. The picker reuses the note list rendering of the overview if it can
  be used on its own; otherwise a minimal searchable list (title, notebook).
- `NoteCanvas.insertPdf` is split: picking a file stays in `insertPdf`;
  importing a given `File` into the open note becomes `importPdfFile(file)`,
  which the pdf_pages work later generalises to `addPdfPages` (first import =
  the same function on an empty note). The shared path calls it after opening
  the target note, so the import code exists once. If this feature ships first,
  `importPdfFile` is the seam; pdf_pages then wraps it rather than the other
  way round.
- A new note is created with `createNote`, filled by opening it and calling
  `importPdfFile`, so thumbnail, recognition and sync follow the usual
  triggers.

## 5. Edge cases

| Case | Behaviour |
|---|---|
| Cold start | The intent is staged in `onCreate`; the web side asks once the app is ready. |
| App running, overview or other note open | `onNewIntent` stages and emits `shared-file`; the dialog opens over the current view. |
| App running, an import already in progress | The shared file waits; the dialog opens when it ends. |
| User is mid-stroke or editing text | The dialog opens after the stroke / on focus change; it never takes pointer input away mid-stroke. |
| Share while a dialog (settings, backup) is open | Queued until that closes. |
| Encrypted PDF (password) | `importPdf` fails as it does for a picked file; the same error message, the staged file is removed. |
| Corrupt PDF / not a PDF | Rejected at staging (header check) or by `importPdf`; clear message. |
| Very large PDF | Size ceiling at staging; the progress dialog of the import. |
| Same PDF shared twice | Two imports; no deduplication (the file ids are per import). |
| App killed between staging and handling | The staged copy remains in the cache; startup deletes staged files older than a day. |
| Note read-only or shared read-only | Disabled in the picker. |
| Locked / always unlocked | Not applicable: the app has no locked state. |

## 6. Several files in one share

`ACTION_SEND_MULTIPLE` is not declared in the first version, so Android shows
the app only for a single file. Declaring it later means one note per PDF (or
one chooser listing them) and is a contained extension of the plugin and the
dialog.

## 7. Privacy and security

- Only the chosen file is read, only once, and only into the app's own cache.
- The incoming file name is never used as a path, only as a title hint.
- The staged copy is deleted after import, on cancel, on replacement and by a
  startup sweep (mandatory, not optional).
- **The staged copy is plaintext in the app cache**, even when the user has
  encrypted notes: the file is the user's own and only transiently here, but
  it exists in clear until the import has saved it (where it follows the
  note's normal storage and encryption). The window is as short as the dialog
  and the import; a killed app leaves it until the next startup sweep.
- The app does not request storage permissions: the `content://` grant that
  comes with the intent is enough.
- Logging records type and size, never the file name or content.
- Declaring `VIEW` for PDF makes the app appear next to PDF viewers. That is
  expected and intentional; the app never becomes the default unless the user
  picks "Always".

## 8. Later

- `image/*` and other types with the same dialog (images go into a new or an
  existing note as page images; the app already inserts images).
- Multiple files per share (§6).
- Windows "Open with" through Tauri file associations (separate platform
  work).
- Choosing pages of the shared PDF before importing it, once
  [pdf_pages](../pdf_pages/DESIGN.md) has the page-selection dialog (§5.2
  there): the same dialog would sit between "which note" and the import.
