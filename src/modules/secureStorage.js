/**
 * Secure Storage Module
 *
 * Desktop (Windows/macOS/Linux/iOS):
 *   Uses tauri-plugin-stronghold — an encrypted on-disk vault opened with a
 *   32-byte random key stored in the OS keychain (Windows Credential Manager,
 *   macOS/iOS Keychain, Linux Secret Service).
 *
 * Android:
 *   Uses DeviceKeyPlugin (Kotlin) — credentials encrypted with Android Keystore
 *   hardware-backed AES-256-GCM and stored in SharedPreferences. Stronghold is
 *   excluded from Android builds due to a libsodium C cross-compilation issue.
 *
 * Browser / dev-without-Tauri:
 *   Falls back to Web Crypto API with a hardcoded key (development only).
 *
 * Migration: on first run after this update, existing localStorage secrets
 * encrypted with the old hardcoded key are transparently migrated and removed.
 */

import { invoke } from "@tauri-apps/api/core";

// ── Stronghold state (desktop only) ──────────────────────────────────────────

let _stronghold = null;
let _store = null;
let _initPromise = null;

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
  await invoke("save_credential", { key, value });
}

async function _androidGet(key) {
  const result = await invoke("get_credential", { key });
  // Rust returns Result<Option<String>> → Tauri serializes as string | null directly
  return result ?? null;
}

async function _androidDelete(key) {
  await invoke("delete_credential", { key });
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
    console.info(`[SecureStorage] Android: localStorage 'secure_${key}' present=${oldEncrypted !== null}`);
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

// ── Desktop path: Stronghold ──────────────────────────────────────────────────

async function _initStronghold() {
  if (_store) return _store;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const { appLocalDataDir } = await import("@tauri-apps/api/path");
      const { Stronghold } = await import("@tauri-apps/plugin-stronghold");

      // get_or_create_vault_key returns a JSON array of numbers (Vec<u8>).
      // Pass as hex string — the Stronghold Builder::new closure decodes it.
      const keyBytes = await invoke("get_or_create_vault_key");
      const vaultPassword = Array.from(keyBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const dataDir = await appLocalDataDir();
      _stronghold = await Stronghold.load(`${dataDir}/noteberg.vault`, vaultPassword);

      // loadClient throws if the client doesn't exist yet (new vault).
      // In that case, create it.
      let client;
      try {
        client = await _stronghold.loadClient("noteberg-v1");
      } catch {
        client = await _stronghold.createClient("noteberg-v1");
      }
      _store = client.getStore();

      await _desktopMigrateFromLocalStorage(_store);

      return _store;
    } catch (err) {
      _initPromise = null;
      throw err;
    }
  })();

  return _initPromise;
}

async function _desktopMigrateFromLocalStorage(store) {
  let migrated = 0;
  for (const key of MANAGED_KEYS) {
    const existing = await store.get(key).catch(() => null);
    if (existing) continue;
    const oldEncrypted = localStorage.getItem(`secure_${key}`);
    if (!oldEncrypted) continue;
    try {
      const plaintext = await _legacyDecrypt(oldEncrypted);
      if (plaintext) {
        await store.insert(key, Array.from(new TextEncoder().encode(plaintext)));
        migrated++;
        console.info(`[SecureStorage] Migrated '${key}' to Stronghold`);
      }
    } catch (e) {
      console.warn(`[SecureStorage] Could not migrate '${key}':`, e);
    }
  }
  if (migrated > 0) {
    await _stronghold.save();
    for (const key of MANAGED_KEYS) localStorage.removeItem(`secure_${key}`);
    console.info(`[SecureStorage] Migration complete: ${migrated} secret(s) moved to Stronghold`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function saveSecureCredential(key, value) {
  if (!_isTauriEnvironment()) return _legacySave(key, value);
  if (_isAndroid()) {
    await _androidMigrateFromLocalStorage(); // run once lazily
    return _androidSave(key, value);
  }
  const store = await _initStronghold();
  await store.insert(key, Array.from(new TextEncoder().encode(value)));
  await _stronghold.save();
}

export async function getSecureCredential(key) {
  if (!_isTauriEnvironment()) return _legacyGet(key);
  if (_isAndroid()) {
    await _androidMigrateFromLocalStorage(); // run once lazily
    return _androidGet(key);
  }
  try {
    const store = await _initStronghold();
    const bytes = await store.get(key);
    if (!bytes) return null;
    return new TextDecoder().decode(new Uint8Array(bytes));
  } catch (err) {
    console.error("[SecureStorage] Stronghold read failed:", err);
    return null;
  }
}

export async function deleteSecureCredential(key) {
  if (!_isTauriEnvironment()) return _legacyDelete(key);
  if (_isAndroid()) return _androidDelete(key);
  const store = await _initStronghold();
  await store.remove(key);
  await _stronghold.save();
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
    { name: "PBKDF2", salt: new TextEncoder().encode(_LEGACY_SALT), iterations: 10000, hash: "SHA-256" },
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
  if (!_isCryptoAvailable()) { localStorage.setItem(`secure_${key}`, value); return; }
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
  try { return await _legacyDecrypt(stored); } catch { return stored; }
}

function _legacyDelete(key) {
  localStorage.removeItem(`secure_${key}`);
}
