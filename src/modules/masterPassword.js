/**
 * Master Password Manager
 *
 * Manages the master password lifecycle and app unlock state.
 * Handles encryption key management and biometric unlock integration.
 */

import {
  decryptData,
  deriveKeyFromPassword,
  ENCRYPTION_CONFIG,
  encryptData,
  generateSalt,
  LEGACY_PBKDF2_ITERATIONS,
} from "./encryption.js";
import { getSecureCredential, saveSecureCredential } from "./secureStorage.js";
import { getSetting, setSetting } from "./storage.js";

// In-memory state (cleared on lock)
let encryptionKey = null;
let unlocked = false;

// Storage keys
const STORAGE_KEYS = {
  ENCRYPTION_CONFIG: "encryption_config",
  BIOMETRIC_CONFIG: "biometric_unlock_config",
  PASSWORD_TEST: "password_test",
};

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
      iterations: ENCRYPTION_CONFIG.PBKDF2_ITERATIONS,
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

    console.log("[MasterPassword] App unlocked after setup");
  } catch (error) {
    console.error("[MasterPassword] Failed to set up master password:", error);
    throw new Error(`Failed to set up master password: ${error.message}`);
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

    // Derive key from password using the iteration count this config was
    // created with (configs from before the field existed used the legacy count)
    const iterations = config.iterations || LEGACY_PBKDF2_ITERATIONS;
    const key = await deriveKeyFromPassword(password, salt, iterations);

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
 * Clear the encryption key from memory. Called by clearMasterPassword() when
 * encryption is disabled or the master password is reset.
 */
export function lockApp() {
  encryptionKey = null;
  unlocked = false;
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
  // Also turn encryption off, otherwise saves fail closed (no key, encryption
  // still flagged on) until the user re-enables it. Reset means "start fresh".
  await setSetting("encrypt_local_data", false);

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
