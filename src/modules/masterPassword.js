/**
 * Master Password Manager
 *
 * Manages the master password lifecycle and app unlock state.
 * Handles encryption key management and biometric unlock integration.
 */

import { decryptData, deriveKeyFromPassword, encryptData, generateSalt } from "./encryption.js";
import { getSetting, setSetting } from "./storage.js";
import { getSecureCredential, saveSecureCredential } from "./secureStorage.js";

// In-memory state (cleared on lock)
let encryptionKey = null;
let unlocked = false;
let unlockTime = null;
let autoLockTimeout = null;

// Storage keys
const STORAGE_KEYS = {
  ENCRYPTION_CONFIG: "encryption_config",
  BIOMETRIC_CONFIG: "biometric_unlock_config",
  PASSWORD_TEST: "password_test",
  AUTO_LOCK_TIMEOUT: "auto_lock_timeout_minutes",
};

// Default auto-lock timeout (minutes)
const DEFAULT_AUTO_LOCK_TIMEOUT = 15;

/**
 * Check if master password is configured
 * @returns {Promise<boolean>}
 */
export async function isMasterPasswordSet() {
  const config = await getSetting(STORAGE_KEYS.ENCRYPTION_CONFIG);
  return config !== null && config !== undefined;
}

/**
 * Get encryption configuration
 * @returns {Promise<Object|null>} Encryption config or null if not set
 */
async function getEncryptionConfig() {
  return await getSetting(STORAGE_KEYS.ENCRYPTION_CONFIG);
}

/**
 * Save encryption configuration
 * @param {Object} config - Encryption configuration
 */
async function saveEncryptionConfig(config) {
  await setSetting(STORAGE_KEYS.ENCRYPTION_CONFIG, config);
}

/**
 * Set up master password (first time setup)
 * @param {string} password - Master password
 * @param {string} [hint] - Optional password hint
 * @param {boolean} [enableBiometric] - Enable biometric unlock
 * @returns {Promise<void>}
 * @throws {Error} If password is too weak or setup fails
 */
export async function setupMasterPassword(password, hint = "", enableBiometric = false) {
  console.log("[MasterPassword] Setting up master password...");

  // Validate password
  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters long");
  }

  try {
    // Generate salt for this user
    const salt = generateSalt();
    const saltBase64 = bufferToBase64Helper(salt);

    // Derive encryption key from password
    const key = await deriveKeyFromPassword(password, salt);

    // Create a test encrypted value to verify password on unlock
    const testData = "master_password_verification";
    const testEncrypted = await encryptData(testData, key);

    // Save encryption configuration
    const config = {
      version: 1,
      salt: saltBase64,
      iterations: 100000,
      algorithm: "PBKDF2-SHA256",
      passwordHint: hint || null,
      createdAt: new Date().toISOString(),
    };
    await saveEncryptionConfig(config);

    // Save password test data
    await setSetting(STORAGE_KEYS.PASSWORD_TEST, testEncrypted);

    console.log("[MasterPassword] Master password configured successfully");

    // ALWAYS store master password in keyring for automatic unlock
    await saveSecureCredential("master_password", password);
    console.log("[MasterPassword] Master password stored in keyring");

    // Biometric unlock removed for performance
    if (enableBiometric) {
      console.warn(
        "[MasterPassword] Biometric unlock requested but feature removed for performance",
      );
    }

    // Automatically unlock the app
    encryptionKey = key;
    unlocked = true;
    unlockTime = Date.now();
    startAutoLockTimer();

    console.log("[MasterPassword] App unlocked after setup");
  } catch (error) {
    console.error("[MasterPassword] Failed to set up master password:", error);
    throw new Error(`Failed to set up master password: ${error.message}`);
  }
}

/**
 * Enable biometric unlock
 * Just sets the biometric config flag (password is already in keyring)
 * @param {string} password - Master password (unused, password already in keyring)
 * @param {CryptoKey} key - Current encryption key (unused, kept for compatibility)
 * @returns {Promise<void>}
 */
async function enableBiometricUnlock(_password, _key) {
  console.log("[MasterPassword] Enabling biometric unlock...");

  try {
    // Password is already stored in keyring during setupMasterPassword
    // Just save the biometric configuration flag
    const biometricConfig = {
      enabled: true,
      enabledAt: new Date().toISOString(),
    };
    await setSetting(STORAGE_KEYS.BIOMETRIC_CONFIG, biometricConfig);

    console.log("[MasterPassword] Biometric unlock enabled");
  } catch (error) {
    console.error("[MasterPassword] Failed to enable biometric unlock:", error);
    throw new Error("Failed to enable biometric unlock");
  }
}

/**
 * Disable biometric unlock
 * Note: Does NOT remove master password from keyring (it's always needed for auto-unlock)
 * @returns {Promise<void>}
 */
export async function disableBiometricUnlock() {
  console.log("[MasterPassword] Disabling biometric unlock...");

  try {
    // DO NOT delete master password from keyring - it's needed for automatic unlock
    // Just remove the biometric configuration flag
    await setSetting(STORAGE_KEYS.BIOMETRIC_CONFIG, null);
    console.log("[MasterPassword] Biometric unlock disabled");
  } catch (error) {
    console.error("[MasterPassword] Failed to disable biometric unlock:", error);
  }
}

/**
 * Check if biometric unlock is enabled
 * @returns {Promise<boolean>}
 */
export async function isBiometricUnlockEnabled() {
  const config = await getSetting(STORAGE_KEYS.BIOMETRIC_CONFIG);
  return config !== null && config.enabled === true;
}

/**
 * Unlock the app with master password
 * @param {string} password - Master password
 * @returns {Promise<boolean>} True if unlock successful
 */
export async function unlockApp(password) {
  console.log("[MasterPassword] Attempting to unlock app with password...");

  try {
    // Get encryption configuration
    const config = await getEncryptionConfig();
    if (!config) {
      throw new Error("Master password not configured");
    }

    // Convert salt from base64
    const salt = base64ToBufferHelper(config.salt);

    // Derive key from password
    const key = await deriveKeyFromPassword(password, salt);

    // Test the key by trying to decrypt the test data
    const testEncrypted = await getSetting(STORAGE_KEYS.PASSWORD_TEST);
    if (!testEncrypted) {
      throw new Error("Password verification data not found");
    }

    const testDecrypted = await decryptData(testEncrypted.data, testEncrypted.iv, key);
    if (testDecrypted !== "master_password_verification") {
      console.log("[MasterPassword] Password verification failed");
      return false;
    }

    // Password is correct - unlock the app
    encryptionKey = key;
    unlocked = true;
    unlockTime = Date.now();
    startAutoLockTimer();

    console.log("[MasterPassword] App unlocked successfully");
    return true;
  } catch (error) {
    console.error("[MasterPassword] Failed to unlock app:", error);
    return false;
  }
}

/**
 * Auto-unlock the app using master password from keyring
 * This is called automatically on app startup
 * @returns {Promise<boolean>} True if unlock successful
 */
export async function autoUnlockFromKeyring() {
  console.log("[MasterPassword] Attempting auto-unlock from keyring...");

  try {
    // Get the stored master password from keyring
    const masterPassword = await getSecureCredential("master_password");

    if (!masterPassword) {
      console.warn("[MasterPassword] No master password found in keyring");
      return false;
    }

    console.log("[MasterPassword] Master password retrieved from keyring, unlocking...");

    // Unlock the app with the retrieved master password
    const unlocked = await unlockApp(masterPassword);

    if (unlocked) {
      console.log("[MasterPassword] App auto-unlocked successfully from keyring");
      return true;
    } else {
      console.error("[MasterPassword] Failed to unlock app with keyring password");
      return false;
    }
  } catch (error) {
    console.error("[MasterPassword] Failed to auto-unlock from keyring:", error);
    return false;
  }
}

/**
 * Unlock the app with biometric authentication
 * @returns {Promise<boolean>} True if unlock successful
 */
export async function unlockWithBiometric() {
  console.log("[MasterPassword] Biometric unlock removed for performance");
  return false;
}

/**
 * Lock the app and clear encryption key from memory
 */
export function lockApp() {
  console.log("[MasterPassword] Locking app...");

  // Clear encryption key from memory
  encryptionKey = null;
  unlocked = false;
  unlockTime = null;

  // Stop auto-lock timer
  if (autoLockTimeout) {
    clearTimeout(autoLockTimeout);
    autoLockTimeout = null;
  }

  console.log("[MasterPassword] App locked");
}

/**
 * Clear master password and all encryption configuration
 * This removes all stored passwords and encryption settings
 * @returns {Promise<void>}
 */
export async function clearMasterPassword() {
  console.log("[MasterPassword] Clearing master password...");

  // Lock the app and clear in-memory state
  lockApp();

  // Clear encryption configuration from IndexedDB
  await setSetting(STORAGE_KEYS.ENCRYPTION_CONFIG, null);
  await setSetting(STORAGE_KEYS.PASSWORD_TEST, null);
  await setSetting(STORAGE_KEYS.BIOMETRIC_CONFIG, null);

  console.log("[MasterPassword] Master password and encryption configuration cleared");
}

/**
 * Check if app is currently unlocked
 * @returns {boolean}
 */
export function isAppUnlocked() {
  return unlocked && encryptionKey !== null;
}

/**
 * Get the current encryption key (only when unlocked)
 * @returns {CryptoKey|null}
 * @throws {Error} If app is locked
 */
export function getEncryptionKey() {
  if (!isAppUnlocked()) {
    throw new Error("App is locked - cannot access encryption key");
  }
  return encryptionKey;
}

/**
 * Get password hint
 * @returns {Promise<string|null>}
 */
export async function getPasswordHint() {
  const config = await getEncryptionConfig();
  return config?.passwordHint || null;
}

/**
 * Change master password
 * @param {string} oldPassword - Current password
 * @param {string} newPassword - New password
 * @param {string} [newHint] - Optional new password hint
 * @returns {Promise<void>}
 * @throws {Error} If old password is incorrect or change fails
 */
export async function changeMasterPassword(oldPassword, newPassword, newHint) {
  console.log("[MasterPassword] Changing master password...");

  // Validate new password
  if (!newPassword || newPassword.length < 8) {
    throw new Error("New password must be at least 8 characters long");
  }

  try {
    // Verify old password
    const unlockSuccess = await unlockApp(oldPassword);
    if (!unlockSuccess) {
      throw new Error("Current password is incorrect");
    }

    // Get current encryption config
    const oldConfig = await getEncryptionConfig();

    // Generate new salt
    const newSalt = generateSalt();
    const newSaltBase64 = bufferToBase64Helper(newSalt);

    // Derive new encryption key from new password
    const newKey = await deriveKeyFromPassword(newPassword, newSalt);

    // Create new test encrypted value
    const testData = "master_password_verification";
    const testEncrypted = await encryptData(testData, newKey);

    // TODO: Re-encrypt all encrypted data with the new key
    // This requires:
    // 1. Decrypt all data with old key
    // 2. Encrypt all data with new key
    // 3. Save re-encrypted data
    // For now, we'll just update the password configuration

    // Save new encryption configuration
    const newConfig = {
      ...oldConfig,
      salt: newSaltBase64,
      passwordHint: newHint !== undefined ? newHint : oldConfig.passwordHint,
      changedAt: new Date().toISOString(),
    };
    await saveEncryptionConfig(newConfig);

    // Save new password test data
    await setSetting(STORAGE_KEYS.PASSWORD_TEST, testEncrypted);

    // Update in-memory key
    encryptionKey = newKey;

    // If biometric unlock is enabled, update the stored encrypted password
    const biometricConfig = await getSetting(STORAGE_KEYS.BIOMETRIC_CONFIG);
    if (biometricConfig?.enabled) {
      await enableBiometricUnlock(newPassword, newKey);
    }

    console.log("[MasterPassword] Master password changed successfully");
  } catch (error) {
    console.error("[MasterPassword] Failed to change master password:", error);
    throw new Error(`Failed to change master password: ${error.message}`);
  }
}

/**
 * Get auto-lock timeout in minutes
 * @returns {Promise<number>}
 */
export async function getAutoLockTimeout() {
  const timeout = await getSetting(STORAGE_KEYS.AUTO_LOCK_TIMEOUT);
  return timeout || DEFAULT_AUTO_LOCK_TIMEOUT;
}

/**
 * Set auto-lock timeout in minutes (0 = never)
 * @param {number} minutes - Timeout in minutes
 */
export async function setAutoLockTimeout(minutes) {
  await setSetting(STORAGE_KEYS.AUTO_LOCK_TIMEOUT, minutes);

  // Restart auto-lock timer if app is unlocked
  if (isAppUnlocked()) {
    startAutoLockTimer();
  }
}

/**
 * Start auto-lock timer
 */
async function startAutoLockTimer() {
  // Clear existing timer
  if (autoLockTimeout) {
    clearTimeout(autoLockTimeout);
    autoLockTimeout = null;
  }

  // Get timeout setting
  const timeoutMinutes = await getAutoLockTimeout();

  // If timeout is 0, don't auto-lock
  if (timeoutMinutes === 0) {
    console.log("[MasterPassword] Auto-lock disabled");
    return;
  }

  // Set new timer
  const timeoutMs = timeoutMinutes * 60 * 1000;
  autoLockTimeout = setTimeout(() => {
    console.log("[MasterPassword] Auto-lock timeout reached");
    lockApp();
    // Trigger app-wide lock event
    window.dispatchEvent(new CustomEvent("app-locked", { detail: { reason: "timeout" } }));
  }, timeoutMs);

  console.log(`[MasterPassword] Auto-lock timer set for ${timeoutMinutes} minutes`);
}

/**
 * Reset auto-lock timer (call this on user activity)
 */
export function resetAutoLockTimer() {
  if (isAppUnlocked()) {
    unlockTime = Date.now();
    startAutoLockTimer();
  }
}

/**
 * Get time since unlock (in seconds)
 * @returns {number|null} Seconds since unlock, or null if locked
 */
export function getTimeSinceUnlock() {
  if (!isAppUnlocked() || !unlockTime) {
    return null;
  }
  return Math.floor((Date.now() - unlockTime) / 1000);
}

/**
 * Export encryption configuration (for backup/debugging)
 * Does NOT include the encryption key or password
 * @returns {Promise<Object>}
 */
export async function exportEncryptionConfig() {
  const config = await getEncryptionConfig();
  if (!config) {
    throw new Error("Master password not configured");
  }

  return {
    version: config.version,
    algorithm: config.algorithm,
    iterations: config.iterations,
    createdAt: config.createdAt,
    changedAt: config.changedAt,
    hasPasswordHint: !!config.passwordHint,
    // DO NOT export: salt, passwordHint
  };
}

// Helper functions for base64 conversion (defined inline to avoid circular imports)
function bufferToBase64Helper(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBufferHelper(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
