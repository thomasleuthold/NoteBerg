/**
 * Settings Dialog
 *
 * Hosts the settings panel in a modal overlay instead of a full view mode.
 *
 * Why a dialog and not a router mode: navigating to a mode replaces
 * #main-content, which destroys an open note's canvas — losing scroll position,
 * zoom, and the selected tool. Worse, NoteCanvas/index.js tears the canvas down
 * on any `navigate` event whose previousMode is "notebook", so simply keeping
 * the note's DOM around would not be enough. Opening settings without going
 * through the router leaves the note mounted and untouched underneath.
 *
 * Settings that affect the view behind the dialog (theme, PDF inversion, card
 * size) already propagate by event — `themechange` is observed by NoteCanvas,
 * and card size re-renders the overview — so the view updates live underneath
 * without being rebuilt.
 */

import { t } from "../i18n/index.js";

/**
 * Own overlay id, deliberately NOT the shared #modal-overlay used by modals.js.
 * Every helper in modals.js removes any existing #modal-overlay before showing
 * its own, so reusing that id would make the first nested confirm/alert/prompt
 * opened *from* settings destroy the settings dialog behind it. Settings opens
 * several (revoke token, purge data, audit log, licenses).
 */
const OVERLAY_ID = "settings-overlay";

let isOpen = false;
let lastFocusedElement = null;

/**
 * Re-render the open dialog in the newly selected language.
 *
 * As a router mode, settings was re-rendered by changeLanguage's navigateTo.
 * The dialog is outside the router's view tree, so it has to refresh itself or
 * it keeps the previous language's strings until closed and reopened.
 */
async function handleLanguageChange() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!isOpen || !overlay) return;

  const title = overlay.querySelector(".settings-dialog__title");
  if (title) title.textContent = t("settings.title");

  const dialogEl = overlay.querySelector(".settings-dialog");
  dialogEl?.setAttribute("aria-label", t("settings.title"));

  const closeBtn = overlay.querySelector(".settings-dialog__close");
  closeBtn?.setAttribute("aria-label", t("modals.close"));

  const container = overlay.querySelector("#settings-content");
  if (!container) return;

  // Preserve scroll: re-rendering resets it, which would throw the user back to
  // the top of a long panel just for picking a language.
  const body = overlay.querySelector(".settings-dialog__body");
  const scrollTop = body?.scrollTop ?? 0;

  const { renderSettings } = await import("./settingsMode.js");
  await renderSettings(container);

  if (body) body.scrollTop = scrollTop;
}

function handleKeydown(event) {
  if (event.key !== "Escape") return;

  // Only the topmost dialog reacts. Nested dialogs from modals.js live in
  // #modal-overlay and attach their own bubble-phase Escape handlers without
  // stopping propagation, so without this check one Escape would close both the
  // nested dialog and the settings dialog behind it.
  if (document.getElementById("modal-overlay")) return;

  closeSettingsDialog();
}

/**
 * Whether the settings dialog is currently open. Used by the Android hardware
 * Back handler to close the dialog rather than navigating the app.
 */
export function isSettingsDialogOpen() {
  return isOpen;
}

export function closeSettingsDialog() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) {
    isOpen = false;
    return;
  }

  document.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("languagechange", handleLanguageChange);
  overlay.classList.add("modal-closing");
  setTimeout(() => overlay.remove(), 200);
  isOpen = false;

  // Return focus to whatever opened the dialog (usually the toolbar button).
  if (lastFocusedElement?.isConnected) lastFocusedElement.focus();
  lastFocusedElement = null;

  window.dispatchEvent(new CustomEvent("settingsdialogclose"));
}

/**
 * Open the settings dialog and render the settings panel into it.
 */
export async function openSettingsDialog() {
  if (isOpen) return;

  lastFocusedElement = document.activeElement;
  isOpen = true;

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "modal-overlay settings-overlay";
  overlay.innerHTML = `
    <div class="settings-dialog" role="dialog" aria-modal="true" aria-label="${t("settings.title")}">
      <div class="settings-dialog__header">
        <h2 class="settings-dialog__title">${t("settings.title")}</h2>
        <button class="modal-close settings-dialog__close" aria-label="${t("modals.close")}">&times;</button>
      </div>
      <div class="settings-dialog__body">
        <div id="settings-content"></div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector(".settings-dialog__close")?.addEventListener("click", closeSettingsDialog);

  // Backdrop click closes; clicks inside the dialog must not.
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeSettingsDialog();
  });

  document.addEventListener("keydown", handleKeydown);
  window.addEventListener("languagechange", handleLanguageChange);

  const { renderSettings } = await import("./settingsMode.js");
  const container = overlay.querySelector("#settings-content");
  if (container) await renderSettings(container);

  overlay.querySelector(".settings-dialog__close")?.focus();
}
