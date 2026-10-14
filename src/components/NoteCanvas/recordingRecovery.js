/**
 * recordingRecovery.js - Last chance for a recording that could not be stored.
 *
 * When a finished recording cannot be read into the app or written to storage
 * (typically storage quota on a long recording), its native temp file is all
 * that is left, and the startup sweep deletes recording temp files. So the
 * user is told at once and offered to save the file somewhere of their
 * choosing; from there it can be imported into the note again with the sound
 * dialog's "Import audio file".
 *
 * Lives outside RecordingManager because it is UI, and because it must keep
 * working after the note that made the recording has closed.
 */

import { t } from "../../i18n/index.js";

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * File name offered in the save picker: `recording-YYYY-MM-DD_HH-MM{ext}`,
 * keeping the temp file's extension (.m4a, .mp4 or .wav).
 * @param {string} path - The temp file path
 * @param {Date} [date]
 */
export function suggestedRecordingName(path, date = new Date()) {
  const match = /\.(m4a|mp4|wav)$/i.exec(path ?? "");
  const ext = match ? `.${match[1].toLowerCase()}` : ".m4a";
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`;
  return `recording-${stamp}${ext}`;
}

async function defaultDeps() {
  const [{ invoke }, { showAlertDialog, showConfirmDialog }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("../modals.js"),
  ]);
  return { invoke, confirm: showConfirmDialog, alert: showAlertDialog };
}

/**
 * Explain the failure and offer to save the recording as a file.
 *
 * @param {{path: string, mimeType: string, error?: unknown}} info
 * @param {{invoke?: Function, confirm?: Function, alert?: Function}} [deps] - for tests
 * @returns {Promise<"exported"|"declined"|"cancelled"|"failed">}
 *   declined/cancelled/failed all leave the temp file in place until the next
 *   startup, so nothing is deleted without the user having chosen it.
 */
export async function offerRecordingRecovery({ path, mimeType, error }, deps = {}) {
  const injected = deps.invoke && deps.confirm && deps.alert;
  const { invoke, confirm, alert } = injected ? deps : { ...(await defaultDeps()), ...deps };
  const title = t("soundDialog.saveFailedTitle");
  const reason = escapeHtml(error?.message || String(error ?? ""));

  const keep = await confirm(
    title,
    t("soundDialog.saveFailedMsg", { reason }),
    t("soundDialog.saveFailedExport"),
    "btn-primary",
  );
  if (!keep) return "declined";

  let savedAs;
  try {
    savedAs = await invoke("native_audio_export", {
      path,
      suggestedName: suggestedRecordingName(path),
      mimeType,
    });
  } catch (err) {
    console.error("[RecordingRecovery] Export failed:", err);
    await alert(
      title,
      t("soundDialog.exportFailedMsg", { reason: escapeHtml(err?.message || String(err)) }),
    );
    return "failed";
  }
  if (!savedAs) return "cancelled"; // picker dismissed

  // The copy is safe; the temp file has done its job.
  try {
    await invoke("native_audio_delete", { path });
  } catch (_e) {
    /* swept at next startup anyway */
  }
  await alert(title, t("soundDialog.exportDoneMsg", { path: escapeHtml(savedAs) }));
  return "exported";
}
