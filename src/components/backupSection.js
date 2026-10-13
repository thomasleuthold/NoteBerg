/**
 * Backup section of the settings screen (native builds only).
 *
 * Renders the section markup and wires the two flows — backup to file and
 * restore from file — over the domain modules in modules/backup_restore/.
 * Loaded on demand by settingsMode.js so the Nextcloud build never bundles it:
 * that build reads WebDAV directly and has no local corpus to back up.
 *
 * Both flows share the same pre-flight (§7.2 of the plan): no note may be open
 * (its canvas holds pending writes the DB has not received) and no sync may be
 * in flight. Restore additionally suspends auto-sync for its whole duration,
 * because auto-sync is event-driven and would otherwise race the writes.
 */

import { APP_VERSION } from "../config.js";
import { getCurrentLanguage, t } from "../i18n/index.js";
import {
  BackupCancelledError,
  estimateBackupSize,
  getBackupFreshness,
  getEncryptByDefault,
  invalidateBackupEstimate,
  isBackupStale,
  recordBackupSuccess,
  runBackup,
  suggestedBackupFilename,
} from "../modules/backup_restore/backup.js";
import {
  abortBackup,
  chooseBackupDestination,
  chooseRestoreSource,
  getBackupFreeSpace,
  openBackupReader,
  openBackupWriter,
} from "../modules/backup_restore/backupArchive.js";
import {
  applyRestore,
  checkCompatibility,
  indexArchive,
  MODE_MISSING,
  MODE_REPLACE_ALL,
  parseManifest,
  planRestore,
  scanRestore,
} from "../modules/backup_restore/restore.js";
import { purgeLocalData } from "../modules/storage.js";
import { bindGuardedClick } from "../utils/asyncAction.js";
import {
  showBackupPasswordDialog,
  showReplaceAllBlockedDialog,
  showRestoreCompleteDialog,
  showRestoreConfirmDialog,
  showRestoreModeDialog,
  showRestorePasswordPrompt,
} from "./backupModals.js";
import { showAlertDialog, showConfirmDialog, showProgressDialog } from "./modals.js";

/** Headroom over the estimate when checking free space (Android cache staging). */
const FREE_SPACE_HEADROOM = 1.2;
const FREE_SPACE_MIN_BYTES = 20 * 1024 * 1024;

// The blob-store walk behind the size estimate is cached in backup.js; any
// change to the corpus starts a fresh walk on the next render.
if (typeof window !== "undefined") {
  for (const event of ["datachange", "notes-updated"]) {
    window.addEventListener(event, invalidateBackupEstimate);
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

/** "180 MB" style, base 1024, one decimal below 10. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit > 0 && value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** "3 days ago" in the interface language; a user judging freshness thinks in elapsed time. */
export function formatRelativeTime(timestamp, now = Date.now(), lang = getCurrentLanguage()) {
  const seconds = Math.round((timestamp - now) / 1000);
  const steps = [
    ["year", 365 * 86400],
    ["month", 30 * 86400],
    ["week", 7 * 86400],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  let rtf;
  try {
    rtf = new Intl.RelativeTimeFormat(lang || "en", { numeric: "auto" });
  } catch (_e) {
    rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  }
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(0, "minute");
}

/**
 * The detail line under the progress bar. Always non-empty: a line that only
 * appears while media is being written makes the dialog's height jump.
 * @param {"writing"|"reading"} direction
 * @param {{phase: string, detail?: string}} p
 */
export function progressDetail(direction, p) {
  if (p.phase === "media") {
    return t(`backup.progress.${direction}Media`, { name: p.detail, percent: p.percent ?? 0 });
  }
  if (p.phase === "notebook") return t(`backup.progress.${direction}Notebook`);
  return t(`backup.progress.${direction}Note`);
}

/** "needed available" byte counts from a no-space error into the message params. */
function cacheSpaceParams(message) {
  const [needed, available] = String(message ?? "")
    .trim()
    .split(/\s+/)
    .map(Number);
  return [{ needed: formatBytes(needed), available: formatBytes(available) }];
}

const fileNameOf = (path) =>
  String(path ?? "")
    .split(/[\\/]/)
    .pop() || String(path ?? "");

// ─── Render ───────────────────────────────────────────────────────────────────

/**
 * The section markup. Async because the freshness line and the size estimate
 * are read from storage; the nav entry appears automatically from the <h3>.
 */
export async function renderBackupSection() {
  const [freshness, estimate, encryptByDefault] = await Promise.all([
    getBackupFreshness(),
    estimateBackupSize(),
    getEncryptByDefault(),
  ]);
  const stale = isBackupStale(freshness, estimate.noteCount);
  const never = freshness.lastBackupAt == null;

  const freshnessHtml = never
    ? `<div class="backup-freshness backup-freshness--warning" id="backup-freshness">${t("backup.freshness.never")}</div>`
    : `<div class="backup-freshness" id="backup-freshness" title="${escapeHtml(new Date(freshness.lastBackupAt).toLocaleString())}">
        ${t("backup.freshness.last", {
          when: formatRelativeTime(freshness.lastBackupAt),
          count: freshness.lastBackupNoteCount ?? 0,
        })}${freshness.lastBackupEncrypted ? ` <span class="backup-freshness__detail">· ${t("backup.freshness.encrypted")}</span>` : ""}
      </div>`;
  const nudgeHtml = stale
    ? `<div class="backup-nudge" id="backup-nudge">${never ? t("backup.freshness.neverNudge") : t("backup.freshness.staleNudge")}</div>`
    : "";

  return `
      <div class="settings-section" data-section="backup">
        <h3>${t("settings.sections.backup")}</h3>

        <div class="setting-item setting-item--full">
          ${freshnessHtml}
          ${nudgeHtml}
          <div class="backup-estimate" id="backup-estimate">${t("backup.estimate", {
            notes: estimate.noteCount,
            files: estimate.fileCount,
            size: formatBytes(estimate.bytes),
          })}</div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("backup.encryptLabel")}</span>
            <span class="setting-description">${t("backup.encryptDesc")}</span>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="backup-encrypt-toggle" ${encryptByDefault ? "checked" : ""} />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("backup.backupTitle")}</span>
            <span class="setting-description">${t("backup.backupDesc")}</span>
          </div>
          <div class="setting-item__actions">
            <button id="backup-create-btn" class="btn-primary">${t("backup.backupBtn")}</button>
            <span id="backup-status" class="setting-note"></span>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("backup.restoreTitle")}</span>
            <span class="setting-description">${t("backup.restoreDesc")}</span>
          </div>
          <div class="setting-item__actions">
            <button id="backup-restore-btn" class="btn-secondary">${t("backup.restoreBtn")}</button>
            <span id="restore-status" class="setting-note"></span>
          </div>
        </div>

        <div class="setting-item setting-item--full">
          <div class="backup-scope-note">${t("backup.scopeNote")}</div>
        </div>
      </div>
  `;
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

/**
 * Bind the two buttons.
 * @param {HTMLElement} container - the rendered settings form
 * @param {object} deps
 * @param {() => Promise<object>} deps.loadNextcloudSync - lazy nextcloudSync.js
 * @param {() => Promise<void>} deps.rerender - re-render settings (freshness line)
 */
export function initBackupSection(container, deps) {
  const createBtn = container.querySelector("#backup-create-btn");
  const restoreBtn = container.querySelector("#backup-restore-btn");
  if (!createBtn || !restoreBtn) return;

  const status = (id) => {
    const el = container.querySelector(`#${id}`);
    return (text, color) => {
      if (!el) return;
      el.textContent = text;
      el.style.color = color ?? "";
    };
  };
  const ctx = {
    ...deps,
    encryptToggle: container.querySelector("#backup-encrypt-toggle"),
    setBackupStatus: status("backup-status"),
    setRestoreStatus: status("restore-status"),
  };

  bindGuardedClick(createBtn, () => runBackupFlow(ctx), { busyLabel: t("backup.backingUp") });
  bindGuardedClick(restoreBtn, () => runRestoreFlow(ctx), { busyLabel: t("backup.restoring") });
}

/**
 * Pre-flight shared by both flows. Returns the blocking message, or null.
 * The checks import lazily so this module stays cheap to load.
 */
export async function preflightMessage() {
  const { getCurrentMode, getCurrentNoteId } = await import("../modules/router.js");
  if (getCurrentMode() === "notebook" && getCurrentNoteId()) return t("backup.errors.noteOpen");
  const { getIsSyncing } = await import("../modules/sync.js");
  if (getIsSyncing()) return t("backup.errors.syncing");
  // Locked, every note read (backup) or write (restore) throws, and a restore
  // would stop half-applied.
  const { isLocalEncryptionEnabled } = await import("../modules/storage.js");
  const { isAppUnlocked } = await import("../modules/masterPassword.js");
  if ((await isLocalEncryptionEnabled()) && !isAppUnlocked()) return t("backup.errors.locked");
  return null;
}

// ─── Backup flow ──────────────────────────────────────────────────────────────

export async function runBackupFlow(ctx) {
  const blocked = await preflightMessage();
  if (blocked) {
    await showAlertDialog(t("backup.backupTitle"), blocked);
    return;
  }

  let password = null;
  if (ctx.encryptToggle?.checked) {
    const entered = await showBackupPasswordDialog();
    if (!entered) return; // cancelled: silent
    password = entered.password;
  }

  // Android stages the archive in the cache dir; fail before any work rather
  // than halfway through. Desktop returns null and writes to the chosen path.
  const estimate = await estimateBackupSize();
  const free = await getBackupFreeSpace();
  if (free != null) {
    const needed = Math.max(estimate.bytes * FREE_SPACE_HEADROOM, FREE_SPACE_MIN_BYTES);
    if (needed > free) {
      await showAlertDialog(
        t("backup.done.backupFailedTitle"),
        t("backup.errors.cacheSpace", {
          needed: formatBytes(needed),
          available: formatBytes(free),
        }),
      );
      return;
    }
  }

  const path = await chooseBackupDestination(suggestedBackupFilename());
  if (!path) return; // picker cancelled: silent

  let cancelled = false;
  const progress = showProgressDialog(t("backup.progress.backupTitle"), {
    onCancel: () => {
      cancelled = true;
      progress.indeterminate(t("backup.progress.cancelling"));
    },
  });
  progress.indeterminate(t("backup.progress.preparing"));
  ctx.setBackupStatus("", null);

  let writer = null;
  try {
    writer = await openBackupWriter(path, password, {
      isCancelled: () => cancelled,
      onProgress: ({ name, written, total }) => {
        const percent = total > 0 ? Math.floor((written / total) * 100) : 100;
        progress.setNote(progressDetail("writing", { phase: "media", detail: name, percent }));
      },
    });
    const manifest = await runBackup(writer, {
      appVersion: APP_VERSION,
      encrypted: password != null,
      isCancelled: () => cancelled,
      onProgress: (p) => {
        if (p.phase === "finalize") {
          // From here the file is being finalised and copied; a cancel could
          // no longer be honoured, so the button must not offer one.
          progress.disableCancel();
          progress.indeterminate(t("backup.progress.finalizing"));
          return;
        }
        const key = p.phase === "notebook" ? "backup.progress.notebook" : "backup.progress.note";
        progress.update(p.current, p.total, t(key, { current: p.current + 1, total: p.total }));
        progress.setNote(progressDetail("writing", p));
      },
    });
    progress.indeterminate(t("backup.progress.saving"));
    const result = await writer.finish();
    writer = null;

    await recordBackupSuccess({
      noteCount: manifest.counts.notes,
      bytes: result.bytes,
      encrypted: password != null,
    });
    progress.close();
    ctx.setBackupStatus(
      t("backup.done.backupStatus", { size: formatBytes(result.bytes) }),
      "var(--nb-status-success)",
    );
    await showAlertDialog(
      t("backup.done.backupTitle"),
      t("backup.done.backupMsg", {
        count: manifest.counts.notes,
        path: escapeHtml(result.path),
        size: formatBytes(result.bytes),
      }),
    );
    await ctx.rerender?.();
  } catch (error) {
    progress.close();
    try {
      // Also when no writer exists yet: on Android the picker has already
      // created the destination document, and it must not be left behind.
      await (writer ? writer.abort() : abortBackup());
    } catch (_e) {
      /* the file may already be gone */
    }
    if (error instanceof BackupCancelledError || error?.code === "cancelled") {
      ctx.setBackupStatus(t("backup.done.backupCancelledStatus"), "var(--nb-status-warning)");
      return;
    }
    console.error("[Backup] Backup failed:", error);
    const message =
      error?.code === "io"
        ? t("backup.errors.diskFull", { message: error.message })
        : error?.message || String(error);
    ctx.setBackupStatus(t("backup.done.backupFailedStatus", { message }), "var(--nb-status-error)");
    await showAlertDialog(t("backup.done.backupFailedTitle"), escapeHtml(message));
  } finally {
    // Never keep the password around longer than the run.
    password = null;
  }
}

// ─── Restore flow ─────────────────────────────────────────────────────────────

/** Map a restore/archive error to the message the user should see. */
export function describeRestoreError(error, fileName) {
  const file = escapeHtml(fileName);
  switch (error?.code) {
    case "not-a-backup":
      return t("backup.errors.notABackup", { file });
    case "corrupt":
    case "size-mismatch":
    case "password-required":
      return t("backup.errors.corrupt", { file });
    case "unsafe-entry":
      return t("backup.errors.unsafeEntry", { file });
    case "entry-too-large":
      return t("backup.errors.entryTooLarge", { file });
    case "schema-newer":
    case "db-newer":
      return t("backup.errors.newerVersion", {
        version: escapeHtml(error.details?.appVersion || "?"),
      });
    default:
      return escapeHtml(error?.message || String(error));
  }
}

/** Ask for the password until it is right or the user gives up. */
async function unlockReader(reader) {
  let wrong = false;
  for (;;) {
    const password = await showRestorePasswordPrompt({ wrong });
    if (password == null) return false;
    try {
      await reader.unlock(password);
      return true;
    } catch (error) {
      if (error?.code !== "wrong-password") throw error;
      wrong = true;
    }
  }
}

/**
 * "Replace everything" is refused while Nextcloud is connected: purging and
 * re-uploading is indistinguishable from a mass deletion to the server. Offers
 * the disconnect inline. Returns false when the user backs out.
 */
async function prepareReplaceAll(ctx) {
  const { isAuthenticated, clearCredentials } = await ctx.loadNextcloudSync();
  if (await isAuthenticated()) {
    const disconnect = await showReplaceAllBlockedDialog();
    if (!disconnect) return false;
    await clearCredentials();
    window.dispatchEvent(new CustomEvent("nextcloud-auth-changed"));
  }
  const confirmed = await showConfirmDialog(
    t("backup.restore.replaceAllConfirmTitle"),
    t("backup.restore.replaceAllConfirmMsg"),
    t("backup.restore.replaceAllConfirmBtn"),
    "btn-danger",
  );
  return confirmed;
}

async function openRecycleBin() {
  const { closeSettingsDialog } = await import("./settingsDialog.js");
  const { navigateTo } = await import("../modules/router.js");
  closeSettingsDialog();
  navigateTo("recyclebin");
}

export async function runRestoreFlow(ctx) {
  const blocked = await preflightMessage();
  if (blocked) {
    await showAlertDialog(t("backup.restoreTitle"), blocked);
    return;
  }

  let path;
  try {
    path = await chooseRestoreSource();
  } catch (error) {
    // Android copies the chosen document into the app cache before Rust can
    // open it, and refuses up front when it would not fit.
    const message =
      error?.code === "no-space"
        ? t("backup.errors.cacheSpace", ...cacheSpaceParams(error.message))
        : escapeHtml(error?.message || String(error));
    await showAlertDialog(t("backup.done.restoreFailedTitle"), message);
    return;
  }
  if (!path) return; // picker cancelled: silent
  const fileName = fileNameOf(path);
  ctx.setRestoreStatus("", null);

  let reader = null;
  let progress = null;
  let summary = null;
  let notebooksKept = 0;
  let restoreCancelled = false;
  let applyStarted = false;
  const { suspendAutoSync, resumeAutoSync } = await import("../modules/autoSync.js");
  suspendAutoSync();
  try {
    reader = await openBackupReader(path, {
      isCancelled: () => restoreCancelled,
      onProgress: ({ name, read, total }) => {
        const percent = total > 0 ? Math.floor((read / total) * 100) : 100;
        progress?.setNote(progressDetail("reading", { phase: "media", detail: name, percent }));
      },
    });
    const manifest = parseManifest(reader.manifestText ?? "");
    checkCompatibility(manifest);
    if (manifest.encrypted && !(await unlockReader(reader))) return;

    const index = indexArchive(reader.entries, manifest);

    progress = showProgressDialog(t("backup.progress.scanTitle"));
    progress.indeterminate(t("backup.progress.scanning"));
    let scan = await scanRestore(reader, index);
    progress.close();
    progress = null;

    // Progressive disclosure: the scan decides how much UI appears. No
    // conflicts means one confirm and no mode selection.
    let mode = MODE_MISSING;
    let decisions = {};
    if (scan.counts.conflicts === 0) {
      if (!(await showRestoreConfirmDialog({ scan, manifest }))) return;
    } else {
      const choice = await showRestoreModeDialog({ scan, manifest });
      if (!choice) return;
      mode = choice.mode;
      decisions = choice.decisions;
    }

    if (mode === MODE_REPLACE_ALL) {
      if (!(await prepareReplaceAll(ctx))) return;
      progress = showProgressDialog(t("backup.progress.restoreTitle"));
      progress.indeterminate(t("backup.progress.purging"));
      await purgeLocalData();
      window.dispatchEvent(new CustomEvent("notes-updated"));
      scan = await scanRestore(reader, index); // everything is new now
      progress.close();
      progress = null;
    }

    notebooksKept = scan.notebooks.filter((nb) => nb.status === "keep" && nb.titleDiffers).length;
    const plan = planRestore(scan, { mode, decisions });

    progress = showProgressDialog(t("backup.progress.restoreTitle"), {
      onCancel: () => {
        restoreCancelled = true;
        progress.indeterminate(t("backup.progress.cancelling"));
      },
    });
    progress.indeterminate(t("backup.progress.preparing"));
    applyStarted = true;
    summary = await applyRestore(reader, index, plan, {
      replacedSuffix: t("backup.restore.replacedSuffix"),
      isCancelled: () => restoreCancelled,
      onProgress: (p) => {
        if (restoreCancelled || p.phase === "done") return;
        const key = p.phase === "notebook" ? "backup.progress.notebook" : "backup.progress.note";
        progress.update(p.current, p.total, t(key, { current: p.current + 1, total: p.total }));
        progress.setNote(progressDetail("reading", p));
      },
    });
    progress.close();
    progress = null;
  } catch (error) {
    progress?.close();
    console.error("[Restore] Restore failed:", error);
    const message = describeRestoreError(error, fileName);
    ctx.setRestoreStatus(
      t("backup.done.restoreFailedStatus", { message }),
      "var(--nb-status-error)",
    );
    await showAlertDialog(t("backup.done.restoreFailedTitle"), message);
    return;
  } finally {
    resumeAutoSync();
    if (reader) {
      try {
        await reader.close();
      } catch (_e) {
        /* nothing left to release */
      }
    }
    // Anything apply wrote is real, whether or not it finished: the overview
    // must not keep showing the corpus as it was.
    if (applyStarted) window.dispatchEvent(new CustomEvent("notes-updated"));
  }

  if (summary.cancelled) {
    ctx.setRestoreStatus(
      t("backup.done.restoreCancelledStatus", { restored: summary.restored, total: summary.total }),
      "var(--nb-status-warning)",
    );
  } else {
    ctx.setRestoreStatus(t("backup.done.restoreStatus"), "var(--nb-status-success)");
  }
  await showRestoreCompleteDialog(summary, { notebooksKept, onOpenRecycleBin: openRecycleBin });

  // Restored items are dirty local edits; push them before anything else
  // touches the server. Restored notes carry `restoredAt` and upload as-is;
  // anything the merge cannot settle resolves by timestamp, which the restore
  // has just set, so nothing is left sitting as an unreported conflict. Not
  // awaited: the footer shows sync progress.
  const { isAuthenticated } = await ctx.loadNextcloudSync();
  if (await isAuthenticated()) {
    import("../modules/sync.js")
      .then(({ performSync }) =>
        performSync({ silent: true, skipConflictResolution: true, preferNewer: true }),
      )
      .catch((e) => console.warn("[Restore] Post-restore sync failed:", e));
  }
}
