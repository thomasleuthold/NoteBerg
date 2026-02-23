use std::sync::Mutex;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(RecognitionState {
            url: String::new(),
        }))
        .invoke_handler(tauri::generate_handler![get_recognition_url, save_pdf]);

    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(pdf_plugin());
    }

    builder
        .setup(|_app| {
            #[cfg(target_os = "windows")]
            {
                spawn_recognition_sidecar(_app)?;
            }
            Ok(())
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
