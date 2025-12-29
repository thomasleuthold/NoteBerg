// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

#[derive(Serialize, Deserialize)]
struct BiometricCapability {
    available: bool,
    biometric_type: String,
}

#[tauri::command]
async fn check_biometric_availability() -> Result<BiometricCapability, String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Security::Credentials::UI::{UserConsentVerifier, UserConsentVerifierAvailability};

        eprintln!("[RUST] Checking biometric availability on Windows...");

        let operation = UserConsentVerifier::CheckAvailabilityAsync()
            .map_err(|e| format!("Failed to check availability: {}", e))?;

        eprintln!("[RUST] CheckAvailabilityAsync operation created successfully");

        let availability = operation.get()
            .map_err(|e| format!("Failed to get availability: {}", e))?;

        eprintln!("[RUST] Got availability result: {:?}", availability);

        match availability {
            UserConsentVerifierAvailability::Available => {
                eprintln!("[RUST] Biometric available!");
                Ok(BiometricCapability {
                    available: true,
                    biometric_type: "windows_hello".to_string(),
                })
            },
            UserConsentVerifierAvailability::DeviceNotPresent => {
                eprintln!("[RUST] DeviceNotPresent - No biometric device detected");
                eprintln!("[RUST] This usually means:");
                eprintln!("[RUST]   - No fingerprint reader or camera is installed");
                eprintln!("[RUST]   - Windows Hello is not set up");
                eprintln!("[RUST]   - Biometric device drivers are not installed");
                Ok(BiometricCapability {
                    available: false,
                    biometric_type: "none".to_string(),
                })
            },
            UserConsentVerifierAvailability::NotConfiguredForUser => {
                eprintln!("[RUST] NotConfiguredForUser - Windows Hello not set up for this user");
                eprintln!("[RUST] Go to Settings → Accounts → Sign-in options to set up Windows Hello");
                Ok(BiometricCapability {
                    available: false,
                    biometric_type: "none".to_string(),
                })
            },
            UserConsentVerifierAvailability::DisabledByPolicy => {
                eprintln!("[RUST] DisabledByPolicy - Biometric authentication disabled by group policy");
                Ok(BiometricCapability {
                    available: false,
                    biometric_type: "none".to_string(),
                })
            },
            UserConsentVerifierAvailability::DeviceBusy => {
                eprintln!("[RUST] DeviceBusy - Biometric device is currently in use");
                Ok(BiometricCapability {
                    available: false,
                    biometric_type: "none".to_string(),
                })
            },
            _ => {
                eprintln!("[RUST] Biometric not available (unknown reason): {:?}", availability);
                Ok(BiometricCapability {
                    available: false,
                    biometric_type: "none".to_string(),
                })
            },
        }
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        let output = Command::new("bioutil").arg("-r").output();

        match output {
            Ok(result) => {
                if result.status.success() {
                    Ok(BiometricCapability {
                        available: true,
                        biometric_type: "touch_id".to_string(),
                    })
                } else {
                    Ok(BiometricCapability {
                        available: false,
                        biometric_type: "none".to_string(),
                    })
                }
            }
            Err(_) => Ok(BiometricCapability {
                available: false,
                biometric_type: "none".to_string(),
            }),
        }
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;

        let output = Command::new("fprintd-verify").arg("--help").output();

        Ok(BiometricCapability {
            available: output.is_ok(),
            biometric_type: if output.is_ok() {
                "fingerprint"
            } else {
                "none"
            }
            .to_string(),
        })
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        eprintln!("[RUST] Biometric authentication not supported on this platform");
        Ok(BiometricCapability {
            available: false,
            biometric_type: "none".to_string(),
        })
    }
}

#[tauri::command]
async fn authenticate_biometric(_reason: String, _window: tauri::Window) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Security::Credentials::UI::{UserConsentVerifier, UserConsentVerificationResult};
        use windows::core::HSTRING;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, SetWindowPos, SWP_NOMOVE, SWP_NOSIZE, HWND_TOPMOST, HWND_NOTOPMOST};

        let reason_hstring = HSTRING::from(&_reason);

        // Get the window handle to ensure prompt appears in foreground
        eprintln!("[RUST] Getting window handle for foreground prompt...");
        let hwnd = _window.hwnd().map(|h| HWND(h.0 as isize)).ok();

        if let Some(hwnd) = hwnd {
            eprintln!("[RUST] Window handle obtained, bringing window to foreground");
            unsafe {
                // Bring the main window to foreground first
                let _ = SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
                let _ = SetForegroundWindow(hwnd);
                let _ = SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            }
        } else {
            eprintln!("[RUST] Warning: Could not get window handle");
        }

        eprintln!("[RUST] Requesting biometric verification...");

        let operation = UserConsentVerifier::RequestVerificationAsync(&reason_hstring)
            .map_err(|e| format!("Failed to request verification: {}", e))?;

        let result = operation.get()
            .map_err(|e| format!("Verification failed: {}", e))?;

        match result {
            UserConsentVerificationResult::Verified => {
                eprintln!("[RUST] Biometric verification succeeded");
                Ok(true)
            },
            _ => {
                eprintln!("[RUST] Biometric verification failed or cancelled");
                Ok(false)
            },
        }
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        let script = format!(
            r#"
            use framework "LocalAuthentication"
            set context to current application's LAContext's alloc()'s init()
            set success to context's evaluatePolicy:2 localizedReason:"{}" |error|:(missing value)
            return success as boolean
            "#,
            _reason.replace("\"", "\\\"")
        );

        let output = Command::new("osascript")
            .arg("-l")
            .arg("JavaScript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| e.to_string())?;

        Ok(output.status.success()
            && String::from_utf8_lossy(&output.stdout).contains("true"))
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;

        let output = Command::new("fprintd-verify")
            .output()
            .map_err(|e| e.to_string())?;

        Ok(output.status.success())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        eprintln!("[RUST] Biometric authentication not supported on this platform");
        Err("Biometric authentication not supported on this platform".to_string())
    }
}

#[tauri::command]
async fn save_secure_credential(
    key: String,
    value: String,
    use_biometric: bool,
    window: tauri::Window,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    eprintln!("[RUST] save_secure_credential called: key={}, use_biometric={}", key, use_biometric);

    if use_biometric {
        let authenticated = authenticate_biometric("Authenticate to save credentials".to_string(), window.clone())
            .await?;

        if !authenticated {
            eprintln!("[RUST] Biometric authentication failed");
            return Err("Biometric authentication failed".to_string());
        }
        eprintln!("[RUST] Biometric authentication succeeded");
    }

    let store = app_handle
        .store_builder("credentials.bin")
        .build()
        .map_err(|e| format!("Failed to build store: {}", e))?;

    eprintln!("[RUST] Store built successfully");

    let credential_data = serde_json::json!({
        "value": value,
        "biometric_protected": use_biometric,
    });

    store.set(key.clone(), credential_data);
    eprintln!("[RUST] Credential set in store");

    store
        .save()
        .map_err(|e| format!("Failed to save store: {}", e))?;

    eprintln!("[RUST] Store saved successfully");

    Ok(())
}

#[tauri::command]
async fn get_secure_credential(
    key: String,
    window: tauri::Window,
    app_handle: tauri::AppHandle,
) -> Result<Option<String>, String> {
    eprintln!("[RUST] get_secure_credential called: key={}", key);

    let store = app_handle
        .store_builder("credentials.bin")
        .build()
        .map_err(|e| format!("Failed to build store: {}", e))?;

    eprintln!("[RUST] Store built successfully");

    let credential_data = match store.get(&key) {
        Some(data) => {
            eprintln!("[RUST] Found credential data for key: {}", key);
            data
        },
        None => {
            eprintln!("[RUST] Key not found: {}", key);
            return Err("Key not found".to_string());
        }
    };

    let biometric_protected = credential_data
        .get("biometric_protected")
        .and_then(|v: &serde_json::Value| v.as_bool())
        .unwrap_or(false);

    eprintln!("[RUST] Biometric protected: {}", biometric_protected);

    if biometric_protected {
        let authenticated =
            authenticate_biometric("Authenticate to access credentials".to_string(), window.clone()).await?;

        if !authenticated {
            eprintln!("[RUST] Biometric authentication failed");
            return Err("Biometric authentication failed".to_string());
        }
        eprintln!("[RUST] Biometric authentication succeeded");
    }

    let value = credential_data
        .get("value")
        .and_then(|v: &serde_json::Value| v.as_str().map(String::from));

    eprintln!("[RUST] Returning credential value: {}", if value.is_some() { "present" } else { "null" });

    Ok(value)
}

#[tauri::command]
async fn delete_secure_credential(
    key: String,
    use_biometric: bool,
    window: tauri::Window,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    if use_biometric {
        let authenticated =
            authenticate_biometric("Authenticate to delete credentials".to_string(), window.clone()).await?;

        if !authenticated {
            return Err("Biometric authentication failed".to_string());
        }
    }

    let store = app_handle
        .store_builder("credentials.bin")
        .build()
        .map_err(|e| format!("Failed to build store: {}", e))?;

    store.delete(key);
    store
        .save()
        .map_err(|e| format!("Failed to save store: {}", e))?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            save_secure_credential,
            get_secure_credential,
            delete_secure_credential,
            check_biometric_availability,
            authenticate_biometric,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
