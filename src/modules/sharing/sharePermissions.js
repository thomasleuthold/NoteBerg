/**
 * What this user may do with a notebook, as a pure function of the notebook
 * record (DESIGN §3, §4). All UI gating, storage guards and background writers
 * ask here, so a permission is interpreted in exactly one place.
 *
 * Gating is on the permissions GRANTED by the server, read back on every
 * discovery pass, never on what was requested: an admin policy can reduce them.
 */

/** Nextcloud share permission bits. */
export const PERMISSION = { READ: 1, UPDATE: 2, CREATE: 4, DELETE: 8, SHARE: 16 };

/** Permissions requested when sharing: read-only, or read + update + create (no delete, no re-share). */
export const SHARE_MODE_PERMISSIONS = {
  readonly: PERMISSION.READ,
  collab: PERMISSION.READ | PERMISSION.UPDATE | PERMISSION.CREATE,
};

/** True for a notebook shared with this user (as opposed to one they own). */
export function isShared(notebook) {
  return notebook?.origin === "shared";
}

/** True once the share behind a shared notebook is gone. */
export function isShareEnded(notebook) {
  return isShared(notebook) && notebook.shareEnded === true;
}

/**
 * Whether content in the notebook may be changed: notes edited or created, media
 * added or removed, the notebook renamed or recolored. Needs UPDATE and CREATE.
 * A share with UPDATE but no CREATE is read-only, because adding media would fail.
 * Own notebooks (and quick notes, `notebook` null) are always editable.
 */
export function canEdit(notebook) {
  if (!isShared(notebook)) return true;
  if (notebook.shareEnded) return false;
  const granted = notebook.sharePermissions;
  if (typeof granted !== "number") return false;
  const needed = PERMISSION.UPDATE | PERMISSION.CREATE;
  return (granted & needed) === needed;
}

/**
 * Whether the notebook may be deleted, purged, moved, copied, restored or shared
 * further. Recipients never may, whatever the share grants.
 */
export function canManage(notebook) {
  return !isShared(notebook);
}
