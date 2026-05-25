/**
 * Secure Storage Module
 *
 * Desktop (Windows/macOS/Linux/iOS):
 *   Uses the OS native keychain directly via Tauri commands (keyring crate):
 *   Windows Credential Manager, macOS/iOS Keychain, Linux Secret Service.
 *   Fast — no vault file, no snapshot decryption, just one IPC call.
 *
 * Android:
 *   Uses DeviceKeyPlugin (Kotlin) — credentials encrypted with Android Keystore
 *   hardware-backed AES-256-GCM and stored in SharedPreferences.
 *
 * Browser / dev-without-Tauri:
 *   Falls back to Web Crypto API with a hardcoded key (development only).
 *
 * Migration: on first run, existing localStorage secrets encrypted with the
 * old hardcoded key are transparently migrated to the OS keychain and removed.
 */

let _invoke = null;
async function _getInvoke() {
  if (!_invoke) ({ invoke: _invoke } = await import("@tauri-apps/api/core"));
  return _invoke;
}

const MANAGED_KEYS = ["master_password", "nextcloud_credentials"];

// ── Environment detection ─────────────────────────────────────────────────────

function _isTauriEnvironment() {
  if (typeof window === "undefined") return false;
  return window.__TAURI_INTERNALS__ !== undefined || window.__TAURI__ !== undefined;
}

// Detect Android via user agent — reliable in Tauri's Android WebView.
function _isAndroid() {
  return typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
}

// ── Android path: DeviceKeyPlugin via Tauri commands ─────────────────────────

let _androidMigrationDone = false;

async function _androidSave(key, value) {
  await (await _getInvoke())("save_credential", { key, value });
}

async function _androidGet(key) {
  const result = await (await _getInvoke())("get_credential", { key });
  // Rust returns Result<Option<String>> → Tauri serializes as string | null directly
  return result ?? null;
}

async function _androidDelete(key) {
  await (await _getInvoke())("delete_credential", { key });
}

async function _androidMigrateFromLocalStorage() {
  if (_androidMigrationDone) return;
  _androidMigrationDone = true;
  let migrated = 0;
  for (const key of MANAGED_KEYS) {
    const existing = await _androidGet(key).catch(() => null);
    if (existing) {
      console.info(`[SecureStorage] Android: '${key}' already in DeviceKeyPlugin`);
      continue;
    }
    const oldEncrypted = localStorage.getItem(`secure_${key}`);
    console.info(
      `[SecureStorage] Android: localStorage 'secure_${key}' present=${oldEncrypted !== null}`,
    );
    if (!oldEncrypted) continue;
    try {
      const plaintext = await _legacyDecrypt(oldEncrypted);
      if (plaintext) {
        await _androidSave(key, plaintext);
        migrated++;
        console.info(`[SecureStorage] Android: migrated '${key}' to DeviceKeyPlugin`);
      }
    } catch (e) {
      console.warn(`[SecureStorage] Android: could not migrate '${key}':`, e);
    }
  }
  if (migrated > 0) {
    for (const key of MANAGED_KEYS) localStorage.removeItem(`secure_${key}`);
    console.info(`[SecureStorage] Android: migration complete (${migrated} secret(s))`);
  }
}

// ── Desktop path: OS keychain via Tauri commands ─────────────────────────────
//
// Uses save_credential / get_credential / delete_credential Tauri commands which
// call the keyring crate (Windows Credential Manager, macOS Keychain, Linux
// Secret Service). This is fast — no vault file, no snapshot decryption.

async function _desktopMigrateFromLocalStorage() {
  let migrated = 0;
  for (const key of MANAGED_KEYS) {
    const existing = await (await _getInvoke())("get_credential", { key }).catch(() => null);
    if (existing) continue;
    const oldEncrypted = localStorage.getItem(`secure_${key}`);
    if (!oldEncrypted) continue;
    try {
      const plaintext = await _legacyDecrypt(oldEncrypted);
      if (plaintext) {
        await (await _getInvoke())("save_credential", { key, value: plaintext });
        migrated++;
        console.info(`[SecureStorage] Migrated '${key}' to OS keychain`);
      }
    } catch (e) {
      console.warn(`[SecureStorage] Could not migrate '${key}':`, e);
    }
  }
  if (migrated > 0) {
    for (const key of MANAGED_KEYS) localStorage.removeItem(`secure_${key}`);
    console.info(`[SecureStorage] Migration complete: ${migrated} secret(s) moved to OS keychain`);
  }
}

let _desktopMigrationDone = false;
async function _ensureDesktopMigration() {
  if (_desktopMigrationDone) return;
  _desktopMigrationDone = true;
  await _desktopMigrateFromLocalStorage();
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function saveSecureCredential(key, value) {
  if (!_isTauriEnvironment()) return _legacySave(key, value);
  if (_isAndroid()) {
    await _androidMigrateFromLocalStorage(); // run once lazily
    return _androidSave(key, value);
  }
  await _ensureDesktopMigration();
  await (await _getInvoke())("save_credential", { key, value });
}

export async function getSecureCredential(key) {
  if (!_isTauriEnvironment()) return _legacyGet(key);
  if (_isAndroid()) {
    await _androidMigrateFromLocalStorage(); // run once lazily
    return _androidGet(key);
  }
  try {
    await _ensureDesktopMigration();
    return await (await _getInvoke())("get_credential", { key });
  } catch (err) {
    console.error("[SecureStorage] Keychain read failed:", err);
    return null;
  }
}

export async function deleteSecureCredential(key) {
  if (!_isTauriEnvironment()) return _legacyDelete(key);
  if (_isAndroid()) return _androidDelete(key);
  await _ensureDesktopMigration();
  await (await _getInvoke())("delete_credential", { key });
}

// ── Legacy fallback (browser / dev mode) + migration decryption ──────────────

const _LEGACY_PASSWORD = "noteberg_secure_storage_2025";
const _LEGACY_SALT = "noteberg_salt_v1";
let _legacyKey = null;

function _isCryptoAvailable() {
  return typeof window !== "undefined" && window.crypto && window.crypto.subtle;
}

async function _getLegacyKey() {
  if (_legacyKey) return _legacyKey;
  if (!_isCryptoAvailable()) throw new Error("Web Crypto API not available");
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(_LEGACY_PASSWORD),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"],
  );
  _legacyKey = await window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(_LEGACY_SALT),
      iterations: 10000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return _legacyKey;
}

async function _legacyDecrypt(encryptedBase64) {
  const key = await _getLegacyKey();
  const combined = Uint8Array.from(atob(encryptedBase64), (c) => c.charCodeAt(0));
  const decrypted = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: combined.slice(0, 12) },
    key,
    combined.slice(12),
  );
  return new TextDecoder().decode(decrypted);
}

async function _legacyEncrypt(plaintext) {
  const key = await _getLegacyKey();
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function _legacySave(key, value) {
  if (!_isCryptoAvailable()) {
    localStorage.setItem(`secure_${key}`, value);
    return;
  }
  try {
    localStorage.setItem(`secure_${key}`, await _legacyEncrypt(value));
  } catch (e) {
    console.error("[SecureStorage] Legacy encrypt failed, storing plain:", e);
    localStorage.setItem(`secure_${key}`, value);
  }
}

async function _legacyGet(key) {
  const stored = localStorage.getItem(`secure_${key}`);
  if (!stored) return null;
  if (!_isCryptoAvailable()) return stored;
  try {
    return await _legacyDecrypt(stored);
  } catch {
    return stored;
  }
}

function _legacyDelete(key) {
  localStorage.removeItem(`secure_${key}`);
}
