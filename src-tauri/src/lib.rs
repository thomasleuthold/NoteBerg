use std::sync::Mutex;
#[cfg(target_os = "windows")]
use std::sync::OnceLock;

#[cfg(target_os = "windows")]
mod mcp;

// Platform-independent (pure arithmetic, no I/O), so it builds and its unit
// tests run on every target — including Android, whose Kotlin AudioDsp port must
// stay behaviourally identical to it.
mod audio_dsp;
// Windows only: `hound` is a Windows-target dependency, and the encoders here
// are for the cpal capture path. Android encodes in Kotlin via MediaCodec and
// never reaches this module.
#[cfg(target_os = "windows")]
mod audio_encoder;
mod backup;

// ── Windows native audio recording ───────────────────────────────────────────
//
// cpal (WASAPI) capture → lock-free ring → worker thread → DSP → encoder.
// The capture callback only copies into the ring: no allocation, no locks and
// no file I/O run in the real-time context. Encoding is AAC/MP4 via Media
// Foundation, falling back to WAV where MF is unavailable.
// State is held in a global Mutex so the stateless Tauri commands can access it.

#[cfg(target_os = "windows")]
mod win_audio {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
    use std::sync::Arc;

    /// An f32 published as `f32::to_bits` so it can be read across threads
    /// without a lock. Used both for the meter's peak amplitude and for the
    /// live-adjustable auto-gain aggressiveness.
    pub struct AtomicF32(AtomicU32);

    impl AtomicF32 {
        fn new(v: f32) -> Self {
            Self(AtomicU32::new(v.to_bits()))
        }
        #[inline]
        pub fn store(&self, v: f32) {
            self.0.store(v.to_bits(), Ordering::Relaxed);
        }
        pub fn load(&self) -> f32 {
            f32::from_bits(self.0.load(Ordering::Relaxed))
        }
    }

    /// Register the calling thread with MMCSS ("Pro Audio") for real-time-ish
    /// scheduling, and return the handle that keeps the registration alive.
    ///
    /// Neither cpal's WASAPI capture thread nor a plain `std::thread` gets any
    /// scheduling priority boost on Windows — unlike Android, where the audio
    /// HAL runs the capture path at an elevated priority by default. Without
    /// this, a brief scheduling delay under system load (another process, a
    /// page fault, disk contention) can starve the audio thread past WASAPI's
    /// buffer deadline; the callback then silently drops samples (see the
    /// overrun counter below), which is heard as a click. MMCSS is the
    /// standard, documented fix real-time audio apps use for exactly this.
    ///
    /// Best-effort: every audio app already works without it on a healthy,
    /// idle system, so a failure here (missing service, restricted
    /// environment) is not fatal — it only gives up the extra scheduling
    /// headroom, logged once rather than failing the recording.
    fn register_mmcss() -> Option<windows::Win32::Foundation::HANDLE> {
        use windows::Win32::System::Threading::AvSetMmThreadCharacteristicsW;
        let mut task_index: u32 = 0;
        // SAFETY: `task_index` is a valid local `u32` the API writes back to;
        // the returned handle is later passed only to `AvRevertMmThreadCharacteristics`.
        let handle = unsafe { AvSetMmThreadCharacteristicsW(windows::core::w!("Pro Audio"), &mut task_index) };
        match handle {
            Ok(h) if !h.is_invalid() => Some(h),
            _ => {
                eprintln!("[WinAudio] MMCSS registration failed; continuing without it");
                None
            }
        }
    }

    /// RAII guard that reverts `register_mmcss` on drop, so every return path
    /// out of the worker closure (including an early `?` on encoder failure)
    /// releases the registration without needing to repeat the revert call.
    struct MmcssGuard(Option<windows::Win32::Foundation::HANDLE>);

    // SAFETY: the wrapped HANDLE is an opaque MMCSS registration token, never
    // dereferenced — only ever handed back to AvRevertMmThreadCharacteristics,
    // which is safe to call from any thread. Needed because HANDLE wraps a raw
    // pointer and is therefore !Send by default, but this one is moved into
    // the cpal capture closure, which must be Send.
    unsafe impl Send for MmcssGuard {}

    impl Drop for MmcssGuard {
        fn drop(&mut self) {
            if let Some(h) = self.0 {
                use windows::Win32::System::Threading::AvRevertMmThreadCharacteristics;
                // SAFETY: `h` was obtained from a matching, still-valid `AvSetMmThreadCharacteristicsW` call.
                let _ = unsafe { AvRevertMmThreadCharacteristics(h) };
            }
        }
    }

    pub struct RecordingState {
        pub stream: Option<cpal::Stream>,
        pub path: Option<PathBuf>,
        pub paused: Arc<AtomicBool>,
        /// Post-DSP peak, published by the worker so the meter means the same
        /// thing it does on Android (see F6).
        pub amplitude: Arc<AtomicF32>,
        /// Auto-gain aggressiveness (0.0-1.0), read by the worker at each DSP
        /// block boundary. Lets the frontend adjust the live slider without
        /// restarting capture.
        pub aggressiveness: Arc<AtomicF32>,
        /// Cleared to stop the worker once the stream is dropped and the ring
        /// has been drained.
        running: Arc<AtomicBool>,
        /// Count of callback invocations that could not push all their samples
        /// because the worker fell behind. Logged once at stop; a non-zero
        /// count means an overrun happened, though `lost_frames` (below) is
        /// what actually compensates for it.
        overruns: Arc<AtomicU32>,
        /// Set when the worker exits on an encoder error. Without it the worker
        /// dies quietly, the ring fills, and the user goes on "recording" into
        /// nothing until they press stop.
        pub worker_failed: Arc<AtomicBool>,
        worker: Option<std::thread::JoinHandle<Result<(), String>>>,
    }

    // Safety: cpal::Stream is not Send, but we only access it from the Tauri
    // command thread under the Mutex lock and never send it across threads.
    unsafe impl Send for RecordingState {}

    impl RecordingState {
        /// Stop capture and let the worker finish the file. Returns the number
        /// of dropped buffers so the caller can log it.
        pub fn finish(&mut self) -> Result<u32, String> {
            // Drop the stream first: no more pushes can occur afterwards, so the
            // worker's "stream stopped and ring empty" check is race-free.
            drop(self.stream.take());
            self.running.store(false, Ordering::Release);
            if let Some(handle) = self.worker.take() {
                handle
                    .join()
                    .map_err(|_| "Audio worker thread panicked".to_string())??;
            }
            Ok(self.overruns.load(Ordering::Relaxed))
        }
    }

    /// Capacity of the callback→worker ring, in samples: ~8 s of stereo 48 kHz.
    /// Sized generously so the worker can fall behind for several seconds
    /// under heavy system load (a large concurrent build, antivirus scan, disk
    /// contention) without losing capture data. 1 s previously proved too
    /// small: a build running in parallel starved the worker long enough that
    /// the ring filled and stayed full, dropping audio continuously — heard as
    /// both clicks and, because the lost samples silently shortened the
    /// stream relative to its wall-clock duration, an accelerated/shrunk
    /// recording (51 s reported, ~20 s of audio). See `lost_frames` on
    /// `RecordingState` for the backstop that keeps the timeline correct even
    /// if this still fills.
    const RING_CAPACITY: usize = 48_000 * 2 * 8;

    /// Samples the worker moves per wake-up. At 48 kHz stereo this is ~40 ms,
    /// large enough that the DSP call and the WAV writes amortise well.
    const WORKER_CHUNK: usize = 4096;

    pub fn start(aggressiveness: f32) -> Result<RecordingState, String> {
        let host = cpal::default_host();
        let device = host.default_input_device()
            .ok_or_else(|| "No audio input device found".to_string())?;
        let config = device.default_input_config()
            .map_err(|e| format!("Audio config error: {e}"))?;

        let sample_rate = config.sample_rate().0;
        let channels = config.channels();

        // Extensionless: create_encoder appends .m4a or .wav depending on
        // whether Media Foundation is available.
        let tmp_path = std::env::temp_dir().join(format!("noteberg_rec_{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()));

        let paused = Arc::new(AtomicBool::new(false));
        let amplitude = Arc::new(AtomicF32::new(0.0));
        let aggressiveness = Arc::new(AtomicF32::new(aggressiveness));
        let running = Arc::new(AtomicBool::new(true));
        let overruns = Arc::new(AtomicU32::new(0));
        // Frames (per-channel sample groups, not raw interleaved samples) the
        // callback could not push into the ring, accumulated since the worker
        // last drained it. Shared only between the callback and the worker —
        // the worker consumes it every iteration and inserts an equal span of
        // silence into the encoded stream, so a dropped span shortens what was
        // captured but never desyncs the timeline: encoder timestamps are
        // derived from samples written, and without this compensation a lost
        // span would silently shrink the file relative to its real elapsed
        // duration — heard as the whole recording being accelerated on
        // playback, not just a click at the drop point.
        let lost_frames = Arc::new(AtomicU64::new(0));
        let worker_failed = Arc::new(AtomicBool::new(false));

        let (mut producer, mut consumer) = rtrb::RingBuffer::<f32>::new(RING_CAPACITY);

        // ── Worker thread ────────────────────────────────────────────────────
        //
        // Owns the DSP state, the WAV writer and the post-DSP meter value.
        // Everything that can block — allocation, file I/O, locks — lives here
        // rather than in the real-time callback (F3).
        // The encoder is built on the worker thread, not here. Media Foundation
        // and COM are per-thread: `CoInitializeEx`/`MFStartup` must be matched
        // by `CoUninitialize`/`MFShutdown` on the same thread, and the runtime
        // guard is dropped wherever the encoder is dropped — which is the
        // worker. Creating it on the Tauri command thread (a tokio worker) and
        // dropping it here would leave an unbalanced STA refcount on a pooled
        // thread per recording.
        //
        // The path is only known after `create_encoder` has chosen AAC or WAV,
        // so it comes back over a channel and start() waits for it.
        let (path_tx, path_rx) = std::sync::mpsc::channel::<Result<PathBuf, String>>();

        let worker = {
            let running = Arc::clone(&running);
            let amplitude = Arc::clone(&amplitude);
            let aggressiveness_worker = Arc::clone(&aggressiveness);
            let paused_worker = Arc::clone(&paused);
            let worker_failed = Arc::clone(&worker_failed);
            let lost_frames_worker = Arc::clone(&lost_frames);
            let tmp_path = tmp_path.clone();
            std::thread::Builder::new()
                .name("noteberg-audio".into())
                .spawn(move || -> Result<(), String> {
                    // Held for the worker's lifetime; reverted on drop
                    // regardless of which return path is taken below.
                    let _mmcss_guard = MmcssGuard(register_mmcss());

                    // AAC/MP4 where Media Foundation is available, WAV otherwise.
                    let (mut encoder, out_path) =
                        match crate::audio_encoder::create_encoder(&tmp_path, sample_rate) {
                            Ok(v) => v,
                            Err(e) => {
                                // start() is waiting on this; report and stop.
                                let _ = path_tx.send(Err(e.clone()));
                                return Err(e);
                            }
                        };
                    if path_tx.send(Ok(out_path)).is_err() {
                        // start() gave up waiting; nothing will claim the file.
                        let _ = encoder.finish();
                        return Ok(());
                    }

                    // Any error below leaves the recording unusable; flag it so
                    // the meter poll can tell the UI rather than failing silently.
                    let mut mark_failed = |e: String| -> String {
                        worker_failed.store(true, Ordering::Release);
                        eprintln!("[WinAudio] worker stopped: {e}");
                        e
                    };

                    let mut dsp = crate::audio_dsp::DspState::new(sample_rate, aggressiveness_worker.load());
                    let mut interleaved: Vec<f32> = Vec::with_capacity(WORKER_CHUNK);
                    let mut mono: Vec<f32> = Vec::with_capacity(WORKER_CHUNK);
                    let mut pcm: Vec<i16> = Vec::with_capacity(WORKER_CHUNK);

                    // A pause is observed by the worker only after the last
                    // pre-pause audio has already been processed — the callback
                    // simply stops pushing, and the ring is usually empty by the
                    // time the flag is seen. Fading "the current chunk when
                    // paused" therefore almost never fires, and double-fades
                    // when the ring happens to hold more than one chunk.
                    //
                    // Instead the tail of every chunk is held back: `pending`
                    // keeps the last fade_len samples, which are either written
                    // unfaded once the next chunk proves the stream continued,
                    // or faded out and written when a pause or end of stream is
                    // observed. The fade then always lands on the real last
                    // samples before the gap.
                    let fade_len = dsp.fade_len();
                    let mut pending: Vec<f32> = Vec::with_capacity(fade_len);
                    let mut was_paused = false;

                    loop {
                        let available = consumer.slots();
                        if available == 0 {
                            // The stream is dropped before `running` is cleared, so
                            // once it is false no producer remains and an empty ring
                            // is empty for good.
                            if !running.load(Ordering::Acquire) {
                                break;
                            }
                            // Nothing queued and still recording: the only place a
                            // pause can be observed, since a paused callback pushes
                            // nothing.
                            if paused_worker.load(Ordering::Relaxed) && !was_paused {
                                was_paused = true;
                                // Flush the held-back tail with a fade, so the
                                // audio before the gap ends at silence.
                                if !pending.is_empty() {
                                    dsp.apply_fade_out(&mut pending);
                                    pcm.clear();
                                    pcm.extend(
                                        pending.iter().map(|s| (s * i16::MAX as f32) as i16),
                                    );
                                    encoder.write(&pcm).map_err(&mut mark_failed)?;
                                    pending.clear();
                                }
                            }
                            std::thread::sleep(std::time::Duration::from_millis(5));
                            continue;
                        }

                        // Read whole frames only, so the downmix never straddles
                        // a channel boundary between iterations.
                        let ch = channels.max(1) as usize;
                        let want = (available.min(WORKER_CHUNK) / ch) * ch;
                        if want == 0 {
                            std::thread::sleep(std::time::Duration::from_millis(5));
                            continue;
                        }

                        interleaved.clear();
                        match consumer.read_chunk(want) {
                            Ok(chunk) => {
                                let (a, b) = chunk.as_slices();
                                interleaved.extend_from_slice(a);
                                interleaved.extend_from_slice(b);
                                chunk.commit_all();
                            }
                            Err(_) => continue,
                        }

                        if was_paused {
                            dsp.begin_fade_in();
                            was_paused = false;
                        }

                        // A ring-buffer overrun since the last iteration means
                        // the callback had to drop that many captured frames —
                        // this span of real time was never recorded. Compensate
                        // with an equal span of silence, run through the same
                        // DSP → pending → encoder path as real audio, so the
                        // encoded timeline keeps matching wall-clock time. Without
                        // this the file simply gets shorter than it should be,
                        // which on playback sounds like the recording sped up
                        // (fewer encoded samples than the elapsed real time).
                        let lost = lost_frames_worker.swap(0, Ordering::AcqRel);
                        if lost > 0 {
                            let mut silence = vec![0.0f32; lost as usize];
                            crate::audio_dsp::process(&mut silence, &mut dsp);

                            pcm.clear();
                            pcm.extend(pending.drain(..).map(|s| (s * i16::MAX as f32) as i16));
                            let keep = fade_len.min(silence.len());
                            let split = silence.len() - keep;
                            pcm.extend(silence[..split].iter().map(|s| (s * i16::MAX as f32) as i16));
                            pending.extend_from_slice(&silence[split..]);
                            encoder.write(&pcm).map_err(&mut mark_failed)?;

                            // The peak meter should reflect the gap rather than
                            // hold the last real value, so a silent stretch
                            // under load is visible on the meter too.
                            amplitude.store(0.0);
                        }

                        // Cheap relaxed read every chunk (~40 ms), so a live
                        // slider change takes effect within one chunk.
                        dsp.set_aggressiveness(aggressiveness_worker.load());

                        crate::audio_dsp::downmix_to_mono(&interleaved, channels, &mut mono);
                        let peak = crate::audio_dsp::process(&mut mono, &mut dsp);
                        amplitude.store(peak);

                        // The stream continued, so the previously held-back tail
                        // was not the last audio before a gap: write it as-is,
                        // ahead of this chunk.
                        pcm.clear();
                        pcm.extend(pending.drain(..).map(|s| (s * i16::MAX as f32) as i16));

                        // Hold back this chunk's own tail for the same reason.
                        let keep = fade_len.min(mono.len());
                        let split = mono.len() - keep;
                        pcm.extend(mono[..split].iter().map(|s| (s * i16::MAX as f32) as i16));
                        pending.extend_from_slice(&mono[split..]);

                        encoder.write(&pcm).map_err(&mut mark_failed)?;
                    }

                    // End of stream: the held-back tail really is the last audio,
                    // so fade it rather than dropping it.
                    if !pending.is_empty() {
                        dsp.apply_fade_out(&mut pending);
                        pcm.clear();
                        pcm.extend(pending.iter().map(|s| (s * i16::MAX as f32) as i16));
                        encoder.write(&pcm).map_err(&mut mark_failed)?;
                    }

                    encoder.finish().map_err(&mut mark_failed)?;
                    Ok(())
                })
                .map_err(|e| format!("Failed to spawn audio worker: {e}"))?
        };

        // Wait for the worker to report which container it opened. A failure
        // here means no file exists, so there is nothing to clean up beyond
        // joining the thread that already returned.
        let out_path = match path_rx.recv() {
            Ok(Ok(p)) => p,
            Ok(Err(e)) => {
                running.store(false, Ordering::Release);
                let _ = worker.join();
                return Err(e);
            }
            Err(_) => {
                running.store(false, Ordering::Release);
                let _ = worker.join();
                return Err("Audio worker stopped before opening the output file".into());
            }
        };

        /// Stop the worker and delete the partial file. Used on every failure
        /// path after the worker exists: returning without this leaves the
        /// thread looping on 5 ms sleeps forever, holding the output file open.
        macro_rules! abort_worker {
            ($running:expr, $worker:expr, $path:expr) => {{
                $running.store(false, Ordering::Release);
                let _ = $worker.join();
                let _ = std::fs::remove_file(&$path);
            }};
        }

        // ── Capture callback ─────────────────────────────────────────────────
        //
        // Real-time context: no allocation, no locks, no I/O. Converts to f32,
        // pushes into the ring, publishes the raw input peak only as a fallback
        // for the window before the worker's first post-DSP value.
        macro_rules! build_stream {
            ($sample:ty, $to_f32:expr) => {{
                let paused = Arc::clone(&paused);
                let overruns = Arc::clone(&overruns);
                let lost_frames = Arc::clone(&lost_frames);
                let ch = channels.max(1) as usize;
                // Registered on the callback's own first invocation, not here:
                // cpal owns and spawns the thread this closure runs on, so it
                // does not exist yet at build_input_stream() time. Held in this
                // cell for that thread's lifetime, i.e. the whole recording —
                // dropping the stream (which owns this closure) reverts it.
                // The one syscall this costs runs only on the first callback,
                // never a real-time cost afterwards.
                let mmcss_guard: std::cell::RefCell<Option<MmcssGuard>> =
                    std::cell::RefCell::new(None);
                device.build_input_stream(
                    &config.into(),
                    move |data: &[$sample], _: &cpal::InputCallbackInfo| {
                        {
                            let mut guard = mmcss_guard.borrow_mut();
                            if guard.is_none() {
                                *guard = Some(MmcssGuard(register_mmcss()));
                            }
                        }
                        if paused.load(Ordering::Relaxed) {
                            return;
                        }
                        let conv = $to_f32;
                        // Ask only for what fits: a short write is an overrun,
                        // but it still keeps the audio that did fit.
                        let want = data.len().min(producer.slots());
                        let written = match producer.write_chunk_uninit(want) {
                            Ok(chunk) => chunk.fill_from_iter(data.iter().map(|&s| conv(s))),
                            Err(_) => 0,
                        };
                        if written < data.len() {
                            overruns.fetch_add(1, Ordering::Relaxed);
                            // Rounds down: a partial trailing frame lost here is
                            // rare (it would need an overrun to land exactly
                            // mid-frame) and is not worth the complexity of
                            // carrying a fractional frame across callbacks.
                            let lost = (data.len() - written) / ch;
                            lost_frames.fetch_add(lost as u64, Ordering::Relaxed);
                        }
                    },
                    |e| eprintln!("[WinAudio] stream error: {e}"),
                    None,
                )
                .map_err(|e| format!("Stream build error: {e}"))
            }};
        }

        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => build_stream!(f32, |s: f32| s),
            cpal::SampleFormat::I16 => {
                build_stream!(i16, |s: i16| s as f32 / i16::MAX as f32)
            }
            cpal::SampleFormat::U16 => {
                build_stream!(u16, |s: u16| (s as f32 - 32768.0) / 32768.0)
            }
            other => Err(format!("Unsupported input sample format: {other:?}")),
        };
        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                abort_worker!(running, worker, out_path);
                return Err(e);
            }
        };

        if let Err(e) = stream.play() {
            // Drop the stream before joining: the worker waits for the ring to
            // drain, and a live stream could still be pushing into it.
            drop(stream);
            abort_worker!(running, worker, out_path);
            return Err(format!("Stream play error: {e}"));
        }

        Ok(RecordingState {
            stream: Some(stream),
            path: Some(out_path),
            paused,
            amplitude,
            aggressiveness,
            running,
            overruns,
            worker_failed,
            worker: Some(worker),
        })
    }
}

/// State holding the sidecar recognition URL (empty if not available)
struct RecognitionState {
    url: String,
}

/// Tauri command: returns the local sidecar recognition URL (or empty string)
#[tauri::command]
fn get_recognition_url(state: tauri::State<Mutex<RecognitionState>>) -> String {
    state.lock().unwrap().url.clone()
}

/// Tauri command: show a native Save dialog and write bytes to the chosen path.
/// Returns the path that was written, or an empty string if the user cancelled.
/// Only available on desktop (Windows, macOS, Linux) — not on Android/iOS.
#[tauri::command]
#[cfg(not(target_os = "android"))]
async fn save_pdf(bytes: Vec<u8>, suggested_name: String) -> Result<String, String> {
    let path = rfd::AsyncFileDialog::new()
        .set_file_name(&suggested_name)
        .add_filter("PDF", &["pdf"])
        .save_file()
        .await;

    match path {
        Some(handle) => {
            let path_str = handle.path().to_string_lossy().to_string();
            std::fs::write(handle.path(), &bytes)
                .map_err(|e| format!("Failed to write file: {}", e))?;
            Ok(path_str)
        }
        None => Ok(String::new()), // user cancelled
    }
}

// ── Android PDF plugin ────────────────────────────────────────────────────────
//
// The Android plugin chain for opening a PDF from private app storage:
//   1. Rust `save_pdf` command: write bytes to app cache dir
//   2. Rust calls Kotlin `PdfSavePlugin.openCachedPdf` via the plugin handle
//   3. Kotlin: FileProvider.getUriForFile() → content:// URI
//   4. Kotlin: Intent(ACTION_VIEW) with FLAG_GRANT_READ_URI_PERMISSION → system PDF viewer
//
// Why not use tauri-plugin-opener's openPath/openUrl from JS or Rust:
//   - open_path from JS: Jackson deserializes the string arg as OpenArgs object → error
//   - open_path from Rust: passes plain string to Android, same Jackson error
//   - open_url with file://: Android 7+ throws FileUriExposedException
//   - open_url with content://: FileProvider URI requires our package as authority,
//     and the opener plugin doesn't grant FLAG_GRANT_READ_URI_PERMISSION

#[cfg(target_os = "android")]
struct PdfSavePlugin(tauri::plugin::PluginHandle<tauri::Wry>);

/// Register our Kotlin PdfSavePlugin as a Tauri plugin so we can call it from Rust.
#[cfg(target_os = "android")]
fn pdf_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry>::new("pdf-save")
        .setup(|app, api| {
            use tauri::Manager;
            let handle = api.register_android_plugin("eu.noteberg.app", "PdfSavePlugin")?;
            app.manage(PdfSavePlugin(handle));
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
pub struct AudioRecorderPlugin(tauri::plugin::PluginHandle<tauri::Wry>);

/// Register the native AudioRecorderPlugin (bypasses WebView getUserMedia).
#[cfg(target_os = "android")]
fn audio_recorder_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry>::new("audio-recorder")
        .setup(|app, api| {
            use tauri::Manager;
            let handle = api.register_android_plugin("eu.noteberg.app", "AudioRecorderPlugin")?;
            app.manage(AudioRecorderPlugin(handle));
            Ok(())
        })
        .build()
}

// ── Android status bar appearance ────────────────────────────────────────────
//
// enableEdgeToEdge() (MainActivity) draws the WebView behind the Android status
// bar, so the bar's icon color is the only thing distinguishing it from the app
// background. The app's light/dark theme is a JS-side toggle independent of the
// OS theme, so native code has no way to know which one is active unless told —
// without this, switching the in-app theme leaves status bar icons the wrong
// color against the new background (e.g. white icons on a white background).

#[cfg(target_os = "android")]
struct StatusBarPlugin(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
fn status_bar_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry>::new("status-bar")
        .setup(|app, api| {
            use tauri::Manager;
            let handle = api.register_android_plugin("eu.noteberg.app", "StatusBarPlugin")?;
            app.manage(StatusBarPlugin(handle));
            Ok(())
        })
        .build()
}

/// Set the Android status bar icon appearance. `light: true` gives dark icons
/// (for a light app background), `false` gives light icons (for a dark background).
#[tauri::command]
#[cfg(target_os = "android")]
async fn set_status_bar_appearance(app: tauri::AppHandle, light: bool) -> Result<(), String> {
    use tauri::Manager;
    app.state::<StatusBarPlugin>()
        .0
        .run_mobile_plugin::<()>("setAppearance", serde_json::json!({ "light": light }))
        .map_err(|e| format!("set_status_bar_appearance: {}", e))
}
#[tauri::command]
#[cfg(not(target_os = "android"))]
async fn set_status_bar_appearance(_light: bool) -> Result<(), String> {
    Ok(())
}

/// System bar insets (status bar, navigation bar, display cutout) in CSS px (dp).
/// Fed to JS as a fallback for `env(safe-area-inset-*)`, which was observed to
/// report 0 on some Android system images (e.g. emulator images) even though the
/// WebView is drawn edge-to-edge there — see StatusBarPlugin.kt `getInsets`.
#[derive(serde::Serialize, serde::Deserialize)]
struct SafeAreaInsets {
    top: f64,
    bottom: f64,
    left: f64,
    right: f64,
}

#[tauri::command]
#[cfg(target_os = "android")]
async fn get_safe_area_insets(app: tauri::AppHandle) -> Result<SafeAreaInsets, String> {
    use tauri::Manager;
    app.state::<StatusBarPlugin>()
        .0
        .run_mobile_plugin::<SafeAreaInsets>("getInsets", serde_json::json!({}))
        .map_err(|e| format!("get_safe_area_insets: {}", e))
}
#[tauri::command]
#[cfg(not(target_os = "android"))]
async fn get_safe_area_insets() -> Result<SafeAreaInsets, String> {
    Ok(SafeAreaInsets { top: 0.0, bottom: 0.0, left: 0.0, right: 0.0 })
}

// ── Global recording state (Windows) ─────────────────────────────────────────
#[cfg(target_os = "windows")]
static WIN_RECORDING: OnceLock<Mutex<Option<win_audio::RecordingState>>> = OnceLock::new();

#[cfg(target_os = "windows")]
fn win_recording() -> &'static Mutex<Option<win_audio::RecordingState>> {
    WIN_RECORDING.get_or_init(|| Mutex::new(None))
}

/// Start native audio recording.
/// Returns which capture pipeline started, so the JS layer can log it. On a
/// device without a USB cable logcat is unreachable, and a recording made by
/// the MediaRecorder fallback is indistinguishable from one made by the
/// AudioRecord engine.
#[tauri::command]
#[cfg(target_os = "android")]
async fn native_audio_start(app: tauri::AppHandle, aggressiveness: f32) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    app.state::<AudioRecorderPlugin>()
        .0
        .run_mobile_plugin::<serde_json::Value>("start", serde_json::json!({ "aggressiveness": aggressiveness }))
        .map_err(|e| format!("native_audio_start: {}", e))
}
#[tauri::command]
#[cfg(target_os = "windows")]
async fn native_audio_start(aggressiveness: f32) -> Result<serde_json::Value, String> {
    // Replacing a live recording would drop its RecordingState without joining
    // the worker, leaking the thread and the open output file.
    if win_recording().lock().unwrap().is_some() {
        return Err("A recording is already in progress".into());
    }
    let state = win_audio::start(aggressiveness)?;
    // The encoder picks AAC or falls back to WAV; the extension says which.
    let pipeline = match state.path.as_ref().and_then(|p| p.extension()).and_then(|e| e.to_str()) {
        Some("m4a") => "windowsAac",
        _ => "windowsWav",
    };
    *win_recording().lock().unwrap() = Some(state);
    Ok(serde_json::json!({ "pipeline": pipeline }))
}
#[tauri::command]
#[cfg(not(any(target_os = "android", target_os = "windows")))]
async fn native_audio_start(_aggressiveness: f32) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "pipeline": "none" }))
}

/// Live-update the auto-gain aggressiveness (0.0-1.0) of the recording in
/// progress, without stopping and restarting capture. No-op if nothing is
/// recording — the frontend's slider only exists while the active-recording
/// strip is shown.
#[tauri::command]
#[cfg(target_os = "android")]
async fn native_audio_set_aggressiveness(app: tauri::AppHandle, aggressiveness: f32) -> Result<(), String> {
    use tauri::Manager;
    app.state::<AudioRecorderPlugin>()
        .0
        .run_mobile_plugin::<()>("setAggressiveness", serde_json::json!({ "aggressiveness": aggressiveness }))
        .map_err(|e| format!("native_audio_set_aggressiveness: {}", e))
}
#[tauri::command]
#[cfg(target_os = "windows")]
async fn native_audio_set_aggressiveness(aggressiveness: f32) -> Result<(), String> {
    if let Some(state) = win_recording().lock().unwrap().as_ref() {
        state.aggressiveness.store(aggressiveness);
    }
    Ok(())
}
#[tauri::command]
#[cfg(not(any(target_os = "android", target_os = "windows")))]
async fn native_audio_set_aggressiveness(_aggressiveness: f32) -> Result<(), String> {
    Ok(())
}

/// Stop native audio recording and return { path, mimeType }.
#[tauri::command]
#[cfg(target_os = "android")]
async fn native_audio_stop(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    app.state::<AudioRecorderPlugin>()
        .0
        .run_mobile_plugin::<serde_json::Value>("stop", serde_json::json!({}))
        .map_err(|e| format!("native_audio_stop: {}", e))
}
#[tauri::command]
#[cfg(target_os = "windows")]
async fn native_audio_stop() -> Result<serde_json::Value, String> {
    let mut guard = win_recording().lock().unwrap();
    let mut state = guard.take().ok_or("Not recording")?;
    // Stops capture, drains the ring and finalizes the WAV on the worker thread.
    let overruns = state.finish()?;
    if overruns > 0 {
        // Audio was lost: the worker could not keep up with the capture callback.
        // Surfaced here because cpal swallows WASAPI's discontinuity flag, which
        // is what made the old in-callback drops invisible (F3).
        eprintln!("[WinAudio] {overruns} buffer(s) dropped during recording");
    }
    let path = state.path.take().ok_or("No recording path")?;
    // The encoder chose the extension (AAC/MP4 normally, WAV where Media
    // Foundation is unavailable), so it is the authority on the type.
    let mime_type = match path.extension().and_then(|e| e.to_str()) {
        Some("m4a") => "audio/mp4",
        _ => "audio/wav",
    };
    let path_str = path.to_string_lossy().to_string();
    Ok(serde_json::json!({ "path": path_str, "mimeType": mime_type }))
}
#[tauri::command]
#[cfg(not(any(target_os = "android", target_os = "windows")))]
async fn native_audio_stop() -> Result<serde_json::Value, String> { Err("not supported".into()) }

/// Validate that `path` points at a recording file we created: a flat file
/// inside an allowed directory (the OS temp dir, or on Android the app cache
/// dir) whose name matches our recording naming. Rejects path traversal and
/// arbitrary reads — without this the command would read/delete any file the
/// user can access (see security review).
fn validate_recording_path(
    path: &str,
    allowed_dirs: &[std::path::PathBuf],
) -> Result<std::path::PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("Invalid recording path: {}", e))?;

    let name = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Recording path has no file name".to_string())?;
    let name_ok = (name.starts_with("noteberg_rec_") || name.starts_with("rec_"))
        && (name.ends_with(".wav") || name.ends_with(".mp4") || name.ends_with(".m4a"));
    if !name_ok {
        return Err("Refusing to read non-recording file".to_string());
    }

    let parent = canonical
        .parent()
        .ok_or_else(|| "Recording path has no parent directory".to_string())?;
    let in_allowed = allowed_dirs.iter().any(|dir| {
        std::fs::canonicalize(dir).map(|d| parent == d).unwrap_or(false)
    });
    if !in_allowed {
        return Err("Recording file is outside the allowed directory".to_string());
    }

    Ok(canonical)
}

/// Delete recording temp files left behind by an earlier run.
///
/// A recording whose app was killed mid-write leaves a file nothing will ever
/// claim: an unfinalized MP4 has no `moov` index and is unplayable, so there is
/// nothing to recover. Runs once at startup, best-effort.
///
/// The prefix accepted depends on the directory, and this matters:
/// `noteberg_rec_` is ours and unambiguous, but the Android recorder names its
/// files `rec_`, which is generic. The OS temp dir is shared with every other
/// program on the machine, so matching `rec_` there would delete other
/// applications' files. `rec_` is therefore only swept in the app-private cache
/// dir, where nothing else writes.
fn sweep_orphaned_recordings(dirs: &[(std::path::PathBuf, bool)]) -> usize {
    let mut removed = 0;
    for (dir, is_app_private) in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
            let prefix_ok = name.starts_with("noteberg_rec_")
                || (*is_app_private && name.starts_with("rec_"));
            let is_recording = prefix_ok
                && (name.ends_with(".wav") || name.ends_with(".mp4") || name.ends_with(".m4a"));
            if is_recording && std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/// Resolve the directories a recording file is allowed to live in: the OS temp
/// dir, plus the app cache dir on Android.
#[allow(unused_variables)]
fn recording_allowed_dirs(app: &tauri::AppHandle) -> Vec<std::path::PathBuf> {
    #[allow(unused_mut)]
    let mut dirs = vec![std::env::temp_dir()];
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        if let Ok(cache_dir) = app.path().app_cache_dir() {
            dirs.push(cache_dir);
        }
    }
    dirs
}

/// Size in bytes of a finished recording, so JS knows how many chunks to read.
#[tauri::command]
async fn native_audio_file_size(app: tauri::AppHandle, path: String) -> Result<u64, String> {
    let safe_path = validate_recording_path(&path, &recording_allowed_dirs(&app))?;
    let meta = std::fs::metadata(&safe_path)
        .map_err(|e| format!("Failed to stat recording file: {}", e))?;
    Ok(meta.len())
}

/// Read one slice of a recording file as raw bytes.
///
/// Returns `tauri::ipc::Response`, which `invoke` resolves as an ArrayBuffer:
/// no JSON encoding, no base64, no `atob` on the main thread. The previous
/// base64 command hit V8's 2^29-character string cap at a ~403 MB file (~35 min
/// of 48 kHz stereo WAV) and cost 5-6x the file size in transient memory well
/// before that (F4).
#[tauri::command]
async fn native_audio_read_chunk(
    app: tauri::AppHandle,
    path: String,
    offset: u64,
    len: usize,
) -> Result<tauri::ipc::Response, String> {
    use std::io::{Read, Seek, SeekFrom};

    // Bound the allocation a single call can request regardless of what JS asks
    // for. JS reads in 4 MB pieces; this is headroom, not the expected size.
    const MAX_CHUNK: usize = 16 * 1024 * 1024;
    if len > MAX_CHUNK {
        return Err(format!("Chunk length {len} exceeds the {MAX_CHUNK} byte limit"));
    }

    let safe_path = validate_recording_path(&path, &recording_allowed_dirs(&app))?;

    let mut file = std::fs::File::open(&safe_path)
        .map_err(|e| format!("Failed to open recording file: {}", e))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("Failed to seek recording file: {}", e))?;

    let mut buf = vec![0u8; len];
    let mut filled = 0;
    // A short read is not EOF: loop until the buffer is full or the file ends.
    while filled < len {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("Failed to read recording file: {}", e)),
        }
    }
    buf.truncate(filled);

    Ok(tauri::ipc::Response::new(buf))
}

/// Delete a recording temp file once its bytes are safely stored.
///
/// Split from the read (the old command did both) so a failure to store the
/// blob leaves the file on disk instead of destroying the only copy.
/// Save a copy of a recording temp file wherever the user chooses.
///
/// The rescue path for a recording that could not be stored in the app
/// (recordingRecovery.js): its temp file is otherwise the only copy, and the
/// startup sweep deletes it. Returns where it was saved, or null if the user
/// cancelled the picker. Leaves the temp file in place; JS deletes it after a
/// successful export.
#[tauri::command]
async fn native_audio_export(
    app: tauri::AppHandle,
    path: String,
    suggested_name: String,
    mime_type: String,
) -> Result<Option<String>, String> {
    let safe_path = validate_recording_path(&path, &recording_allowed_dirs(&app))?;
    backup::export_file(&app, &safe_path, suggested_name, &mime_type).await
}

#[tauri::command]
async fn native_audio_delete(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let safe_path = validate_recording_path(&path, &recording_allowed_dirs(&app))?;
    std::fs::remove_file(&safe_path)
        .map_err(|e| format!("Failed to delete recording file: {}", e))
}

/// Get current recording amplitude 0.0–1.0.
#[tauri::command]
#[cfg(target_os = "android")]
async fn native_audio_get_amplitude(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    app.state::<AudioRecorderPlugin>()
        .0
        .run_mobile_plugin::<serde_json::Value>("getAmplitude", serde_json::json!({}))
        .map_err(|e| format!("native_audio_get_amplitude: {}", e))
}
#[tauri::command]
#[cfg(target_os = "windows")]
async fn native_audio_get_amplitude() -> Result<serde_json::Value, String> {
    let guard = win_recording().lock().unwrap();
    let amplitude = guard.as_ref()
        .map(|s| s.amplitude.load())
        .unwrap_or(0.0);
    // Reported on the poll JS already makes every 100 ms, so a worker that died
    // mid-recording is visible immediately instead of at stop.
    let failed = guard
        .as_ref()
        .map(|s| s.worker_failed.load(std::sync::atomic::Ordering::Acquire))
        .unwrap_or(false);
    Ok(serde_json::json!({ "amplitude": amplitude, "failed": failed }))
}
#[tauri::command]
#[cfg(not(any(target_os = "android", target_os = "windows")))]
async fn native_audio_get_amplitude() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "amplitude": 0.0 }))
}

/// Pause native audio recording.
#[tauri::command]
#[cfg(target_os = "android")]
async fn native_audio_pause(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    app.state::<AudioRecorderPlugin>()
        .0
        .run_mobile_plugin::<()>("pause", serde_json::json!({}))
        .map_err(|e| format!("native_audio_pause: {}", e))
}
#[tauri::command]
#[cfg(target_os = "windows")]
async fn native_audio_pause() -> Result<(), String> {
    let guard = win_recording().lock().unwrap();
    if let Some(s) = guard.as_ref() {
        s.paused.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}
#[tauri::command]
#[cfg(not(any(target_os = "android", target_os = "windows")))]
async fn native_audio_pause() -> Result<(), String> { Ok(()) }

/// Resume native audio recording.
#[tauri::command]
#[cfg(target_os = "android")]
async fn native_audio_resume(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    app.state::<AudioRecorderPlugin>()
        .0
        .run_mobile_plugin::<()>("resume", serde_json::json!({}))
        .map_err(|e| format!("native_audio_resume: {}", e))
}
#[tauri::command]
#[cfg(target_os = "windows")]
async fn native_audio_resume() -> Result<(), String> {
    let guard = win_recording().lock().unwrap();
    if let Some(s) = guard.as_ref() {
        s.paused.store(false, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}
#[tauri::command]
#[cfg(not(any(target_os = "android", target_os = "windows")))]
async fn native_audio_resume() -> Result<(), String> { Ok(()) }

/// Cancel native audio recording (discard result).
#[tauri::command]
#[cfg(target_os = "android")]
async fn native_audio_cancel(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    app.state::<AudioRecorderPlugin>()
        .0
        .run_mobile_plugin::<()>("cancel", serde_json::json!({}))
        .map_err(|e| format!("native_audio_cancel: {}", e))
}
#[tauri::command]
#[cfg(target_os = "windows")]
async fn native_audio_cancel() -> Result<(), String> {
    let mut guard = win_recording().lock().unwrap();
    if let Some(mut state) = guard.take() {
        // Join the worker before deleting: it still holds the WAV writer, and on
        // Windows the open handle would make the remove fail.
        let _ = state.finish();
        if let Some(path) = state.path.take() { let _ = std::fs::remove_file(path); }
    }
    Ok(())
}
#[tauri::command]
#[cfg(not(any(target_os = "android", target_os = "windows")))]
async fn native_audio_cancel() -> Result<(), String> { Ok(()) }


/// Android: write PDF to app cache dir, then open via PdfSavePlugin (FileProvider + ACTION_VIEW).
#[tauri::command]
#[cfg(target_os = "android")]
async fn save_pdf(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    suggested_name: String,
) -> Result<String, String> {
    use tauri::Manager;

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Cannot resolve cache dir: {}", e))?;
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Cannot create cache dir: {}", e))?;
    let file_path = cache_dir.join(&suggested_name);
    std::fs::write(&file_path, &bytes)
        .map_err(|e| format!("Failed to write PDF: {}", e))?;

    let path_str = file_path.to_string_lossy().to_string();

    app.state::<PdfSavePlugin>()
        .0
        .run_mobile_plugin::<()>("openCachedPdf", serde_json::json!({ "path": path_str }))
        .map_err(|e| format!("Failed to open PDF: {}", e))?;

    Ok(path_str)
}

// ── Desktop secure credential storage (via OS keychain) ──────────────────────
//
// All desktop platforms use the keyring crate for fast, native credential
// storage (Windows Credential Manager, macOS/iOS Keychain, Linux Secret Service).
// This replaces tauri-plugin-stronghold which was too slow due to vault file I/O.
//
// On Linux, if no Secret Service daemon is available, credentials are stored in
// an encrypted file using a machine-specific key (derived from machine UUID).

const KEYRING_SERVICE: &str = "eu.noteberg.app";

#[cfg(not(target_os = "android"))]
fn keyring_entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, key)
        .map_err(|e| format!("keyring entry: {e}"))
}

#[tauri::command]
#[cfg(not(target_os = "android"))]
fn save_credential(key: String, value: String) -> Result<(), String> {
    let entry = keyring_entry(&key)?;
    entry.set_secret(value.as_bytes())
        .map_err(|e| format!("keyring write: {e}"))
}

#[tauri::command]
#[cfg(not(target_os = "android"))]
fn get_credential(key: String) -> Result<Option<String>, String> {
    let entry = keyring_entry(&key)?;
    match entry.get_secret() {
        Ok(bytes) => {
            let s = String::from_utf8(bytes)
                .map_err(|e| format!("keyring decode: {e}"))?;
            Ok(Some(s))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read: {e}")),
    }
}

#[tauri::command]
#[cfg(not(target_os = "android"))]
fn delete_credential(key: String) -> Result<(), String> {
    let entry = keyring_entry(&key)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // already gone — not an error
        Err(e) => Err(format!("keyring delete: {e}")),
    }
}


// ── Android secure credential plugin ─────────────────────────────────────────
//
// On Android, tauri-plugin-stronghold cannot be compiled from Windows (requires
// libsodium C cross-compilation). Instead, the Kotlin DeviceKeyPlugin handles
// all credential storage directly using Android Keystore-backed AES-256-GCM
// encryption, storing ciphertext in SharedPreferences.
//
// The JS secureStorage.js calls save_credential / get_credential / delete_credential
// on both platforms; on Android these route through DeviceKeyPlugin.

#[cfg(target_os = "android")]
struct DeviceKeyPlugin(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
fn device_key_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry>::new("device-key")
        .setup(|app, api| {
            use tauri::Manager;
            let handle = api.register_android_plugin("eu.noteberg.app", "DeviceKeyPlugin")?;
            app.manage(DeviceKeyPlugin(handle));
            Ok(())
        })
        .build()
}

#[tauri::command]
#[cfg(target_os = "android")]
async fn save_credential(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    use tauri::Manager;
    app.state::<DeviceKeyPlugin>()
        .0
        .run_mobile_plugin::<()>("saveCredential", serde_json::json!({ "key": key, "value": value }))
        .map_err(|e| format!("DeviceKeyPlugin.saveCredential: {e}"))
}
#[tauri::command]
#[cfg(target_os = "android")]
async fn get_credential(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    use tauri::Manager;
    #[derive(serde::Deserialize)]
    struct GetResult { #[serde(default)] value: Option<String> }
    let result = app.state::<DeviceKeyPlugin>()
        .0
        .run_mobile_plugin::<GetResult>("getCredential", serde_json::json!({ "key": key }))
        .map_err(|e| format!("DeviceKeyPlugin.getCredential: {e}"))?;
    Ok(result.value)
}
#[tauri::command]
#[cfg(target_os = "android")]
async fn delete_credential(app: tauri::AppHandle, key: String) -> Result<(), String> {
    use tauri::Manager;
    app.state::<DeviceKeyPlugin>()
        .0
        .run_mobile_plugin::<()>("deleteCredential", serde_json::json!({ "key": key }))
        .map_err(|e| format!("DeviceKeyPlugin.deleteCredential: {e}"))
}

/// Guard so we only call grant_media_permissions once per app lifetime.
#[cfg(target_os = "windows")]
static PERMISSIONS_GRANTED: OnceLock<()> = OnceLock::new();

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(RecognitionState {
            url: String::new(),
        }))
        .manage(backup::SharedState::default())
        .invoke_handler(tauri::generate_handler![
            get_recognition_url,
            backup::backup_choose_destination,
            backup::backup_begin,
            backup::backup_add_text,
            backup::backup_begin_entry,
            backup::backup_write_chunk,
            backup::backup_finish,
            backup::backup_abort,
            backup::backup_free_space,
            backup::restore_choose_source,
            backup::restore_open,
            backup::restore_unlock,
            backup::restore_read_text,
            backup::restore_read_begin,
            backup::restore_read_chunk,
            backup::restore_read_end,
            backup::restore_close,
            save_credential,
            get_credential,
            delete_credential,
            save_pdf,
            native_audio_start,
            native_audio_stop,
            native_audio_file_size,
            native_audio_read_chunk,
            native_audio_delete,
            native_audio_export,
            native_audio_get_amplitude,
            native_audio_pause,
            native_audio_resume,
            native_audio_cancel,
            native_audio_set_aggressiveness,
            set_status_bar_appearance,
            get_safe_area_insets,
            #[cfg(target_os = "windows")]
            mcp::mcp_respond,
            #[cfg(target_os = "windows")]
            mcp::mcp_set_config,
            #[cfg(target_os = "windows")]
            mcp::mcp_get_status,
        ]);

    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(pdf_plugin());
        builder = builder.plugin(audio_recorder_plugin());
        builder = builder.plugin(device_key_plugin());
        builder = builder.plugin(status_bar_plugin());
        builder = builder.plugin(backup::android_plugin());
    }

    builder
        .setup(|_app| {
            #[cfg(target_os = "windows")]
            {
                // register_audio_privacy() used to run here, writing microphone
                // consent registry keys for the WebView2 renderer on every start.
                // It existed so getUserMedia could find a device; Windows now
                // records through cpal/WASAPI in-process, which needs no
                // ConsentStore entry.
                spawn_recognition_sidecar(_app)?;
                mcp::start(_app);
            }
            // Clear temp files from a run that was killed mid-recording. The
            // OS temp dir is shared, the Android cache dir is app-private; the
            // sweep is stricter about what it matches in the former.
            {
                #[allow(unused_mut)]
                let mut dirs: Vec<(std::path::PathBuf, bool)> =
                    vec![(std::env::temp_dir(), false)];
                #[cfg(target_os = "android")]
                {
                    use tauri::Manager;
                    if let Ok(cache_dir) = _app.path().app_cache_dir() {
                        dirs.push((cache_dir, true));
                    }
                }
                let removed = sweep_orphaned_recordings(&dirs);
                if removed > 0 {
                    eprintln!("[Audio] removed {removed} orphaned recording file(s)");
                }
            }
            Ok(())
        })
        // Grant WebView2 microphone permission once the page has loaded (webview is ready).
        .on_page_load(|webview, _payload| {
            #[cfg(target_os = "windows")]
            {
                if PERMISSIONS_GRANTED.set(()).is_ok() {
                    eprintln!("[Permissions] on_page_load fired, calling with_webview");
                    match webview.with_webview(grant_media_permissions) {
                        Ok(_) => eprintln!("[Permissions] with_webview dispatched OK"),
                        Err(e) => eprintln!("[Permissions] with_webview ERROR: {:?}", e),
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Ensure a recognition service is available on Windows.
/// Always spawns the sidecar on port 5089.
#[cfg(target_os = "windows")]
fn spawn_recognition_sidecar(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    use tauri_plugin_shell::ShellExt;

    const SIDECAR_PORT: u16 = 5089;

    let port = SIDECAR_PORT;
    let url = format!("http://localhost:{}", port);
    eprintln!("[Recognition] Starting sidecar on port {}...", port);

    let sidecar = app
        .shell()
        .sidecar("NoteBerg.Recognition")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args(["--port", &port.to_string()]);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    // Log sidecar stdout/stderr in a background thread
    let url_for_log = url.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    eprintln!("[Recognition Sidecar] {}", text.trim());
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line);
                    eprintln!("[Recognition Sidecar ERR] {}", text.trim());
                }
                CommandEvent::Terminated(status) => {
                    eprintln!(
                        "[Recognition Sidecar] Process terminated with status: {:?}",
                        status
                    );
                    break;
                }
                _ => {}
            }
        }
        eprintln!(
            "[Recognition Sidecar] Event loop ended for {}",
            url_for_log
        );
    });

    // Poll for readiness off the main thread so app startup is not blocked for up
    // to 10s. The recognition URL stays empty until the sidecar answers; recognition
    // is only triggered on note-close/post-sync (never at page load), so a few-second
    // delay is harmless and the layer already tolerates an empty URL.
    let app_handle = app.handle().clone();
    let check_url = format!("{}/recognize", url);
    std::thread::spawn(move || {
        for i in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if let Ok(resp) = ureq::post(&check_url)
                .set("Content-Type", "application/json")
                .send_string("[]")
            {
                if resp.status() == 200 {
                    eprintln!("[Recognition Sidecar] Ready after {}ms", (i + 1) * 500);
                    let state = app_handle.state::<Mutex<RecognitionState>>();
                    state.lock().unwrap().url = url.clone();
                    eprintln!("[Recognition Sidecar] Available at {}", url);
                    return;
                }
            }
        }
        eprintln!("[Recognition Sidecar] Not ready within 10 seconds, falling back to external URL");
        let _ = child.kill();
    });

    Ok(())
}

// ── WebView2 media permissions ─────────────────────────────────────────────────

/// Pre-grant microphone permission on the WebView2 profile so getUserMedia works
/// without a permission prompt. Uses both approaches:
///  1. SetPermissionState on the profile (proactive, survives across navigations)
///  2. add_PermissionRequested handler (catches any runtime request that slips through)
#[cfg(target_os = "windows")]
fn grant_media_permissions(webview: tauri::webview::PlatformWebview) {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_13, ICoreWebView2Profile4,
            COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
            COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        },
        PermissionRequestedEventHandler, SetPermissionStateCompletedHandler,
    };
    use windows_core::Interface;

    eprintln!("[Permissions] grant_media_permissions called");

    unsafe {
        let core = webview
            .controller()
            .CoreWebView2()
            .expect("CoreWebView2");

        eprintln!("[Permissions] Got CoreWebView2, registering handler");

        // 1. Register a PermissionRequested handler to auto-approve mic requests
        let mut token = Default::default();
        let _ = core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    let mut kind = Default::default();
                    let _ = args.PermissionKind(&mut kind);
                    eprintln!("[Permissions] PermissionRequested fired: kind={:?}", kind);
                    if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                        eprintln!("[Permissions] Granting microphone");
                        let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                    }
                }
                Ok(())
            })),
            &mut token,
        );

        eprintln!("[Permissions] Handler registered, setting profile permission");

        // 2. Also pre-grant via the profile so the permission persists
        if let Ok(core13) = core.cast::<ICoreWebView2_13>() {
            if let Ok(profile) = core13.Profile() {
                if let Ok(profile4) = profile.cast::<ICoreWebView2Profile4>() {
                    eprintln!("[Permissions] Got ICoreWebView2Profile4, calling SetPermissionState");
                    let handler = SetPermissionStateCompletedHandler::create(Box::new(|_| {
                        eprintln!("[Permissions] SetPermissionState completed");
                        Ok(())
                    }));
                    let _ = profile4.SetPermissionState(
                        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                        windows_core::w!("https://tauri.localhost"),
                        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                        &handler,
                    );
                    // Also grant for http://localhost (dev mode)
                    let _ = profile4.SetPermissionState(
                        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                        windows_core::w!("http://localhost:3000"),
                        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                        &handler,
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::validate_recording_path;
    use std::fs;

    #[test]
    fn accepts_a_recording_file_in_an_allowed_dir() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("noteberg_rec_{}.wav", std::process::id()));
        fs::write(&path, b"x").unwrap();

        let result = validate_recording_path(&path.to_string_lossy(), &[dir.clone()]);
        fs::remove_file(&path).ok();
        assert!(result.is_ok());
    }

    #[test]
    fn accepts_the_android_rec_prefix() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("rec_{}.mp4", std::process::id()));
        fs::write(&path, b"x").unwrap();

        let result = validate_recording_path(&path.to_string_lossy(), &[dir.clone()]);
        fs::remove_file(&path).ok();
        assert!(result.is_ok());
    }

    #[test]
    fn rejects_a_file_with_the_wrong_name() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("secrets_{}.wav", std::process::id()));
        fs::write(&path, b"x").unwrap();

        let result = validate_recording_path(&path.to_string_lossy(), &[dir.clone()]);
        fs::remove_file(&path).ok();
        assert!(result.is_err());
    }

    #[test]
    fn rejects_a_recording_named_file_outside_allowed_dirs() {
        // File has a valid recording name but lives outside any allowed dir.
        let outside = std::env::temp_dir().join(format!("nb_outside_{}", std::process::id()));
        fs::create_dir_all(&outside).unwrap();
        let path = outside.join("noteberg_rec_1.wav");
        fs::write(&path, b"x").unwrap();

        let allowed = std::env::temp_dir(); // parent is `outside`, not `allowed`
        let result = validate_recording_path(&path.to_string_lossy(), &[allowed]);
        fs::remove_file(&path).ok();
        fs::remove_dir(&outside).ok();
        assert!(result.is_err());
    }

    #[test]
    fn rejects_a_nonexistent_path() {
        let dir = std::env::temp_dir();
        let result = validate_recording_path("noteberg_rec_does_not_exist.wav", &[dir]);
        assert!(result.is_err());
    }
}
