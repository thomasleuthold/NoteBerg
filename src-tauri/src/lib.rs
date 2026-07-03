use std::sync::Mutex;
#[cfg(target_os = "windows")]
use std::sync::OnceLock;

// ── Windows native audio recording ───────────────────────────────────────────
//
// Uses cpal for cross-platform WASAPI capture and hound for WAV encoding.
// WAV files have correct duration headers so playback time display works.
// State is held in a global Mutex so the stateless Tauri commands can access it.

#[cfg(target_os = "windows")]
mod win_audio {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::{Arc, Mutex};
    use std::path::PathBuf;

    pub struct RecordingState {
        pub stream: Option<cpal::Stream>,
        /// Writer shared with the stream callback; take ownership after dropping stream.
        pub writer: Arc<Mutex<Option<hound::WavWriter<std::io::BufWriter<std::fs::File>>>>>,
        pub path: Option<PathBuf>,
        pub paused: Arc<std::sync::atomic::AtomicBool>,
        pub amplitude: Arc<Mutex<f32>>,
        pub proc_state: Arc<Mutex<AudioProcessState>>,
    }

    // Safety: cpal::Stream is not Send, but we only access it from the Tauri
    // command thread under the Mutex lock and never send it across threads.
    unsafe impl Send for RecordingState {}

    /// Persistent state for the two-stage audio processing chain.
    pub struct AudioProcessState {
        comp_detector: f32, // peak level detector for compressor (dB)
        comp_gain_db: f32,  // smoothed gain reduction from compressor (dB, <= 0)
        lim_detector: f32,  // peak level detector for limiter (dB)
        lim_gain_db: f32,   // smoothed gain reduction from limiter (dB, <= 0)
    }

    impl AudioProcessState {
        pub fn new() -> Self {
            Self { comp_detector: -100.0, comp_gain_db: 0.0, lim_detector: -100.0, lim_gain_db: 0.0 }
        }
    }

    /// Port of the browser Web Audio chain:
    ///   DynamicsCompressor(threshold=-18, knee=12, ratio=3, attack=0.05, release=0.3)
    ///   → Gain(1.1)
    ///   → DynamicsCompressor/limiter(threshold=-1, knee=0, ratio=20, attack=0.001, release=0.1)
    ///
    /// Follows the WebKit/Chromium DynamicsCompressor spec:
    ///   per-sample peak detector (attack/release) → gain computer (soft-knee curve) → smoothed gain
    ///
    /// Processes samples in-place. Returns output peak for the amplitude meter.
    pub fn process_audio(samples: &mut [f32], st: &mut AudioProcessState, sample_rate: u32) -> f32 {
        let sr = sample_rate as f32;

        // Compressor: threshold=-18 dB, knee=12 dB, ratio=3, attack=50ms, release=300ms
        let comp_threshold: f32 = -18.0;
        let comp_knee: f32      =  12.0;
        let comp_ratio: f32     =   3.0;
        let comp_att  = (-1.0_f32 / (0.05 * sr)).exp();
        let comp_rel  = (-1.0_f32 / (0.3  * sr)).exp();

        // Limiter: threshold=-1 dB, knee=0, ratio=20, attack=1ms, release=100ms
        let lim_threshold: f32 = -1.0;
        let lim_ratio: f32     = 20.0;
        let lim_att  = (-1.0_f32 / (0.001 * sr)).exp();
        let lim_rel  = (-1.0_f32 / (0.1   * sr)).exp();

        let makeup: f32 = 1.1;

        let mut peak = 0f32;
        for s in samples.iter_mut() {
            let x = *s;

            // ── Compressor ────────────────────────────────────────────────────
            let x_db = lin_to_db(x.abs());
            // Peak detector
            st.comp_detector = if x_db > st.comp_detector {
                comp_att * st.comp_detector + (1.0 - comp_att) * x_db
            } else {
                comp_rel * st.comp_detector + (1.0 - comp_rel) * x_db
            };
            // Gain computer → smooth gain reduction
            let comp_gc = gain_computer(st.comp_detector, comp_threshold, comp_knee, comp_ratio);
            st.comp_gain_db = if comp_gc < st.comp_gain_db {
                comp_att * st.comp_gain_db + (1.0 - comp_att) * comp_gc
            } else {
                comp_rel * st.comp_gain_db + (1.0 - comp_rel) * comp_gc
            };
            let y = x * db_to_lin(st.comp_gain_db) * makeup;

            // ── Limiter ───────────────────────────────────────────────────────
            let y_db = lin_to_db(y.abs());
            st.lim_detector = if y_db > st.lim_detector {
                lim_att * st.lim_detector + (1.0 - lim_att) * y_db
            } else {
                lim_rel * st.lim_detector + (1.0 - lim_rel) * y_db
            };
            let lim_gc = gain_computer(st.lim_detector, lim_threshold, 0.0, lim_ratio);
            st.lim_gain_db = if lim_gc < st.lim_gain_db {
                lim_att * st.lim_gain_db + (1.0 - lim_att) * lim_gc
            } else {
                lim_rel * st.lim_gain_db + (1.0 - lim_rel) * lim_gc
            };
            let out = (y * db_to_lin(st.lim_gain_db)).clamp(-1.0, 1.0);

            *s = out;
            if out.abs() > peak { peak = out.abs(); }
        }
        peak
    }

    /// Gain computer: returns gain reduction in dB (always <= 0).
    /// Soft-knee curve per the WebAudio spec.
    #[inline]
    fn gain_computer(level_db: f32, threshold: f32, knee: f32, ratio: f32) -> f32 {
        let half_knee = knee / 2.0;
        if knee > 0.0 && level_db > threshold - half_knee && level_db < threshold + half_knee {
            // Soft-knee region: quadratic interpolation
            let x = level_db - threshold + half_knee;
            (1.0 / ratio - 1.0) / (2.0 * knee) * x * x
        } else if level_db >= threshold + half_knee {
            // Above knee: full ratio
            (level_db - threshold) * (1.0 / ratio - 1.0)
        } else {
            0.0
        }
    }

    #[inline]
    fn lin_to_db(x: f32) -> f32 {
        if x < 1e-6 { -120.0 } else { 20.0 * x.log10() }
    }

    #[inline]
    fn db_to_lin(db: f32) -> f32 {
        10f32.powf(db / 20.0)
    }

    pub fn start() -> Result<RecordingState, String> {
        let host = cpal::default_host();
        let device = host.default_input_device()
            .ok_or_else(|| "No audio input device found".to_string())?;
        let config = device.default_input_config()
            .map_err(|e| format!("Audio config error: {e}"))?;

        let sample_rate = config.sample_rate().0;
        let channels = config.channels();

        let tmp_path = std::env::temp_dir().join(format!("noteberg_rec_{}.wav", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()));

        let wav_spec = hound::WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let writer = hound::WavWriter::create(&tmp_path, wav_spec)
            .map_err(|e| format!("Failed to create WAV file: {e}"))?;
        let writer = Arc::new(Mutex::new(Some(writer)));
        let writer_clone = Arc::clone(&writer);
        let paused = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let paused_clone = Arc::clone(&paused);
        let amplitude_shared = Arc::new(Mutex::new(0f32));
        let amplitude_clone = Arc::clone(&amplitude_shared);
        let compressor = Arc::new(Mutex::new(AudioProcessState::new()));

        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => {
                let compressor_c = Arc::clone(&compressor);
                let writer_c = Arc::clone(&writer_clone);
                let amplitude_c = Arc::clone(&amplitude_clone);
                let paused_c = Arc::clone(&paused_clone);
                device.build_input_stream(
                    &config.into(),
                    move |data: &[f32], _| {
                        if paused_c.load(std::sync::atomic::Ordering::Relaxed) { return; }
                        let mut buf = data.to_vec();
                        let peak = process_audio(&mut buf, &mut compressor_c.lock().unwrap(), sample_rate);
                        *amplitude_c.lock().unwrap() = peak;
                        if let Ok(mut guard) = writer_c.lock() {
                            if let Some(w) = guard.as_mut() {
                                for s in buf { let _ = w.write_sample((s * i16::MAX as f32) as i16); }
                            }
                        }
                    },
                    |e| eprintln!("[WinAudio] stream error: {e}"),
                    None,
                ).map_err(|e| format!("Stream build error: {e}"))?
            }
            cpal::SampleFormat::I16 => {
                let compressor_c = Arc::clone(&compressor);
                let writer_c = Arc::clone(&writer_clone);
                let amplitude_c = Arc::clone(&amplitude_clone);
                let paused_c = Arc::clone(&paused_clone);
                device.build_input_stream(
                    &config.into(),
                    move |data: &[i16], _| {
                        if paused_c.load(std::sync::atomic::Ordering::Relaxed) { return; }
                        let mut buf: Vec<f32> = data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
                        let peak = process_audio(&mut buf, &mut compressor_c.lock().unwrap(), sample_rate);
                        *amplitude_c.lock().unwrap() = peak;
                        if let Ok(mut guard) = writer_c.lock() {
                            if let Some(w) = guard.as_mut() {
                                for s in buf { let _ = w.write_sample((s * i16::MAX as f32) as i16); }
                            }
                        }
                    },
                    |e| eprintln!("[WinAudio] stream error: {e}"),
                    None,
                ).map_err(|e| format!("Stream build error: {e}"))?
            }
            _ => {
                // Unknown format: write raw without enhancement
                let writer_c = Arc::clone(&writer_clone);
                let paused_c = Arc::clone(&paused_clone);
                device.build_input_stream(
                    &config.into(),
                    move |data: &[u8], _| {
                        if paused_c.load(std::sync::atomic::Ordering::Relaxed) { return; }
                        if let Ok(mut guard) = writer_c.lock() {
                            if let Some(w) = guard.as_mut() {
                                for chunk in data.chunks(2) {
                                    if chunk.len() == 2 {
                                        let s = i16::from_le_bytes([chunk[0], chunk[1]]);
                                        let _ = w.write_sample(s);
                                    }
                                }
                            }
                        }
                    },
                    |e| eprintln!("[WinAudio] stream error: {e}"),
                    None,
                ).map_err(|e| format!("Stream build error: {e}"))?
            }
        };

        stream.play().map_err(|e| format!("Stream play error: {e}"))?;

        Ok(RecordingState {
            stream: Some(stream),
            writer,
            path: Some(tmp_path),
            paused,
            amplitude: amplitude_shared,
            proc_state: compressor,
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

// ── Global recording state (Windows) ─────────────────────────────────────────
#[cfg(target_os = "windows")]
static WIN_RECORDING: OnceLock<Mutex<Option<win_audio::RecordingState>>> = OnceLock::new();

#[cfg(target_os = "windows")]
fn win_recording() -> &'static Mutex<Option<win_audio::RecordingState>> {
    WIN_RECORDING.get_or_init(|| Mutex::new(None))
}

/// Start native audio recording.
#[tauri::command]
#[cfg(target_os = "android")]
async fn native_audio_start(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    app.state::<AudioRecorderPlugin>()
        .0
        .run_mobile_plugin::<()>("start", serde_json::json!({}))
        .map_err(|e| format!("native_audio_start: {}", e))
}
#[tauri::command]
#[cfg(target_os = "windows")]
async fn native_audio_start() -> Result<(), String> {
    let state = win_audio::start()?;
    *win_recording().lock().unwrap() = Some(state);
    Ok(())
}
#[tauri::command]
#[cfg(not(any(target_os = "android", target_os = "windows")))]
async fn native_audio_start() -> Result<(), String> { Ok(()) }

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
    let state = guard.take().ok_or("Not recording")?;
    // Drop stream first to stop capture, then finalize writer
    drop(state.stream);
    let path = state.path.ok_or("No recording path")?;
    if let Some(w) = state.writer.lock().unwrap().take() {
        w.finalize().map_err(|e| format!("WAV finalize: {e}"))?;
    }
    let path_str = path.to_string_lossy().to_string();
    Ok(serde_json::json!({ "path": path_str, "mimeType": "audio/wav" }))
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
        && (name.ends_with(".wav") || name.ends_with(".mp4"));
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

/// Read a native recording file into base64 on the Rust heap and delete it.
#[tauri::command]
async fn native_audio_read_and_delete(
    #[allow(unused_variables)] app: tauri::AppHandle,
    path: String,
) -> Result<String, String> {
    // `mut` is used only on Android (cache-dir push); allow the unused-mut warning elsewhere.
    #[allow(unused_mut)]
    let mut allowed_dirs = vec![std::env::temp_dir()];
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        if let Ok(cache_dir) = app.path().app_cache_dir() {
            allowed_dirs.push(cache_dir);
        }
    }

    let safe_path = validate_recording_path(&path, &allowed_dirs)?;

    let bytes = std::fs::read(&safe_path)
        .map_err(|e| format!("Failed to read recording file: {}", e))?;
    let _ = std::fs::remove_file(&safe_path);
    use base64::{Engine as _, engine::general_purpose};
    Ok(general_purpose::STANDARD_NO_PAD.encode(&bytes))
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
        .map(|s| *s.amplitude.lock().unwrap())
        .unwrap_or(0.0);
    Ok(serde_json::json!({ "amplitude": amplitude }))
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
    if let Some(state) = guard.take() {
        drop(state.stream);
        // Delete the temp file
        if let Some(path) = state.path { let _ = std::fs::remove_file(path); }
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
        .invoke_handler(tauri::generate_handler![
            get_recognition_url,
            save_credential,
            get_credential,
            delete_credential,
            save_pdf,
            native_audio_start,
            native_audio_stop,
            native_audio_read_and_delete,
            native_audio_get_amplitude,
            native_audio_pause,
            native_audio_resume,
            native_audio_cancel,
        ]);

    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(pdf_plugin());
        builder = builder.plugin(audio_recorder_plugin());
        builder = builder.plugin(device_key_plugin());
    }

    builder
        .setup(|_app| {
            #[cfg(target_os = "windows")]
            {
                // Enumerate audio endpoints so Windows registers this process for the
                // microphone privacy list (required for getUserMedia to find the device).
                register_audio_privacy();
                spawn_recognition_sidecar(_app)?;
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

/// Write Windows microphone consent registry entries for the host exe and the
/// WebView2 renderer, so getUserMedia({ audio }) works without NotFoundError.
/// Windows blocks audio device access for processes not listed under:
///   HKCU\...\ConsentStore\microphone\NonPackaged\<path-with-#-separators>
#[cfg(target_os = "windows")]
fn register_audio_privacy() {
    fn grant(path: &str) {
        let key = path.replace('\\', "#");
        let reg_key = format!(
            "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\{}",
            key
        );
        let status = std::process::Command::new("reg")
            .args(["add", &reg_key, "/v", "Value", "/t", "REG_SZ", "/d", "Allow", "/f"])
            .status();
        match status {
            Ok(s) if s.success() => eprintln!("[Permissions] Mic consent granted: {}", path),
            Ok(s) => eprintln!("[Permissions] reg add failed ({}): {:?}", path, s.code()),
            Err(e) => eprintln!("[Permissions] reg add error ({}): {}", path, e),
        }
    }

    // 1. Host process
    if let Ok(exe) = std::env::current_exe() {
        grant(&exe.to_string_lossy());
    }

    // 2. WebView2 renderer — find all msedgewebview2.exe under EdgeWebView\Application
    let wv2_base = std::path::Path::new(
        r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application",
    );
    if let Ok(entries) = std::fs::read_dir(wv2_base) {
        for entry in entries.flatten() {
            let candidate = entry.path().join("msedgewebview2.exe");
            if candidate.exists() {
                grant(&candidate.to_string_lossy());
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
