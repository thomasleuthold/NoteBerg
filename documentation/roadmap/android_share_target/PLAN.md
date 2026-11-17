# Android share target for PDFs: implementation plan

Design: [DESIGN.md](DESIGN.md). Each phase ends green on `just fct` and is
checked on a real Android device (the native part cannot be tested in
Playwright or vitest, see `documentation/manual_test.md`) before the next
starts. The web side must not change anything on Windows or in the Nextcloud
app: the new module is inert without the native event.

## Status (2026-10-28)

Proposed, nothing implemented. Existing code was read first (DESIGN §2).
Revised 2026-10-28: unverified native assumptions marked as spike questions,
concrete ready/blocker rules for the dialog, an adb test recipe, sizes.

Sizes are rough, for ordering only: S = 1-2 days, M = 3-5 days.

| Phase | Size |
|---|---|
| 0 spike | S |
| 1 native side | M |
| 2 web side | M |
| 3 notes that already have a PDF | S (after pdf_pages phase 4) |
| 4 release | S |

This plan is smaller than [pdf_pages](../pdf_pages/PLAN.md) and independent of
it; phases 0 to 2 can ship first. Phase 3 needs `addPdfPages` from pdf_pages
phase 4. If this ships first, `importPdfFile` (DESIGN §4.2) is the seam that
pdf_pages later generalises.

## Phase 0: spike (throwaway, findings written into DESIGN.md)

- **S1 Delivery.** A minimal intent filter and plugin that logs: `SEND` from a
  mail app and the file manager, `VIEW` from a file manager and a browser
  download. Check cold start (does a Tauri plugin see the `onCreate` intent,
  or must it read `activity.intent` when it loads?), warm (`onNewIntent` on the
  `singleTask` activity), and that the intent is not re-delivered after
  rotation or resume.
- **S2 Large file path.** Stage a 200 MB PDF from `content://`, read it into
  JS. First read the backup restore code to see how one large blob really
  reaches JS (the design only knows the `backup.rs` header). Measure memory
  and time on a mid-range tablet; if one blob is too large, try slices into a
  `Blob`, or `saveFile` from the staged path. Decide the size ceiling
  (DESIGN D5).
- **S3 Temporary grant.** Confirm the copy in `onCreate` / `onNewIntent` is
  early enough for providers that revoke quickly (mail attachments, cloud
  storage providers).

Exit: S1 to S3 confirm DESIGN §4.1, or DESIGN is updated before phase 1.

## Phase 1: native side

- `AndroidManifest.xml`: `SEND` and `VIEW` filters for `application/pdf`
  (DESIGN §4.1).
- `SharedFilePlugin.kt`: read the intent, stage into the cache under a
  generated name, checks (type, `%PDF-` header, size, free space), clear the
  intent, replace-and-delete on a second share, startup sweep of old staged
  files.
- Rust: register the plugin (as `PdfSavePlugin` / `BackupFilePlugin`),
  pending-file state, `take_pending_shared_file`, `discard_shared_file`,
  `shared-file` event; capability entries in `capabilities/android.json`.
- Kotlin and Rust unit tests where the code is pure (header check, naming,
  sweep); the rest by hand.

Exit: sharing a PDF to the app from a mail app and a file manager stages the
file and logs type and size; nothing is visible in the UI yet.

## Phase 2: web side

- Split `NoteCanvas.insertPdf`: `importPdfFile(file)` (progress, save,
  undo command) and the picker wrapper. No behaviour change for the toolbar
  button; existing tests and `media.e2e.js` stay green.
- `src/modules/sharedFile.js` + tests (vitest, Tauri `invoke`/events mocked):
  asks on startup and on the event once the named ready signal from
  `appInit.js` fired; one test per blocker of DESIGN §4.2 (import running,
  modal open, stroke in progress, text box editing with the keyboard open);
  clears when handled; keeps when not; registers nothing outside the Android
  build. Add the ready signal to `appInit.js` if it has none.
- `src/components/sharedPdfDialog.js` + tests: dialog and note picker
  (disabled rows with reasons: already has a PDF, read-only).
- Flows: new note (title, notebook), existing note without PDF, cancel
  (discards the staged file), a note already open (import into it directly,
  or navigate with `destroy()` awaited).
- i18n in all 9 locales; help text.
- e2e (`media.e2e.js` with the Tauri mock): the mocked pending file leads to a
  new note holding the PDF's pages; to an existing note; cancel leaves
  nothing behind.

Exit: the full flow runs against a faked pending file in the browser suite;
on a device the real share works end to end.

## Phase 3: add to a note that already has a PDF

Depends on phase 4 of [pdf_pages](../pdf_pages/PLAN.md) (add pages). Until
then the picker shows such notes disabled.

- Enable them; the choice appends the shared PDF's pages at the end.
- Test with a note that has ink and text boxes: they stay on their pages.

## Phase 4: release

- `CHANGELOG.md` entry (stamp by hand, see release convention), README
  feature list, `play-release-notes.txt`, help content.
- `documentation/manual_test.md`: mail attachment, file manager "Open with",
  cold start and warm start, a note open when the share arrives, a large PDF,
  cancel, a second share before the first is handled, process killed between.
  Repeatable without a mail client, with a PDF pushed to the device
  (`adb push x.pdf /sdcard/Download/`): `adb shell am start -a
  android.intent.action.VIEW -t application/pdf -d <content-uri>` for `VIEW`
  (a `file://` URI is refused by recent Android versions, so use a
  `content://` URI from the file manager or the app's FileProvider), and
  `adb shell am start -a android.intent.action.SEND -t application/pdf --eu
  android.intent.extra.STREAM <content-uri> eu.noteberg.app/.MainActivity` for
  `SEND`. Cold start: `adb shell am force-stop eu.noteberg.app` first.
  Staged files: `adb shell run-as eu.noteberg.app ls cache` before and after.
- Update `architecture_design.md` (Android plugins list).
- Mark DESIGN.md "Implemented" and note what implementing changed.

## Risks

- **Temporary URI grant** expiring before the copy (provider-dependent).
  Mitigation: the copy happens first thing, spike S3.
- **Large files** blocking the UI or exhausting memory. Mitigation: stage on a
  background thread with a size ceiling; read through the streaming route used
  by backup; never hold the whole PDF as a string.
- **Intent delivered twice** (rotation, resume, `singleTask` re-entry).
  Mitigation: the plugin clears the intent, the pending state is taken once.
- **Dialog at a bad moment** (mid-stroke, other dialog, keyboard open).
  Mitigation: the ready signal and blocker list of DESIGN §4.2; a test per
  blocker.
- **Plaintext staged copy** in the cache (DESIGN §7). Mitigation: delete on
  every exit path and a mandatory startup sweep; both covered by tests.
- **Two unverified native assumptions** (cold-start intent in a plugin, large
  blob into JS). Mitigation: spike S1 and S2 come first and can change phase
  1 before it starts.
- **Visible in "Open with" for all PDFs.** Intentional; documented in the
  changelog.
- **Native code is invisible to the automated suites.** The manual test pass
  in phase 4 is the safety net; keep the Kotlin small and the logic in JS.
