use std::sync::{Mutex, OnceLock};

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

/// Start native audio recording (Android only).
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
#[cfg(not(target_os = "android"))]
async fn native_audio_start() -> Result<(), String> { Ok(()) }

/// Stop native audio recording and return base64-encoded audio data (Android only).
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
#[cfg(not(target_os = "android"))]
async fn native_audio_stop() -> Result<serde_json::Value, String> { Err("not supported".into()) }

/// Read a native recording file into base64 on the Rust (native) heap and delete it.
/// Using Rust avoids Android JVM heap OOM for large files.
#[tauri::command]
async fn native_audio_read_and_delete(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("Failed to read recording file: {}", e))?;
    let _ = std::fs::remove_file(&path);
    use base64::{Engine as _, engine::general_purpose};
    Ok(general_purpose::STANDARD_NO_PAD.encode(&bytes))
}

/// Get current recording amplitude 0.0–1.0 (Android only).
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
#[cfg(not(target_os = "android"))]
async fn native_audio_get_amplitude() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "amplitude": 0.0 }))
}

/// Pause native audio recording (Android only).
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
#[cfg(not(target_os = "android"))]
async fn native_audio_pause() -> Result<(), String> { Ok(()) }

/// Resume native audio recording (Android only).
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
#[cfg(not(target_os = "android"))]
async fn native_audio_resume() -> Result<(), String> { Ok(()) }

/// Cancel native audio recording (Android only).
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
#[cfg(not(target_os = "android"))]
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

// ── Secure vault key ──────────────────────────────────────────────────────────
//
// Returns a 32-byte random key from the OS keychain (Windows Credential Manager,
// macOS/iOS Keychain, Linux Secret Service). On first launch a random key is
// generated and stored. The key is used to open the Stronghold vault — no Argon2
// KDF is needed because the key is already high-entropy random data.
//
// On Linux, if no Secret Service daemon is available, falls back to a
// deterministic key derived from the machine UUID (weaker but functional).

const KEYRING_SERVICE: &str = "eu.noteberg.app";
const KEYRING_ACCOUNT: &str = "stronghold-vault-key";

#[tauri::command]
#[cfg(not(target_os = "android"))]
fn get_or_create_vault_key() -> Result<Vec<u8>, String> {
    use keyring::Entry;
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("keyring entry: {e}"))?;

    match entry.get_secret() {
        Ok(key) if key.len() == 32 => return Ok(key),
        Ok(_) => { /* wrong size — fall through to regenerate */ }
        Err(keyring::Error::NoEntry) => { /* first launch — fall through to generate */ }
        Err(e) => {
            // Linux: Secret Service unavailable — fall back to device ID
            #[cfg(target_os = "linux")]
            {
                eprintln!("[SecureStorage] keyring unavailable ({e}), using device ID fallback");
                return get_linux_fallback_key();
            }
            #[cfg(not(target_os = "linux"))]
            return Err(format!("keyring read: {e}"));
        }
    }

    // Generate new random 32-byte key and persist it
    let key: Vec<u8> = (0..32).map(|_| rand::random::<u8>()).collect();
    entry.set_secret(&key).map_err(|e| format!("keyring write: {e}"))?;
    Ok(key)
}

#[cfg(target_os = "linux")]
fn get_linux_fallback_key() -> Result<Vec<u8>, String> {
    use blake2::{Blake2b512, Digest};
    let uid = machine_uid::get().map_err(|e| format!("machine-uid: {e}"))?;
    let input = format!("noteberg-vault-v1:{uid}");
    let hash = Blake2b512::digest(input.as_bytes());
    Ok(hash[..32].to_vec())
}

// ── Android vault key plugin ──────────────────────────────────────────────────
//
// Android Keystore (hardware-backed TEE) generates and protects a random AES key.
// That key encrypts the 32-byte vault key stored in SharedPreferences.
// The Kotlin DeviceKeyPlugin handles this via the Android Keystore API.

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
async fn get_or_create_vault_key(app: tauri::AppHandle) -> Result<Vec<u8>, String> {
    use tauri::Manager;
    let hex_key = app
        .state::<DeviceKeyPlugin>()
        .0
        .run_mobile_plugin::<String>("getOrCreateVaultKey", serde_json::json!({}))
        .map_err(|e| format!("DeviceKeyPlugin: {e}"))?;
    hex::decode(&hex_key).map_err(|e| format!("hex decode: {e}"))
}

/// Guard so we only call grant_media_permissions once per app lifetime.
#[cfg(target_os = "windows")]
static PERMISSIONS_GRANTED: OnceLock<()> = OnceLock::new();

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_stronghold::Builder::new(|password| {
            // The password is already 32 bytes of OS-keychain-backed random data.
            // No KDF needed — pass through directly.
            password
                .as_ref()
                .try_into()
                .expect("vault key must be exactly 32 bytes")
        })
        .build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(RecognitionState {
            url: String::new(),
        }))
        .invoke_handler(tauri::generate_handler![
            get_recognition_url,
            get_or_create_vault_key,
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

    // Wait for the sidecar to become ready (poll up to 10 seconds)
    let check_url = format!("{}/recognize", url);
    let ready = std::thread::spawn(move || {
        for i in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if let Ok(resp) = ureq::post(&check_url)
                .set("Content-Type", "application/json")
                .send_string("[]")
            {
                if resp.status() == 200 {
                    eprintln!(
                        "[Recognition Sidecar] Ready after {}ms",
                        (i + 1) * 500
                    );
                    return true;
                }
            }
        }
        eprintln!("[Recognition Sidecar] Failed to become ready within 10 seconds");
        false
    })
    .join()
    .unwrap_or(false);

    if ready {
        let state = app.state::<Mutex<RecognitionState>>();
        state.lock().unwrap().url = url.clone();
        eprintln!("[Recognition Sidecar] Available at {}", url);
    } else {
        eprintln!("[Recognition Sidecar] Not available, falling back to external URL");
        let _ = child.kill();
    }

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
