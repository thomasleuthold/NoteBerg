# Encryption Implementation Plan for oneJournal

## Overview

This document outlines the implementation plan for adding encryption to oneJournal to protect user data both at rest (IndexedDB) and in transit (Nextcloud sync). The plan uses a hybrid approach combining multiple security layers, including **biometric authentication** for credential protection.

### Key Features

1. **OS-Native Secure Storage**: Nextcloud credentials stored in Windows Credential Manager, macOS Keychain, or Linux Secret Service
2. **Biometric Authentication**: Windows Hello, Touch ID, or fingerprint protection for accessing credentials
3. **HTTPS Enforcement**: All network traffic encrypted with TLS
4. **End-to-End Encryption**: Note content and drawings encrypted before storage and sync using AES-256-GCM
5. **Master Password**: User-controlled encryption with PBKDF2 key derivation

### Supported Biometric Methods

| Platform | Biometric Type | Implementation |
|----------|---------------|----------------|
| Windows 10/11 | Windows Hello (Face, Fingerprint, PIN) | Windows.Security.Credentials.UI API |
| macOS | Touch ID | LocalAuthentication framework |
| Linux | Fingerprint | fprintd service |

## Security Architecture

### Current Vulnerabilities

1. **Critical**: Nextcloud credentials stored in plaintext in localStorage
2. **High**: No at-rest encryption for note content and drawing strokes in IndexedDB
3. **High**: Data synced to Nextcloud as plaintext JSON files
4. **Medium**: HTTP connections allowed (should be HTTPS-only)
5. **Medium**: No Content Security Policy (CSP) configured

### Target Architecture

```
User Master Password (in memory only)
    ↓
PBKDF2 Key Derivation (100k iterations + salt)
    ↓
AES-256-GCM Encryption Key (in memory only)
    ↓
    ├─→ Encrypt note content before IndexedDB storage
    ├─→ Encrypt strokes before IndexedDB storage
    └─→ Encrypt data before Nextcloud sync

Nextcloud Credentials
    ↓
OS Keychain (Tauri Plugin) + Biometric Authentication
    ↓
Windows Hello / Touch ID / Fingerprint / Linux PAM
    ↓
Windows Credential Manager / macOS Keychain / Linux Secret Service
```

## Phase 1: Secure Credentials with Biometric Authentication

**Goal**: Move Nextcloud credentials from plaintext localStorage to OS-native secure storage with biometric authentication support.

### 1.1 Add Tauri Plugins

**Files to modify:**
- `src-tauri/Cargo.toml`
- `src-tauri/src/main.rs`

**Steps:**

1. Add dependencies to `Cargo.toml`:
```toml
[dependencies]
tauri-plugin-store = "2.0.0"
tauri-plugin-biometric = { git = "https://github.com/tauri-apps/tauri-plugin-biometric" }
# Alternative if official plugin not available:
keyring = "2.3"
windows = { version = "0.52", features = ["Security_Credentials_UI"] }
```

2. Register plugins in `src-tauri/src/main.rs`:
```rust
use tauri_plugin_store::StoreBuilder;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_biometric::init())
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
```

3. Create Rust commands for biometric authentication:
```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct BiometricCapability {
    available: bool,
    biometric_type: String, // "fingerprint", "face", "iris", "none"
}

#[tauri::command]
async fn check_biometric_availability() -> Result<BiometricCapability, String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Security::Credentials::UI::{
            UserConsentVerifier,
            UserConsentVerifierAvailability
        };

        match UserConsentVerifier::CheckAvailabilityAsync()
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?
        {
            UserConsentVerifierAvailability::Available => {
                Ok(BiometricCapability {
                    available: true,
                    biometric_type: "windows_hello".to_string(),
                })
            }
            UserConsentVerifierAvailability::DeviceNotPresent => {
                Ok(BiometricCapability {
                    available: false,
                    biometric_type: "none".to_string(),
                })
            }
            _ => Ok(BiometricCapability {
                available: false,
                biometric_type: "none".to_string(),
            }),
        }
    }

    #[cfg(target_os = "macos")]
    {
        // macOS Touch ID availability check
        use std::process::Command;

        let output = Command::new("bioutil")
            .arg("-r")
            .output();

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
        // Linux fingerprint check (fprintd)
        use std::process::Command;

        let output = Command::new("fprintd-verify")
            .arg("--help")
            .output();

        Ok(BiometricCapability {
            available: output.is_ok(),
            biometric_type: if output.is_ok() { "fingerprint" } else { "none" }.to_string(),
        })
    }
}

#[tauri::command]
async fn authenticate_biometric(reason: String) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Security::Credentials::UI::UserConsentVerifier;

        match UserConsentVerifier::RequestVerificationAsync(&reason.into())
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?
        {
            windows::Security::Credentials::UI::UserConsentVerificationResult::Verified => {
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    #[cfg(target_os = "macos")]
    {
        // macOS Touch ID authentication using LocalAuthentication framework
        use std::process::Command;

        // Use osascript to trigger Touch ID
        let script = format!(
            r#"
            use framework "LocalAuthentication"
            set context to current application's LAContext's alloc()'s init()
            set success to context's evaluatePolicy:2 localizedReason:"{}" |error|:(missing value)
            return success as boolean
            "#,
            reason.replace("\"", "\\\"")
        );

        let output = Command::new("osascript")
            .arg("-l")
            .arg("JavaScript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| e.to_string())?;

        Ok(output.status.success() &&
           String::from_utf8_lossy(&output.stdout).contains("true"))
    }

    #[cfg(target_os = "linux")]
    {
        // Linux fingerprint authentication using fprintd
        use std::process::Command;

        let output = Command::new("fprintd-verify")
            .output()
            .map_err(|e| e.to_string())?;

        Ok(output.status.success())
    }
}
```

4. Create Rust commands for credential management with biometric protection:
```rust
#[tauri::command]
async fn save_secure_credential(
    key: String,
    value: String,
    use_biometric: bool,
    app_handle: tauri::AppHandle
) -> Result<(), String> {
    // If biometric is enabled, require authentication before saving
    if use_biometric {
        let authenticated = authenticate_biometric(
            "Authenticate to save credentials".to_string()
        ).await?;

        if !authenticated {
            return Err("Biometric authentication failed".to_string());
        }
    }

    let store = app_handle.store_builder("credentials.bin")
        .build()
        .map_err(|e| e.to_string())?;

    // Store with biometric flag
    let credential_data = serde_json::json!({
        "value": value,
        "biometric_protected": use_biometric,
    });

    store.set(key.clone(), credential_data);
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn get_secure_credential(
    key: String,
    app_handle: tauri::AppHandle
) -> Result<Option<String>, String> {
    let store = app_handle.store_builder("credentials.bin")
        .build()
        .map_err(|e| e.to_string())?;

    let credential_data = store.get(&key);

    if let Some(data) = credential_data {
        // Check if biometric protection is enabled
        let biometric_protected = data.get("biometric_protected")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if biometric_protected {
            // Require biometric authentication
            let authenticated = authenticate_biometric(
                "Authenticate to access credentials".to_string()
            ).await?;

            if !authenticated {
                return Err("Biometric authentication failed".to_string());
            }
        }

        Ok(data.get("value").and_then(|v| v.as_str().map(String::from)))
    } else {
        Ok(None)
    }
}

#[tauri::command]
async fn delete_secure_credential(
    key: String,
    use_biometric: bool,
    app_handle: tauri::AppHandle
) -> Result<(), String> {
    // If biometric is enabled, require authentication before deleting
    if use_biometric {
        let authenticated = authenticate_biometric(
            "Authenticate to delete credentials".to_string()
        ).await?;

        if !authenticated {
            return Err("Biometric authentication failed".to_string());
        }
    }

    let store = app_handle.store_builder("credentials.bin")
        .build()
        .map_err(|e| e.to_string())?;

    store.delete(key)?;
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}
```

### 1.2 Create Secure Storage JavaScript Module with Biometric Support

**New file**: `src/modules/secureStorage.js`

```javascript
import { invoke } from "@tauri-apps/api/core";
import { getSetting, setSetting } from "./storage.js";

const BIOMETRIC_ENABLED_KEY = "biometric_auth_enabled";

/**
 * Check if biometric authentication is available on this device
 * @returns {Promise<{available: boolean, biometricType: string}>}
 */
export async function checkBiometricAvailability() {
  try {
    const result = await invoke("check_biometric_availability");
    return result;
  } catch (error) {
    console.error("Failed to check biometric availability:", error);
    return { available: false, biometricType: "none" };
  }
}

/**
 * Check if user has enabled biometric authentication
 * @returns {Promise<boolean>}
 */
export async function isBiometricEnabled() {
  const enabled = await getSetting(BIOMETRIC_ENABLED_KEY);
  return enabled === true;
}

/**
 * Enable or disable biometric authentication
 * @param {boolean} enabled - Whether to enable biometric auth
 */
export async function setBiometricEnabled(enabled) {
  await setSetting(BIOMETRIC_ENABLED_KEY, enabled);
  console.log(`Biometric authentication ${enabled ? "enabled" : "disabled"}`);
}

/**
 * Authenticate using biometric (fingerprint, face, etc.)
 * @param {string} reason - Reason for authentication (shown to user)
 * @returns {Promise<boolean>} True if authenticated
 */
export async function authenticateBiometric(reason) {
  try {
    const result = await invoke("authenticate_biometric", { reason });
    return result;
  } catch (error) {
    console.error("Biometric authentication failed:", error);
    return false;
  }
}

/**
 * Save credentials to OS-native secure storage
 * @param {string} key - Credential key
 * @param {string} value - Credential value
 */
export async function saveSecureCredential(key, value) {
  try {
    const useBiometric = await isBiometricEnabled();
    await invoke("save_secure_credential", {
      key,
      value,
      useBiometric,
    });
    console.log(`Secure credential saved: ${key} (biometric: ${useBiometric})`);
  } catch (error) {
    console.error("Failed to save secure credential:", error);
    throw error;
  }
}

/**
 * Retrieve credentials from OS-native secure storage
 * Requires biometric authentication if enabled
 * @param {string} key - Credential key
 * @returns {Promise<string|null>} Credential value or null
 */
export async function getSecureCredential(key) {
  try {
    const value = await invoke("get_secure_credential", { key });
    return value;
  } catch (error) {
    console.error("Failed to get secure credential:", error);
    // Check if error is due to biometric failure
    if (error.toString().includes("Biometric authentication failed")) {
      throw new Error("Biometric authentication required");
    }
    return null;
  }
}

/**
 * Delete credentials from OS-native secure storage
 * @param {string} key - Credential key
 */
export async function deleteSecureCredential(key) {
  try {
    const useBiometric = await isBiometricEnabled();
    await invoke("delete_secure_credential", { key, useBiometric });
    console.log(`Secure credential deleted: ${key}`);
  } catch (error) {
    console.error("Failed to delete secure credential:", error);
    throw error;
  }
}
```

### 1.3 Migrate nextcloudSync.js to Secure Storage

**File to modify**: `src/modules/nextcloudSync.js`

**Changes:**

1. Import secure storage module (line 6):
```javascript
import { saveSecureCredential, getSecureCredential, deleteSecureCredential } from "./secureStorage.js";
```

2. Replace `saveCredentials()` function (lines 31-48):
```javascript
/**
 * Save Nextcloud credentials to secure storage
 */
async function saveCredentials(credentials) {
  try {
    await saveSecureCredential("nextcloud_credentials", JSON.stringify(credentials));
    currentCredentials = credentials;
  } catch (error) {
    console.error("Failed to save credentials to secure storage:", error);
    throw error;
  }
}
```

3. Replace `getCredentials()` function (lines 50-59):
```javascript
/**
 * Get Nextcloud credentials from secure storage
 */
async function getCredentials() {
  if (currentCredentials) {
    return currentCredentials;
  }

  try {
    const credString = await getSecureCredential("nextcloud_credentials");
    if (credString) {
      currentCredentials = JSON.parse(credString);
      return currentCredentials;
    }
  } catch (error) {
    console.error("Failed to get credentials from secure storage:", error);
  }

  return null;
}
```

4. Update `logout()` function (lines 231-240):
```javascript
/**
 * Logout and clear credentials
 */
export async function logout() {
  try {
    await deleteSecureCredential("nextcloud_credentials");
    currentCredentials = null;
    window.dispatchEvent(new CustomEvent("nextcloud-auth-changed"));
    console.log("Logged out successfully");
  } catch (error) {
    console.error("Failed to clear credentials:", error);
    throw error;
  }
}
```

5. Add migration function to move existing localStorage credentials:
```javascript
/**
 * Migrate existing localStorage credentials to secure storage
 * Called once on app startup
 */
async function migrateCredentials() {
  const NEXTCLOUD_STORAGE_KEY = "nextcloud_credentials";
  const oldCreds = localStorage.getItem(NEXTCLOUD_STORAGE_KEY);

  if (oldCreds) {
    try {
      console.log("Migrating credentials from localStorage to secure storage...");
      const credentials = JSON.parse(oldCreds);
      await saveCredentials(credentials);
      localStorage.removeItem(NEXTCLOUD_STORAGE_KEY);
      console.log("Credentials migrated successfully");
    } catch (error) {
      console.error("Failed to migrate credentials:", error);
    }
  }
}
```

6. Call migration in app initialization (update `src/main.js`):
```javascript
import { migrateCredentials } from "./modules/nextcloudSync.js";

// After storage initialization
await migrateCredentials();
```

### 1.4 Add Biometric Settings UI

**File to modify**: `src/components/settingsMode.js`

**Add biometric section to settings** (after Nextcloud sync section, around line 180):

```javascript
import {
  checkBiometricAvailability,
  isBiometricEnabled,
  setBiometricEnabled,
  authenticateBiometric,
} from "../modules/secureStorage.js";

// In renderSettings() function, add this section:
```

```html
<div class="settings-section">
  <h3>Security</h3>

  <div class="setting-item" id="biometric-setting-container">
    <div class="setting-info">
      <label>Biometric Authentication</label>
      <p class="setting-description" id="biometric-description">
        Checking device capabilities...
      </p>
    </div>
    <div class="setting-control">
      <label class="toggle-switch">
        <input type="checkbox" id="biometric-toggle" disabled />
        <span class="toggle-slider"></span>
      </label>
    </div>
  </div>

  <div class="setting-item" id="test-biometric-container" style="display: none;">
    <button id="test-biometric-btn" class="btn-secondary">
      Test Biometric Authentication
    </button>
  </div>
</div>
```

**Add JavaScript to handle biometric settings**:

```javascript
// Initialize biometric settings
async function initBiometricSettings() {
  const biometricToggle = document.getElementById("biometric-toggle");
  const biometricDescription = document.getElementById("biometric-description");
  const testBiometricContainer = document.getElementById("test-biometric-container");
  const testBiometricBtn = document.getElementById("test-biometric-btn");

  if (!biometricToggle || !biometricDescription) return;

  // Check availability
  const availability = await checkBiometricAvailability();
  const isEnabled = await isBiometricEnabled();

  if (availability.available) {
    // Map biometric type to friendly name
    const typeNames = {
      windows_hello: "Windows Hello",
      touch_id: "Touch ID",
      fingerprint: "Fingerprint",
      face: "Face Recognition",
    };

    const typeName = typeNames[availability.biometricType] || availability.biometricType;

    biometricDescription.textContent = `Use ${typeName} to protect Nextcloud credentials`;
    biometricToggle.disabled = false;
    biometricToggle.checked = isEnabled;

    // Show test button if enabled
    if (isEnabled && testBiometricContainer) {
      testBiometricContainer.style.display = "block";
    }

    // Toggle handler
    biometricToggle.addEventListener("change", async () => {
      const newState = biometricToggle.checked;

      if (newState) {
        // Test biometric before enabling
        const authenticated = await authenticateBiometric(
          "Verify your identity to enable biometric authentication"
        );

        if (authenticated) {
          await setBiometricEnabled(true);
          if (testBiometricContainer) {
            testBiometricContainer.style.display = "block";
          }
          await showAlertDialog(
            "Biometric Enabled",
            `${typeName} authentication has been enabled. Your Nextcloud credentials will now be protected with biometric authentication.`
          );
        } else {
          biometricToggle.checked = false;
          await showAlertDialog(
            "Authentication Failed",
            "Biometric authentication failed. Please try again."
          );
        }
      } else {
        await setBiometricEnabled(false);
        if (testBiometricContainer) {
          testBiometricContainer.style.display = "none";
        }
        await showAlertDialog(
          "Biometric Disabled",
          "Biometric authentication has been disabled."
        );
      }
    });

    // Test button handler
    if (testBiometricBtn) {
      testBiometricBtn.addEventListener("click", async () => {
        const authenticated = await authenticateBiometric(
          "Testing biometric authentication"
        );

        if (authenticated) {
          await showAlertDialog(
            "Success",
            `${typeName} authentication successful!`
          );
        } else {
          await showAlertDialog(
            "Failed",
            "Biometric authentication failed. Please try again."
          );
        }
      });
    }
  } else {
    biometricDescription.textContent = "Biometric authentication not available on this device";
    biometricDescription.style.color = "var(--text-secondary)";
    biometricToggle.disabled = true;
  }
}

// Call in renderSettings()
initBiometricSettings();
```

### 1.5 Update Nextcloud Login Flow UI

**File to modify**: `src/components/settingsMode.js`

**Add biometric prompt during login** (update login flow around line 420):

```javascript
import { getSecureCredential } from "../modules/secureStorage.js";

// When retrieving credentials on app start or before sync
async function loadCredentials() {
  try {
    const credentials = await getSecureCredential("nextcloud_credentials");
    if (credentials) {
      return JSON.parse(credentials);
    }
  } catch (error) {
    if (error.message.includes("Biometric authentication required")) {
      await showAlertDialog(
        "Authentication Required",
        "Please authenticate to access your Nextcloud credentials."
      );
    }
    throw error;
  }
  return null;
}
```

### 1.6 Testing Phase 1

**Test checklist:**
- [ ] New credentials saved to OS keychain (verify not in localStorage)
- [ ] Existing credentials migrated from localStorage
- [ ] Login flow works with secure storage
- [ ] Logout properly clears credentials
- [ ] App restart retrieves credentials correctly
- [ ] Sync operations work with new credential storage
- [ ] Biometric availability detected correctly (Windows Hello / Touch ID / Fingerprint)
- [ ] Biometric toggle enables/disables correctly
- [ ] Credentials require biometric authentication when enabled
- [ ] Test biometric button works
- [ ] Error messages shown when biometric fails
- [ ] Settings persist across app restarts

---

## Phase 2: Enforce HTTPS

**Goal**: Ensure all network traffic uses encrypted HTTPS connections.

### 2.1 Update Tauri Capabilities

**File to modify**: `src-tauri/capabilities/default.json`

**Change** (line 23-24):
```json
{
  "permissions": [
    "core:default",
    {
      "identifier": "http:default",
      "allow": [
        { "url": "https://**" }
      ],
      "deny": [
        { "url": "http://**" }
      ]
    },
    "opener:default",
    "shell:allow-open"
  ]
}
```

### 2.2 Add Server URL Validation

**File to modify**: `src/modules/nextcloudSync.js`

**Add validation function**:
```javascript
/**
 * Validate that server URL uses HTTPS
 * @param {string} url - Server URL to validate
 * @throws {Error} If URL is not HTTPS
 */
function validateServerUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error("Server URL must use HTTPS for security. HTTP connections are not allowed.");
    }
    return true;
  } catch (error) {
    if (error.message.includes("HTTPS")) {
      throw error;
    }
    throw new Error("Invalid server URL format");
  }
}
```

**Update `testConnection()` function** (line 61-80):
```javascript
export async function testConnection(serverUrl) {
  // Validate HTTPS
  validateServerUrl(serverUrl);

  try {
    const url = `${serverUrl}/status.php`;
    console.log("Testing connection to:", url);
    // ... rest of function
  } catch (error) {
    // ... existing error handling
  }
}
```

**Update `initiateLoginFlow()` function** (line 87):
```javascript
export async function initiateLoginFlow(serverUrl) {
  // Validate HTTPS
  validateServerUrl(serverUrl);

  try {
    const initUrl = `${serverUrl}/index.php/login/v2`;
    // ... rest of function
  } catch (error) {
    // ... existing error handling
  }
}
```

### 2.3 Add Content Security Policy (CSP)

**File to modify**: `src-tauri/tauri.conf.json`

**Change** (lines 24-26):
```json
{
  "security": {
    "csp": "default-src 'self'; connect-src 'self' https://*; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self' data:"
  }
}
```

**CSP Breakdown:**
- `default-src 'self'` - Only load resources from same origin by default
- `connect-src 'self' https://*` - Allow HTTPS connections to any domain (for Nextcloud servers)
- `style-src 'self' 'unsafe-inline'` - Allow inline styles (needed for dynamic UI)
- `script-src 'self'` - Only execute scripts from app bundle
- `img-src 'self' data:` - Allow images from app and data URIs
- `font-src 'self' data:` - Allow fonts from app and data URIs

### 2.4 Update Settings UI

**File to modify**: `src/components/settingsMode.js`

**Add HTTPS validation to server URL input** (around line 400):
```javascript
// Server URL input validation
serverUrlInput?.addEventListener("input", () => {
  const url = serverUrlInput.value.trim();
  if (url && !url.startsWith("https://")) {
    serverUrlInput.setCustomValidity("Server URL must use HTTPS (e.g., https://cloud.example.com)");
  } else {
    serverUrlInput.setCustomValidity("");
  }
});
```

### 2.5 Testing Phase 2

**Test checklist:**
- [ ] HTTP URLs rejected in settings
- [ ] HTTPS URLs accepted
- [ ] Existing HTTP connections fail gracefully
- [ ] CSP doesn't break existing functionality
- [ ] Nextcloud sync works over HTTPS
- [ ] Error messages are user-friendly

---

## Phase 3: Encrypt Note Data

**Goal**: Implement end-to-end encryption for note content and drawing strokes.

### 3.1 Create Crypto Module

**New file**: `src/modules/crypto.js`

```javascript
/**
 * Crypto Module
 * Handles encryption/decryption of note data using Web Crypto API
 */

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits for GCM
const SALT_LENGTH = 16; // 128 bits
const PBKDF2_ITERATIONS = 100000;

/**
 * Derive encryption key from master password
 * @param {string} password - Master password
 * @param {Uint8Array} salt - Salt for key derivation
 * @returns {Promise<CryptoKey>} Derived encryption key
 */
export async function deriveKey(password, salt) {
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);

  // Import password as key material
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    passwordBuffer,
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"]
  );

  // Derive AES key
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH },
    false, // not extractable
    ["encrypt", "decrypt"]
  );

  return key;
}

/**
 * Generate random salt for key derivation
 * @returns {Uint8Array} Random salt
 */
export function generateSalt() {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

/**
 * Encrypt data using AES-GCM
 * @param {string} plaintext - Data to encrypt
 * @param {CryptoKey} key - Encryption key
 * @returns {Promise<string>} Base64-encoded encrypted data (IV + ciphertext + auth tag)
 */
export async function encrypt(plaintext, key) {
  if (!plaintext || plaintext === "") {
    return ""; // Don't encrypt empty strings
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  // Generate random IV
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  // Encrypt
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: ALGORITHM,
      iv: iv
    },
    key,
    data
  );

  // Combine IV + ciphertext
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  // Return as base64
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt data using AES-GCM
 * @param {string} ciphertext - Base64-encoded encrypted data
 * @param {CryptoKey} key - Decryption key
 * @returns {Promise<string>} Decrypted plaintext
 */
export async function decrypt(ciphertext, key) {
  if (!ciphertext || ciphertext === "") {
    return ""; // Return empty string for empty input
  }

  try {
    // Decode from base64
    const combined = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));

    // Extract IV and ciphertext
    const iv = combined.slice(0, IV_LENGTH);
    const data = combined.slice(IV_LENGTH);

    // Decrypt
    const plaintext = await crypto.subtle.decrypt(
      {
        name: ALGORITHM,
        iv: iv
      },
      key,
      data
    );

    // Decode to string
    const decoder = new TextDecoder();
    return decoder.decode(plaintext);
  } catch (error) {
    console.error("Decryption failed:", error);
    throw new Error("Failed to decrypt data. Wrong password or corrupted data.");
  }
}

/**
 * Encrypt object (converts to JSON first)
 * @param {object} obj - Object to encrypt
 * @param {CryptoKey} key - Encryption key
 * @returns {Promise<string>} Encrypted JSON string
 */
export async function encryptObject(obj, key) {
  const json = JSON.stringify(obj);
  return await encrypt(json, key);
}

/**
 * Decrypt object (parses JSON after decryption)
 * @param {string} ciphertext - Encrypted data
 * @param {CryptoKey} key - Decryption key
 * @returns {Promise<object>} Decrypted object
 */
export async function decryptObject(ciphertext, key) {
  const json = await decrypt(ciphertext, key);
  return JSON.parse(json);
}
```

### 3.2 Create Password Management Module

**New file**: `src/modules/passwordManager.js`

```javascript
/**
 * Password Manager Module
 * Handles master password input and encryption key lifecycle
 */

import { deriveKey, generateSalt } from "./crypto.js";
import { getSetting, setSetting } from "./storage.js";

const SALT_SETTING_KEY = "encryption_salt";
const SESSION_TIMEOUT = 15 * 60 * 1000; // 15 minutes

let currentEncryptionKey = null;
let sessionTimer = null;

/**
 * Initialize encryption (get or create salt)
 * @returns {Promise<Uint8Array>} Encryption salt
 */
async function initEncryption() {
  let saltBase64 = await getSetting(SALT_SETTING_KEY);

  if (!saltBase64) {
    // First time setup - generate new salt
    const salt = generateSalt();
    saltBase64 = btoa(String.fromCharCode(...salt));
    await setSetting(SALT_SETTING_KEY, saltBase64);
    return salt;
  }

  // Convert base64 back to Uint8Array
  return Uint8Array.from(atob(saltBase64), c => c.charCodeAt(0));
}

/**
 * Prompt user for master password
 * @param {boolean} isSetup - True if setting up password for first time
 * @returns {Promise<string>} Master password
 */
async function promptForPassword(isSetup = false) {
  return new Promise((resolve, reject) => {
    const dialog = document.createElement("div");
    dialog.className = "modal-overlay";
    dialog.innerHTML = `
      <div class="modal-content password-dialog">
        <h2>${isSetup ? "Set Master Password" : "Enter Master Password"}</h2>
        <p>${isSetup
          ? "Create a master password to encrypt your notes. Do not forget this password - it cannot be recovered!"
          : "Enter your master password to unlock your notes."
        }</p>
        <input type="password" id="master-password-input" placeholder="Master password" autofocus />
        ${isSetup ? '<input type="password" id="master-password-confirm" placeholder="Confirm password" />' : ''}
        <div class="modal-buttons">
          <button id="password-submit" class="btn-primary">Submit</button>
          <button id="password-cancel" class="btn-secondary">Cancel</button>
        </div>
        <div id="password-error" style="color: var(--color-error); margin-top: 10px; display: none;"></div>
      </div>
    `;

    document.body.appendChild(dialog);

    const input = dialog.querySelector("#master-password-input");
    const confirmInput = dialog.querySelector("#master-password-confirm");
    const submitBtn = dialog.querySelector("#password-submit");
    const cancelBtn = dialog.querySelector("#password-cancel");
    const errorDiv = dialog.querySelector("#password-error");

    const handleSubmit = () => {
      const password = input.value;

      if (!password) {
        errorDiv.textContent = "Password cannot be empty";
        errorDiv.style.display = "block";
        return;
      }

      if (isSetup) {
        const confirm = confirmInput.value;
        if (password !== confirm) {
          errorDiv.textContent = "Passwords do not match";
          errorDiv.style.display = "block";
          return;
        }

        if (password.length < 8) {
          errorDiv.textContent = "Password must be at least 8 characters";
          errorDiv.style.display = "block";
          return;
        }
      }

      document.body.removeChild(dialog);
      resolve(password);
    };

    submitBtn.addEventListener("click", handleSubmit);
    input.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        if (isSetup && confirmInput) {
          confirmInput.focus();
        } else {
          handleSubmit();
        }
      }
    });

    if (confirmInput) {
      confirmInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") handleSubmit();
      });
    }

    cancelBtn.addEventListener("click", () => {
      document.body.removeChild(dialog);
      reject(new Error("Password entry cancelled"));
    });
  });
}

/**
 * Check if encryption is set up (salt exists)
 * @returns {Promise<boolean>} True if encryption is configured
 */
export async function isEncryptionSetup() {
  const salt = await getSetting(SALT_SETTING_KEY);
  return salt !== null;
}

/**
 * Setup encryption for first time
 * @returns {Promise<CryptoKey>} Encryption key
 */
export async function setupEncryption() {
  const password = await promptForPassword(true);
  const salt = await initEncryption();
  const key = await deriveKey(password, salt);

  currentEncryptionKey = key;
  resetSessionTimer();

  return key;
}

/**
 * Unlock encryption with password
 * @returns {Promise<CryptoKey>} Encryption key
 */
export async function unlockEncryption() {
  const salt = await initEncryption();
  const password = await promptForPassword(false);
  const key = await deriveKey(password, salt);

  currentEncryptionKey = key;
  resetSessionTimer();

  return key;
}

/**
 * Get current encryption key (prompts if not available)
 * @returns {Promise<CryptoKey>} Encryption key
 */
export async function getEncryptionKey() {
  if (currentEncryptionKey) {
    resetSessionTimer();
    return currentEncryptionKey;
  }

  const isSetup = await isEncryptionSetup();
  if (isSetup) {
    return await unlockEncryption();
  } else {
    return await setupEncryption();
  }
}

/**
 * Lock encryption (clear key from memory)
 */
export function lockEncryption() {
  currentEncryptionKey = null;
  if (sessionTimer) {
    clearTimeout(sessionTimer);
    sessionTimer = null;
  }

  // Dispatch event for UI updates
  window.dispatchEvent(new CustomEvent("encryption-locked"));
}

/**
 * Reset session timer (extends session)
 */
function resetSessionTimer() {
  if (sessionTimer) {
    clearTimeout(sessionTimer);
  }

  sessionTimer = setTimeout(() => {
    console.log("Session timeout - locking encryption");
    lockEncryption();
  }, SESSION_TIMEOUT);
}

/**
 * Check if encryption is currently unlocked
 * @returns {boolean} True if unlocked
 */
export function isEncryptionUnlocked() {
  return currentEncryptionKey !== null;
}
```

### 3.3 Update Storage Module for Encryption

**File to modify**: `src/modules/storage.js`

**Add imports** (after line 5):
```javascript
import { encrypt, decrypt, encryptObject, decryptObject } from "./crypto.js";
import { getEncryptionKey } from "./passwordManager.js";
```

**Add encryption wrapper functions**:
```javascript
/**
 * Encrypt note before storing
 * @param {object} note - Note object to encrypt
 * @returns {Promise<object>} Note with encrypted fields
 */
async function encryptNote(note) {
  const key = await getEncryptionKey();

  const encrypted = { ...note };

  // Encrypt content
  if (note.content) {
    encrypted.content = await encrypt(note.content, key);
  }

  // Encrypt strokes
  if (note.strokes && note.strokes.length > 0) {
    encrypted.strokes = await encryptObject(note.strokes, key);
  }

  // Mark as encrypted
  encrypted.encrypted = true;

  return encrypted;
}

/**
 * Decrypt note after loading
 * @param {object} note - Encrypted note object
 * @returns {Promise<object>} Decrypted note
 */
async function decryptNote(note) {
  if (!note.encrypted) {
    return note; // Not encrypted (legacy note)
  }

  const key = await getEncryptionKey();

  const decrypted = { ...note };

  // Decrypt content
  if (note.content) {
    decrypted.content = await decrypt(note.content, key);
  }

  // Decrypt strokes
  if (note.strokes) {
    if (typeof note.strokes === "string") {
      // Encrypted strokes
      decrypted.strokes = await decryptObject(note.strokes, key);
    } else {
      // Legacy unencrypted strokes
      decrypted.strokes = note.strokes;
    }
  }

  return decrypted;
}
```

**Update `saveNote()` function** (line 233):
```javascript
export async function saveNote(note) {
  if (!db) await initStorage();

  // Encrypt note before saving
  const encryptedNote = await encryptNote(note);

  await db.put("notes", encryptedNote);
  console.log("Note saved (encrypted):", note.id);

  // Dispatch event for UI updates
  window.dispatchEvent(new CustomEvent("datachange"));
}
```

**Update `getNote()` function** (line 253):
```javascript
export async function getNote(noteId) {
  if (!db) await initStorage();

  const note = await db.get("notes", noteId);

  if (note) {
    // Decrypt note before returning
    return await decryptNote(note);
  }

  return null;
}
```

**Update `getAllNotes()` function** (line 268):
```javascript
export async function getAllNotes() {
  if (!db) await initStorage();

  const notes = await db.getAll("notes");

  // Decrypt all notes
  return await Promise.all(notes.map(note => decryptNote(note)));
}
```

**Update `getAllNotesForSync()` function** (line 291):
```javascript
export async function getAllNotesForSync() {
  if (!db) await initStorage();

  const notes = await db.getAll("notes");

  // Decrypt all notes before sync
  return await Promise.all(notes.map(note => decryptNote(note)));
}
```

### 3.4 Update Sync Module for Encryption

**File to modify**: `src/modules/nextcloudSync.js`

**Add encryption functions for sync**:

Since notes are already decrypted when loaded from IndexedDB, we need to re-encrypt them before uploading to Nextcloud, and decrypt them after downloading.

**Add imports**:
```javascript
import { encrypt, decrypt, encryptObject, decryptObject } from "./crypto.js";
import { getEncryptionKey } from "./passwordManager.js";
```

**Add helper functions**:
```javascript
/**
 * Prepare note for upload (encrypt for transit)
 * @param {object} note - Decrypted note
 * @returns {Promise<object>} Encrypted note for upload
 */
async function prepareNoteForUpload(note) {
  const key = await getEncryptionKey();

  const encrypted = { ...note };

  if (note.content) {
    encrypted.content = await encrypt(note.content, key);
  }

  if (note.strokes && Array.isArray(note.strokes)) {
    encrypted.strokes = await encryptObject(note.strokes, key);
  }

  encrypted.encrypted = true;

  return encrypted;
}

/**
 * Process downloaded note (decrypt from server)
 * @param {object} note - Encrypted note from server
 * @returns {Promise<object>} Decrypted note
 */
async function processDownloadedNote(note) {
  if (!note.encrypted) {
    return note; // Legacy unencrypted note
  }

  const key = await getEncryptionKey();

  const decrypted = { ...note };

  if (note.content && typeof note.content === "string") {
    try {
      decrypted.content = await decrypt(note.content, key);
    } catch (error) {
      console.error("Failed to decrypt note content:", error);
      decrypted.content = "[Decryption failed]";
    }
  }

  if (note.strokes && typeof note.strokes === "string") {
    try {
      decrypted.strokes = await decryptObject(note.strokes, key);
    } catch (error) {
      console.error("Failed to decrypt note strokes:", error);
      decrypted.strokes = [];
    }
  }

  return decrypted;
}
```

**Update upload functions** (around line 335):
```javascript
// Before uploading note
const encryptedNote = await prepareNoteForUpload(note);
const noteContent = JSON.stringify(encryptedNote, null, 2);
// ... proceed with upload
```

**Update download functions** (around line 364):
```javascript
// After downloading note
const noteData = JSON.parse(await response.text());
const decryptedNote = await processDownloadedNote(noteData);
// ... proceed with processing
```

### 3.5 Add UI Indicators

**File to modify**: `src/components/settingsMode.js`

**Add encryption status section** (around line 200):
```javascript
<div class="settings-section">
  <h3>Encryption</h3>

  <div class="setting-item">
    <div class="setting-info">
      <label>Encryption Status</label>
      <p class="setting-description">
        <span id="encryption-status">Checking...</span>
      </p>
    </div>
  </div>

  <div class="setting-item">
    <button id="change-master-password-btn" class="btn-secondary">Change Master Password</button>
  </div>

  <div class="setting-item">
    <button id="lock-encryption-btn" class="btn-secondary">Lock Encryption</button>
  </div>
</div>
```

**Add status update code**:
```javascript
import { isEncryptionSetup, isEncryptionUnlocked, lockEncryption } from "../modules/passwordManager.js";

// Update encryption status
async function updateEncryptionStatus() {
  const statusSpan = document.getElementById("encryption-status");
  if (!statusSpan) return;

  const isSetup = await isEncryptionSetup();
  const isUnlocked = isEncryptionUnlocked();

  if (!isSetup) {
    statusSpan.textContent = "⚠️ Not configured (will be setup on first note save)";
    statusSpan.style.color = "var(--color-warning)";
  } else if (isUnlocked) {
    statusSpan.textContent = "🔓 Unlocked (notes are accessible)";
    statusSpan.style.color = "var(--color-success)";
  } else {
    statusSpan.textContent = "🔒 Locked (password required to access notes)";
    statusSpan.style.color = "var(--color-error)";
  }
}

// Lock encryption button
const lockBtn = document.getElementById("lock-encryption-btn");
lockBtn?.addEventListener("click", () => {
  lockEncryption();
  updateEncryptionStatus();
});

// Listen for encryption state changes
window.addEventListener("encryption-locked", updateEncryptionStatus);

// Initial status update
updateEncryptionStatus();
```

### 3.6 Testing Phase 3

**Test checklist:**
- [ ] First-time password setup works
- [ ] Password confirmation validation works
- [ ] Notes encrypted in IndexedDB (verify with browser dev tools)
- [ ] Notes decrypt correctly when loaded
- [ ] Sync uploads encrypted data to Nextcloud
- [ ] Sync downloads and decrypts data correctly
- [ ] Wrong password shows error
- [ ] Session timeout locks encryption
- [ ] Lock button works
- [ ] Encryption status indicator updates correctly
- [ ] Legacy unencrypted notes still readable (backward compatibility)

---

## Migration Strategy

### Handling Existing Unencrypted Data

**Option 1: Lazy Migration (Recommended)**
- Unencrypted notes marked with `encrypted: false` or no flag
- Notes encrypted on next save
- Gradual migration over time
- No bulk migration needed

**Option 2: One-Time Migration**
- On first encryption setup, offer to encrypt all existing notes
- Show progress dialog
- Backup recommended before migration

**Implementation (Lazy Migration)**:
Already handled by `encryptNote()` and `decryptNote()` functions which check the `encrypted` flag.

---

## Security Considerations

### Key Management
- **Master password**: Never stored, only in memory
- **Encryption key**: Derived from password, only in memory
- **Salt**: Stored in settings (not sensitive, required for key derivation)
- **Session timeout**: 15 minutes of inactivity
- **Nextcloud credentials**: Stored in OS keychain, optionally protected by biometric authentication

### Biometric Security
- **Hardware-backed**: Uses OS-native biometric APIs (TPM on Windows, Secure Enclave on macOS)
- **Privacy**: Biometric data never leaves the device, never sent to app
- **Fallback**: If biometric fails, credentials can be cleared and re-entered
- **Optional**: Users can choose to enable/disable biometric protection
- **Transparent**: App only receives authentication success/failure from OS

### Threat Model Coverage

| Threat | Mitigation |
|--------|------------|
| Physical device access | ✅ Data encrypted at rest |
| Stolen device (powered off) | ✅ Data encrypted, key not recoverable |
| Stolen device (logged in) | ✅ Biometric + session timeout |
| Credential theft | ✅ OS keychain + biometric protection |
| Malware on system | ⚠️ Can't protect against keyloggers (but biometric helps) |
| Nextcloud admin access | ✅ Data encrypted end-to-end |
| Nextcloud server breach | ✅ Data encrypted |
| Network eavesdropping | ✅ HTTPS enforced |
| XSS attacks | ✅ CSP mitigates |

### Limitations
- **No protection against**:
  - Keyloggers capturing master password (but biometric reduces risk)
  - Screen recording malware
  - Memory dumps while unlocked
  - Compromised OS/kernel
  - Physical coercion to use biometric authentication
- **User responsibility**:
  - Strong master password
  - OS-level security
  - Physical device security
  - Enrolling strong biometric (e.g., actual fingerprint, not photo for face recognition)

---

## Performance Impact

### Expected Performance
- **Key derivation**: ~100ms (one-time per session)
- **Encryption per note**: ~5-10ms
- **Decryption per note**: ~5-10ms
- **Bulk operations**: Parallelizable with `Promise.all()`

### Optimization Strategies
- Cache decrypted notes in memory (with session timeout)
- Lazy decrypt (only when note is opened)
- Background encryption for sync

---

## Dependencies

### New Dependencies
None! All encryption uses Web Crypto API (built into browsers/webviews).

### Tauri Plugins
- `tauri-plugin-store` (Phase 1 - credential storage)
- `tauri-plugin-biometric` or custom Rust implementation (Phase 1 - biometric auth)

### Platform-Specific Dependencies
- **Windows**: `windows` crate with `Security_Credentials_UI` feature
- **macOS**: osascript (built-in) for LocalAuthentication framework access
- **Linux**: fprintd service (optional, for fingerprint support)

---

## Rollback Plan

If issues arise:

1. **Disable encryption**:
   - Remove encryption calls from `saveNote()`/`getNote()`
   - Keep encrypted data (can decrypt later)

2. **Recover from failed decryption**:
   - Export raw encrypted JSON from IndexedDB
   - Decrypt manually with password

3. **Complete rollback**:
   - Remove encryption wrapper functions
   - Legacy unencrypted notes continue working

---

## Timeline Estimate

- **Phase 1** (Secure Credentials + Biometric Auth): 3-4 days
  - Tauri plugin integration: 1 day
  - Biometric authentication (cross-platform): 1-2 days
  - Credential migration & UI: 1 day
- **Phase 2** (HTTPS Enforcement): 1-2 days
- **Phase 3** (Note Encryption): 4-5 days
- **Testing & Refinement**: 2-3 days

**Total**: ~2-3 weeks

---

## Phase 4: Mobile Biometric Support (Android/iOS)

**Goal**: Extend biometric authentication support to Android and iOS platforms.

**Status**: Planned for future implementation (after Phase 1-3 complete)

### Current Limitation

As of Phase 1 implementation:
- ✅ **Desktop platforms** fully supported (Windows Hello, macOS Touch ID, Linux fingerprint)
- ❌ **Mobile platforms** return "not available"
  - Android: No BiometricPrompt integration
  - iOS: No Face ID/Touch ID integration
- ⚠️ **Credentials still secured** on mobile using `tauri-plugin-store`, just without biometric protection

### 4.1 Android Biometric Implementation

**Requirements:**
- Android API 28+ (Android 9.0 Pie) for BiometricPrompt API
- Tauri v2 mobile support
- Kotlin/Java code for native Android integration

**Implementation approach:**

1. **Add Android dependencies** (`src-tauri/gen/android/app/build.gradle`):
```gradle
dependencies {
    implementation 'androidx.biometric:biometric:1.2.0-alpha05'
}
```

2. **Create Kotlin biometric helper** (`src-tauri/gen/android/app/src/main/java/BiometricHelper.kt`):
```kotlin
package com.onejournal.app

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

class BiometricHelper(private val activity: FragmentActivity) {

    fun checkAvailability(): BiometricAvailability {
        val biometricManager = BiometricManager.from(activity)

        return when (biometricManager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)) {
            BiometricManager.BIOMETRIC_SUCCESS -> {
                BiometricAvailability(available = true, type = "fingerprint_or_face")
            }
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> {
                BiometricAvailability(available = false, type = "none")
            }
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> {
                BiometricAvailability(available = false, type = "none")
            }
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> {
                BiometricAvailability(available = false, type = "none")
            }
            else -> BiometricAvailability(available = false, type = "none")
        }
    }

    fun authenticate(reason: String, callback: (Boolean) -> Unit) {
        val executor = ContextCompat.getMainExecutor(activity)

        val biometricPrompt = BiometricPrompt(activity, executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    super.onAuthenticationError(errorCode, errString)
                    callback(false)
                }

                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    super.onAuthenticationSucceeded(result)
                    callback(true)
                }

                override fun onAuthenticationFailed() {
                    super.onAuthenticationFailed()
                    callback(false)
                }
            })

        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Authentication Required")
            .setSubtitle(reason)
            .setNegativeButtonText("Cancel")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .build()

        biometricPrompt.authenticate(promptInfo)
    }
}

data class BiometricAvailability(
    val available: Boolean,
    val type: String
)
```

3. **Create Tauri plugin bridge** (Rust side, `src-tauri/src/mobile.rs`):
```rust
#[cfg(target_os = "android")]
use jni::JNIEnv;
#[cfg(target_os = "android")]
use jni::objects::{JClass, JString, JValue};
#[cfg(target_os = "android")]
use jni::sys::jboolean;

#[cfg(target_os = "android")]
#[tauri::command]
async fn check_biometric_availability_android(app: tauri::AppHandle) -> Result<BiometricCapability, String> {
    // Call Kotlin BiometricHelper via JNI
    // Implementation details depend on Tauri's Android plugin API

    // Placeholder for actual JNI call
    Ok(BiometricCapability {
        available: false,
        biometric_type: "android_biometric".to_string(),
    })
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn authenticate_biometric_android(reason: String, app: tauri::AppHandle) -> Result<bool, String> {
    // Call Kotlin BiometricHelper.authenticate() via JNI
    // Implementation details depend on Tauri's Android plugin API

    Ok(false)
}
```

4. **Update main Rust commands** to use Android implementation:
```rust
#[tauri::command]
async fn check_biometric_availability(app: tauri::AppHandle) -> Result<BiometricCapability, String> {
    #[cfg(target_os = "windows")]
    { /* existing Windows implementation */ }

    #[cfg(target_os = "macos")]
    { /* existing macOS implementation */ }

    #[cfg(target_os = "linux")]
    { /* existing Linux implementation */ }

    #[cfg(target_os = "android")]
    {
        return check_biometric_availability_android(app).await;
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux", target_os = "android")))]
    {
        Ok(BiometricCapability {
            available: false,
            biometric_type: "none".to_string(),
        })
    }
}
```

### 4.2 iOS Biometric Implementation

**Requirements:**
- iOS 11+ for Face ID/Touch ID
- Tauri v2 mobile support
- Swift/Objective-C code for native iOS integration

**Implementation approach:**

1. **Update iOS permissions** (`src-tauri/gen/ios/Info.plist`):
```xml
<key>NSFaceIDUsageDescription</key>
<string>We use Face ID to protect your Nextcloud credentials</string>
```

2. **Create Swift biometric helper** (`src-tauri/gen/ios/Sources/BiometricHelper.swift`):
```swift
import Foundation
import LocalAuthentication

class BiometricHelper {

    func checkAvailability() -> (available: Bool, type: String) {
        let context = LAContext()
        var error: NSError?

        if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
            switch context.biometryType {
            case .faceID:
                return (true, "face_id")
            case .touchID:
                return (true, "touch_id")
            default:
                return (false, "none")
            }
        }

        return (false, "none")
    }

    func authenticate(reason: String, completion: @escaping (Bool) -> Void) {
        let context = LAContext()
        var error: NSError?

        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            completion(false)
            return
        }

        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                             localizedReason: reason) { success, error in
            DispatchQueue.main.async {
                completion(success)
            }
        }
    }
}
```

3. **Create Tauri plugin bridge** (Rust side):
```rust
#[cfg(target_os = "ios")]
use objc::{msg_send, sel, sel_impl};

#[cfg(target_os = "ios")]
#[tauri::command]
async fn check_biometric_availability_ios() -> Result<BiometricCapability, String> {
    // Call Swift BiometricHelper via Objective-C bridge
    // Implementation details depend on Tauri's iOS plugin API

    Ok(BiometricCapability {
        available: false,
        biometric_type: "ios_biometric".to_string(),
    })
}
```

### 4.3 Tauri Mobile Plugin Architecture

**Option A: Use Tauri Plugin System**
- Create a proper Tauri plugin with mobile support
- Package as `tauri-plugin-biometric-mobile`
- Cleaner separation, reusable by other projects

**Option B: Direct Integration**
- Embed native code directly in the app
- Simpler for single-app use case
- Less overhead

**Recommendation**: Start with Option B (direct integration), refactor to Option A if needed.

### 4.4 Testing on Mobile

**Android testing:**
- Test on physical device with fingerprint sensor
- Test on emulator with simulated fingerprint
- Test on device with face unlock
- Test fallback when no biometric enrolled

**iOS testing:**
- Test on physical device with Touch ID (older iPhones/iPads)
- Test on physical device with Face ID (iPhone X+)
- Test on simulator (limited biometric simulation)
- Test fallback when biometric disabled

### 4.5 Mobile-Specific Considerations

**Security:**
- Android: Uses hardware-backed keystore (TEE/Secure Enclave on supported devices)
- iOS: Always hardware-backed (Secure Enclave)
- Both platforms: Biometric data never leaves device

**User Experience:**
- Mobile prompts are modal and block UI (expected behavior)
- No need for window focus handling (like on Windows)
- System handles cancellation and retry logic

**Permissions:**
- Android: No special permissions required for BiometricPrompt
- iOS: Requires `NSFaceIDUsageDescription` in Info.plist

**Fallback:**
- Both platforms support fallback to PIN/pattern/password
- Configure via BiometricPrompt options (Android) or LAPolicy (iOS)

### 4.6 Timeline Estimate

**Android implementation**: 2-3 days
- Kotlin helper: 0.5 day
- JNI bridge: 1 day
- Testing: 0.5-1 day
- Platform-specific bug fixes: 0.5-1 day

**iOS implementation**: 2-3 days
- Swift helper: 0.5 day
- Objective-C bridge: 1 day
- Testing: 0.5-1 day
- Platform-specific bug fixes: 0.5-1 day

**Total Phase 4**: ~5-7 days

### 4.7 Dependencies

**New dependencies (Android):**
```toml
# build.gradle
androidx.biometric:biometric:1.2.0-alpha05
```

**New dependencies (iOS):**
```swift
// Built-in frameworks (no additional dependencies)
import LocalAuthentication
```

**Rust crates:**
```toml
# Cargo.toml
[target.'cfg(target_os = "android")'.dependencies]
jni = "0.21"  # For JNI bridge

[target.'cfg(target_os = "ios")'.dependencies]
objc = "0.2"  # For Objective-C bridge
```

### 4.8 Current Workaround

Until Phase 4 is implemented, mobile users can:
- ✅ Still use secure credential storage (tauri-plugin-store)
- ✅ Credentials are encrypted at rest by the OS
- ❌ Cannot use biometric authentication for additional protection
- ℹ️ Security is still good, just missing the convenience/extra layer

---

## Next Steps

1. Review this plan and approve phases
2. Begin Phase 1 implementation
3. Test thoroughly after each phase
4. Deploy incrementally to minimize risk
5. Consider Phase 4 (mobile biometric) after desktop implementation is stable
