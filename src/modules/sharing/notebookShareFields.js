/**
 * Local-only sharing fields on a notebook record (DESIGN §5.1).
 *
 * They describe this user's relationship to a notebook, not the notebook, so
 * they never travel: not uploaded (a collaborator would otherwise write
 * `origin:"shared"` into the owner's `_notebook.json`), not adopted from a
 * downloaded file (a buggy or malicious collaborator could write them), not
 * backed up. Absent `origin` means an own notebook, so existing records need no
 * migration.
 */

export const NOTEBOOK_LOCAL_FIELDS = [
  "origin", // "own" | "shared"
  "remoteBasePath", // shared: current OCS file_target
  "ownerUid", // shared
  "ownerDisplayName", // shared
  "sharePermissions", // shared: permission bits as granted
  "shareId", // shared: OCS share id (the first of shareIds)
  "shareIds", // shared: every OCS share mounting the folder (user and group shares)
  "normalized", // shared: moved into /Shared_NoteBerg once
  "shareEnded", // shared: share gone, kept frozen for unsynced changes
  "strandedNoteIds", // shared: notes whose changes can no longer be uploaded
];

/** The notebook without its local-only fields: the form that goes to the server and into archives. */
export function stripLocalFields(notebook) {
  const copy = { ...notebook };
  for (const field of NOTEBOOK_LOCAL_FIELDS) delete copy[field];
  return copy;
}

/**
 * A notebook received from the server, with the local-only fields taken from
 * the existing local record (if any) and never from the file.
 */
export function adoptRemoteNotebook(remote, local) {
  const adopted = stripLocalFields(remote);
  if (!local) return adopted;
  for (const field of NOTEBOOK_LOCAL_FIELDS) {
    if (field in local) adopted[field] = local[field];
  }
  return adopted;
}
