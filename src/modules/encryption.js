/**
 * Encryption Module
 *
 * Provides cryptographic functions for master password encryption using Web Crypto API.
 * Uses PBKDF2 for key derivation and AES-GCM for encryption.
 *
 * Security Design:
 * - PBKDF2 with SHA-256, 600,000 iterations for new key derivations
 *   (legacy configs keep their stored iteration count — see encryption_config)
 * - AES-GCM with 256-bit keys for encryption
 * - Random 12-byte IV per encryption operation
 * - Random 16-byte salt for each user
 */

// Default for NEW key derivations (OWASP guidance for PBKDF2-SHA256).
// Existing users keep the iteration count stored in their encryption_config —
// callers MUST pass it explicitly or their key/hash won't match.
const PBKDF2_ITERATIONS = 600000;
// Iteration count used before the default was raised; fallback for configs
// that predate the stored `iterations` field.
export const LEGACY_PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16; // 128 bits
const IV_LENGTH = 12; // 96 bits (recommended for AES-GCM)
const KEY_LENGTH = 256; // 256 bits

/**
 * Generate a cryptographically secure random salt
 * @returns {Uint8Array} 16-byte salt
 */
export function generateSalt() {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

/**
 * Generate a cryptographically secure random IV
 * @returns {Uint8Array} 12-byte initialization vector
 */
export function generateIV() {
  return crypto.getRandomValues(new Uint8Array(IV_LENGTH));
}

/**
 * Convert Uint8Array to base64 string
 * @param {Uint8Array} buffer - Buffer to convert
 * @returns {string} Base64 string
 */
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert base64 string to Uint8Array
 * @param {string} base64 - Base64 string
 * @returns {Uint8Array} Buffer
 */
function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Derive an encryption key from a password using PBKDF2
 * @param {string} password - User's master password
 * @param {Uint8Array} salt - Salt for key derivation
 * @param {number} [iterations] - Iteration count. Pass the value stored in the
 *   user's encryption_config for existing setups; defaults to the current
 *   PBKDF2_ITERATIONS for new key derivations.
 * @returns {Promise<CryptoKey>} 256-bit AES-GCM key
 */
export async function deriveKeyFromPassword(password, salt, iterations = PBKDF2_ITERATIONS) {
  try {
    // Convert password to ArrayBuffer
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);

    // Import password as a CryptoKey for PBKDF2
    const baseKey = await crypto.subtle.importKey("raw", passwordBuffer, "PBKDF2", false, [
      "deriveKey",
    ]);

    // Derive the encryption key
    const derivedKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations,
        hash: "SHA-256",
      },
      baseKey,
      {
        name: "AES-GCM",
        length: KEY_LENGTH,
      },
      false, // Not extractable — nothing exports the key; workers receive it via structured clone
      ["encrypt", "decrypt"],
    );

    return derivedKey;
  } catch (error) {
    console.error("[Encryption] Failed to derive key:", error);
    throw new Error("Failed to derive encryption key from password");
  }
}

/**
 * Encrypt data using AES-GCM
 * @param {string} data - Data to encrypt (will be converted to string if object)
 * @param {CryptoKey} key - Encryption key
 * @returns {Promise<{data: string, iv: string}>} Encrypted data and IV (both base64)
 */
export async function encryptData(data, key) {
  try {
    // Convert data to string if it's an object
    const dataString = typeof data === "string" ? data : JSON.stringify(data);

    // Convert string to ArrayBuffer
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(dataString);

    // Generate random IV
    const iv = generateIV();

    // Encrypt the data
    const encryptedBuffer = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      key,
      dataBuffer,
    );

    // Convert encrypted data and IV to base64
    const encryptedData = bufferToBase64(encryptedBuffer);
    const ivBase64 = bufferToBase64(iv);

    return {
      data: encryptedData,
      iv: ivBase64,
    };
  } catch (error) {
    console.error("[Encryption] Failed to encrypt data:", error);
    throw new Error("Failed to encrypt data");
  }
}

/**
 * Decrypt data using AES-GCM
 * @param {string} encryptedData - Base64 encrypted data
 * @param {string} ivBase64 - Base64 initialization vector
 * @param {CryptoKey} key - Decryption key
 * @returns {Promise<string>} Decrypted data
 */
export async function decryptData(encryptedData, ivBase64, key) {
  try {
    // Convert base64 to ArrayBuffer
    const encryptedBuffer = base64ToBuffer(encryptedData);
    const iv = base64ToBuffer(ivBase64);

    // Decrypt the data
    const decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      key,
      encryptedBuffer,
    );

    // Convert ArrayBuffer to string
    const decoder = new TextDecoder();
    const decryptedData = decoder.decode(decryptedBuffer);

    return decryptedData;
  } catch (error) {
    console.error("[Encryption] Failed to decrypt data:", error);
    throw new Error("Failed to decrypt data - incorrect password or corrupted data");
  }
}

/**
 * Hash a password for verification purposes (NOT for encryption)
 * This creates a hash that can be stored to verify the password later
 * @param {string} password - Password to hash
 * @param {Uint8Array} salt - Salt for hashing
 * @returns {Promise<string>} Base64 hash
 */
export async function hashPassword(password, salt, iterations = PBKDF2_ITERATIONS) {
  try {
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);

    // Import password as a key
    const baseKey = await crypto.subtle.importKey("raw", passwordBuffer, "PBKDF2", false, [
      "deriveBits",
    ]);

    // Derive bits (not a key) for hashing
    const hashBits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: salt,
        iterations,
        hash: "SHA-256",
      },
      baseKey,
      256, // 256 bits
    );

    return bufferToBase64(hashBits);
  } catch (error) {
    console.error("[Encryption] Failed to hash password:", error);
    throw new Error("Failed to hash password");
  }
}

/**
 * Verify a password against a stored hash
 * @param {string} password - Password to verify
 * @param {string} storedHash - Base64 stored hash
 * @param {Uint8Array} salt - Salt used for original hash
 * @returns {Promise<boolean>} True if password matches
 */
export async function verifyPassword(password, storedHash, salt) {
  try {
    const computedHash = await hashPassword(password, salt);
    return computedHash === storedHash;
  } catch (error) {
    console.error("[Encryption] Failed to verify password:", error);
    return false;
  }
}

/**
 * Encrypt an object and return it in a structured format
 * @param {Object} obj - Object to encrypt
 * @param {CryptoKey} key - Encryption key
 * @returns {Promise<{data: string, iv: string, version: number}>} Encrypted object with metadata
 */
export async function encryptObject(obj, key) {
  const encrypted = await encryptData(JSON.stringify(obj), key);
  return {
    data: encrypted.data,
    iv: encrypted.iv,
    version: 1, // Encryption version for future compatibility
  };
}

/**
 * Decrypt a structured encrypted object
 * @param {{data: string, iv: string, version: number}} encryptedObj - Encrypted object with metadata
 * @param {CryptoKey} key - Decryption key
 * @returns {Promise<Object>} Decrypted object
 */
export async function decryptObject(encryptedObj, key) {
  const decryptedString = await decryptData(encryptedObj.data, encryptedObj.iv, key);
  return JSON.parse(decryptedString);
}

/**
 * Test encryption/decryption with a given key
 * Used to verify that a password is correct
 * @param {CryptoKey} key - Key to test
 * @returns {Promise<boolean>} True if encryption/decryption works
 */
export async function testKey(key) {
  try {
    const testData = "encryption_test";
    const encrypted = await encryptData(testData, key);
    const decrypted = await decryptData(encrypted.data, encrypted.iv, key);
    return decrypted === testData;
  } catch (_error) {
    return false;
  }
}

/**
 * Calculate password strength (0-100)
 * @param {string} password - Password to analyze
 * @returns {number} Strength score (0-100)
 */
export function calculatePasswordStrength(password) {
  if (!password) return 0;

  let strength = 0;

  // Length contribution (up to 40 points)
  strength += Math.min(password.length * 4, 40);

  // Character variety (up to 60 points)
  const hasLowercase = /[a-z]/.test(password);
  const hasUppercase = /[A-Z]/.test(password);
  const hasNumbers = /[0-9]/.test(password);
  const hasSymbols = /[^a-zA-Z0-9]/.test(password);

  if (hasLowercase) strength += 10;
  if (hasUppercase) strength += 15;
  if (hasNumbers) strength += 15;
  if (hasSymbols) strength += 20;

  // Bonus for meeting all criteria
  if (hasLowercase && hasUppercase && hasNumbers && hasSymbols && password.length >= 12) {
    strength += 10;
  }

  // Penalty for common patterns
  if (/^[0-9]+$/.test(password)) strength -= 20; // All numbers
  if (/^[a-zA-Z]+$/.test(password)) strength -= 10; // All letters
  if (/(.)\1{2,}/.test(password)) strength -= 10; // Repeated characters

  return Math.max(0, Math.min(100, strength));
}

/**
 * Get password strength label
 * @param {number} strength - Strength score (0-100)
 * @returns {string} Strength label
 */
export function getPasswordStrengthLabel(strength) {
  if (strength < 30) return "Weak";
  if (strength < 60) return "Fair";
  if (strength < 80) return "Good";
  return "Strong";
}

/**
 * Get password strength color
 * @param {number} strength - Strength score (0-100)
 * @returns {string} Color class or hex code
 */
export function getPasswordStrengthColor(strength) {
  if (strength < 30) return "#ef4444"; // Red
  if (strength < 60) return "#f59e0b"; // Orange
  if (strength < 80) return "#eab308"; // Yellow
  return "#22c55e"; // Green
}

// Export configuration constants for reference
export const ENCRYPTION_CONFIG = {
  PBKDF2_ITERATIONS,
  SALT_LENGTH,
  IV_LENGTH,
  KEY_LENGTH,
  ALGORITHM: "AES-GCM",
  KEY_DERIVATION: "PBKDF2",
  HASH: "SHA-256",
  VERSION: 1,
};
