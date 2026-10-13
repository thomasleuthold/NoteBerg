# Audio recording fixes — implementation plan and log

Companion to [`AUDIO_RECORDING_LEVEL_ARTIFACTS_LENGTH.md`](AUDIO_RECORDING_LEVEL_ARTIFACTS_LENGTH.md),
which holds the evidence, the measurements and the design (F1–F6, D1–D6). This
document does not restate them. It orders the work by **regression risk** rather
than by subsystem, fixes what "done" means for each step, and records what has
actually been implemented.

Why a separate ordering: the investigation's own Phase 1/2/3 puts the Media
Foundation AAC encoder at step 2 — new unsafe COM code plus a change of stored
file format — ahead of changes that are pure-Rust refactors with no observable
output change. The tiers below put every no-observable-change step first, so
that when audio quality or file handling does change, exactly one step is
responsible for it.

Each step is independently shippable. No step depends on a later one.


---

## Status

| Step | Tier | What | Status |
|---|---|---|---|
| 1 | 0 | `.m4a` in `validate_recording_path`; MF crate feature | **done** |
| 2 | 0 | Remove dead browser recording path | **done** |
| 3 | 1 | Windows ring buffer + worker thread (D2a) | **done** |
| 4 | 1 | Chunked binary IPC hand-off (D4) | **done** |
| 5 | 2 | Windows Media Foundation AAC, mono (D2b) | **done** |
| 6 | 2 | D1 DSP in Rust + unit tests, wired into Windows | **done** |
| 7 | 2 | Stop-and-save on note close (D5) | **done** |
| 8 | 2 | Android keep-screen-on + stop cleanly on background (replaces D3a) | **done** |
| 9 | 3 | Android `AudioRecord` + DSP + `MediaCodec`/`MediaMuxer` (D3b) | **done** |
| 10 | 3 | Remove `register_audio_privacy()`; update architecture doc (D6) | **done** |


---

## Corrections to the investigation

Three things found while reading the code against the design. They change what
the steps have to do, not whether they are right.

**The Media Foundation crate feature is not present.** D2 says MF "needs only
the `Win32_Media_MediaFoundation` feature of the `windows` crate already in
`Cargo.toml`". The *crate* is there, pinned at 0.58 with
`["Win32_Media_Audio", "Win32_System_Com"]`; the MF feature is not. One line,
but it is a new feature set to add, not a no-op — hence step 1.

**`validate_recording_path` would reject the new files.** It allows `.wav` and
`.mp4` only. An `.m4a` from the MF encoder passes every other check and then
fails at read-back, i.e. after the recording is finished and the temp file is
the only copy. Extended in step 1, well ahead of the encoder that needs it.

**`native_audio_status` would not have been optional.** The investigation lists
it under "Android execution" risk rather than in the implementation plan.
Without it a foreground service can outlive the WebView and leak a running
recording that JS no longer knows about — so it belonged *in* the service step,
not after it. Moot as of the step 8 decision below (no service is being built),
and recorded here in case that decision is ever revisited.


---

## Tier 0 — no runtime behaviour change

Nothing a user can observe changes in this tier. Both steps are preparation:
they make later steps a code change rather than a code-plus-plumbing change.

### Step 1 — extension allowlist and MF crate feature ✅

- `validate_recording_path` accepts `.m4a` alongside `.wav` and `.mp4`.
- `windows` crate gains `Win32_Media_MediaFoundation`.

Nothing produces an `.m4a` yet and no MF symbol is called yet. Shipping this
alone is inert.

### Step 2 — remove the dead browser recording path ✅

`RecordingManager` takes the native path whenever `window.__TAURI_INTERNALS__`
exists, which is every Windows and Android build; the Nextcloud build never
renders the "New recording" button. The `getUserMedia` + Web Audio +
`MediaRecorder` branch is therefore unreachable on every shipped build.

The investigation defers this to Phase 3. It belongs first: it is the lowest-risk
item in the list and it shrinks the file every later JS step edits.

**The one real hazard, and how it was handled.** The deleted "web" test groups
were the only coverage for `_saveCompletedRecording`, for `getElapsed`'s paused
accounting, and for `importFile`'s save path — all of which the native path
still uses. Deleting those tests alongside the code would have dropped that
coverage silently. They were rewritten against the native path in the same
change, not after it.

`register_audio_privacy()` is *not* removed here. The investigation notes it
must be tested with "Let desktop apps access your microphone" off before
shipping, which makes it not free. It goes in step 10.


---

## Tier 1 — Windows internals; no format, API or data change

### Step 3 — ring buffer + worker thread (D2, first bullet) ✅

Callback becomes: `paused` check → push into an `rtrb` SPSC ring (~1 s) →
publish input peak to an `AtomicU32`. No allocation, no lock, no I/O. A worker
thread drains the ring, runs the **existing** DSP unchanged, and writes WAV as
today.

Output format, file naming, IPC and JS all stay identical, so the only possible
regression is audible — which is the point of the step. Count ring overruns and
log the total once at stop.

Explicitly **not** fixed here: the interleaved-stereo DSP bug (F3). It lives in
the DSP's channel handling and is fixed in step 6. Keeping them apart means a
level change can be attributed to one or the other.

*Done when:* 10 min recording while a sync and a large PDF import run shows no
drop-outs and logs an overrun count of zero.

### Step 4 — chunked binary IPC hand-off (D4) ✅

`native_audio_read_chunk(path, offset, len)` returning
`tauri::ipc::Response::new(bytes)` plus `native_audio_delete(path)`, replacing
`native_audio_read_and_delete`. JS assembles a Blob from 4 MB pieces. Removes
F4's hard wall and the multi-second stop freeze on both platforms without
touching either recorder.

`native_audio_read_and_delete` has no other caller and can be deleted outright.

Two things to get right while here:

- A chunk read racing a `destroy()`.
- **Delete-after-save ordering.** Today the file is deleted before the Blob
  reaches `saveFile()`, so a `saveFile` failure loses the recording with no
  copy left anywhere. Splitting read from delete is the chance to fix that:
  delete only once the blob is stored.

*Done when:* a 2 h Windows recording stops without a freeze and without
`Invalid string length`.


---

## Tier 2 — changes output format or platform lifecycle

### Step 5 — Windows Media Foundation AAC, mono (rest of D2) ✅

`IMFSinkWriter` on the worker thread, `MFStartup` and COM init per worker
thread, WAV fallback when MF is unavailable (N editions without the Media
Feature Pack). 48 kHz mono 96 kbps AAC-LC in MP4.

Changes the stored mime type from `audio/wav` to `audio/mp4`. That ripples into
sync, backup/restore and NC playback — all read-only consumers, but all need
the verification pass. Existing WAV recordings keep working; no migration.

After step 3 deliberately: if audio quality changes, threading and codec are
then distinguishable.

### Step 6 — D1 DSP in Rust with unit tests ✅

Downmix to mono → 80 Hz high-pass → slow AGC → true look-ahead limiter →
pause/resume fades. The actual fix for F1/F2 on Windows, and the fix for the
interleaved-stereo bug left over from step 3.

Risk is tuning, not crashing: the thing to listen for is the AGC over-boosting
room noise when the noise-floor freeze is mistuned.

Windows only at this step. **Run the JNI spike here**, while the Rust DSP is
being written — if the symbol export from the Tauri cdylib does not work out,
the Kotlin port gets written now rather than discovered as a blocker in step 9.

*Done when:* the five Verification unit tests pass (-40 dBFS sine reaches
-20 dBFS RMS within 10 s without overshoot; 0 dBFS burst produces nothing above
-1 dBFS; digital silence leaves gain unchanged; per-sample gain change bounded;
a -40→-10 dBFS step produces nothing above the ceiling).

### Step 7 — stop-and-save on note close (D5) ✅

Small change, user-visible semantics. `RecordingManager.destroy()` stops and
saves instead of cancelling; `NoteCanvas.destroy()` must push the resulting
promise into its `pending` array — today it calls `destroy()` synchronously and
discards the result, so a save started there would not be awaited.

Invalidates the "cancels the native recording on destroy" test, which is
rewritten to the new design.

Deliberately after the format work: before producing a file on every navigation
away, the file size and the stop path should already be fixed.

Also here: the leftover-file sweep for orphaned `rec_*` / `noteberg_rec_*`.

*Done when:* navigating away mid-recording leaves the recording in the note's
list.

### Step 8 — Android: keep the app awake while recording, stop cleanly when it is not ✅

**Decision (2026-09-17): no foreground service.** Recording is a
while-you-take-notes feature — the recorder lives inside `NoteCanvas`, bound to
an open note, and the intended use is capturing audio while writing. Unattended
background recording is not a goal, so the capability a `microphone` foreground
service buys is not one this feature needs.

That removes the Play Console "Foreground service permissions" declaration —
the form, the demo video, and a release gated on Google Play review — from the
plan entirely. It is the largest process risk in the original design and it is
being avoided by scoping, not worked around.

What replaces it, in the same step:

- **Keep the screen on while recording.** `FLAG_KEEP_SCREEN_ON` on the window
  for the duration of an active recording, cleared on stop, pause-with-intent,
  cancel and note close. No new permission, no manifest declaration, no policy
  surface. The app stays visible, so the Android 9+ background microphone
  restriction never engages and F5's silencing cannot happen. Needs a small
  Kotlin command (the existing `StatusBarPlugin` pattern fits) plus the JS
  calls around start/stop.
- **Stop and save if the app is backgrounded anyway.** Incoming call, a
  notification the user taps, a manual app switch. `NoteCanvas` already has a
  bound `_onVisibilityChange` handler and already listens for the event, so the
  stop hangs off that rather than adding a second listener. Reuses step 7's
  stop-and-save.
- **Tell the user why it ended.** A recording that stops at eleven minutes with
  a stated reason is a good outcome; a two-hour file that is silent after
  minute three is the bug being fixed. The saved recording is intact and in the
  note's list either way.

Explicitly accepted limitation: a recording does not survive the screen going
off or the user leaving the app. That is the feature's scope, and it is now
enforced honestly rather than failing silently.

No `RecordingService`, no `FOREGROUND_SERVICE*` or `WAKE_LOCK` permissions, no
`POST_NOTIFICATIONS` prompt, and **no `native_audio_status`** — the orphaned
running-recording problem it existed to solve cannot arise without a service
that outlives the WebView. (The "Corrections" note above stands as the reason
it *would* have been mandatory had the service been built.)

Worth stating because it looks like a shortcut and is not: `WAKE_LOCK` alone
would not have worked. It keeps the CPU awake, while the microphone
restriction keys off process importance — a wake-locked background recording
runs its full length and contains silence. Keeping the app visible is what
actually prevents it.

*Done when:* a 30 min Android recording with the app open and the screen
untouched records audio throughout; backgrounding the app mid-recording leaves
a complete, playable recording in the note's list with the user told why it
stopped.

---

## Tier 3 — highest risk, last

### Step 9 — Android `AudioRecord` + DSP + `MediaCodec`/`MediaMuxer` ✅

Hand-written pause timestamps, muxer finalisation and codec buffer handling —
the highest-risk code change in the plan. `VOICE_RECOGNITION` source
(`UNPROCESSED` where advertised), 48 kHz mono with a 44.1 kHz fallback, since
only 44.1 kHz capture is guaranteed on every device.

The existing `MediaRecorder` path stays as an automatic fallback on init
failure for at least one release. JNI to the Rust DSP must be guarded against
`UnsatisfiedLinkError` with a fallback to the Kotlin port or to unprocessed
audio.

Blocked on the JNI spike, which is run during step 6.

### Step 10 — remaining D6 cleanups ✅

Remove `register_audio_privacy()` (it exists for `getUserMedia`, no longer used
on Windows) and update the "Audio Recording" section of
`architecture_design.md`.

Removal must be tested with "Let desktop apps access your microphone" **off**
before shipping.


---

## Verification scope per step

"Check on Windows, Android and NC" is right for the plan as a whole but
expensive to repeat per step. Steps 1, 2, 3 and 6 touch no file format and no
shared data, so Windows-only verification (plus `just fct` for the JS steps)
is sufficient. The full cross-platform pass — playback, chunked sync upload,
backup/restore — genuinely matters at steps 5, 7, 8 and 9.

### Meter semantics (F6) has no step of its own

Windows reports post-DSP peak today, Android raw input peak, so the same bar
height already means different things. Step 6 changes what Windows reports and
step 9 changes Android. Between those two the gap persists in a different
shape. `SoundDialog` needs no code change at any point, but the bar should be
eyeballed for sane behaviour at each of those steps rather than assumed.


---

## Log

### Step 1 — extension allowlist and MF crate feature

- `src-tauri/src/lib.rs`, `validate_recording_path`: extension check now accepts
  `.m4a`. The name-prefix check (`noteberg_rec_` / `rec_`) and the
  allowed-directory check are unchanged, so the security property the function
  exists for is untouched — this widens only the format, not the reachable set
  of directories or names.
- `src-tauri/Cargo.toml`: `windows` crate features gain
  `Win32_Media_MediaFoundation`, unused until step 5.

Inert on its own: nothing writes an `.m4a` and no MF symbol is called yet.

### Step 2 — remove the dead browser recording path

Removed from `src/components/NoteCanvas/RecordingManager.js`:

- `_getUserMediaWithRetry()` and the whole `getUserMedia` branch of
  `startRecording()`, including the Web Audio chain (compressor → gain →
  limiter → analyser → `MediaStreamDestination`) that fed `MediaRecorder`.
- `_handleRecordingStopped()`, `_releaseStream()`, and the `MediaRecorder`
  branches of `pauseRecording`, `resumeRecording`, `stopRecording`, `destroy`,
  `isRecording`, `isPaused` and `getAmplitude`.
- The now-unused fields `_mediaRecorder`, `_audioChunks`, `_stream`,
  `_mimeType`, `_audioContext`, `_analyser`, `_analyserBuffer`.

`IS_NATIVE` is gone with them: every path it guarded is now the only path.
`startRecording()` throws if invoked outside a Tauri environment, which is the
honest failure for a build that should never render the button.

Tests (`RecordingManager.test.js`): the `describe` blocks
`isRecording / isPaused (web)`, `getUserMedia constraint fallback` and
`web recording completion` are gone. Their coverage of code the native path
still uses was **re-established against the native path**, not dropped:

- `_saveCompletedRecording` — appending on stop, and `onChange`-not-throw when
  `saveFile` rejects — now asserted through the native stop flow.
- `getElapsed` paused accounting and `importFile` were already covered by
  native-independent tests and needed no change.

The `web` test-harness scaffolding (`MediaRecorder`/`getUserMedia` fakes) went
with them.

Net test count: 26 → 31. Eight web tests removed, thirteen added — the
re-established coverage plus guards the web block never had (`resumeRecording`
and `stopRecording` no-ops, `native_audio_stop` itself rejecting, a read
failure after a successful stop, destroy with no active recording, and the
reported mime type reaching the stored blob).

**Verified:** `cargo check` clean; `just fct` green — 92 files / 2064 tests
passed (the single "expected fail" is a pre-existing intentional marker),
Biome format and lint clean, PHP tests pass. No reference to any removed
member survives outside the module: `SoundDialog` uses only `isRecording`,
`isPaused` and `getAmplitude`, all still public.

Not verified by this change: real recording on a device. Tier 0 alters no
runtime path on Windows or Android, so a smoke test is prudent but no
behaviour should differ.

### Step 3 — ring buffer + worker thread

`mod win_audio` in `src-tauri/src/lib.rs`. New dependency: `rtrb = "0.4"`
(Windows target only, pure Rust — the pinned NDK build is unaffected).

**Callback** now does only: `paused` check → `write_chunk_uninit` +
`fill_from_iter` into the SPSC ring → bump an overrun counter on a short write.
No `Vec` allocation, no `Mutex`, no `write_sample`, no `WriteFile`. The three
near-identical per-format branches collapsed into a `build_stream!` macro over
the sample conversion, which also added the `U16` case the old code sent to a
"write raw, no DSP" fallback.

**Worker thread** (`noteberg-audio`) owns the DSP state, the `hound` writer and
the meter value. Drains up to `WORKER_CHUNK` (4096 samples, ~40 ms of stereo
48 kHz) per wake-up, sleeping 5 ms when the ring is empty.

Shutdown is ordered so it cannot race: `finish()` drops the stream *first*, so
no producer remains, then clears `running`; the worker treats "ring empty **and**
not running" as end-of-stream, finalizes the WAV and returns. `native_audio_stop`
and `native_audio_cancel` both join the worker — cancel must, because the writer
holds the file handle and Windows will not remove an open file.

**Meter** moved from `Arc<Mutex<f32>>` to an `AtomicPeak` (an `AtomicU32` of
`f32::to_bits`), published by the worker. Two consequences: the 100 ms meter
poll no longer contends with the audio callback for a lock, and the value is now
post-DSP from the worker rather than post-DSP from the callback — same meaning,
different thread (F6 unchanged for now).

**Overruns** are counted and logged once at stop
(`[WinAudio] N buffer(s) dropped during recording`). cpal swallows WASAPI's
`AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY`, which is exactly why the old
in-callback drops were inaudible in the logs and audible in the file.

The DSP itself is untouched, as the step requires — the interleaved-stereo bug
stays until step 6 so a level change can be attributed to one step or the other.

### Step 4 — chunked binary IPC hand-off

`native_audio_read_and_delete` is gone, replaced by three commands sharing a
new `recording_allowed_dirs()` helper (the allowed-directory logic was inline
and would otherwise have been copied three times):

- `native_audio_file_size(path) -> u64`
- `native_audio_read_chunk(path, offset, len) -> tauri::ipc::Response` — raw
  bytes, which `invoke` resolves as an ArrayBuffer. Loops on short reads rather
  than treating one as EOF, and caps a single call at 16 MB so a bad `len`
  cannot drive an arbitrary allocation.
- `native_audio_delete(path)`

Every one still goes through `validate_recording_path`, unchanged.

JS (`RecordingManager._readNativeFile`) assembles a Blob from 4 MB pieces.
No base64, no JSON body, no `atob`, no per-char loop on the main thread.

**Delete-after-save ordering fixed.** `_saveCompletedRecording` now returns a
boolean and the delete only fires when it is `true`. Previously the file was
deleted as part of the read, so a `saveFile()` rejection destroyed the only
copy; the temp file now survives a failed save and the recording is recoverable.

Tests: the stop stub models the real chunked protocol (size + per-offset
slices). Three new cases — multi-chunk reassembly (two full 4 MB chunks plus a
partial, each filled with a distinct byte, asserting offsets, lengths, total
size and boundary bytes), delete-ordered-after-last-read, and no-delete-on-save-
failure. The reassembly test was checked against a mutant (`chunks.reverse()`)
and fails on it, so it is not a can't-fail test.

**Verified:** `cargo check` and `cargo build --release` clean (the one
`unused_mut` warning at `lib.rs:857` is pre-existing and unrelated);
`just fct` green — 92 files / 2067 tests passed, Biome format and lint clean,
PHP tests pass.

Not verified by this change: real recording on a device. Both steps alter the
Windows capture path, so the step 3 and step 4 "done when" checks — a 10 min
recording under load with a zero overrun count, and a 2 h recording that stops
without a freeze — still need a real run on Windows. Android is affected only
by the step 4 JS/IPC change (its `MediaRecorder` path is untouched) and needs a
record-stop-play smoke test.

### Steps 5 & 6 — Windows AAC encoder and the D1 DSP chain

Done together and in that order — 6 before 5 in practice — so the encoder was
wired to the finished chain rather than rewired twice.

**`src-tauri/src/audio_dsp.rs` (new).** Platform-independent, I/O-free, so
`cargo test` reaches it on any target and a JNI call could later reach it from
Kotlin. Chain: downmix to mono → 80 Hz 2nd-order Butterworth high-pass → slow
AGC (-20 dBFS RMS target, +30/-6 dB range, 3 dB/s rise, 30 dB/s fall, noise-floor
freeze) → true look-ahead peak limiter (5 ms delay line, -1 dBFS ceiling) →
pause/resume fades. The old `process_audio` port and its `gain_computer`,
`lin_to_db`, `db_to_lin` helpers are gone from `win_audio`.

The downmix also removes the interleaved-stereo bug held over from step 3: the
worker now reads whole frames only (`(available / channels) * channels`), so a
downmix never straddles a channel boundary between iterations.

13 unit tests. One is worth recording because it failed first and the failure
was informative: the zipper-noise test tripped on a 3.11 dB jump between the
first two 10 ms blocks. A probe showed `gain_db` was still exactly 0 there — the
jump was the high-pass settling from zero state, a filter transient, not gain
movement. Relaxing the bound would have hidden that; instead the test skips the
first 50 ms, tightens the bound to 0.5 dB (the AGC's own maximum is 0.03 dB per
block, so it is now a real constraint rather than a formality), and a separate
test asserts the startup transient stays below -20 dBFS.

**`src-tauri/src/audio_encoder.rs` (new).** An `Encoder` trait with two
implementations: `AacEncoder` (Media Foundation `IMFSinkWriter`, AAC-LC in MP4,
mono, 96 kbps — the MF floor) and `WavEncoder` (the previous `hound` path).
`create_encoder` tries AAC and falls back to WAV, so Windows N without the Media
Feature Pack still records. COM and `MFStartup` are owned by an `MfRuntime`
guard created on the worker thread and shut down on drop, never on the command
thread. Presentation timestamps derive from samples written, not the wall clock.

The temp path is now extensionless and the encoder appends `.m4a` or `.wav`;
`native_audio_stop` derives the media type from the extension the encoder chose,
which is why step 1's allowlist change was a prerequisite.

Three encoder tests, including one that opens the produced `.m4a` and asserts
real MP4 box structure (`ftyp` at bytes 4..8, a recognised brand, plausible size
for 2 s of 96 kbps). Without it the fallback test would pass on a machine with
no MF at all, so a silently broken AAC path would have looked green. Verified on
this machine that the AAC path — not the fallback — is the one that ran.

### Step 7 — stop-and-save on note close

`RecordingManager.destroy()` now returns a Promise and stops-and-saves instead
of cancelling. Completion is signalled explicitly through `_stopSettled`,
resolved at every exit of `_handleNativeStopped` and on the stop error path —
an earlier draft wrapped `onChange` to detect completion, which coupled the
promise to a UI callback for no good reason. A 30 s `Promise.race` backstop
means a hung native stop delays note close instead of blocking it forever.

`NoteCanvas.destroy()` captures that promise and pushes it into the `pending`
array it already awaits, so the note's save and sync see the new recording.

Also here: `sweep_orphaned_recordings()` at startup, clearing `rec_*` /
`noteberg_rec_*` files from a run killed mid-write. An unfinalized MP4 has no
`moov` index and is unplayable, so there is nothing to recover.

### Step 8 — Android keep-screen-on and clean background stop

`FLAG_KEEP_SCREEN_ON` is set in `beginRecording` and cleared in
`stopAndRelease`, so every stop path clears it and process death releases it
with the window. No new permission, no manifest change, no Play declaration.

`NoteCanvas._onVisibilityChange` stops and saves via
`RecordingManager.stopRecordingForBackground()`. Placed **before** the existing
`activePointers.size === 0` early return — that guard is about gesture state,
and a hidden page with no active pointers still needs the recording stopped.

The user is told why: `stoppedInBackground` on the manager, rendered by
`SoundDialog` as a notice and cleared when the dialog closes (both `_close()`
and the `_toggle()` close path) or when the next recording starts. Nine locales
updated. A long comment block in `AudioRecorderPlugin.kt` records why there is
no foreground service, including that `WAKE_LOCK` alone would not have worked.

### Step 9 — Android AudioRecord + MediaCodec pipeline

`AudioRecorderEngine.kt` (new): `AudioRecord` (`VOICE_RECOGNITION`, mono PCM16,
4x minimum buffer, 48 kHz with a 44.1 kHz fallback since only 44.1 is guaranteed
for capture) → `AudioDsp` → `MediaCodec` AAC-LC 48 kbps → `MediaMuxer` MP4.
Platform `AutomaticGainControl` and `NoiseSuppressor` are explicitly disabled if
attached. Timestamps derive from samples encoded. A capture-thread exception is
stored and rethrown from `stop()`, so a broken recording is reported rather than
returned as a valid path.

`AudioRecorderPlugin` tries the engine first and falls back to the existing
`MediaRecorder` on any start failure, logging why — kept for at least one
release, as the plan required.

**`AudioDsp.kt` (new).** The design's first choice was one Rust implementation
reached over JNI; the plan's open point was to confirm that in a spike. That
confirmation needs a verified symbol export from the Tauri cdylib and a working
`System.loadLibrary` name, neither of which can be established without a device
build, so this took the fallback the design itself named: a direct Kotlin port
with the tuning constants pinned to the Rust ones.

That pinning is only worth something if it is checked, so
`AudioDspTest.kt` mirrors the Rust tests — same assertions, same thresholds.
10 tests, executed and passing (verified in the JUnit XML, not inferred from
BUILD SUCCESSFUL). A change that makes one implementation pass and the other
fail is exactly what it exists to catch.

### Step 10 — cleanups

`register_audio_privacy()` removed: it wrote microphone consent registry keys on
every start so `getUserMedia` could find a device, and Windows now records
in-process through cpal/WASAPI, which needs no ConsentStore entry. The
`win_audio` module header was rewritten, since it still described a WAV-only
in-callback design.

**Left in place:** the WebView2 `PermissionRequested` handler and the
`SetPermissionState` profile grants in `grant_media_permissions`.

An earlier version of this note called them "equally dead getUserMedia code".
That was wrong and is worth correcting rather than quietly fixing: **the camera
feature still uses `getUserMedia`**. `src/utils/imageUtils.js` calls it in
several places for camera capture, and `NoteToolbar` renders the "insert camera"
button wherever `navigator.mediaDevices` exists, Windows WebView2 included. The
WebView2 permission plumbing is live code for a different feature, not leftovers
from recording.

What *is* dead is narrower: both halves are microphone-scoped — the profile
grants pass `COREWEBVIEW2_PERMISSION_KIND_MICROPHONE`, and the request handler
only acts `if kind == ...MICROPHONE`. Nothing on Windows asks the WebView for a
microphone any more, since recording goes through cpal in-process. A *camera*
permission request never reaches either branch.

So removal is very likely safe, but "very likely" is doing real work in that
sentence and has not been tested. Deferred as its own change, after the test
session, with one specific check: on Windows, insert → camera, confirm the
preview appears and a capture lands in the note. Keeping it out of this batch
also avoids stacking two unverified Windows-permission removals (this and
`register_audio_privacy()`) into one session, where a failure would have two
candidate causes.

`architecture_design.md` "Audio Recording" section rewritten: it described a
WAV-only in-callback Windows design, a `MediaRecorder`-only Android path and a
browser recording path that no longer exists.

**Verified across steps 5-10:** `cargo test --lib` 70 passed / 0 failed;
`cargo build --release` clean; Gradle `compileUniversalDebugKotlin` clean on a
forced full recompile; Gradle unit tests 10 passed / 0 skipped / 0 failures;
`just fct` green — 92 files / 2073 JS tests, Biome format and lint clean, PHP
tests pass.

---

## Fix: Android build broke on a Windows-only dependency

Found by the first real `just build-aab`, after every step was marked done.

`audio_encoder.rs` was declared as an unconditional `mod`, but its `WavEncoder`
uses `hound`, which `Cargo.toml` declares only for
`cfg(target_os = "windows")`. Windows compiled fine; the Android target failed
with four `unresolved module or unlinked crate 'hound'` errors before it reached
anything Android-specific.

The fix is a `#[cfg(target_os = "windows")]` on the module. That is the right
gate rather than adding `hound` for Android, because Android never touches this
module at all — it encodes in Kotlin via `MediaCodec`/`MediaMuxer`, and the
encoders here exist for the cpal capture path. The now-unreachable non-Windows
`create_encoder` branch and the redundant inner `cfg` attributes went with it.

`audio_dsp` is deliberately **not** gated: it is pure arithmetic with no
platform dependencies, so it builds everywhere and its unit tests run on every
target — which is what makes it the reference the Kotlin port is checked
against.

**Why the existing verification missed it.** Everything Rust was checked with
`cargo check`, `cargo test` and `cargo build --release` — all of which default
to the host target, Windows. A Windows-only dependency referenced from a
non-gated module is invisible to every one of those. The Android work was
verified through Gradle (Kotlin compile plus JUnit), which never invokes the
Rust cross-compile, so the two verification paths between them covered
everything except the seam where they meet.

Running `cargo check --target aarch64-linux-android` would have caught it, and
is the check to run after any change to a shared Rust module. Note that it
needs the NDK toolchain on PATH: run it the way the build does
(`NDK_HOME` pinned to 27.2.12479018 per the Tauri 2.11 workaround), or accept
that `ring`'s build script fails for environment reasons unrelated to the code.

---

## Follow-up: the active pipeline is logged in-app

`native_audio_start` now returns `{ pipeline }` and `RecordingManager` logs it
through the app's own logger at **warning** level.

Why warning rather than info or debug: the logger defaults to `warning`
(`src/utils/logger.js`), and on Android it never even reads the saved level --
`initLogger` returns early there -- so anything below warning would be invisible
on exactly the device where this matters. It is not a fault condition; it is
diagnostic information that has to survive the default level.

Values: `audioRecord` / `mediaRecorder` on Android, `windowsAac` / `windowsWav`
on Windows. When the Android engine fails and the fallback takes over, the
rejection reason rides along as `fallbackReason`.

The problem it solves: a recording made by the MediaRecorder fallback is
indistinguishable from one made by the AudioRecord engine -- same file, same
container, plays the same. The only prior evidence was logcat, which needs the
phone plugged into a development machine. A tester with just the APK could not
tell which pipeline they had actually exercised, which made "successful
recording" much weaker evidence than it looked.

Windows reports the same way, so a silent fall back to WAV (Media Foundation
unavailable) is equally visible.

Four tests cover it, including one that asserts recording still works when the
native side reports no pipeline at all -- an older binary against a newer
frontend must not break.

---

## Device results so far (2026-09-18)

Android, release APK sideloaded onto a physical phone:

- **The AudioRecord pipeline ran**, confirmed by the in-app log line
  `Recording pipeline: audioRecord` -- not the MediaRecorder fallback.
- **The recording was successful and playable.**
- **Level looked right** on a listening check (no instrument comparison yet).

This closes the largest code risk in the plan. Step 9 is hand-written pause
timestamps, MediaCodec buffer handling and MediaMuxer finalisation, none of
which any test in this repo can exercise -- a unit test cannot tell you whether
the moov atom was written. It works on real hardware.

It also confirms F1 is addressed on the Android side: the app's own DSP is the
gain stage, not the OEM HAL.

Still unconfirmed on Android: pause/resume (the fades are new), backgrounding
mid-recording, and a long recording. Nothing on Windows has recorded real audio
yet.

---

## Code review fixes (2026-09-18)

A review raised eleven points. All were verified against the code and all were
real; every one is fixed. The ones that mattered most:

**COM/MF init was on the wrong thread.** `create_encoder` ran on the Tauri
command thread (a tokio worker) while the `MfRuntime` guard was moved into the
audio worker and dropped there — `CoInitializeEx` and `CoUninitialize` on
different threads, leaving an STA refcount on a pooled thread per recording. It
happened to work only because the sink writer is free-threaded. The encoder is
now built as the first thing inside the worker closure, with the chosen path
returned to `start()` over an `mpsc` channel. This also made the code match its
own comment and the architecture doc, which both already claimed it.

**The startup sweep could delete other programs' files.** It matched the `rec_`
prefix — Android's naming — in the *shared* Windows temp dir, so any
`rec_*.mp4` another tool left in `%TEMP%` was deleted at every launch. Now
`noteberg_rec_` is swept anywhere and `rec_` only in the app-private Android
cache dir. This was the worst of the eleven: it touched files outside the app.

**A failed start leaked a thread and an open file.** After the worker was
spawned, a `build_input_stream` or `stream.play()` error returned with `running`
still true, leaving the worker looping on 5 ms sleeps forever holding the
`.m4a` open. Every "no microphone" click leaked one. All failure paths now go
through an `abort_worker!` macro, and `native_audio_start` refuses to replace a
live recording rather than dropping its state.

**The Windows pause fade-out almost never fired.** It was applied only when the
pause flag was seen right after processing a chunk, but the worker polls every
5 ms against ~10 ms WASAPI delivery, so the ring is normally empty when a pause
lands — and when it wasn't, chunks got double-faded. The worker now holds back
the last `fade_len` samples and flushes them faded on pause or end of stream,
unfaded when the next chunk proves the stream continued.

**Android replayed audio recorded during a pause.** The capture loop slept
without reading while paused, but `AudioRecord` keeps filling its buffer
regardless — so the first reads after a resume returned up to a full buffer
(4× minimum) of audio captured *during* the pause, spliced in as if live. It
now keeps reading and discarding. `applyFadeOut` also had no production caller
at all; a fade is now queued when the pause is observed.

Also fixed: `destroy()` not awaiting a stop someone else started (the
background stop made this far likelier — two tests, both verified to fail
against the old code); silent Android buffer drops (now counted and logged like
the Windows overruns); a spinning capture thread on persistent read errors; a
leaked microphone when codec or muxer creation threw; an EOS drain that exited
on `INFO_TRY_AGAIN_LATER` and lost the tail; worker write errors surfacing only
at stop (now reported through the amplitude poll, which stops the recording);
and a stale module header.

**What this says about the earlier verification.** Every one of these is a
concurrency, lifetime or cleanup defect on a failure path — exactly the class
that compiles, passes unit tests, and works in a successful manual run. The
device test that confirmed the Android pipeline could not have caught any of
them, because none occur on the happy path. Worth remembering before treating
"it recorded fine" as coverage.

---

## Sync investigation during testing: no bug (2026-09-19)

Most of this session's testing time went into "recordings made on Android do
not appear on Windows, and vice versa". **There was no bug.** The Windows
client was pointed at a local dev Nextcloud while Android used the real server,
so the two never shared data. Every `EQUAL -> skip` in the logs was correct.

Recorded because the false trail cost a day and the lesson generalises: on any
two-client sync symptom, confirm both clients target the same server before
reading a line of merge logic. It was never asked.

Four real defects were found by reading code along the way, and they are kept
on their own merits -- none was the reported symptom:

- **`decryptNoteLocally` failed a whole note on one bad field.** One
  undecryptable field (a key this client no longer holds) threw out of the
  function and failed the note's entire upload, every sync, indefinitely. Now
  per-field, dropping only what cannot be read and naming it in a warning.
  Confirmed live: a note that had failed for days uploaded and named
  `deletedTasks`.
- **Encrypted notes never merged.** `attemptMerge` refuses them (it must be
  safe to call from the Web Worker, which has no key), and both callers fell
  back to "local wins, remote's edits are lost" -- the code comment said so
  outright. fullSync runs on the main thread where the key IS available, so it
  now decrypts and merges, falling back to the old behaviour only when the note
  genuinely cannot be decrypted. Still untested against a real two-device
  conflict.
- **Media check excluded every recording.** The queue gate required
  `r.fileId`, which `splitNote()` strips from the index copy of `recordings`,
  and `getRawNote` does not decrypt so encrypted notes failed the array checks
  too. No encrypted note, and no note whose media was a recording, ever had its
  binaries downloaded.
- **`audio/wav` was missing from the MIME map.** Windows recorded WAV until the
  AAC encoder landed (and still does where MF is unavailable); those files
  uploaded as `{fileId}.bin` and came back `application/octet-stream`, which no
  `<audio>` element plays. Added, with WAV/MP4 magic-byte sniffing in the NC
  backend.

**Reverted before finishing:** a stale-fork guard added for a post-restore
scenario that was inferred and never confirmed. It sat next to the documented
stroke-loss regression (commit e809876) and solved a problem no evidence
supports, so the surface area was not worth it. The per-note `etag check` log
line went too -- ~56 lines per sync. The bounded summaries stayed: what was
queued for download, what came back, and what the media check resolved per
note. Those four would have exposed the server mix-up in one look.

---

## What a test session still has to cover

Everything above is compile- and unit-verified. None of it has recorded actual
audio, and three things in particular cannot be checked any other way:

1. **Windows, end to end.** Record, play back, check the level sounds right and
   that there are no clicks. The DSP, the AAC encoder and the ring-buffer
   threading all land in the same first recording — if something is wrong,
   bisect by checking whether the file is `.m4a` (encoder) and whether the
   audio is quiet or distorted (DSP) versus dropping out (threading).
2. **Android.** ~~Which pipeline ran~~ -- answered: the `AudioRecord` engine,
   on a physical device, producing a playable file (see Device results). The
   `MediaRecorder` fallback remains untested, which is acceptable: it is the
   previous shipping code, reached only when the engine refuses to start.
   The pipeline is logged in-app at warning level on every start, so any device
   that does fall back will say so without needing logcat.
3. **Level parity.** The point of owning the DSP: record the same sentence at
   the same distance on Windows and on each Android device, then compare
   `ffmpeg -af volumedetect` mean volumes. They should agree within ±3 dB.

Also worth covering: a 2 h Windows recording (the old ~35 min wall), stopping
without a freeze; navigating away mid-recording and finding the recording in the
list; backgrounding the Android app mid-recording and seeing the notice; pause
and resume on both platforms (the fades are new); and playback of a new `.m4a`
in the Nextcloud web app in both Chrome and Safari.
