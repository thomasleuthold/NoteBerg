/**
 * Secure Storage Module
 * Handles OS-native secure credential storage with biometric authentication support
 * Falls back to localStorage in browser/dev mode
 */

import { invoke } from "@tauri-apps/api/core";
import { getSetting, setSetting } from "./storage.js";

const BIOMETRIC_ENABLED_KEY = "biometric_auth_enabled";

// Cache for credentials to avoid excessive Rust calls
const credentialCache = new Map();
let cacheInitialized = false;

/**
 * Check if running in Tauri environment
 * In Tauri v2, window.__TAURI__ may not be set, so we check for window.__TAURI_INTERNALS__ instead
 * @returns {boolean}
 */
function isTauriEnvironment() {
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
 * Check if biometric authentication is available on this device
 * @returns {Promise<{available: boolean, biometricType: string}>}
 */
export async function checkBiometricAvailability() {
  console.log("[JS] checkBiometricAvailability called");
  console.log("[JS] window.__TAURI__:", typeof window.__TAURI__);
  console.log("[JS] window.__TAURI_INTERNALS__:", typeof window.__TAURI_INTERNALS__);
  console.log("[JS] isTauriEnvironment:", isTauriEnvironment());

  if (!isTauriEnvironment()) {
    console.log("[JS] Not in Tauri environment, returning unavailable");
    return { available: false, biometricType: "none" };
  }

  try {
    console.log("[JS] Calling Rust check_biometric_availability...");
    const result = await invoke("check_biometric_availability");
    console.log("[JS] Rust returned:", result);
    return result;
  } catch (error) {
    console.error("[JS] Failed to check biometric availability:", error);
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
  if (!isTauriEnvironment()) {
    return false;
  }

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
 * Falls back to localStorage in browser/dev mode
 * @param {string} key - Credential key
 * @param {string} value - Credential value
 */
export async function saveSecureCredential(key, value) {
  console.log("[JS] saveSecureCredential called, key:", key);

  // Fallback to localStorage in browser/dev mode
  if (!isTauriEnvironment()) {
    console.warn("[JS] Running in browser mode - using localStorage instead of secure storage");
    localStorage.setItem(key, value);
    credentialCache.set(key, value); // Update cache
    return;
  }

  try {
    const useBiometric = await isBiometricEnabled();
    console.log("[JS] Calling Rust save_secure_credential, useBiometric:", useBiometric);
    await invoke("save_secure_credential", {
      key,
      value,
      useBiometric,
    });
    credentialCache.set(key, value); // Update cache
    console.log(`[JS] Secure credential saved: ${key} (biometric: ${useBiometric})`);
  } catch (error) {
    console.error("[JS] Failed to save secure credential:", error);
    throw error;
  }
}

/**
 * Retrieve credentials from OS-native secure storage
 * Requires biometric authentication if enabled
 * Falls back to localStorage in browser/dev mode
 * @param {string} key - Credential key
 * @returns {Promise<string|null>} Credential value or null
 */
export async function getSecureCredential(key) {
  // Check cache first
  if (cacheInitialized && credentialCache.has(key)) {
    console.log("[JS] getSecureCredential cache hit for key:", key);
    return credentialCache.get(key);
  }

  console.log("[JS] getSecureCredential cache miss, fetching key:", key);

  // Fallback to localStorage in browser/dev mode
  if (!isTauriEnvironment()) {
    const value = localStorage.getItem(key);
    credentialCache.set(key, value);
    cacheInitialized = true;
    console.log("[JS] Retrieved from localStorage:", value ? "present" : "null");
    return value;
  }

  try {
    console.log("[JS] Calling Rust get_secure_credential...");
    const value = await invoke("get_secure_credential", { key });
    credentialCache.set(key, value);
    cacheInitialized = true;
    console.log("[JS] Rust returned value:", value ? "present" : "null");
    return value;
  } catch (error) {
    console.error("[JS] Failed to get secure credential:", error);
    // Check if error is due to biometric failure
    if (error.toString().includes("Biometric authentication failed")) {
      throw new Error("Biometric authentication required");
    }
    // Check if key not found
    if (error.toString().includes("Key not found")) {
      console.log("[JS] Key not found in store");
      credentialCache.set(key, null);
      cacheInitialized = true;
      return null;
    }
    return null;
  }
}

/**
 * Delete credentials from OS-native secure storage
 * Falls back to localStorage in browser/dev mode
 * @param {string} key - Credential key
 */
export async function deleteSecureCredential(key) {
  // Clear from cache
  credentialCache.delete(key);

  // Fallback to localStorage in browser/dev mode
  if (!isTauriEnvironment()) {
    localStorage.removeItem(key);
    return;
  }

  try {
    const useBiometric = await isBiometricEnabled();
    await invoke("delete_secure_credential", { key, useBiometric });
    console.log(`Secure credential deleted: ${key}`);
  } catch (error) {
    console.error("Failed to delete secure credential:", error);
    throw error;
  }
}
