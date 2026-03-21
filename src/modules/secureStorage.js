/**
 * Secure Storage Module
 *
 * In Tauri: uses tauri-plugin-stronghold to store secrets in an encrypted
 * on-disk vault. The vault is opened with a 32-byte random key managed by the
 * OS keychain (Windows Credential Manager, macOS/iOS Keychain, Linux Secret
 * Service, Android Keystore). No hardcoded keys, no localStorage for secrets.
 *
 * In browser/dev-without-Tauri: falls back to Web Crypto API with a hardcoded
 * key (same as the original implementation — acceptable for development only).
 *
 * Migration: on first run after this update, existing localStorage secrets
 * encrypted with the old hardcoded key are transparently migrated to Stronghold
 * and then removed from localStorage.
 */

// ── Stronghold state ──────────────────────────────────────────────────────────

let _stronghold = null;
let _store = null;
let _initPromise = null;

const MANAGED_KEYS = ["master_password", "nextcloud_credentials"];

// ── Environment detection ─────────────────────────────────────────────────────

function _isTauriEnvironment() {
  if (typeof window === "undefined") return false;
  return window.__TAURI_INTERNALS__ !== undefined || window.__TAURI__ !== undefined;
}

// ── Stronghold initialization ─────────────────────────────────────────────────

async function _initStronghold() {
  if (_store) return _store;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { appLocalDataDir } = await import("@tauri-apps/api/path");
      const { Stronghold } = await import("@tauri-apps/plugin-stronghold");

      // Get (or create) the 32-byte random vault key from the OS keychain.
      // Returned as a JSON array of numbers by Tauri's serialization.
      const keyBytes = await invoke("get_or_create_vault_key");

      // Stronghold.load expects the password as a Uint8Array
      const vaultPassword = new Uint8Array(keyBytes);
      const dataDir = await appLocalDataDir();
      const vaultPath = `${dataDir}/noteberg.vault`;

      _stronghold = await Stronghold.load(vaultPath, vaultPassword);
      const client = await _stronghold.loadClient("noteberg-v1");
      _store = client.getStore();

      await _migrateFromLocalStorage(_store);

      return _store;
    } catch (err) {
      _initPromise = null; // allow retry on next call
      throw err;
    }
  })();

  return _initPromise;
}

// ── Migration from legacy localStorage ───────────────────────────────────────

async function _migrateFromLocalStorage(store) {
  let migrated = 0;

  for (const key of MANAGED_KEYS) {
    // Skip if already present in Stronghold
    const existing = await store.get(key).catch(() => null);
    if (existing) continue;

    // Check for legacy localStorage entry
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
      console.warn(`[SecureStorage] Could not migrate legacy '${key}':`, e);
    }
  }

  if (migrated > 0) {
    await _stronghold.save();
    for (const key of MANAGED_KEYS) {
      localStorage.removeItem(`secure_${key}`);
    }
    console.info(`[SecureStorage] Migration complete: ${migrated} secret(s) moved to Stronghold`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Save a credential. In Tauri, stores in Stronghold. Falls back to encrypted localStorage.
 * @param {string} key
 * @param {string} value
 */
export async function saveSecureCredential(key, value) {
  if (!_isTauriEnvironment()) {
    return _legacySave(key, value);
  }
  const store = await _initStronghold();
  await store.insert(key, Array.from(new TextEncoder().encode(value)));
  await _stronghold.save();
}

/**
 * Retrieve a credential. In Tauri, reads from Stronghold. Falls back to encrypted localStorage.
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export async function getSecureCredential(key) {
  if (!_isTauriEnvironment()) {
    return _legacyGet(key);
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

/**
 * Delete a credential.
 * @param {string} key
 */
export async function deleteSecureCredential(key) {
  if (!_isTauriEnvironment()) {
    return _legacyDelete(key);
  }
  const store = await _initStronghold();
  await store.remove(key);
  await _stronghold.save();
}

// ── Legacy fallback (browser / dev mode) + migration decryption ──────────────
//
// These functions use the original hardcoded-key AES-256-GCM scheme.
// They are kept for:
//   1. Browser/dev-mode fallback (no Tauri available)
//   2. One-time migration: decrypting old localStorage entries on first run

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
  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);
  const decrypted = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
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
    const encrypted = await _legacyEncrypt(value);
    localStorage.setItem(`secure_${key}`, encrypted);
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
    return stored; // stored as plain text (fallback path)
  }
}

function _legacyDelete(key) {
  localStorage.removeItem(`secure_${key}`);
}
