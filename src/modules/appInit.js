/**
 * App Initialization
 * Handles app startup and automatic master password unlock from keyring
 */

import { autoUnlockFromKeyring, isAppUnlocked, isMasterPasswordSet } from "./masterPassword.js";
import { fixCorruptedNotes, getSetting } from "./storage.js";

/**
 * Initialize the app and handle master password unlock
 * Master password is automatically retrieved from OS keyring - no user prompt needed
 * @returns {Promise<boolean>} True if app is ready to use
 */
export async function initializeApp() {
  const startTime = performance.now();
  console.log("[AppInit] Starting app initialization...");

  try {
    // Check if encryption is actually ENABLED (not just configured)
    const settingsStart = performance.now();
    const encryptLocalData = await getSetting("encrypt_local_data");
    const encryptNextcloudData = await getSetting("encrypt_nextcloud_data");
    const encryptionEnabled = encryptLocalData === true || encryptNextcloudData === true;
    console.log(`[AppInit] Settings check took ${Math.round(performance.now() - settingsStart)}ms`);

    console.log("[AppInit] Encryption status:", {
      encryptLocalData,
      encryptNextcloudData,
      encryptionEnabled,
    });

    // Auto-unlock from keyring if encryption is enabled
    if (encryptionEnabled) {
      const passwordCheckStart = performance.now();
      const masterPasswordConfigured = await isMasterPasswordSet();
      console.log(
        `[AppInit] Master password check took ${Math.round(performance.now() - passwordCheckStart)}ms`,
      );

      if (!masterPasswordConfigured) {
        console.log(
          "[AppInit] Encryption enabled but no master password - user must set it up in Settings",
        );
        // Don't block app startup - user can set it up later in Settings
      } else if (!isAppUnlocked()) {
        console.log("[AppInit] Encryption enabled - attempting auto-unlock from keyring...");
        const unlockStart = performance.now();
        const unlocked = await autoUnlockFromKeyring();
        console.log(`[AppInit] Auto-unlock took ${Math.round(performance.now() - unlockStart)}ms`);

        if (unlocked) {
          console.log("[AppInit] Successfully auto-unlocked from keyring");

          // Fix any corrupted notes (encrypted content but no encrypted flag)
          const fixStart = performance.now();
          const { fixed } = await fixCorruptedNotes();
          console.log(
            `[AppInit] Corrupted notes scan took ${Math.round(performance.now() - fixStart)}ms (${fixed} fixed)`,
          );
        } else {
          console.error(
            "[AppInit] Failed to auto-unlock from keyring - master password may be missing or corrupted",
          );
          // Don't block app startup - encryption just won't work until user fixes it in Settings
        }
      }
    } else {
      console.log("[AppInit] No encryption enabled - proceeding without master password");
    }

    const totalTime = Math.round(performance.now() - startTime);
    console.log(`[AppInit] App initialization complete in ${totalTime}ms`);
    return true;
  } catch (error) {
    console.error("[AppInit] App initialization failed:", error);
    throw error;
  }
}

/**
 * Listen for app lock events and auto-unlock from keyring
 */
export function setupAppLockListener() {
  window.addEventListener("app-locked", async (event) => {
    console.log("[AppInit] App locked:", event.detail);
    console.log("[AppInit] Auto-unlocking from keyring after lock event...");
    const unlocked = await autoUnlockFromKeyring();
    if (unlocked) {
      console.log("[AppInit] Successfully auto-unlocked after lock event");
    } else {
      console.error("[AppInit] Failed to auto-unlock after lock event");
    }
  });
}
