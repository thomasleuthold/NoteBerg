# Manual Test

The smallest manual pass that covers what the automated tests cannot reach. It is not a feature tour: if a behaviour is already pinned by a unit, e2e or PHP test, it is not repeated here.

## What the automated tests miss

| Suite | Runs | Cannot see |
|---|---|---|
| vitest (102 files) | JS logic in jsdom; `invoke`, WebDAV, AI backends mocked | Real Tauri commands, real servers, real hardware, real rendering |
| Playwright e2e (`e2e/`) | Built bundle in Edge with Tauri faked: real canvas, pdf.js, IndexedDB, clipboard, pen/touch input via CDP, a fake webcam feed | Anything native: Rust/Kotlin, OS dialogs and permission prompts, the real keychain, Android WebView behaviour |
| Rust `cargo test` | Desktop build of `backup.rs`, `mcp.rs`, `audio_dsp.rs`, `audio_encoder.rs` | Every `#[cfg(target_os = "android")]` / `#[cfg(windows)]` command body, file dialogs, keyring, sidecar |
| Kotlin unit tests | `AudioDspTest.kt` only | All Tauri plugins (`BackupFile`, `PdfSave`, `DeviceKey`, `StatusBar`, `AudioRecorder`) and `MainActivity` |
| `just test-php` | `resolveUrl`, `buildHeaders`, `readApiKey`, `EndpointPolicy` | The proxied HTTP round trip, admin page, usage counting |

So this pass targets: **native plugins and commands**, **OS dialogs and permission prompts**, **real input hardware**, **real servers** (Nextcloud, AI endpoints), and **app lifecycle**.

### Moved to Playwright

These were manual steps. The browser half of each now runs in `e2e/`; any native remainder is still listed below.

| Former step | Now | Native remainder kept here |
|---|---|---|
| Pen pressure, pen-then-finger, pinch (2.1, 2.2) | `input.e2e.js` | 2.1: feel on real hardware |
| Lasso move, undo/redo (2.3) | `canvas.e2e.js` | — |
| Paste formatted text and images (3.2) | `text.e2e.js` | — |
| Insert image, insert PDF (4.1, 4.5) | `media.e2e.js` | 4.1: crop by touch; 4.4: a large PDF on Android |
| Camera denied, document capture (4.2, 4.4) | `camera.e2e.js` | 4.2: Android's permission prompt; 4.3: a real phone camera |
| PDF export content (5.1) | `media.e2e.js` | 5.1: the Windows save dialog |
| Master password, unlock prompt (9.1, 9.2) | `security.e2e.js` | 9.1: the real keychain |
| Backup cancel paths, encrypted round trip (11.x) | `backup.e2e.js` | Section 10: everything on Android; 10.7: Windows dialogs and zip interop |
| Saving when the app is hidden and then killed (12.1) | `canvas.e2e.js` | 11.1: that the Android WebView reports the hide |

## How to use it

- **★ = release smoke.** Run every ★ step before each release, on every platform listed for it.
- Run a whole section when its code changed. See [When to run what](#when-to-run-what).
- Platforms: **W** Windows app · **A** Android app · **N** Nextcloud app in a desktop browser.

## Setup

- A fresh build of the change under test, installed on W and A. A stylus-capable Android device is best; any Windows pen or touch display is a bonus.
- A Nextcloud test account. `just nc-up` is fine for N and for sync; a real server is better before a release.
- Test assets on each device:
  - **big.pdf**: a multi-page PDF larger than 5 MiB.
  - **photo.jpg**: any camera photo.
  - A printed A4 sheet for document capture.
- A note named **MT-media** containing big.pdf. Backup/restore uses it.
- Optional: a local AI vision endpoint (LM Studio or Ollama) for section 6.

---

## 1. Install, startup, platform chrome

| # | P | Steps | Expected | Covers |
|---|---|---|---|---|
| 1.1 ★ | W | Install the new installer over the previous release. Launch it. | It launches. Existing notes and Nextcloud connection are intact. | Installer, upgrade path, data dir stability |
| 1.2 ★ | A | Install the new build over the previous release (`adb install -r` or Play internal track). Launch it. | Same as 1.1. | Upgrade, signing key, data dir stability |
| 1.3 | A | Toggle light/dark theme. Rotate the device. Repeat on a phone with a notch or punch-hole if available. | Status-bar icons are readable in both themes. No toolbar or content sits under the status bar, navigation bar or cutout, in either orientation. | `StatusBarPlugin.setAppearance` / `getInsets`, `safeArea.js` |
| 1.4 | W A | Settings › About: open the project link and the licenses dialog links. | Each opens in the system browser. | `plugin-opener` |

## 2. Pen, touch and canvas

| # | P | Steps | Expected | Covers |
|---|---|---|---|---|
| 2.1 ★ | A W | Write a few lines quickly with a real stylus, then pinch-zoom and pan with two fingers. | Strokes stay smooth, with no gaps or straight-line shortcuts, and keep up with the pen tip. Zoom and pan follow the fingers without stutter. | Real digitiser timing and coalesced events, which CDP input cannot reproduce |
| 2.2 | N | Draw in Chrome and in Firefox. | Ink works in both. (Some lag in Chrome on Android is a known, unfixable limitation.) | Browser input paths |

## 3. Text editor

| # | P | Steps | Expected | Covers |
|---|---|---|---|---|
| 3.1 ★ | A | Switch to text mode. Type with the on-screen keyboard, using autocorrect and swipe typing. Add a task checkbox. Tick it. | The keyboard does not cover the line you are typing in. Autocorrect and swipe-typed words land correctly, with no duplicated or lost characters. The checkbox toggles. | Real IME composition, viewport resize |

## 4. Images, camera, PDF import

| # | P | Steps | Expected | Covers |
|---|---|---|---|---|
| 4.1 | A | Insert photo.jpg. Crop it by dragging the crop handles with a finger. Close and reopen the note. | The handles are easy to grab by touch. The crop sticks. | Crop UI under touch |
| 4.2 ★ | A | On a fresh install, Insert › **Take Photo**. Deny the permission once, then try again and allow it. | On deny: a "Camera Unavailable" message, not a hang. On allow: a live preview, and the photo is inserted. | Android runtime camera permission |
| 4.3 | W | Insert › **Take Photo**. | The preview appears **without** a WebView permission prompt. | `grant_media_permissions` (WebView2) |
| 4.4 | A | **Take Photo** › **Document** mode, pointed at the printed sheet. Switch between the cameras. Capture. | The rear camera is used. "Document detected" follows the sheet. The result is perspective-corrected and evenly lit. | Android WebView camera stack and real optics |
| 4.5 ★ | A | Insert › **Insert PDF**: big.pdf. Scroll through all the pages. | Every page renders. Scrolling stays responsive. The app is not killed for memory. | Memory on a large file on a phone |

## 5. PDF export

| # | P | Steps | Expected | Covers |
|---|---|---|---|---|
| 5.1 ★ | W | **Export PDF** on any note. Save it. Open the result. | A save dialog opens, and the saved file opens in a PDF viewer. | `save_pdf` (`rfd` dialog, file write) |
| 5.2 ★ | A | **Export PDF** on a note with strokes, an image and an imported PDF page. | The PDF opens in a viewer app via the system chooser, with all of that content. | `save_pdf` Android → `PdfSavePlugin` (FileProvider, `ACTION_VIEW`) |
| 5.3 | N | Same as 5.2. | The browser's print or save flow shows the same content. | Browser export path |

## 6. Audio recording

| # | P | Steps | Expected | Covers |
|---|---|---|---|---|
| 6.1 ★ | A | On a fresh install, open the sound dialog › **New recording**. Deny the mic permission, then retry and allow it. | Deny gives a clear message. Allow starts recording, and the level meter moves when you speak. | `AudioRecorderPlugin.start`, permission callback |
| 6.2 ★ | A W | Record about 1 minute: pause, resume, move the gain slider, then **Stop recording**. Play it back. | The pause gap is absent from the recording. The volume tracks the slider. Playback has no clicks, dropouts or pitch shift. The duration is right. | Native capture, DSP, AAC/WAV encoding, chunked file read (`native_audio_*`) |
| 6.3 | A | While recording, leave the device untouched for 2 minutes. | The screen stays on. The recording is uninterrupted. | `setKeepScreenOn`, audio focus (`MainActivity`) |
| 6.4 | W | Record 10+ minutes with other CPU-heavy work running (a build, for example). | No clicks in playback. (A ring-buffer overrun is logged, never silent.) | MMCSS capture thread, ring buffer |
| 6.5 | A W | Delete a recording. | It disappears and does not come back after restarting the app. | `native_audio_delete`, startup orphan sweep |

## 7. Handwriting recognition

| # | P | Steps | Expected | Covers |
|---|---|---|---|---|
| 7.1 ★ | W | Handwrite a distinctive word. Close the note and wait a few seconds. Search for the word. | The note is found. | Bundled sidecar spawn (port 5089), `get_recognition_url`, InkAnalyzer |
| 7.2 | A W | Settings: configure a local AI endpoint (LM Studio or Ollama) and accept the consent. In a note, start AI recognition from the toolbar. | The consent names the destination. Text comes back and is searchable. Cancelling midway leaves no stuck queue entry. | Real HTTP through `plugin-http`, real model response shapes |
| 7.3 | N | As admin: Admin settings › NoteBerg, allow the endpoint. As a user: run AI recognition. Then try an endpoint that is not allowlisted. | The allowed endpoint recognizes, and the admin usage report shows the run. The non-allowlisted endpoint is refused with a clear message. | PHP proxy round trip, `UsageCounter`, admin page (`test-php` stops short of HTTP) |

## 8. Nextcloud sync (native clients) and Nextcloud app

The sync unit tests use a mock WebDAV server. Real servers behave differently, for example with oscillating etags.

| # | P | Steps | Expected | Covers |
|---|---|---|---|---|
| 8.1 ★ | A W | Settings › **Connect to Nextcloud**. Finish the login in the browser that opens. Restart the app. | The system browser opens the Login Flow. The app shows "Logged in as …", and still does after the restart. | `openUrl`, Login Flow v2, credential storage (`keyring` on W, `DeviceKeyPlugin` Keystore on A) |
| 8.2 ★ | A W N | On W, create a note with strokes, text and an image. Sync. Open it on A and in N. | It appears on both, complete, with the thumbnail and image. | Real WebDAV upload/download, media, the N `storage.webdav.js` path |
| 8.3 | A W | Take both devices offline. Edit the same note on each. Reconnect and sync both. | The conflict is resolved as designed (merge or conflict copy). No edit is silently lost. | Real etag/412 behaviour |
| 8.4 | A W | Delete a note on A and sync both devices. Then sync both twice more with no changes. | The note is in W's recycle bin. The extra syncs re-download nothing and create no conflicts. | Tombstones and etag oscillation against a real server |
| 8.5 | A W | **Disconnect**. Restart the app. | It shows as not connected and does not prompt for the old account. | `delete_credential` |
| 8.6 | N | Enter and leave fullscreen. Open the app in a second tab and edit the same note. | Fullscreen works. The second tab does not corrupt the note. | `ncFullscreen.js`, real browser |

## 9. Master password

| # | P | Steps | Expected | Covers |
|---|---|---|---|---|
| 9.1 ★ | A W | Settings › Security: turn on local encryption and set a master password. Restart the app. | It opens **without** an unlock prompt (the password comes from the keychain), and notes open normally. Turning encryption on and the restart each take seconds, not tens of seconds. | Windows Credential Manager / Android Keystore round trip, PBKDF2 at real-device speed |

## 10. Backup & restore

| # | P | Steps | Expected | Covers |
|---|---|---|---|---|
| 10.1 ★ | A | Settings › Backup › **Backup to file**. Back out of the picker without saving. | The system save picker **opens**, suggesting a `.zip` name. After backing out: no error. | `createDocument` intent (the 2026-10-11 `typ=` regression) |
| 10.2 | A | **Backup to file**, save to Downloads. Press **Cancel** while it is still writing. | The Files app shows no new (zero-byte) zip in Downloads. | `discard_backup_target` → `deleteDocument` |
| 10.3 ★ | A | With **Protect the file with a password** on, back up to Downloads. | "Backup complete" shows the file **name** (not `content://…`) and a plausible size. The Files app shows the same size. | `copyToUri`, `displayName`, AES and deflate on Android, chunked JNI writes |
| 10.4 | A | **Restore from file**, then back out. | The picker opens, and the 10.3 zip is selectable (not greyed out). | `openDocument` MIME filter |
| 10.5 ★ | A | Permanently delete MT-media: delete it, then delete it from the recycle bin. Restore the 10.3 zip with its password, choosing **Restore missing items only**. | The restore reports 1 note. Every page of big.pdf renders. | `openDocument` cache copy, `restore_unlock`, chunked JNI reads, `restore_close` |
| 10.6 | A | *(Debug build)* `adb shell run-as eu.noteberg.app ls cache` | No `restore-*.zip`, `noteberg-restore-entry-*.bin` or staged backup zip left behind. | Cache cleanup |
| 10.7 ★ | W | Back up with a password. | The save dialog filters on `*.zip`. The folder holds no `.partial` file. In 7-Zip, `manifest.json` opens without a password, and any other entry asks for one. | `rfd` dialog, real archive on disk, zip interop |
| 10.8 | W A | Restore the **Android** backup on Windows, and the **Windows** backup on Android. | Both restore, and the media renders completely. | Cross-device archive compatibility, including SAF copy integrity |

## 11. Android lifecycle

| # | P | Steps | Expected | Covers |
|---|---|---|---|---|
| 11.1 ★ | A | Type a few words in a note, then immediately press Home. Swipe the app away from Recents. Relaunch it. | The words are there. | That the Android WebView reports the hide that triggers the save (the save itself is e2e-tested) |
| 11.2 | A | With a note open, switch to another app for a few minutes, then come back. Rotate the device mid-note. | The note is intact. Nothing reloads unexpectedly, and the zoom position is sensible. | Activity resume/recreate |

## 12. MCP server (Windows only)

`mcp.rs` has 42 Rust tests, but none of them involve a real client.

| # | P | Steps | Expected | Covers |
|---|---|---|---|---|
| 12.1 | W | Settings › **Enable MCP server**. Generate a token. Configure Claude Desktop as described in [mcp.md](mcp.md) §2. Ask it to list your notebooks, then to read MT-media. | The status shows the listening port. Claude lists the notebooks and reads the note. The access shows up in the MCP review log. | `mcp-remote` bridge, the real HTTP transport, token auth |
| 12.2 | W | Disable the MCP server and ask Claude again. | The connection is refused. | Server shutdown, port release |

---

## Deliberately not covered

These cannot be set up cheaply by hand. Each one is a known risk that this pass does not check.

- **Recording export** (`native_audio_export`): it is only offered after a recording fails to save. It shares its intent code with 10.1.
- **Android backup over an existing document** (`existing = true`): most providers never return one.
- **No-space pre-flight, and `copyToUri` failing mid-copy**: these need a nearly full device or a faulty provider.
- **The recognition sidecar failing to start, or port 5089 already in use**.
- **Android Keystore key invalidation** (for example after the lock screen is removed): credentials would need re-entry.

## When to run what

| Changed | Run |
|---|---|
| `src-tauri/gen/android/**` (any Kotlin) | Every A step in the section of that plugin, plus 1.2 and 11.1 |
| `src-tauri/src/lib.rs` | Sections 1, 5, 6, 8.1, 8.5, 9 |
| `src-tauri/src/backup.rs`, `src/modules/backup_restore/**`, `backupSection.js` | Section 10 |
| `src-tauri/src/audio_*.rs`, `RecordingManager.js`, `SoundDialog.js` | Section 6 |
| `src-tauri/src/mcp.rs`, `mcpBridge.js` | Section 12 |
| `InputHandler.js`, `NoteNavigator.js`, `StrokeManager.js` | 2.1 |
| `imageUtils.js`, `documentDetector.js`, `ImageCropper.js` | 4.1–4.4 |
| `pdfManager.js`, `pdfExport.js` | 4.5, section 5 |
| `nextcloudSync.js`, `storage.js`, `StorageWorker.js` | Section 8, 11.1 |
| `storage.webdav.js`, `lib/**`, `templates/**`, `appinfo/**` | Every N step, 7.3 |
| `recognition/**`, `src-recognition-backend/**` | Section 7 |
| `masterPassword.js`, `encryption.js`, `secureStorage.js` | 9.1, 8.1 |
| Tauri, NDK or plugin version bump | All ★ steps |

Run `just test-e2e` as well for any frontend change: the steps listed under [Moved to Playwright](#moved-to-playwright) are no longer here.
