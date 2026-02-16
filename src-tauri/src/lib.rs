use std::sync::Mutex;
use tauri::Manager;

/// State holding the sidecar recognition URL (empty if not available)
struct RecognitionState {
    url: String,
}

/// Tauri command: returns the local sidecar recognition URL (or empty string)
#[tauri::command]
fn get_recognition_url(state: tauri::State<Mutex<RecognitionState>>) -> String {
    state.lock().unwrap().url.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(RecognitionState {
            url: String::new(),
        }))
        .invoke_handler(tauri::generate_handler![get_recognition_url])
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                spawn_recognition_sidecar(app)?;
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
    use tauri_plugin_shell::ShellExt;

    const SIDECAR_PORT: u16 = 5089;

    let port = SIDECAR_PORT;
    let url = format!("http://localhost:{}", port);
    eprintln!("[Recognition] Starting sidecar on port {}...", port);

    let sidecar = app
        .shell()
        .sidecar("OneJournal.Recognition")
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
