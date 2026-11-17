# Voice notes: implementation plan

Design: [DESIGN.md](DESIGN.md). Each phase ends green on `just fct` and is
checked on Windows and Android (the Nextcloud app has no recording, so it only
needs the check that the feature is hidden there) before the next starts.
Spoken commands (DESIGN §7) are not part of this plan.

## Status (2026-10-28)

Not started. **Next: phase 0 (spikes).**

## Phase 0: spikes (throwaway code, findings written into DESIGN.md)

- **S1 whisper.cpp on NDK 27.** Build `whisper-rs` for `aarch64-linux-android`
  through the existing `build-a` recipe (NDK 27.2.12479018, `NDK_HOME`
  override) and for Windows x64 (cmake + MSVC present?). Check: the build
  succeeds in `just build-a`; APK size growth; `tiny`, `base`, `small` (and
  q5 variants) on a 60 s speech sample on both Android devices and on
  Windows: real-time factor, peak memory, thread count default. Result decides
  the models offered per platform and whether `small` is offered on Android.
- **S2 Push to talk on Android WebView.** A throwaway button: 300 ms hold
  threshold, pointer capture, `touch-action: none`, `contextmenu` and
  selection suppressed. Check on both devices with finger and pen: no context
  menu or text selection, release outside the button, permission already
  granted, hold start to first captured sample (latency), capture started on
  `pointerdown` and dropped when the gesture was a tap.
- **S3 Silence handling.** Run 10 s of room noise and a quiet recording
  through whisper with and without VAD / energy gate. Pick the gate and the
  threshold under which a recording counts as "no speech".
- **S4 Decoder reach.** Which containers a note can hold today (`mime.js`):
  list them and check Media Foundation (Windows) and MediaCodec (Android)
  decode each to 16 kHz mono f32. Result fixes the supported import list.

Exit: S1 builds and runs on both platforms, or DESIGN.md is updated (engines,
platforms) before phase 1.

## Phase 1: transcription core (Rust, no UI)

- `src-tauri/src/transcribe/`: `whisper.rs` (load model, run on a worker
  thread, progress and cancel, chunking at silence for long audio),
  `models.rs` (catalogue, download to the app data dir with resume and
  SHA-256 check, list, delete), `commands.rs`.
- Commands: `transcribe_models_list`, `transcribe_model_download` (progress
  events), `transcribe_model_delete`, `transcribe_run(path, model, language)`,
  `transcribe_cancel`.
- Audio stays on disk and goes by path, never as base64 over IPC.
- Tests (Rust): catalogue and hash handling, resume of a partial download,
  a short bundled speech sample transcribes to the expected words (tiny
  model, gated behind a feature/env flag so CI does not need the model),
  silence file returns "no speech".

## Phase 2: audio to 16 kHz mono (decoder)

- `audio_decode` Rust module: Windows Media Foundation reader, Android
  MediaCodec through the existing Kotlin plugin pattern with the result
  copied to a cache file (as `BackupFilePlugin` does), both ending in a
  16 kHz mono f32 file or in-memory chunks.
- Also feeds "Transcribe again", imported audio, and the AI engine when a
  provider needs WAV.
- Fresh recordings: optionally write the 16 kHz stream from the DSP output as
  a temp WAV (DESIGN 3.1 A), only if decode time of long `.m4a` proves to be
  a problem. Not in the first cut.
- Tests: each supported container decodes to the expected length within one
  frame; truncated file fails with a typed error, not a crash.

## Phase 3: Voice notes settings

- New `voiceNotesSettings.js` (task: `transcription_method`
  `local|ai`, `transcription_model` (local file id), `transcription_ai_model`,
  `transcription_language`, keep-temp flag) and a "Voice notes" section in
  settings (master/detail nav is built from the DOM). Model manager: list
  with size, download, progress, delete, active marker; "not available on
  this device" for models over the platform cap.
- `isTranscriptionReady()`: local = a model present; ai =
  `isProviderConfigured()` and `transcription_ai_model` set. Enforcement is
  UI-only: no hard block, a "not configured" notice with a button to
  Voice notes or to the AI access settings.
- Download needs an explicit consent step (it is network access).
- Tests: readiness matrix, setting ownership (single writer each), nav entry
  appears, `lastOpenSection` survives re-render.

## Phase 4: engine interface, job queue, text box sink

- `src/modules/voiceNotes/`: `transcriptionEngine.js` (`whisperLocal` first),
  `voiceJob.js` (`{id, noteId, recordingId, steps:[{type,config}], transcript,
  state}`; steps are data, DESIGN 3.7), `voiceQueue.js` (in-memory serial,
  foreground only, no auto-requeue, retry only by explicit action).
- Sink `textBoxSink`: creates the transcript box by id with
  `data-vn-hash`, `data-vn-recording` (box merges by id, DESIGN text_boxes
  §6); placeholder "Transcribing..." box first, replaced by id on result;
  failure leaves "Transcription failed - retry" and the recording.
- Edits made to the note while transcribing: write through the normal
  note-save path (local writes bypass canvas reload, see AI recognition
  invariants), so the open canvas must pick the box up; check how recognition
  results reach an open note and reuse it.
- Tests: queue order and cancel, note deleted meanwhile (result dropped,
  audio kept), box deleted meanwhile, hash set on write, transcript persisted
  with the job, placeholder replaced exactly once.

## Phase 5: UI entry points and recording dialog

- `VoiceNoteDialog`: start, pause, stop, level meter (reuse the amplitude poll
  of `RecordingManager`), cancel, add. Uses the same native recording
  commands; the aggressiveness slider is optional here.
- Entries: notebook view mic button + menu "Add voice note" (creates a note
  in the shown notebook, title "Voice note <date time>" until the transcript
  gives a title and only while untouched), note options menu, note editor add
  menu (adds to the open note, below existing content on the current page).
- Hidden on the Nextcloud app. Disabled with a reason when
  `isTranscriptionReady()` is false.
- Recording survives going to the background per the audio recording
  investigation; stop-and-save on close.
- Tests: dialog state machine, cancel deletes the file, add creates note +
  recording + placeholder, entry points hidden/disabled per platform and
  readiness, i18n keys in all locales.

## Phase 6: push to talk

- Per S2's findings: hold threshold, capture from `pointerdown`, slide away
  to cancel, recordings under ~0.5 s discarded, permission asked on first tap
  without recording.
- Tests (unit for the gesture state machine, e2e where the platform allows);
  manual Android check with finger and pen is the exit.

## Phase 7: AI engine

- `aiEndpoint` engine: OpenAI-compatible `/audio/transcriptions` (also local
  servers) and a Replicate whisper adapter, mirroring `aiRecognition.js`.
  Chunking at silence for provider size limits (decoder from phase 2).
- Consent text says audio leaves the device; keyed on `config.provider` like
  recognition.
- Nextcloud: decide with the recognition proxy whether the server proxies
  audio; not in this phase unless trivial (feature is hidden there anyway).
- Tests: request shape against a mock server, size-limit chunking, provider
  error mapping (reuse `failureReason.js`).

## Phase 8: re-run ("Transcribe again")

- Action on any recording in a note (sound dialog) and on imported audio
  ("Transcribe"): enqueue a job with the current engine.
- Replace rule (DESIGN D5): box exists and its text matches `data-vn-hash` ->
  replace silently; edited -> dialog Replace / Add as new box / Cancel; box
  gone -> add new.
- Tests: all three branches, hash survives save, sync round trip and the
  DOMPurify/Trumbowyg pass; two clients re-running at once do not lose text
  (boxes merge by id).

## Phase 9: release

- CHANGELOG entry under [Unreleased]; i18n for all locales; docs (feature
  description, model sizes, privacy note for cloud audio).
- Full manual matrix: Windows, both Android devices, Nextcloud app (feature
  hidden, an opened voice note is readable there: audio plays, text box
  visible).
- Cleanup of the spike notes in DESIGN.md.

## Later (not planned here)

Spoken commands (DESIGN §7), Windows GPU build, platform speech engines,
side-by-side transcript compare.
