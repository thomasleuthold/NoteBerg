/**
 * Footer Module
 * Handles sync status display and sync triggering
 */

import { APP_FULL_VERSION } from "../config.js";
import { t } from "../i18n/index.js";

const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

/**
 * Update sync status display (Tauri only)
 */
export async function updateSyncStatus() {
  if (IS_NEXTCLOUD) return;

  const { isAuthenticated } = await import("./nextcloudSync.js");
  const { getIsSyncing, getLastSyncResult } = await import("./sync.js");

  const syncStatus = document.querySelector(".sync-status");
  const syncIndicator = document.querySelector(".sync-indicator");

  if (!syncStatus || !syncIndicator) return;

  const authenticated = await isAuthenticated();
  const isSyncing = getIsSyncing();
  const lastResult = getLastSyncResult();

  if (isSyncing) {
    syncStatus.dataset.status = "syncing";
    syncIndicator.textContent = "↻";
    syncStatus.title = t("footer.syncing");
  } else if (authenticated) {
    if (!lastResult) {
      syncStatus.dataset.status = "idle";
      syncIndicator.textContent = "○";
      syncStatus.title = t("footer.syncClickHint");
    } else if (lastResult.success) {
      syncStatus.dataset.status = "connected";
      syncIndicator.textContent = "●";
      const time = new Date(lastResult.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      syncStatus.title = t("footer.lastSyncedTooltip", {
        time,
        uploaded: lastResult.uploaded.notes,
        downloaded: lastResult.downloaded.notes,
      });
    } else {
      syncStatus.dataset.status = "error";
      syncIndicator.textContent = "⚠";
      syncStatus.title = t("footer.syncFailedTooltip", {
        error: lastResult.error || t("footer.unknownError"),
      });
    }
  } else {
    syncStatus.dataset.status = "offline";
    syncIndicator.textContent = "○";
    syncStatus.title = t("footer.notConnected");
  }
}

/**
 * Perform manual sync (triggered by user clicking footer, Tauri only)
 */
async function handleManualSync() {
  const { isAuthenticated } = await import("./nextcloudSync.js");
  const { getIsSyncing, performSync } = await import("./sync.js");
  if (getIsSyncing() || !(await isAuthenticated())) return;

  try {
    await performSync({ silent: false, skipConflictResolution: false });
  } catch (error) {
    console.error("Manual sync failed:", error);
  }
}

/**
 * Initialize footer
 */
export function initFooter() {
  if (!IS_NEXTCLOUD) {
    const syncStatus = document.querySelector(".sync-status");

    // Create recognition indicator
    if (syncStatus?.parentElement) {
      const recognitionIndicator = document.createElement("div");
      recognitionIndicator.className = "recognition-indicator";
      recognitionIndicator.title = t("footer.recognitionRunning");
      recognitionIndicator.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>`;
      syncStatus.insertAdjacentElement("afterend", recognitionIndicator);

      window.addEventListener("recognition-start", () => {
        recognitionIndicator.style.display = "flex";
      });
      window.addEventListener("recognition-end", () => {
        recognitionIndicator.style.display = "none";
      });
    }

    if (syncStatus) {
      syncStatus.addEventListener("click", async () => {
        const { isAuthenticated } = await import("./nextcloudSync.js");
        const { getIsSyncing } = await import("./sync.js");
        if ((await isAuthenticated()) && !getIsSyncing()) {
          handleManualSync();
        }
      });
    }

    // Register callback to update status when sync state changes
    import("./sync.js").then(({ onSyncStatusChange }) => {
      onSyncStatusChange(() => updateSyncStatus());
    });

    updateSyncStatus();
    window.addEventListener("nextcloud-auth-changed", updateSyncStatus);
  }

  // Initialize version display
  const versionEl = document.querySelector(".app-version");
  if (versionEl) {
    versionEl.textContent = `v${APP_FULL_VERSION}`;
  }

  console.log("Footer initialized");
}
