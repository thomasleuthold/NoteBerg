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

// Windows-only, matching main.js's isMcpSupportedPlatform — kept as its own
// local check (same convention settingsMode.js already uses) rather than a
// shared export, since it's one line and this module has no other reason to
// import from main.js.
const IS_MCP_SUPPORTED_PLATFORM =
  !IS_NEXTCLOUD && typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);

let mcpActivityTimeout = null;

/**
 * Show/hide the footer's MCP badge based on whether the server is actually
 * enabled and running — not just whether the user's persisted setting says
 * "enabled" (see settingsMode.js's mcpStatusMismatch handling for why those
 * can disagree, e.g. a failed startup sync).
 */
async function updateMcpIndicator() {
  if (!IS_MCP_SUPPORTED_PLATFORM) return;

  const mcpIndicator = document.querySelector(".mcp-indicator");
  if (!mcpIndicator) return;

  const { isMcpEnabled, getMcpStatus } = await import("./mcpBridge.js");
  let running = false;
  try {
    const enabled = await isMcpEnabled();
    const status = await getMcpStatus();
    running = enabled && status.enabled;
  } catch (_e) {
    // Bridge not initialized yet — treat as not running.
  }

  mcpIndicator.style.display = running ? "flex" : "none";
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

    // MCP badge — Windows only, shown only while the server is actually
    // enabled and running (see updateMcpIndicator). Inserted after the
    // recognition indicator, mirroring its own insertion pattern.
    if (IS_MCP_SUPPORTED_PLATFORM && syncStatus?.parentElement) {
      const mcpIndicator = document.createElement("span");
      mcpIndicator.className = "mcp-indicator";
      mcpIndicator.title = t("footer.mcpRunning");
      mcpIndicator.textContent = "MCP";
      syncStatus.parentElement.appendChild(mcpIndicator);

      updateMcpIndicator();
      window.addEventListener("mcp-status-changed", updateMcpIndicator);

      // Pulse green briefly on real MCP traffic — mcpBridge.js's handle()
      // dispatches this on every tool call, success or failure alike.
      window.addEventListener("mcp-activity", () => {
        mcpIndicator.classList.add("mcp-indicator--active");
        clearTimeout(mcpActivityTimeout);
        mcpActivityTimeout = setTimeout(() => {
          mcpIndicator.classList.remove("mcp-indicator--active");
        }, 500);
      });
    }
  }

  // Initialize version display
  const versionEl = document.querySelector(".app-version");
  if (versionEl) {
    versionEl.textContent = `v${APP_FULL_VERSION}`;
  }

  console.log("Footer initialized");
}
