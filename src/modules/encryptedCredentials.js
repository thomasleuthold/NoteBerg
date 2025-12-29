/**
 * Encrypted Credentials Management
 * Provides secure access to encrypted credentials using master password
 */

import { getEncryptionKey, isAppUnlocked } from './masterPassword.js';
import { encryptObject, decryptObject } from './encryption.js';
import { getSetting, setSetting } from './storage.js';

/**
 * Save encrypted Nextcloud credentials
 * @param {Object} credentials - Nextcloud credentials object
 * @returns {Promise<void>}
 */
export async function saveNextcloudCredentials(credentials) {
  console.log('[EncryptedCredentials] Saving Nextcloud credentials...');

  if (!isAppUnlocked()) {
    throw new Error('App is locked - cannot save credentials');
  }

  try {
    const encryptionKey = getEncryptionKey();
    const encryptedCreds = await encryptObject(credentials, encryptionKey);

    await setSetting('encrypted_nextcloud_credentials', encryptedCreds);

    console.log('[EncryptedCredentials] Nextcloud credentials saved successfully');
  } catch (error) {
    console.error('[EncryptedCredentials] Failed to save credentials:', error);
    throw error;
  }
}

/**
 * Get decrypted Nextcloud credentials
 * @returns {Promise<Object|null>} Credentials object or null if not found
 */
export async function getNextcloudCredentials() {
  console.log('[EncryptedCredentials] Retrieving Nextcloud credentials...');

  if (!isAppUnlocked()) {
    throw new Error('App is locked - cannot access credentials');
  }

  try {
    const encryptedCreds = await getSetting('encrypted_nextcloud_credentials');

    if (!encryptedCreds) {
      console.log('[EncryptedCredentials] No encrypted credentials found');
      return null;
    }

    const encryptionKey = getEncryptionKey();
    const credentials = await decryptObject(encryptedCreds, encryptionKey);

    console.log('[EncryptedCredentials] Credentials retrieved successfully');
    return credentials;
  } catch (error) {
    console.error('[EncryptedCredentials] Failed to retrieve credentials:', error);
    throw error;
  }
}

/**
 * Delete encrypted Nextcloud credentials
 * @returns {Promise<void>}
 */
export async function deleteNextcloudCredentials() {
  console.log('[EncryptedCredentials] Deleting Nextcloud credentials...');

  if (!isAppUnlocked()) {
    throw new Error('App is locked - cannot delete credentials');
  }

  try {
    await setSetting('encrypted_nextcloud_credentials', null);
    console.log('[EncryptedCredentials] Credentials deleted successfully');
  } catch (error) {
    console.error('[EncryptedCredentials] Failed to delete credentials:', error);
    throw error;
  }
}

/**
 * Check if Nextcloud credentials exist
 * @returns {Promise<boolean>}
 */
export async function hasNextcloudCredentials() {
  try {
    const encryptedCreds = await getSetting('encrypted_nextcloud_credentials');
    return encryptedCreds !== null && encryptedCreds !== undefined;
  } catch (error) {
    console.error('[EncryptedCredentials] Error checking credentials:', error);
    return false;
  }
}

/**
 * Save encrypted note data
 * @param {string} noteId - Note ID
 * @param {Object} noteData - Note data object
 * @returns {Promise<void>}
 */
export async function saveEncryptedNote(noteId, noteData) {
  if (!isAppUnlocked()) {
    throw new Error('App is locked - cannot save note');
  }

  try {
    const encryptionKey = getEncryptionKey();
    const encryptedNote = await encryptObject(noteData, encryptionKey);

    await setSetting(`encrypted_note_${noteId}`, encryptedNote);

    console.log(`[EncryptedCredentials] Note ${noteId} saved (encrypted)`);
  } catch (error) {
    console.error(`[EncryptedCredentials] Failed to save note ${noteId}:`, error);
    throw error;
  }
}

/**
 * Get decrypted note data
 * @param {string} noteId - Note ID
 * @returns {Promise<Object|null>} Note data or null
 */
export async function getEncryptedNote(noteId) {
  if (!isAppUnlocked()) {
    throw new Error('App is locked - cannot access note');
  }

  try {
    const encryptedNote = await getSetting(`encrypted_note_${noteId}`);

    if (!encryptedNote) {
      return null;
    }

    const encryptionKey = getEncryptionKey();
    const noteData = await decryptObject(encryptedNote, encryptionKey);

    return noteData;
  } catch (error) {
    console.error(`[EncryptedCredentials] Failed to get note ${noteId}:`, error);
    throw error;
  }
}

/**
 * Delete encrypted note
 * @param {string} noteId - Note ID
 * @returns {Promise<void>}
 */
export async function deleteEncryptedNote(noteId) {
  if (!isAppUnlocked()) {
    throw new Error('App is locked - cannot delete note');
  }

  try {
    await setSetting(`encrypted_note_${noteId}`, null);
    console.log(`[EncryptedCredentials] Note ${noteId} deleted`);
  } catch (error) {
    console.error(`[EncryptedCredentials] Failed to delete note ${noteId}:`, error);
    throw error;
  }
}
