# Voice notes: design

Status: **Accepted** (2026-10-28), not started. Plan: [PLAN.md](PLAN.md).

## Decision record

**Context.** Users want to speak instead of write or draw. The app already
records audio natively (Windows, Android) and has text boxes, AI access
settings and a recognition queue. Missing: one-step capture into a note and
speech-to-text.

**Decisions**

- **D1** A voice note is a **recording plus its transcript**. The recording is
  attached to the note; the transcript is a text box on the note.
- **D2** Transcription is a **pipeline of steps** (`audio -> transcript ->
  [further steps] -> sink`). v1 ships one fixed pipeline, `transcribe -> text
  box`; later steps (clean-up, summary, commands) are added without reworking
  the queue (§3.7).
- **D3** Two engines behind one interface: **whisper.cpp on device** (model
  chosen and downloaded in settings) and the **configured AI endpoint**.
  Platform speech APIs are not used (§3.8). The feature is disabled until one
  engine is ready.
- **D4** "Transcribe again" works on any recording in a note, including
  imported audio. The audio is always kept; there is no transcribe-only mode.
  Consequence: a decoder to 16 kHz mono is required (§3.1).
- **D5** A re-run never overwrites user edits silently. The generated box stores
  a hash of its text (`data-vn-hash`). Unedited box: replaced without a
  prompt. Edited box: dialog with **Replace**, **Add as new box**, **Cancel**.
  Box gone: result is added as a new box.
- **D6** Own **"Voice notes"** section in settings. The task settings live in a
  new `voiceNotesSettings.js`; `aiProvider.js` stays the single owner of the
  AI connection.
- **D7** Entry points: notebook mic button and menu entry (tap opens the
  dialog, hold is push to talk), note options menu, note editor add menu.
- **D8** Native only (Windows, Android). The Nextcloud app has no recording, so
  the feature is hidden there.
- **D9** Spoken commands are a later phase and, when built, use an LLM with a
  confirmation step (§7).

**Consequences**

- whisper.cpp must build with the pinned NDK 27 and run acceptably on phones;
  this is checked by a spike before UI work (§8).
- Audio leaves the device with the AI engine; it needs its own consent text.
- The model files and the queue are local only; nothing new syncs (§6).
- Windows GPU acceleration is a later option, not part of v1.

**Rejected alternatives**

- *Platform speech engines* (Android `SpeechRecognizer`, Windows speech):
  behaviour differs per device, no model choice, Android file input needs API
  33+. Possible later behind the same interface.
- *Rule-based spoken commands*: need a phrase grammar per language and break on
  natural wording.
- *Side-by-side compare of old and new transcript*: "Add as new box" keeps both
  without a compare UI. Revisit if users ask for merging.
- *Transcribe-only mode*: audio is always kept.

## 1. Goal

Speak, get a note.

Entry points:

1. Notebook view: mic button and a menu entry "Add voice note".
   - **Tap:** dialog with start / pause / stop, level meter, cancel, add.
   - **Hold (push to talk):** records immediately, release creates the note.
2. Note options menu: "Add voice note" (to an existing note).
3. Note editor add menu: "Add voice note" (to the open note).

Not goals for v1: live (streaming) transcription while recording, speaker
separation, translation, recording in the Nextcloud app.

## 2. What exists today (verified 2026-10-28)

- Native recording: `RecordingManager.js` + `SoundDialog.js`, Rust
  `audio_dsp.rs` (AGC, limiter), `audio_encoder.rs` (AAC `.m4a`, WAV fallback),
  `native_audio_*` commands. Pause/resume, amplitude polling for the meter and
  an aggressiveness slider exist. Windows and Android only.
- AI: `aiProvider.js` owns the connection (`ai_provider`, `ai_endpoint`,
  `ai_api_key`), `recognitionSettings.js` owns the handwriting task,
  `recognitionQueue.js` is a manual-only in-memory serial queue, `consent.js`
  gates cloud hosts.
- Text boxes exist (text_boxes roadmap) and merge by id on sync.

## 3. Technical design

### 3.1 Audio into Whisper

Whisper needs 16 kHz mono float PCM; recordings are 48 kHz AAC.

- **Decode** the stored file (Media Foundation on Windows, MediaCodec on
  Android). Required by D4: "Transcribe again" and imported audio go through
  it.
- **Optimisation, only if needed:** for fresh recordings, resample the DSP
  output to a temp 16 kHz WAV next to the `.m4a` (about 115 MB/h, deleted after
  transcription), which avoids decoding long files.

### 3.2 whisper.cpp in the Tauri app

- `whisper-rs` crate (whisper.cpp bindings) in `src-tauri`; `transcribe_*`
  commands run on a worker thread and report progress.
- Windows: cmake + MSVC at build time (cmake to verify). CPU only in v1.
- Android: whisper.cpp built through the NDK, which is pinned to
  27.2.12479018 (NDK 29 crashes at load, see the Android build notes). Spike 1.
- Models: ggml files from the whisper.cpp Hugging Face repo. Offer tiny, base,
  small (and quantised q5 variants); medium is too slow on phones. Show size
  and a "speed on this device" hint. SHA-256 verified, stored in the app data
  dir, deletable. The download is the only network access of the offline path
  and needs an explicit consent step.
- Whisper hallucinates on silence ("Thanks for watching"). Use whisper.cpp's
  VAD or an energy gate on the 16 kHz audio, and skip transcription of a
  recording with no speech (the note is still created with the audio).
- Language: auto-detect by default, optional fixed language (a separate
  setting from the handwriting recognition language hint).

### 3.3 Cloud / local-AI transcription

- OpenAI-compatible `POST {endpoint}/audio/transcriptions` (also what local
  servers such as whisper.cpp server or speaches expose). Replicate whisper
  models as a second adapter, mirroring `aiRecognition.js`.
- Audio is more sensitive than a page image: the consent text says audio
  leaves the device. Upload the `.m4a` or WAV per provider support; honour
  provider size limits (OpenAI 25 MB), so long recordings are chunked at
  silence points.
- `transcription_method` = `local` | `ai`, mirroring `recognition_method`.
  Enforcement is UI-only, like the recognition split.

### 3.4 Job model

Same rules as the AI recognition queue: in-memory serial queue, foreground
only, no auto-requeue (an explicit retry on failure). The note is created and
saved **immediately** with the audio and a placeholder text box
("Transcribing..."); the result replaces the placeholder by box id. If the note
was edited meanwhile, the result goes to the box by id; if the note or box is
gone, the result is dropped (the audio is never lost). A failed run leaves the
placeholder as "Transcription failed - retry" and the recording intact.

### 3.5 Push to talk

- Tap vs hold by a threshold (about 300 ms) on `pointerdown`; pointer capture,
  `touch-action: none`, `contextmenu` and text selection suppressed (Android
  long-press).
- **Microphone permission must already be granted** before a hold can work:
  the Android permission dialog steals the pointer. The first tap or hold
  without permission asks for it and does not record.
- Start latency eats the first words, so capture starts on `pointerdown`
  (before the threshold) and is discarded if the gesture was a tap. Sliding
  away from the button before release cancels.
- A hold under about 0.5 s of audio is discarded (accidental).

### 3.6 Placement and naming

- New note: created in the notebook currently shown; title "Voice note <date
  time>" until the transcript gives one (first words), set automatically only
  while the user has not renamed the note.
- Existing note: transcript box is appended below existing content on the
  current page (or the last page); the audio joins the note's recordings.
- Length limits, background recording and stop-on-close follow
  `documentation/investigations/AUDIO_RECORDING_LEVEL_ARTIFACTS_LENGTH.md`.

### 3.7 Pipeline

A job is an ordered list of steps (`{type, config}`) with typed input and
output (audio, text, structured action); the sink is a separate step. The
intermediate transcript is kept with the job so a later step can run without
transcribing again. No general workflow engine in v1.

### 3.8 Engines

`TranscriptionEngine { isAvailable(), transcribe(audio, opts) }` with
`whisperLocal` and `aiEndpoint`. New engines plug in behind this interface.

## 4. Platforms

| | Windows | Android | Nextcloud app |
|---|---|---|---|
| Record | yes | yes | no (feature hidden) |
| Local whisper | yes | yes (Spike 1) | no |
| AI transcription | yes | yes | not in v1 |

## 5. Settings

Section "Voice notes": transcription method, model manager (download, delete,
active), language, AI model for transcription (task-scoped, same provider as
other AI features), keep the 16 kHz temp file (default no).

## 6. Sync

The recording and the text box are ordinary note content, so nothing new
syncs. Model files and the queue are local only. If sync runs while a job is
pending, the placeholder is just a text box with the placeholder text and is
replaced later through the normal merge by id.

## 7. Spoken commands (later)

Example: "Add the following note to *Shopping* as task: buy milk".

- An LLM interprets the transcript. Input: the transcript and the list of note
  titles (not contents). Output: strict JSON `{action: "append"|"create",
  target_title, as_task, payload}`.
- Never silent: a confirmation sheet shows the interpreted action and the
  matched note, with Apply / Save as plain voice note. Titles are matched
  locally against real titles; a weak match asks.
- Explicit mode: a "Command" toggle in the recording dialog, off by default,
  not available for push to talk, disabled without an AI text model.
- The plain voice note is always created first; the command adds a derived
  action. Small fixed action set (append, append as task, create note).

## 8. Risks

1. whisper.cpp on Android with NDK 27 (build, speed, binary size). Spike 1.
2. Push-to-talk gesture reliability on Android WebView. Spike 2.
3. Speed of `small` on mid-range phones; models may be capped per device.
4. Large recordings: the 16 kHz buffer is about 230 MB per hour as f32, so
   audio is processed in chunks.
