/**
 * Secure Storage Module
 * Handles encrypted credential storage using Web Crypto API with AES-256-GCM
 * Falls back to plain localStorage in browser/dev mode if crypto unavailable
 *
 * Security note: The encryption key is derived from a hardcoded password.
 * This provides protection against casual local file inspection but is not
 * secure against determined attackers with access to the source code.
 */

// Hardcoded password for deriving encryption key
const STORAGE_PASSWORD = "noteberg_secure_storage_2025";

// Cache for encryption key to avoid re-deriving it
let encryptionKey = null;

/**
 * Check if running in Tauri environment
 * @returns {boolean}
 */
function _isTauriEnvironment() {
  // Tauri v2 sets window.__TAURI_INTERNALS__
  if (typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined) {
    return true;
  }
  // Fallback to window.__TAURI__ for older versions
  if (typeof window !== "undefined" && window.__TAURI__ !== undefined) {
    return true;
  }
  return false;
}

/**
 * Check if Web Crypto API is available
 * @returns {boolean}
 */
function isCryptoAvailable() {
  return typeof window !== "undefined" && window.crypto && window.crypto.subtle;
}

/**
 * Derive encryption key from password using PBKDF2
 * @returns {Promise<CryptoKey>}
 */
async function getEncryptionKey() {
  if (encryptionKey) {
    return encryptionKey;
  }

  if (!isCryptoAvailable()) {
    throw new Error("Web Crypto API not available");
  }

  // Use fixed salt for deterministic key derivation
  const salt = new TextEncoder().encode("noteberg_salt_v1");

  // Import password as key material
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(STORAGE_PASSWORD),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"],
  );

  // Derive AES-GCM key
  encryptionKey = await window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 10000, // Reasonable iterations for fast performance
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return encryptionKey;
}

/**
 * Encrypt data using AES-256-GCM
 * @param {string} plaintext - Data to encrypt
 * @returns {Promise<string>} Base64-encoded encrypted data with IV
 */
async function encryptData(plaintext) {
  const key = await getEncryptionKey();

  // Generate random IV for each encryption
  const iv = window.crypto.getRandomValues(new Uint8Array(12));

  // Encrypt the data
  const encrypted = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv },
    key,
    new TextEncoder().encode(plaintext),
  );

  // Combine IV and encrypted data
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  // Return as base64
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt data using AES-256-GCM
 * @param {string} encryptedBase64 - Base64-encoded encrypted data with IV
 * @returns {Promise<string>} Decrypted plaintext
 */
async function decryptData(encryptedBase64) {
  const key = await getEncryptionKey();

  // Decode from base64
  const combined = Uint8Array.from(atob(encryptedBase64), (c) => c.charCodeAt(0));

  // Extract IV and encrypted data
  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);

  // Decrypt the data
  const decrypted = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, encrypted);

  return new TextDecoder().decode(decrypted);
}

/**
 * Save credentials to encrypted localStorage
 * @param {string} key - Credential key
 * @param {string} value - Credential value
 */
export async function saveSecureCredential(key, value) {
  if (!isCryptoAvailable()) {
    console.warn("[SecureStorage] Web Crypto API not available - storing in plain localStorage");
    localStorage.setItem(`secure_${key}`, value);
    return;
  }

  try {
    const encrypted = await encryptData(value);
    localStorage.setItem(`secure_${key}`, encrypted);
    console.info("[SecureStorage] Credential saved:", key);
  } catch (error) {
    console.error("[SecureStorage] Encryption failed, falling back to plain storage:", error);
    localStorage.setItem(`secure_${key}`, value);
  }
}

/**
 * Retrieve credentials from encrypted localStorage
 * @param {string} key - Credential key
 * @returns {Promise<string|null>} Credential value or null
 */
export async function getSecureCredential(key) {
  const stored = localStorage.getItem(`secure_${key}`);
  if (!stored) {
    return null;
  }

  if (!isCryptoAvailable()) {
    console.warn("[SecureStorage] Web Crypto API not available - returning plain value");
    return stored;
  }

  try {
    return await decryptData(stored);
  } catch (error) {
    console.warn("[SecureStorage] Decryption failed, assuming plain storage:", error);
    return stored;
  }
}

/**
 * Delete credentials from encrypted localStorage
 * @param {string} key - Credential key
 */
export async function deleteSecureCredential(key) {
  localStorage.removeItem(`secure_${key}`);
}
