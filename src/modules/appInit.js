/**
 * App Initialization
 * Handles app startup, master password unlock, and migration
 */

import { isMasterPasswordSet, isAppUnlocked } from './masterPassword.js';
import { showMasterPasswordSetup, showAppUnlock } from '../components/masterPasswordModals.js';
import { getSecureCredential } from './secureStorage.js';

/**
 * Initialize the app and handle master password unlock
 * @returns {Promise<boolean>} True if app is ready to use
 */
export async function initializeApp() {
  console.log('[AppInit] Starting app initialization...');

  try {
    // Check if master password is configured
    const masterPasswordConfigured = await isMasterPasswordSet();

    if (!masterPasswordConfigured) {
      // Check if there are existing credentials to migrate
      const haLegacyCredentials = await checkLegacyCredentials();

      if (haLegacyCredentials) {
        console.log('[AppInit] Legacy credentials found - showing migration setup');
        await showMasterPasswordSetupWithMigration();
      } else {
        console.log('[AppInit] No master password - showing setup');
        await showMasterPasswordSetupFlow();
      }
    } else {
      // Master password is configured - check if app is unlocked
      if (!isAppUnlocked()) {
        console.log('[AppInit] App locked - showing unlock modal');
        await showAppUnlockFlow();
      } else {
        console.log('[AppInit] App already unlocked');
      }
    }

    console.log('[AppInit] App initialization complete');
    return true;
  } catch (error) {
    console.error('[AppInit] App initialization failed:', error);
    throw error;
  }
}

/**
 * Check if there are legacy credentials to migrate
 * @returns {Promise<boolean>}
 */
async function checkLegacyCredentials() {
  try {
    // Check localStorage for old credentials
    const legacyNextcloudCredentials = localStorage.getItem('nextcloud_credentials');
    if (legacyNextcloudCredentials) {
      console.log('[AppInit] Found legacy Nextcloud credentials in localStorage');
      return true;
    }

    // Check if credentials exist in secure storage (from Phase 1)
    // These would be unencrypted with master password
    try {
      const secureCredentials = await getSecureCredential('nextcloud_credentials');
      if (secureCredentials) {
        console.log('[AppInit] Found credentials in secure storage (Phase 1)');
        return true;
      }
    } catch (error) {
      // Ignore errors - credentials might not exist
    }

    return false;
  } catch (error) {
    console.error('[AppInit] Error checking legacy credentials:', error);
    return false;
  }
}

/**
 * Show master password setup with migration notice
 * @returns {Promise<void>}
 */
function showMasterPasswordSetupWithMigration() {
  return new Promise((resolve) => {
    showMasterPasswordSetup({
      isMigration: true,
      onSuccess: async () => {
        console.log('[AppInit] Master password setup complete (migration)');
        // Perform migration
        await migrateCredentials();
        resolve();
      }
    });
  });
}

/**
 * Show master password setup (new user)
 * @returns {Promise<void>}
 */
function showMasterPasswordSetupFlow() {
  return new Promise((resolve) => {
    showMasterPasswordSetup({
      isMigration: false,
      onSuccess: () => {
        console.log('[AppInit] Master password setup complete (new user)');
        resolve();
      }
    });
  });
}

/**
 * Show app unlock modal
 * @returns {Promise<void>}
 */
function showAppUnlockFlow() {
  return new Promise((resolve) => {
    showAppUnlock({
      onSuccess: () => {
        console.log('[AppInit] App unlocked successfully');
        resolve();
      }
    });
  });
}

/**
 * Migrate legacy credentials to encrypted storage
 * @returns {Promise<void>}
 */
async function migrateCredentials() {
  console.log('[AppInit] Starting credential migration...');

  try {
    const { getEncryptionKey } = await import('./masterPassword.js');
    const { encryptObject } = await import('./encryption.js');
    const { setSetting, getSetting } = await import('./storage.js');

    // Get the encryption key (app must be unlocked at this point)
    let encryptionKey;
    try {
      encryptionKey = getEncryptionKey();
    } catch (error) {
      console.error('[AppInit] Cannot migrate - app is locked');
      return;
    }

    let migratedCount = 0;

    // 1. Check for legacy credentials in localStorage
    const legacyNextcloudCreds = localStorage.getItem('nextcloud_credentials');
    if (legacyNextcloudCreds) {
      console.log('[AppInit] Found legacy Nextcloud credentials in localStorage');

      try {
        // Parse the credentials
        const credsData = JSON.parse(legacyNextcloudCreds);

        // Encrypt with master password
        const encryptedCreds = await encryptObject(credsData, encryptionKey);

        // Store in encrypted format
        await setSetting('encrypted_nextcloud_credentials', encryptedCreds);

        // Clear legacy localStorage
        localStorage.removeItem('nextcloud_credentials');

        migratedCount++;
        console.log('[AppInit] Migrated Nextcloud credentials from localStorage');
      } catch (error) {
        console.error('[AppInit] Failed to migrate localStorage credentials:', error);
      }
    }

    // 2. Check for Phase 1 secure storage credentials (unencrypted with master password)
    try {
      const secureCredentials = await getSecureCredential('nextcloud_credentials');
      if (secureCredentials) {
        console.log('[AppInit] Found credentials in Phase 1 secure storage');

        // Check if we haven't already migrated these
        const alreadyMigrated = await getSetting('encrypted_nextcloud_credentials');
        if (!alreadyMigrated) {
          try {
            // Parse the credentials
            const credsData = JSON.parse(secureCredentials);

            // Encrypt with master password
            const encryptedCreds = await encryptObject(credsData, encryptionKey);

            // Store in encrypted format
            await setSetting('encrypted_nextcloud_credentials', encryptedCreds);

            // Note: We'll keep Phase 1 credentials for now as backup
            // They can be manually cleared later in settings

            migratedCount++;
            console.log('[AppInit] Migrated Nextcloud credentials from Phase 1 secure storage');
          } catch (error) {
            console.error('[AppInit] Failed to migrate Phase 1 credentials:', error);
          }
        } else {
          console.log('[AppInit] Phase 1 credentials already migrated, skipping');
        }
      }
    } catch (error) {
      // Ignore errors - credentials might not exist
      console.log('[AppInit] No Phase 1 credentials found or error accessing them');
    }

    // Mark migration as complete
    if (migratedCount > 0) {
      await setSetting('credentials_migration_completed', {
        completed: true,
        timestamp: new Date().toISOString(),
        migratedCount
      });
      console.log(`[AppInit] Credential migration complete - migrated ${migratedCount} credential(s)`);
    } else {
      console.log('[AppInit] No credentials to migrate');
    }
  } catch (error) {
    console.error('[AppInit] Migration failed:', error);
    throw error;
  }
}

/**
 * Listen for app lock events and show unlock modal
 */
export function setupAppLockListener() {
  window.addEventListener('app-locked', async (event) => {
    console.log('[AppInit] App locked:', event.detail);
    await showAppUnlockFlow();
  });
}
