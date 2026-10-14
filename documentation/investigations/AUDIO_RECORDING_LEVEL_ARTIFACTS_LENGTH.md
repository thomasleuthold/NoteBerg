# Audio recording: inconsistent level, artifacts, length limit

**Status: investigated, not yet implemented.** Three user-visible problems
(level differs per device, clicks/drops, long recordings break) trace back to
a small number of concrete causes in the native recording paths. This document
records the evidence, the numbers, and a proposed design so the work can be
implemented without re-deriving it. Nextcloud has no recording path and is
only affected as a *playback* target for files produced by the native apps.

## Symptoms reported

1. Auto-gain works differently per device: one Android device records at an
   acceptable level, another records far too quietly.
2. The gain/compressor sometimes produces artifacts: clicks, drop-outs.
3. Recording length/size is limited; a recording that is too long "breaks".

## How recording works today

The JS side (`src/components/NoteCanvas/RecordingManager.js`) always takes the
native path when `window.__TAURI_INTERNALS__` exists, i.e. on **every** Windows
and Android build. The browser `getUserMedia` + Web Audio + `MediaRecorder`
path in the same file is therefore dead code on all shipped builds (the NC
build never renders the "New recording" button).

Flow on both platforms:

```
start  → native_audio_start
meter  → native_audio_get_amplitude every 100 ms
stop   → native_audio_stop            → { path, mimeType }
       → native_audio_read_and_delete → base64 string of the whole file
       → atob() + per-char loop → Uint8Array → Blob → saveFile() (IndexedDB)
```

### Windows (`src-tauri/src/lib.rs`, `mod win_audio`)

- `cpal` opens the default input device with its **default config**: usually
  48 kHz, often **2 channels**, f32 samples.
- Inside the WASAPI capture callback, per buffer: `data.to_vec()` (heap
  allocation), a `Mutex` lock on the DSP state, `process_audio()`, a `Mutex`
  lock on the amplitude value, then a `Mutex` lock on a
  `hound::WavWriter<BufWriter<File>>` and one `write_sample()` call per
  sample. **Disk writes happen inside the real-time audio callback.**
- The DSP is a port of the browser chain: downward compressor (threshold
  -18 dB, 3:1, 50 ms / 300 ms), fixed make-up gain 1.1 (+0.8 dB), a
  "limiter" (threshold -1 dB, 20:1, 1 ms attack, no look-ahead), then
  `clamp(-1, 1)`.
- The stereo interleaved buffer is run through the DSP as one sample stream
  (L, R, L, R...), so the detector time constants are effectively halved and
  the state alternates between channels.
- Output: 16-bit PCM **WAV**, uncompressed.
- `native_audio_get_amplitude` returns the post-DSP peak.

### Android (`AudioRecorderPlugin.kt`)

- `android.media.MediaRecorder` with `AudioSource.VOICE_COMMUNICATION`,
  MPEG-4/AAC, 44.1 kHz, 32 kbps, default (mono) channel count.
- **No app-side gain or compression at all.** Whatever level and processing
  the recording has comes from the device's VoIP audio path.
- Amplitude meter uses `MediaRecorder.maxAmplitude` (raw input peak).
- No foreground service, no wake lock. The recorder lives inside the
  Activity-bound plugin.
- `MainActivity` requests audio focus but does nothing else audio-related.

### Teardown

`NoteCanvas.destroy()` calls `RecordingManager.destroy()`, which sends
`native_audio_cancel`: an in-progress recording is **discarded and deleted**
whenever the note is closed (navigate to overview, open another note, app
restart). `visibilitychange` (screen off, app switch) does *not* destroy the
canvas, it only flushes pending saves.

## Findings

### F1. Level differs per Android device because the device's VoIP path is the only gain stage

`VOICE_COMMUNICATION` is documented as "tuned for voice communications such
as VoIP; will for instance take advantage of echo cancellation or automatic
gain control **if available**". Which effects run, how strong the AGC is,
which microphone is selected (some devices route the call path to the
top/earpiece mic) and the noise-suppression gating are all OEM-specific HAL
tuning. That directly explains "one device fine, one too quiet": there is no
gain stage in the app that could equalise them.

The same applies to artifacts on Android: VoIP noise suppression gates
silence (heard as drop-outs), and a call-tuned AGC pumps. With
`MediaRecorder` the app gets no access to PCM, so none of this can be
corrected on the app side.

### F2. The Windows chain cannot raise a quiet input, and the Web Audio port is not an AGC

The comment in `process_audio` calls the first stage "gentle upward
compression for quiet passages", but a `DynamicsCompressor` is downward only:
it reduces gain above the threshold and does nothing below it. The only
upward element is the fixed make-up gain of 1.1 (+0.8 dB). A microphone whose
Windows input level is set low (e.g. peaks at -30 dBFS) is recorded at
roughly -29 dBFS. Loud inputs are flattened, quiet ones stay quiet. So level
consistency is not achieved on Windows either; it just happens to be less
variable than Android's VoIP path.

### F3. Windows clicks and drop-outs: disk I/O and locks in the audio callback, and a limiter without look-ahead

Three separate mechanisms, all in `win_audio::start`:

- **File writes in the callback.** `BufWriter` (8 KiB) flushes to the file
  every ~42 ms of stereo 48 kHz audio, i.e. a `WriteFile` syscall every few
  callbacks, plus a `Vec` allocation per callback. Normally sub-millisecond,
  but any stall (antivirus, the app's own IndexedDB writes, thumbnail saves,
  sync) exceeds the ~10 ms WASAPI period. WASAPI then sets
  `AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY` and drops capture data; cpal
  ignores that flag, so the drop is silent in the logs and audible in the
  file.
- **Mutex contention.** The amplitude `Mutex` is locked by the Tauri command
  thread every 100 ms (meter poll) and by the callback; the DSP `Mutex` is
  uncontended but still a lock in a real-time context. Priority inversion
  under load produces the same drop-outs.
- **Overshoot then hard clip.** The limiter's detector is smoothed with a 1 ms
  attack and has no look-ahead, so a transient passes through before the gain
  reduction arrives; the sample is then `clamp`ed. Hard clipping of a
  transient is a click. Pause/resume also splices the stream without a fade,
  which is a click at every resume.

### F4. "Too long" on Windows is the WAV size hitting a JavaScript string limit

Windows records uncompressed PCM at the device rate and channel count:

| device config | bytes/s | per minute | per hour |
|---|---|---|---|
| 48 kHz, 2 ch, 16-bit (typical laptop array) | 192,000 | 11.5 MB | 691 MB |
| 48 kHz, 1 ch, 16-bit | 96,000 | 5.8 MB | 346 MB |

At stop the file goes through: `std::fs::read` (X bytes) → base64 String
(1.33 X) → JSON-escaped IPC body (1.33 X) → JS response string (1.33 X) →
`atob()` (X) → `Uint8Array` (X) → `Blob` (X) → IndexedDB. Peak transient
memory is about 5-6 X, and the whole `atob` + char loop runs on the main
thread.

V8's maximum string length is 2^29 - 24 characters (~537 million). The base64
string reaches it at a WAV of ~403 MB:

| device config | recording length at which stop fails |
|---|---|
| 48 kHz stereo | ~35 min |
| 44.1 kHz stereo | ~38 min |
| 48 kHz mono | ~70 min |

Beyond that `atob` (or the JSON parse before it) throws "Invalid string
length", the `catch` in `_handleNativeStopped` logs it, and the recording is
lost. Well before the hard wall, a 20-30 minute recording already costs
1-2 GB of transient memory and a multi-second UI freeze at stop. The
resulting hundreds-of-MB blob then also has to be chunk-uploaded by
`nextcloudSync.js` and included in backups.

### F5. "Too long" on Android is most likely the app being backgrounded, not size

Android AAC at 32 kbps is 14.4 MB per hour (19 MB as base64), far below any
string or heap limit for realistic lengths. Size is not the failure mode
there. What does break long recordings on Android:

- **Background microphone restriction (Android 9+).** When the app is not in
  the foreground (screen locked, another app opened, notification shade
  actions), an app without a microphone foreground service has its input
  **silenced**; the recording continues but contains silence from that point.
  The app targets SDK 36 and has no foreground service.
- **Process death.** A backgrounded Activity-only process is a normal kill
  candidate. `MediaRecorder` writes the MP4 `moov` index at `stop()`, so a
  killed process leaves an unplayable file, and nothing recovers it.
- **Navigation.** Leaving the note (see Teardown) cancels and deletes the
  recording without asking.

The exact device/length/behaviour of the reported failure was not
available; the three above are the mechanisms consistent with "breaks if too
long" given the code. F4 is certain for Windows.

### F6. Smaller inconsistencies

- Meter semantics differ: Windows reports post-DSP output peak, Android raw
  input peak (`maxAmplitude`), so the same bar height means different things.
- `register_audio_privacy()` (writes microphone consent registry keys for the
  WebView2 renderer on every start) exists for `getUserMedia`, which is no
  longer used on Windows.
- The browser recording path and its Web Audio chain in
  `RecordingManager.js` are unreachable on every build.

## Proposed design

Goal: the same audible result on every device, no real-time hazards, files
small enough that a multi-hour recording is routine, and recordings that
survive screen-off and app switching.

### D1. One DSP, owned by the app, identical on both platforms

Replace the compressor/limiter port with a voice-recorder style chain
operating on **mono** PCM:

1. **Downmix to mono** (average channels). Halves file size, removes the
   interleaved-channel bug (F3), and voice memos gain nothing from stereo.
2. **High-pass at ~80 Hz** (2nd-order biquad). Removes DC offset, rumble and
   handling noise that would otherwise bias the level estimate.
3. **Slow AGC (the part that fixes F1/F2).** Per 10 ms block: RMS over a
   ~400 ms window; target -20 dBFS RMS; gain range -6 dB to +30 dB; gain may
   rise at most ~3 dB/s and fall at most ~30 dB/s (falls faster when the peak
   would exceed the ceiling); a noise floor tracker freezes the gain when the
   block is within ~6 dB of the floor so silence is not pumped up to hiss.
   The block gain is interpolated linearly per sample, so there is no zipper
   noise and, because changes are slow, no pumping.
4. **True look-ahead peak limiter.** 5 ms delay line; gain computed from the
   maximum over the look-ahead window; ceiling -1 dBFS; release ~80 ms. No
   sample can exceed the ceiling, so the final `clamp` never engages and the
   click source in F3 is gone.
5. **Pause/resume fade.** 5 ms fade-out before pause, fade-in after resume.

Why not the OS AGC: Windows has no standard capture AGC, and Android's is
exactly the OEM-dependent behaviour being fixed. Why adaptive rather than a
post-recording normalise pass: lectures and meetings have speakers at
different distances; a single static gain leaves one of them wrong, and a
second pass over a multi-hour file costs a temp PCM file of the sizes in F4.

Where the code lives. Recommended: **Rust**, exposed to Android through a
small JNI function (`Java_eu_noteberg_app_AudioDsp_process` in the existing
`noteberg_lib` cdylib, which Tauri already loads; add the `jni` crate for the
Android target). Kotlin's `AudioRecord` thread hands each PCM buffer to it.
One implementation, unit-tested with `cargo test`. Fallback if the JNI hook-up
proves awkward in a spike: port the same ~150 lines to Kotlin and pin both
ports to a shared test vector (a short WAV plus expected output RMS/peak).

### D2. Windows: take everything but the copy out of the callback, encode AAC

- Callback does only: `paused` check, push samples into a lock-free SPSC
  ring buffer (`rtrb` crate, ~1 s capacity), publish the input peak to an
  `AtomicU32`. No allocation, no locks, no I/O. Count ring-buffer overruns
  and log them once at stop so a drop is at least visible.
- A dedicated worker thread drains the ring: downmix → D1 chain → i16 →
  encoder. Amplitude for the meter is published from here (post-DSP, same
  meaning as Android).
- **Encoder: Media Foundation AAC** via `IMFSinkWriter`
  (`MFCreateSinkWriterFromURL` on an `.m4a`, output type `MFAudioFormat_AAC`,
  input type PCM 16-bit 48 kHz mono, `WriteSample` per block, `Finalize` at
  stop). Needs only the `Win32_Media_MediaFoundation` feature of the
  `windows` crate already in `Cargo.toml`; no new native dependency. The MF
  AAC encoder's lowest bitrate is 96 kbps and it accepts 44.1/48 kHz input,
  so the format is 48 kHz mono 96 kbps AAC-LC in MP4 (`audio/mp4`, `.m4a`),
  the same container and codec Android already produces. Keep the WAV writer
  as a fallback when MF is unavailable (Windows N editions without the Media
  Feature Pack).
- Alternative considered: Opus in Ogg via the `opus` crate (libopus built
  with cmake) at 32 kbps gives 3x smaller files but adds a C build
  dependency and Ogg/Opus playback in Safari (NC users) is not dependable.
  AAC/MP4 plays everywhere the app's `<audio>` element runs.

Resulting size, 48 kHz mono:

| format | per hour | vs today (Windows stereo WAV) |
|---|---|---|
| AAC-LC 96 kbps (Windows, MF minimum) | 43 MB | 16x smaller |
| AAC-LC 48 kbps (Android proposal) | 22 MB | |
| AAC-LC 32 kbps (Android today, 44.1 kHz) | 14 MB | |

### D3. Android: raw capture, own DSP, `MediaCodec` encode, foreground service

- Replace `MediaRecorder` with `AudioRecord` (source `VOICE_RECOGNITION`:
  flat response, no OEM AGC/NS on virtually all devices; try `UNPROCESSED`
  first where `PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED` is advertised),
  48 kHz mono PCM16, buffer 4x the minimum.
- Capture thread: `read()` → D1 chain (Rust via JNI, or Kotlin port) →
  `MediaCodec` (`audio/mp4a-latm`, AAC-LC, 48 kHz mono, 48 kbps) →
  `MediaMuxer` MP4. Presentation timestamps are derived from samples written,
  not wall-clock, so pause is a seamless splice. Amplitude comes from the DSP
  output.
- **Foreground service** `RecordingService` with
  `android:foregroundServiceType="microphone"`, permissions
  `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE` and
  `POST_NOTIFICATIONS` (requested alongside the mic permission on Android
  13+; without it the service still runs but its notification is hidden).
  The service is started from the plugin's `start()` while the app is in the
  foreground, which satisfies the Android 14+ start restriction, and it holds
  a `PARTIAL_WAKE_LOCK` while recording. The recorder engine moves out of the
  Activity-bound plugin into a singleton the service owns, so screen-off and
  app switching no longer silence or kill it. The microphone service type has
  no runtime limit on Android 15.
- `MediaCodec`/`MediaMuxer` is the standard "voice recorder" pipeline on
  Android; ~200 lines of Kotlin on one thread.

### D4. Hand the file to JS without base64 or a giant string

Replace `native_audio_read_and_delete`'s base64 return with chunked binary
reads: `native_audio_read_chunk(path, offset, len)` returning
`tauri::ipc::Response::new(bytes)`, which `invoke` resolves as an
`ArrayBuffer` (no JSON, no base64, no `atob`), then
`native_audio_delete(path)` once the Blob is saved. JS assembles
`new Blob(chunks, { type })` from 4 MB pieces; Chromium stores blob parts
lazily and pages large blobs to disk, so peak JS memory is one chunk. The
existing `validate_recording_path` check applies unchanged (extend the
allowed extensions with `.m4a`). Chunking matters on Android in particular,
where the IPC response body is handed to the WebView as an in-memory byte
array on the JVM side.

With D2 + D4 a three-hour Windows recording is ~130 MB moved in 4 MB pieces
instead of a 2 GB WAV that cannot be moved at all.

### D5. Do not silently lose an in-progress recording

- `RecordingManager.destroy()`: when a recording is active, **stop and save**
  instead of cancel. `NoteCanvas.destroy()` already returns a promise that
  `index.js` awaits before `syncOnNoteClose`, so the save can be included.
  Alternatively block navigation with a confirm; stop-and-save is the safer
  default.
- On plugin/app start, look for leftover `rec_*` / `noteberg_rec_*` files
  and delete them (an unfinalized MP4 is unplayable; recovering it would need
  `moov` reconstruction and is out of scope). With D3's foreground service,
  process death mid-recording becomes rare.

### D6. Cleanups enabled by the above

- Remove the unreachable browser recording path and Web Audio chain from
  `RecordingManager.js` and its "web" test groups; the manager becomes
  native-only and about half the size.
- Remove `register_audio_privacy()`; it exists for `getUserMedia`.
- Both meters report post-DSP peak; `SoundDialog` needs no change.
- Update `architecture_design.md` "Audio Recording" section.

## Implementation plan

Phase 1, fixes the certain breakages with the least new code:

1. Windows: ring buffer + worker thread (D2, first bullet). This alone
   removes the callback I/O and lock hazards behind most Windows artifacts.
2. Windows: Media Foundation AAC output, mono (D2). Removes F4.
3. Chunked binary IPC hand-off (D4), both platforms.
4. Android: foreground service + wake lock around the *existing*
   `MediaRecorder` (D3, service part only). Removes the background silencing
   without waiting for the pipeline rewrite.
5. Stop-and-save on note close (D5).

Phase 2, fixes level and artifact quality:

6. D1 DSP in Rust with unit tests; wire into the Windows worker thread.
7. Android `AudioRecord` + DSP + `MediaCodec`/`MediaMuxer` pipeline (D3),
   `VOICE_RECOGNITION` source.

Phase 3: D6 cleanups and the leftover-file sweep.

Every phase must be checked on Windows, Android and NC (playback of the new
`.m4a` files, sync via the chunked-upload path, backup/restore).

## Verification

- **DSP unit tests (Rust):** a -40 dBFS sine reaches -20 dBFS RMS within
  10 s and never overshoots; a 0 dBFS burst produces no sample above
  -1 dBFS; digital silence leaves the gain unchanged (no hiss boost); the
  sample-to-sample gain change never exceeds a small bound (no zipper); a
  1 s step from -40 to -10 dBFS produces no sample above the ceiling during
  the transition.
- **Level consistency across devices:** record the same sentence at the same
  distance on both Android devices and on Windows; `ffmpeg -af volumedetect`
  mean volumes must agree within ±3 dB.
- **Artifacts:** record 10 minutes while a sync and a large PDF import run;
  inspect for drop-outs; check the overrun counter logged at stop is zero.
- **Length:** 2-hour recording on Windows with the lid closed and on Android
  with the screen off and after switching apps; file plays in the note,
  shows the right duration, syncs (chunked upload), and plays in the NC web
  app in Chrome and Safari.
- **Teardown:** navigate away mid-recording; the recording must appear in
  the note's list.

## Regression risk

Summary: the Windows changes are low to moderate risk and self-contained.
The Android changes carry the real regression risk, less because of
permissions than because of the foreground service lifecycle and the Play
Store declaration.

### Android rights

- `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE` and `WAKE_LOCK` are
  normal permissions, granted at install without a prompt.
- `POST_NOTIFICATIONS` is a runtime prompt on Android 13+. If denied, the
  service still runs and only its notification is hidden. It can be omitted
  entirely if no new prompt is wanted.
- The microphone permission flow is unchanged. On Android 14+ the service
  must be started while the mic permission is already granted and the app
  is visible, otherwise the system throws
  (`SecurityException` / `ForegroundServiceStartNotAllowedException`).
  Starting it from the plugin's `start()` after the permission callback
  satisfies both.
- **Play Console.** Declaring a `microphone` foreground service type with
  targetSdk 34+ requires the "foreground service permissions" declaration
  form, including a short video of the recording feature. Voice recording is
  an accepted use case, but the release is blocked until the form is
  approved. This is the largest rights-related risk and is process, not code.
- Windows adds no rights. Removing `register_audio_privacy()` is optional and
  must be tested with the "Let desktop apps access your microphone" toggle
  off before shipping.

### Android execution

- **Service outliving the WebView** is a new failure mode. Android may
  destroy the Activity to reclaim memory while the service keeps recording.
  On return the page reloads and JS no longer knows a recording is active.
  Needs a `native_audio_status` command at startup that re-attaches to the
  running recording or stops and saves the orphan. Without it the recording
  is leaked rather than lost.
- **OEM battery killers** (Xiaomi, Huawei and similar) can still kill a
  foreground service. The service reduces this risk; it does not remove it.
  `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` is Play-policy restricted and should
  not be used.
- **Replacing `MediaRecorder`** with `AudioRecord` + `MediaCodec` +
  `MediaMuxer` is the highest-risk code change: pause timestamps, muxer
  finalisation and codec buffer handling are hand-written. Only 44.1 kHz
  `AudioRecord` capture is guaranteed on every device, so 48 kHz needs a
  fallback. Keep the current `MediaRecorder` path as an automatic fallback
  when initialisation fails, for at least one release.
- **JNI to the Rust DSP** fails with `UnsatisfiedLinkError` at record start
  if the symbol is missing. Guard it and fall back to the Kotlin port or to
  unprocessed audio. The `jni` and `rtrb` crates are pure Rust, so the
  pinned NDK 27 build is unaffected.

### Windows

- Media Foundation is new unsafe COM code, but it runs on the worker thread
  and falls back to WAV, which also covers N editions without the Media
  Feature Pack. `MFStartup` and COM initialisation are per thread/process
  and must happen on the worker.
- The ring buffer change removes hazards rather than adding them. The only
  behaviour change is that overruns are counted and logged.

### Cross-platform and data

- Windows switches from `audio/wav` to `audio/mp4`, the type Android already
  produces and NC already plays. Existing WAV recordings keep working; no
  migration.
- Stop-and-save on note close replaces the current cancel semantics. The
  test "cancels the native recording on destroy" in
  `RecordingManager.test.js` must be rewritten to the new design.
- The AGC can over-boost room noise if the noise-floor freeze is mistuned.
  The unit tests under Verification cover this; real-device listening is
  still required.
- Sync and backup are unaffected beyond files being much smaller.

### Ordering by risk

Do the Windows work and the chunked hand-off first: they fix certain
breakages with a small blast radius. Wrap the existing Android recorder in
the foreground service next. Replace the Android recorder pipeline last,
keeping the old one as fallback for one release.
## Open points

- Confirm the JNI hook-up of the Rust DSP from Kotlin in a short spike
  (symbol export from the Tauri cdylib, `System.loadLibrary` name); fall back
  to the Kotlin port otherwise.
- Confirm the exact failure the user saw on Android (silence after screen
  off vs. lost file vs. unplayable file) once a debug build with the service
  is available; F5 lists the candidate mechanisms.
- 96 kbps is the MF encoder's floor on Windows. If file size matters more
  than avoiding a C dependency, revisit Opus later; playback compatibility
  in the NC web app is the deciding factor.
