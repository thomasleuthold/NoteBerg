/**
 * Backup & restore dialogs.
 *
 * Feature-specific modals kept beside modals.js rather than inside it, the way
 * masterPasswordModals.js is. Same conventions: one #modal-overlay at a time,
 * a `modal-closing` fade, Escape cancels, every dialog resolves a value and
 * never throws.
 *
 * Dialogs:
 *   showBackupPasswordDialog()      set a new archive password (confirm +
 *                                   strength + unrecoverable warning)
 *   showRestorePasswordPrompt()     enter a known password, with a re-prompt
 *                                   on a wrong one
 *   showRestoreConfirmDialog()      the zero-decision path: one confirm
 *   showRestoreModeDialog()         mode picker + conflict summary + review list
 *   showReplaceAllBlockedDialog()   "Nextcloud is connected" with the inline
 *                                   disconnect action
 *   showRestoreCompleteDialog()     summary with a button to the recycle bin
 */

import { t } from "../i18n/index.js";
import {
  MODE_MISSING,
  MODE_PREFER_BACKUP,
  MODE_REPLACE_ALL,
} from "../modules/backup_restore/restore.js";
import {
  calculatePasswordStrength,
  getPasswordStrengthColor,
  getPasswordStrengthLabel,
} from "../modules/encryption.js";

const MIN_PASSWORD_LENGTH = 8;
/**
 * Stricter than the master-password setup (30). The archive can be attacked
 * offline, and WinZip AES derives its key with PBKDF2-SHA1 at 1000 iterations,
 * a figure the zip format fixes; the password itself is the only strength
 * available.
 */
const MIN_PASSWORD_STRENGTH = 50;

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

const formatDate = (ts) => (ts ? new Date(ts).toLocaleString() : "—");

/**
 * Mount a dialog and return a one-shot closer. `wide` opts into the wider
 * layout used by the conflict dialog.
 */
function mountDialog(bodyHtml, { title, footerHtml, wide = false, closeButton = true }) {
  document.getElementById("modal-overlay")?.remove();

  const html = `
    <div id="modal-overlay" class="modal-overlay">
      <div class="modal-dialog${wide ? " modal--wide" : ""}">
        <div class="modal-header">
          <h3 class="modal-title">${title}</h3>
          ${closeButton ? `<button class="modal-close" aria-label="${t("modals.close")}">&times;</button>` : ""}
        </div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-footer">${footerHtml}</div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", html);
  const overlay = document.getElementById("modal-overlay");

  let settled = false;
  let resolveResult;
  const result = new Promise((resolve) => {
    resolveResult = resolve;
  });

  const close = (value) => {
    if (settled) return;
    settled = true;
    document.removeEventListener("keydown", onKey);
    overlay.classList.add("modal-closing");
    setTimeout(() => {
      overlay.remove();
      resolveResult(value);
    }, 200);
  };

  const onKey = (e) => {
    if (e.key === "Escape") close(null);
  };
  document.addEventListener("keydown", onKey);
  overlay.querySelector(".modal-close")?.addEventListener("click", () => close(null));
  overlay.querySelector(".modal-cancel")?.addEventListener("click", () => close(null));

  return { overlay, close, result };
}

function showError(overlay, message) {
  const el = overlay.querySelector(".modal-error");
  if (!el) return;
  el.textContent = message;
  el.style.display = "block";
}

// ─── Backup password ──────────────────────────────────────────────────────────

/**
 * Set a password for a new archive. Mirrors showMasterPasswordSetup: a
 * confirm field (a single un-confirmed field is a data-loss trap — one typo
 * and the archive is unreadable, discovered months later), a strength meter,
 * and the warning that there is no reset and no recovery key.
 *
 * Deliberately no hint field: a hint that helps is a hint that leaks, and it
 * would sit unencrypted in the archive next to the data it protects.
 *
 * @returns {Promise<{password: string}|null>} null when cancelled
 */
export function showBackupPasswordDialog() {
  const body = `
    <p class="modal-description">${t("backup.password.description")}</p>
    <div class="form-group">
      <label for="backup-password">${t("backup.password.passwordLabel")}</label>
      <input type="password" id="backup-password" class="form-control"
        placeholder="${t("backup.password.passwordPlaceholder")}" autocomplete="new-password" />
      <div class="password-strength">
        <div class="strength-bar"><div class="strength-fill" id="backup-strength-fill"></div></div>
        <span class="strength-label" id="backup-strength-label">${t("auth.strength.enterPassword")}</span>
      </div>
    </div>
    <div class="form-group">
      <label for="backup-password-confirm">${t("backup.password.confirmLabel")}</label>
      <input type="password" id="backup-password-confirm" class="form-control"
        placeholder="${t("backup.password.confirmPlaceholder")}" autocomplete="new-password" />
    </div>
    <div class="warning-box">${t("backup.password.warning")}</div>
    <p class="backup-note">${t("backup.password.independentNote")}</p>
    <div class="modal-error" style="display: none;"></div>
  `;
  const footer = `
    <button class="btn-secondary modal-cancel">${t("common.cancel")}</button>
    <button class="btn-primary modal-confirm">${t("backup.password.confirmBtn")}</button>
  `;
  const { overlay, close, result } = mountDialog(body, {
    title: t("backup.password.title"),
    footerHtml: footer,
  });

  const passwordInput = overlay.querySelector("#backup-password");
  const confirmInput = overlay.querySelector("#backup-password-confirm");
  const fill = overlay.querySelector("#backup-strength-fill");
  const label = overlay.querySelector("#backup-strength-label");

  passwordInput.addEventListener("input", () => {
    const strength = calculatePasswordStrength(passwordInput.value);
    const color = getPasswordStrengthColor(strength);
    fill.style.width = `${strength}%`;
    fill.style.backgroundColor = color;
    label.textContent = getPasswordStrengthLabel(strength);
    label.style.color = color;
  });

  const submit = () => {
    const password = passwordInput.value;
    if (password.length < MIN_PASSWORD_LENGTH) {
      showError(overlay, t("auth.errors.tooShort"));
      passwordInput.focus();
      return;
    }
    if (calculatePasswordStrength(password) < MIN_PASSWORD_STRENGTH) {
      showError(overlay, t("auth.errors.tooWeak"));
      passwordInput.focus();
      return;
    }
    if (password !== confirmInput.value) {
      showError(overlay, t("auth.errors.mismatch"));
      confirmInput.focus();
      return;
    }
    close({ password });
  };

  overlay.querySelector(".modal-confirm").addEventListener("click", submit);
  for (const input of [passwordInput, confirmInput]) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
  }
  setTimeout(() => passwordInput.focus(), 100);
  return result;
}

// ─── Restore password ─────────────────────────────────────────────────────────

/**
 * Enter the password of an encrypted archive. `wrong` re-prompts with an
 * "incorrect password" line instead of aborting the flow.
 *
 * @param {{wrong?: boolean}} [options]
 * @returns {Promise<string|null>}
 */
export function showRestorePasswordPrompt({ wrong = false } = {}) {
  const body = `
    <p>${t("backup.restore.passwordMessage")}</p>
    <div class="form-field modal-password-field">
      <input type="password" id="restore-password" class="form-input"
        placeholder="${t("backup.restore.passwordPlaceholder")}" autocomplete="off" />
    </div>
    <div class="modal-error" style="display: ${wrong ? "block" : "none"};">${wrong ? t("backup.restore.wrongPassword") : ""}</div>
  `;
  const footer = `
    <button class="btn-secondary modal-cancel">${t("common.cancel")}</button>
    <button class="btn-primary modal-confirm">${t("common.ok")}</button>
  `;
  const { overlay, close, result } = mountDialog(body, {
    title: t("backup.restore.passwordTitle"),
    footerHtml: footer,
  });
  const input = overlay.querySelector("#restore-password");
  const submit = () => {
    if (input.value) close(input.value);
  };
  overlay.querySelector(".modal-confirm").addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  setTimeout(() => input.focus(), 100);
  return result;
}

// ─── Restore: zero-decision confirm ───────────────────────────────────────────

function fromAppLine(manifest) {
  return `<p class="backup-note">${t("backup.restore.fromApp", {
    date: formatDate(manifest.createdAt),
    version: escapeHtml(manifest.appVersion || "?"),
  })}</p>`;
}

/**
 * The common case — empty device, or existing data with no id collisions —
 * asks exactly one question after the file picker.
 * @returns {Promise<boolean>}
 */
export function showRestoreConfirmDialog({ scan, manifest }) {
  const key = scan.hasLocalData
    ? "backup.restore.confirmNoConflicts"
    : "backup.restore.confirmEmpty";
  const body = `
    <div class="confirm-message">${t(key, { notes: scan.counts.notes, notebooks: scan.counts.notebooks })}</div>
    ${fromAppLine(manifest)}
  `;
  const footer = `
    <button class="btn-secondary modal-cancel">${t("common.cancel")}</button>
    <button class="btn-primary modal-confirm">${t("backup.restore.confirmBtn")}</button>
  `;
  const { overlay, close, result } = mountDialog(body, {
    title: t("backup.restore.confirmTitle"),
    footerHtml: footer,
  });
  overlay.querySelector(".modal-confirm").addEventListener("click", () => close(true));
  setTimeout(() => overlay.querySelector(".modal-confirm").focus(), 100);
  return result.then((v) => v === true);
}

// ─── Restore: mode + conflict review ──────────────────────────────────────────

function modeOption(mode, checked, suffix) {
  const labels = {
    [MODE_MISSING]: ["backup.restore.modeMissing", "backup.restore.modeMissingDesc"],
    [MODE_PREFER_BACKUP]: [
      "backup.restore.modePreferBackup",
      "backup.restore.modePreferBackupDesc",
    ],
    [MODE_REPLACE_ALL]: ["backup.restore.modeReplaceAll", "backup.restore.modeReplaceAllDesc"],
  };
  const [labelKey, descKey] = labels[mode];
  return `
    <label class="restore-mode">
      <input type="radio" name="restore-mode" value="${mode}" ${checked ? "checked" : ""} />
      <span class="restore-mode__label">${t(labelKey)}
        <span class="restore-mode__desc">${t(descKey, { suffix })}</span>
      </span>
    </label>
  `;
}

function reviewItem(conflict, decision) {
  return `
    <div class="restore-review__item" data-id="${escapeHtml(conflict.id)}">
      <div class="restore-review__text">
        <div class="restore-review__title" title="${escapeHtml(conflict.title)}">${escapeHtml(conflict.title || t("common.untitled"))}</div>
        <div class="restore-review__meta">
          ${t("backup.restore.localVersion", { date: formatDate(conflict.local?.modified) })} ·
          ${t("backup.restore.backupVersion", { date: formatDate(conflict.backup?.modified) })}
        </div>
      </div>
      <div class="restore-review__choice" role="group">
        <button type="button" class="btn-secondary" data-choice="local" aria-pressed="${decision === "local"}">${t("backup.restore.keepLocal")}</button>
        <button type="button" class="btn-secondary" data-choice="backup" aria-pressed="${decision === "backup"}">${t("backup.restore.useBackup")}</button>
      </div>
    </div>
  `;
}

/**
 * Shown only when the scan found genuine conflicts. Picks the restore mode
 * (prefer-backup pre-selected) and, from there, an optional per-note review of
 * the conflicts — a list variant of showConflictResolutionDialog, without
 * previews. Decisions default to the newer side.
 *
 * @returns {Promise<{mode: string, decisions: Record<string, "local"|"backup">}|null>}
 */
export function showRestoreModeDialog({ scan, manifest }) {
  const suffix = t("backup.restore.replacedSuffix");
  const decisions = {};
  for (const c of scan.conflicts) decisions[c.id] = c.backupNewer ? "backup" : "local";
  let mode = MODE_PREFER_BACKUP;

  const modeView = () => `
    ${fromAppLine(manifest)}
    <div class="backup-summary">
      <p>${t("backup.restore.conflictSummary", {
        count: scan.counts.conflicts,
        localNewer: scan.counts.localNewer,
        backupNewer: scan.counts.backupNewer,
      })}</p>
      <p>${t("backup.restore.newSummary", { count: scan.counts.newNotes })}</p>
    </div>
    <div class="restore-mode-list">
      ${modeOption(MODE_MISSING, mode === MODE_MISSING, suffix)}
      ${modeOption(MODE_PREFER_BACKUP, mode === MODE_PREFER_BACKUP, suffix)}
      ${modeOption(MODE_REPLACE_ALL, mode === MODE_REPLACE_ALL, suffix)}
    </div>
    <div class="restore-mode__actions">
      <button type="button" id="restore-review-btn" class="btn-secondary" ${mode === MODE_PREFER_BACKUP ? "" : "disabled"}>${t("backup.restore.review", { count: scan.counts.conflicts })}</button>
    </div>
  `;

  const reviewView = () => `
    <p>${t("backup.restore.reviewDesc")}</p>
    <div class="restore-review__bulk">
      <button type="button" class="btn-secondary" data-bulk="local">${t("backup.restore.allLocal")}</button>
      <button type="button" class="btn-secondary" data-bulk="backup">${t("backup.restore.allBackup")}</button>
    </div>
    <div class="restore-review__list">
      ${scan.conflicts.map((c) => reviewItem(c, decisions[c.id])).join("")}
    </div>
  `;

  const footer = `
    <button type="button" id="restore-back-btn" class="btn-secondary" style="display: none;">${t("backup.restore.back")}</button>
    <button class="btn-secondary modal-cancel">${t("common.cancel")}</button>
    <button class="btn-primary modal-confirm">${t("backup.restore.continue")}</button>
  `;
  const { overlay, close, result } = mountDialog(modeView(), {
    title: t("backup.restore.modeTitle"),
    footerHtml: footer,
    wide: true,
  });
  const body = overlay.querySelector(".modal-body");
  const title = overlay.querySelector(".modal-title");
  const backBtn = overlay.querySelector("#restore-back-btn");

  const setPressed = (item, choice) => {
    for (const btn of item.querySelectorAll("[data-choice]")) {
      btn.setAttribute("aria-pressed", String(btn.dataset.choice === choice));
    }
  };

  const showMode = () => {
    body.innerHTML = modeView();
    title.textContent = t("backup.restore.modeTitle");
    backBtn.style.display = "none";
    body.querySelectorAll("input[name=restore-mode]").forEach((input) => {
      input.addEventListener("change", () => {
        mode = input.value;
        body.querySelector("#restore-review-btn").disabled = mode !== MODE_PREFER_BACKUP;
      });
    });
    body.querySelector("#restore-review-btn").addEventListener("click", showReview);
  };

  const showReview = () => {
    body.innerHTML = reviewView();
    title.textContent = t("backup.restore.reviewTitle");
    backBtn.style.display = "";
  };

  // One delegated listener for the review controls, attached once: the views
  // swap by innerHTML, and the selectors match nothing in the mode view.
  body.addEventListener("click", (e) => {
    const choiceBtn = e.target.closest("[data-choice]");
    if (choiceBtn) {
      const item = choiceBtn.closest(".restore-review__item");
      decisions[item.dataset.id] = choiceBtn.dataset.choice;
      setPressed(item, choiceBtn.dataset.choice);
      return;
    }
    const bulkBtn = e.target.closest("[data-bulk]");
    if (bulkBtn) {
      for (const item of body.querySelectorAll(".restore-review__item")) {
        decisions[item.dataset.id] = bulkBtn.dataset.bulk;
        setPressed(item, bulkBtn.dataset.bulk);
      }
    }
  });

  backBtn.addEventListener("click", showMode);
  overlay.querySelector(".modal-confirm").addEventListener("click", () => {
    close({ mode, decisions: { ...decisions } });
  });
  showMode();
  return result;
}

// ─── Replace-all blocked by Nextcloud ─────────────────────────────────────────

/**
 * States the reason, states what disconnecting does not do, and offers the
 * action inline. A bare "disconnect first" would be a dead end.
 * @returns {Promise<boolean>} true to disconnect and continue
 */
export function showReplaceAllBlockedDialog() {
  const body = `<div class="confirm-message">${t("backup.restore.replaceAllNcBlocked")}</div>`;
  const footer = `
    <button class="btn-secondary modal-cancel">${t("common.cancel")}</button>
    <button class="btn-primary modal-confirm btn-warning">${t("backup.restore.disconnectAndContinue")}</button>
  `;
  const { overlay, close, result } = mountDialog(body, {
    title: t("backup.restore.replaceAllNcBlockedTitle"),
    footerHtml: footer,
  });
  overlay.querySelector(".modal-confirm").addEventListener("click", () => close(true));
  return result.then((v) => v === true);
}

// ─── Completion ───────────────────────────────────────────────────────────────

/**
 * The completion summary. Names how many notes were displaced and offers a
 * button that opens the recycle bin, so the audit trail is one click away at
 * the moment it matters. A cancelled restore says how far it got and that
 * running again is safe.
 *
 * @param {object} summary - from applyRestore
 * @param {{onOpenRecycleBin?: () => void, notebooksKept?: number}} [options]
 */
export function showRestoreCompleteDialog(summary, { onOpenRecycleBin, notebooksKept = 0 } = {}) {
  const suffix = t("backup.restore.replacedSuffix");
  const cancelled = summary.cancelled;
  const lines = [];
  if (cancelled) {
    lines.push(
      t("backup.done.restoreCancelledMsg", { restored: summary.restored, total: summary.total }),
    );
  } else {
    lines.push(
      t("backup.done.restoreMsg", {
        restored: summary.restored,
        skipped: summary.skipped,
        replaced: summary.replaced,
      }),
    );
  }
  lines.push(
    t("backup.done.restoreNotebooks", {
      created: summary.notebooksCreated,
      restoredNotebooks: summary.notebooksRestored,
      kept: notebooksKept,
    }),
  );
  if (summary.replaced > 0) lines.push(t("backup.done.restoreReplacedHint", { suffix }));

  const body = `<div class="confirm-message">${lines.map((l) => `<p>${l}</p>`).join("")}</div>`;
  const footer = `
    ${summary.replaced > 0 ? `<button type="button" id="restore-open-bin-btn" class="btn-secondary">${t("backup.done.openRecycleBin")}</button>` : ""}
    <button class="btn-primary modal-confirm">${t("common.ok")}</button>
  `;
  const { overlay, close, result } = mountDialog(body, {
    title: cancelled ? t("backup.done.restoreCancelledTitle") : t("backup.done.restoreTitle"),
    footerHtml: footer,
  });
  overlay.querySelector(".modal-confirm").addEventListener("click", () => close(true));
  overlay.querySelector("#restore-open-bin-btn")?.addEventListener("click", () => {
    close(true);
    onOpenRecycleBin?.();
  });
  setTimeout(() => overlay.querySelector(".modal-confirm").focus(), 100);
  return result.then(() => undefined);
}
