/**
 * Footer Module
 * Handles sync status display and sync triggering
 */

import { APP_FULL_VERSION } from "../config.js";
import { t } from "../i18n/index.js";
import { classifyFailure } from "./recognition/failureReason.js";

const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

/**
 * Leading glyph per job state, in the recognition job list.
 *
 * A glance at the list should separate work in progress from work merely
 * waiting, which the status text alone did not do.
 *
 * "running" is absent deliberately: its indicator is a rotating arc drawn in CSS
 * from borders (components.css), the same idiom as the note-preview spinner. A
 * rotating text glyph wobbles, because a glyph's baseline and its optical centre
 * are not the same point.
 *
 * "done" has no icon on purpose. A finished row is about to disappear, and a
 * tick beside every completed job draws the eye to exactly the rows that no
 * longer need it.
 */
const STATE_ICONS = {
  queued: "⧗",
  failed: "⚠",
};

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
 *
 * `status.listening` is the third condition: the port is fixed, so if another
 * process already held it the server never bound and nothing is serving, even
 * though both "enabled" flags read true (see mcp.rs's McpState::listening).
 * Showing the badge then would claim a server that isn't there.
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
    running = enabled && status.enabled && status.listening;
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

/** The pen glyph used by the recognition indicator. */
const PEN_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>`;

/**
 * Summarize the queue for the footer badge.
 *
 * The old indicator was binary — recognition is happening, or it is not. That
 * was honest for the sidecar, which finishes in under a second. With jobs that
 * run for minutes, the user needs to know how much is outstanding and whether
 * anything went wrong, so the badge carries counts and a state.
 *
 * @param {Array} jobs
 * @returns {{visible: boolean, state: string, text: string, title: string}}
 */
export function summarizeQueue(jobs) {
  const list = jobs || [];
  const running = list.find((j) => j.state === "running");
  const queued = list.filter((j) => j.state === "queued").length;
  const failed = list.filter((j) => j.state === "failed").length;

  if (running) {
    // Page x/N of the note being transcribed, plus anything waiting behind it.
    const pages = running.total > 0 ? `${running.current}/${running.total}` : "";
    return {
      visible: true,
      state: "running",
      text: queued > 0 ? `${pages} +${queued}` : pages,
      title: t("footer.recognitionRunning"),
    };
  }
  if (queued > 0) {
    return {
      visible: true,
      state: "queued",
      text: String(queued),
      title: t("footer.recognitionQueued", { count: queued }),
    };
  }
  if (failed > 0) {
    // Failures persist until dismissed: one nobody saw is the one that matters.
    return {
      visible: true,
      state: "failed",
      text: String(failed),
      title: t("footer.recognitionFailed", { count: failed }),
    };
  }
  return { visible: false, state: "idle", text: "", title: "" };
}

/**
 * Create the recognition badge and keep it in step with the queue.
 *
 * Runs on every platform — see the call site for why.
 */
function initRecognitionIndicator() {
  const host = document.querySelector(".footer-left");
  const footer = document.querySelector(".footer");
  if (!host) return;

  const indicator = document.createElement("div");
  indicator.className = "recognition-indicator";
  indicator.innerHTML = `${PEN_ICON}<span class="recognition-indicator__count"></span>`;
  host.appendChild(indicator);

  const countEl = indicator.querySelector(".recognition-indicator__count");

  const apply = (jobs) => {
    const summary = summarizeQueue(jobs);
    indicator.style.display = summary.visible ? "flex" : "none";
    indicator.dataset.state = summary.state;
    indicator.title = summary.title;
    countEl.textContent = summary.text;

    // In NC the footer is a strip inside Nextcloud's own chrome, so it earns
    // its space only while it has something to say.
    if (footer && IS_NEXTCLOUD) {
      footer.style.display = summary.visible ? "" : "none";
    }
  };

  window.addEventListener("recognition-queue-changed", (e) => apply(e.detail?.jobs));
  window.addEventListener("recognition-job-progress", async () => {
    const { getJobs } = await import("./recognition/recognitionQueue.js");
    apply(getJobs());
  });

  indicator.addEventListener("click", () => showRecognitionJobs());

  apply([]);
}

/**
 * The job list, opened from the badge.
 *
 * Deliberately not a modal: recognition must never block writing (DESIGN §7),
 * and this panel exists precisely so the user can watch long work without being
 * held by it.
 */
async function showRecognitionJobs() {
  const { getJobs, cancel, clearFinished } = await import("./recognition/recognitionQueue.js");

  document.querySelector(".recognition-jobs")?.remove();

  const panel = document.createElement("div");
  panel.className = "recognition-jobs";

  const render = () => {
    const jobs = getJobs();
    if (jobs.length === 0) {
      panel.remove();
      return;
    }

    panel.innerHTML = `
      <div class="recognition-jobs__header">
        <span>${t("footer.recognitionJobsTitle")}</span>
        <button class="recognition-jobs__close" type="button" aria-label="${t("common.close")}">×</button>
      </div>
      <ul class="recognition-jobs__list"></ul>
      <div class="recognition-jobs__footer">
        <button class="recognition-jobs__clear" type="button">${t("footer.recognitionClearFinished")}</button>
      </div>
    `;

    const list = panel.querySelector(".recognition-jobs__list");
    for (const job of jobs) {
      const li = document.createElement("li");
      li.className = "recognition-jobs__item";
      li.dataset.state = job.state;

      let status;
      if (job.state === "running") {
        status =
          job.total > 0
            ? t("footer.recognitionPage", { current: job.current, total: job.total })
            : t("footer.recognitionStarting");
      } else if (job.state === "queued") {
        status = t("footer.recognitionWaiting");
      } else if (job.state === "failed") {
        // A short category rather than the backend's sentence. The full message
        // is kept as the row's tooltip below — it names the setting to change
        // and is what a bug report needs, but it is far too long for this line.
        status =
          job.error === "stale"
            ? t("canvas.recognition.staleStrokes")
            : t(`footer.recognitionFailReason.${classifyFailure(job.error)}`);
      } else {
        status = t("footer.recognitionDone");
      }

      // State icon. Decorative only: the status text beside it already names the
      // state, so announcing the glyph too would just repeat it to a screen
      // reader. Animation lives in CSS so it stops under prefers-reduced-motion.
      const icon = document.createElement("span");
      icon.className = "recognition-jobs__icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = STATE_ICONS[job.state] ?? "";

      const title = document.createElement("span");
      title.className = "recognition-jobs__title";
      title.textContent = job.title || t("footer.recognitionUntitled");

      const statusEl = document.createElement("span");
      statusEl.className = "recognition-jobs__status";
      statusEl.textContent = status;

      // The untruncated message, for the row that needs explaining. Only on a
      // failure: a tooltip on a healthy row is noise.
      if (job.state === "failed" && job.error && job.error !== "stale") {
        li.title = job.error;
      }

      li.append(icon, title, statusEl);

      if (job.state === "queued" || job.state === "running") {
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "recognition-jobs__cancel";
        cancelBtn.textContent = t("canvas.recognition.cancel");
        cancelBtn.addEventListener("click", () => cancel(job.id));
        li.append(cancelBtn);
      }

      list.append(li);
    }

    panel.querySelector(".recognition-jobs__close")?.addEventListener("click", () => close());
    panel.querySelector(".recognition-jobs__clear")?.addEventListener("click", () => {
      clearFinished();
      render();
    });
  };

  const onChange = () => render();
  const close = () => {
    window.removeEventListener("recognition-queue-changed", onChange);
    window.removeEventListener("recognition-job-progress", onChange);
    panel.remove();
  };

  window.addEventListener("recognition-queue-changed", onChange);
  window.addEventListener("recognition-job-progress", onChange);

  document.body.append(panel);
  render();
}

/**
 * Initialize footer
 */
export function initFooter() {
  if (!IS_NEXTCLOUD) {
    const syncStatus = document.querySelector(".sync-status");

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

      // Pulse green on real MCP traffic — mcpBridge.js's handle() dispatches
      // this on every tool call, success or failure alike. Snaps on
      // immediately, held just long enough for a paint, then released — the
      // 250ms fade-out (see .mcp-indicator's transition) is what actually
      // makes the pulse visible for a comfortable duration, not a JS hold.
      window.addEventListener("mcp-activity", () => {
        mcpIndicator.classList.add("mcp-indicator--active");
        clearTimeout(mcpActivityTimeout);
        mcpActivityTimeout = setTimeout(() => {
          mcpIndicator.classList.remove("mcp-indicator--active");
        }, 50);
      });
    }
  }

  // Recognition status is NOT Tauri-only. Sync and MCP are, which is why the
  // block above is guarded — but a slow model reached through the Nextcloud
  // proxy is precisely the case that most needs visible progress, and the NC
  // build showed none at all (DESIGN §7).
  initRecognitionIndicator();

  // Initialize version display. Hidden in NC, which has its own footer — the
  // footer exists there now only to carry recognition status.
  const versionEl = document.querySelector(".app-version");
  if (versionEl) {
    versionEl.textContent = IS_NEXTCLOUD ? "" : `v${APP_FULL_VERSION}`;
  }

  console.log("Footer initialized");
}
