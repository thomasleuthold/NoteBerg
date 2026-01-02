/**
 * Footer Module
 * Handles sync status display and sync triggering
 */

import { APP_FULL_VERSION } from "../config.js";
import { isAuthenticated } from "./nextcloudSync.js";
import { getIsSyncing, onSyncStatusChange, performSync } from "./sync.js";

/**
 * Update sync status display
 */
export async function updateSyncStatus() {
  const syncStatus = document.querySelector(".sync-status");
  const syncIndicator = document.querySelector(".sync-indicator");
  const syncText = document.querySelector(".sync-text");

  if (!syncStatus || !syncIndicator || !syncText) return;

  const authenticated = await isAuthenticated();
  const isSyncing = getIsSyncing();

  if (isSyncing) {
    syncStatus.dataset.status = "syncing";
    syncIndicator.textContent = "↻";
    syncText.textContent = "Syncing...";
    syncStatus.style.cursor = "wait";
  } else if (authenticated) {
    syncStatus.dataset.status = "connected";
    syncIndicator.textContent = "●";
    syncText.textContent = "Connected - Click to sync";
    syncStatus.style.cursor = "pointer";
  } else {
    syncStatus.dataset.status = "offline";
    syncIndicator.textContent = "○";
    syncText.textContent = "Not connected";
    syncStatus.style.cursor = "default";
  }
}

/**
 * Perform manual sync (triggered by user clicking footer)
 */
async function handleManualSync() {
  if (getIsSyncing() || !(await isAuthenticated())) return;

  try {
    await performSync({ silent: false, skipConflictResolution: false });

    // Show success briefly
    const syncText = document.querySelector(".sync-text");
    if (syncText) {
      syncText.textContent = "Sync successful!";
      setTimeout(() => {
        updateSyncStatus();
      }, 2000);
    }
  } catch (error) {
    console.error("Manual sync failed:", error);

    // Show error briefly
    const syncText = document.querySelector(".sync-text");
    if (syncText) {
      syncText.textContent = "Sync failed!";
      setTimeout(() => {
        updateSyncStatus();
      }, 3000);
    }
  }
}

/**
 * Initialize footer
 */
export function initFooter() {
  const syncStatus = document.querySelector(".sync-status");

  if (syncStatus) {
    syncStatus.addEventListener("click", async () => {
      if ((await isAuthenticated()) && !getIsSyncing()) {
        handleManualSync();
      }
    });
  }

  // Register callback to update status when sync state changes
  onSyncStatusChange(() => {
    updateSyncStatus();
  });

  // Update status on load and when auth changes
  updateSyncStatus();

  // Listen for auth changes
  window.addEventListener("nextcloud-auth-changed", updateSyncStatus);

  // Initialize version display
  const versionEl = document.querySelector(".app-version");
  if (versionEl) {
    versionEl.textContent = `v${APP_FULL_VERSION}`;
  }

  console.log("Footer initialized");
}
