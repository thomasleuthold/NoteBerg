/**
 * Notebooks other users shared with this one: finding them, registering them,
 * and noticing when they are gone (DESIGN §7, §8). Used by both builds; what
 * differs between them is injected:
 *
 *   dav    file operations on the user's own tree (native: Basic auth through the
 *          Tauri client; Nextcloud app: same-origin fetch)
 *   ocs    the sharing API (nextcloudShares.js, which already picks its transport)
 *   store  where registrations live (native: notebook records in IndexedDB;
 *          Nextcloud app: memory, nothing is ever persisted there)
 *
 * Every decision that deletes or hides something requires two signals (OCS says
 * the share is gone AND its folder is gone), and nothing at all happens unless
 * the OCS listing itself succeeded: a failed or empty-but-failed response must
 * never read as "all shares revoked".
 */

import { assertSafeId, ROOT_FOLDER, validateBasePath } from "../storagePaths.js";
import { stripLocalFields } from "./notebookShareFields.js";
import { canEdit, isShared } from "./sharePermissions.js";

/** Where this app keeps shares it has moved out of the way, so they do not litter the user's files. */
export const SHARED_FOLDER = "/Shared_NoteBerg";

/**
 * @typedef {object} DavOps
 * @property {(path: string) => Promise<string|null|undefined>} ownerOf
 *   user ID owning the node; null when the server does not say; undefined when absent
 * @property {(path: string) => Promise<boolean>} exists
 * @property {(path: string) => Promise<void>} mkcol - an existing folder is fine
 * @property {(from: string, to: string) => Promise<void>} move - never overwrites
 * @property {(path: string) => Promise<object|null>} readJson - null when absent or unreadable
 */

/**
 * @typedef {object} ShareStore
 * @property {() => Promise<object[]>} list - every notebook record, own and shared
 * @property {(record: object) => Promise<void>} upsert
 * @property {(id: string, patch: object) => Promise<void>} update
 * @property {(id: string) => Promise<void>} forget - remove the notebook and its notes locally, no remote call
 * @property {(record: object) => Promise<boolean>} hasUnsyncedChanges
 */

const sameUser = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const isFolderUserShare = (share) => share.shareType === 0 && share.itemType === "folder";
const trimSlash = (path) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

// ─── Names ────────────────────────────────────────────────────────────────────

const FORBIDDEN_NAME_CHARS = new Set(["\\", "/", ":", "*", "?", '"', "<", ">", "|"]);

/** One safe path segment out of arbitrary text. */
function safeSegment(text, fallback) {
  let cleaned = "";
  for (const ch of String(text ?? "")) {
    const code = ch.charCodeAt(0);
    cleaned += FORBIDDEN_NAME_CHARS.has(ch) || code < 0x20 || code === 0x7f ? "_" : ch;
  }
  cleaned = cleaned.replace(/^\.+/, "_").trim().slice(0, 80);
  return cleaned || fallback;
}

/**
 * Where a share is moved to: `/Shared_NoteBerg/{notebookId}`. The id is unique
 * and made of safe characters only, and unlike a title it never goes stale
 * when the owner renames the notebook. Suffixed only if something already
 * occupies the name (e.g. a folder the user created there).
 */
async function freeMountPath(dav, notebookId) {
  const stem = `${SHARED_FOLDER}/${notebookId}`;
  if (!(await dav.exists(stem))) return stem;
  for (let n = 2; ; n++) {
    const candidate = `${stem}_${n}`;
    if (!(await dav.exists(candidate))) return candidate;
  }
}

// ─── Root guard (§7.4) ────────────────────────────────────────────────────────

/**
 * Before the own tree is read or written: make sure `/NoteBerg` really is the
 * user's. A folder shared to someone who has never run the app lands at
 * `/NoteBerg` and would otherwise hijack their storage (cf. Nextcloud Notes
 * CVE-2024-37317). A foreign root is moved to the shared folder and a fresh own
 * root created.
 *
 * @param {object} deps
 * @param {DavOps} deps.dav
 * @param {string} deps.uid - the signed-in user
 * @param {boolean} [deps.uidConfirmed] - false when `uid` is only a guess (the login
 *   name, because the server could not be asked): a root that seems foreign is
 *   then not moved — the sync stops instead, since moving the user's own root on
 *   a wrong guess would take all their notes out of place
 * @param {{listSharedWithMe: Function}} deps.ocs - fallback when the server reports no owners
 * @returns {Promise<{moved: boolean, to?: string}>}
 */
export async function guardOwnRoot({ dav, uid, uidConfirmed = true, ocs }) {
  const owner = await dav.ownerOf(ROOT_FOLDER);
  if (owner === undefined) return { moved: false }; // nothing there yet: ours to create

  let foreignOwner = null;
  if (owner === null) {
    // No oc:owner-id on this server: the share list is the only witness
    const shares = await ocs.listSharedWithMe().catch(() => []);
    const hit = shares.find((s) => trimSlash(s.fileTarget ?? "") === ROOT_FOLDER);
    if (hit) foreignOwner = hit.ownerUid ?? "unknown";
  } else if (!sameUser(owner, uid)) {
    // Only as good as `uid`: a guessed ID that differs from the real one would
    // make the user's own root look foreign. (The share list above is evidence
    // on its own and needs no ID.)
    if (!uidConfirmed || !uid) {
      throw new Error(
        `${ROOT_FOLDER} is owned by ${owner}, but the signed-in user's ID could not be confirmed; not moving it`,
      );
    }
    foreignOwner = owner;
  }
  if (!foreignOwner) return { moved: false };

  await dav.mkcol(SHARED_FOLDER);
  const stem = `${SHARED_FOLDER}/${safeSegment(foreignOwner, "user")}_NoteBerg`;
  let target = stem;
  for (let n = 2; await dav.exists(target); n++) target = `${stem}_${n}`;
  await dav.move(ROOT_FOLDER, target);
  await dav.mkcol(ROOT_FOLDER);
  console.warn(`[Sharing] ${ROOT_FOLDER} belonged to ${foreignOwner}; moved to ${target}`);
  return { moved: true, to: target };
}

// ─── Discovery (§7.5) ─────────────────────────────────────────────────────────

/**
 * Merge shares of the same node: Nextcloud mounts them as one, with the
 * permissions of all of them combined.
 */
function groupByNode(shares) {
  const groups = new Map();
  for (const share of shares) {
    const key = `${share.ownerUid}:${share.itemSource ?? share.id}`;
    const group = groups.get(key);
    if (group) {
      group.permissions |= share.permissions;
      group.shareIds.push(share.id);
    } else {
      groups.set(key, {
        ownerUid: share.ownerUid,
        ownerDisplayName: share.ownerDisplayName,
        fileTarget: share.fileTarget,
        permissions: share.permissions,
        shareIds: [share.id],
      });
    }
  }
  return [...groups.values()];
}

/** The shares a registered notebook hangs on (records from before `shareIds`: their one). */
function shareIdsOf(record) {
  if (Array.isArray(record.shareIds) && record.shareIds.length > 0) return record.shareIds;
  return record.shareId ? [record.shareId] : [];
}

/** Where a share is mounted, if the server's answer is usable. */
function mountPathOf(group) {
  try {
    return validateBasePath(group.fileTarget);
  } catch (_e) {
    return null;
  }
}

/**
 * Move a freshly accepted mount into the shared folder, once. A failed move
 * leaves the share perfectly usable at its `file_target`; it is retried on the
 * next pass until it has succeeded. After that the app never moves it again, so
 * a user who relocates it in Files is respected.
 */
async function normalizeMount(dav, base, notebookId) {
  if (base === SHARED_FOLDER || base.startsWith(`${SHARED_FOLDER}/`)) {
    return { base, normalized: true };
  }
  try {
    await dav.mkcol(SHARED_FOLDER);
    const target = await freeMountPath(dav, notebookId);
    await dav.move(base, target);
    return { base: target, normalized: true };
  } catch (error) {
    console.warn(`[Sharing] Could not move share out of the way (${base}); will retry:`, error);
    return { base, normalized: false };
  }
}

/**
 * Find the notebooks shared with this user and bring the registrations up to date.
 *
 * Runs only on a successful OCS listing; otherwise nothing changes.
 *
 * @param {object} deps
 * @param {DavOps} deps.dav
 * @param {{listPendingShares: Function, listSharedWithMe: Function}} deps.ocs
 * @param {ShareStore} deps.store
 * @param {Set<string>} [deps.notNotebooks] - shares already found not to be notebooks (skips re-reading them)
 * @param {(notebookId: string) => void} [deps.onShareEnded] - a registered share turned out to be gone
 * @param {(notebookId: string) => void} [deps.onAccessReduced] - a share the user could
 *   edit is now view only (an open editor has to stop)
 * @returns {Promise<{ok: boolean, registered: string[], updated: string[], ended: string[], forgotten: string[], reduced: string[], pending: object[]}>}
 *   pending: folder shares waiting for the user's answer (invitations.js offers the notebook ones)
 */
export async function discoverShares({
  dav,
  ocs,
  store,
  notNotebooks = new Set(),
  onShareEnded = () => {},
  onAccessReduced = () => {},
}) {
  const outcome = {
    ok: false,
    registered: [],
    updated: [],
    ended: [],
    forgotten: [],
    reduced: [],
    pending: [],
  };

  let shares;
  try {
    // Pending shares are not accepted here: on a server that asks for acceptance
    // that is the user's decision, offered in the app (invitations.js). Once
    // accepted they appear in shared_with_me like any other share.
    outcome.pending = (await ocs.listPendingShares()).filter(isFolderUserShare);
    shares = await ocs.listSharedWithMe();
  } catch (error) {
    console.warn("[Sharing] Share discovery skipped:", error);
    return outcome;
  }
  outcome.ok = true;

  const records = await store.list();
  const present = new Set(); // notebook ids confirmed by this listing

  for (const group of groupByNode(shares.filter(isFolderUserShare))) {
    const base = mountPathOf(group);
    if (!base) {
      console.warn(
        `[Sharing] Ignoring share with unusable target ${JSON.stringify(group.fileTarget)}`,
      );
      continue;
    }
    try {
      const known = records.find(
        (r) =>
          isShared(r) && !r.shareEnded && shareIdsOf(r).some((id) => group.shareIds.includes(id)),
      );
      const handled = known
        ? await refreshRegistration({ dav, store, known, group, base })
        : await registerNew({ dav, store, records, group, base, notNotebooks });
      if (!handled) continue;
      present.add(handled.id);
      outcome[handled.kind].push(handled.id);
      if (handled.accessReduced) {
        outcome.reduced.push(handled.id);
        onAccessReduced(handled.id);
      }
    } catch (error) {
      // One odd share must not stop the others
      console.warn(`[Sharing] Share ${group.shareIds.join(",")} skipped:`, error);
    }
  }

  // Registered notebooks the listing no longer mentions: gone only if their
  // folder is gone too. Otherwise it is server lag, and nothing changes.
  for (const record of records.filter((r) => isShared(r) && !r.shareEnded)) {
    if (present.has(record.id)) continue;
    try {
      const kind = await endIfGone({ dav, store, record });
      if (!kind) continue;
      outcome[kind].push(record.id);
      // An editor showing one of its notes has to stop accepting changes
      onShareEnded(record.id);
    } catch (error) {
      // No answer is not "gone": keep it, and do not hold up the others
      console.warn(`[Sharing] Could not check whether ${record.id} is still shared:`, error);
    }
  }
  return outcome;
}

/**
 * The second signal of the "share gone" rule: the listing no longer has it, and
 * its folder is not there either. Freezes a notebook with unsynced changes,
 * forgets a clean one.
 * @returns {Promise<"ended"|"forgotten"|null>} null while the folder is still readable
 */
async function endIfGone({ dav, store, record }) {
  if (record.remoteBasePath && (await dav.exists(record.remoteBasePath))) return null;
  if (await store.hasUnsyncedChanges(record)) {
    await store.update(record.id, { shareEnded: true });
    return "ended";
  }
  await store.forget(record.id);
  return "forgotten";
}

/** A share this device already knows: follow its mount, permissions and owner name. */
async function refreshRegistration({ dav, store, known, group, base }) {
  const patch = {};
  const set = (field, value) => {
    if (known[field] !== value) patch[field] = value;
  };
  set("sharePermissions", group.permissions);
  set("ownerDisplayName", group.ownerDisplayName ?? known.ownerDisplayName ?? null);
  // A share of the folder added or removed (a group share next to a user share)
  set("shareId", group.shareIds[0]);
  if (shareIdsOf(known).join(",") !== group.shareIds.join(",")) patch.shareIds = group.shareIds;

  let currentBase = base;
  if (!known.normalized) {
    const moved = await normalizeMount(dav, base, known.id);
    currentBase = moved.base;
    set("normalized", moved.normalized);
  }
  set("remoteBasePath", currentBase);

  if (Object.keys(patch).length > 0) await store.update(known.id, patch);
  return {
    id: known.id,
    kind: "updated",
    accessReduced: canEdit(known) && !canEdit({ ...known, ...patch }),
  };
}

/** A share not registered yet: register it if it is a notebook that does not clash with anything. */
async function registerNew({ dav, store, records, group, base, notNotebooks }) {
  const key = `${group.ownerUid}:${group.shareIds.join(",")}`;
  if (notNotebooks.has(key)) return null;

  const file = await dav.readJson(`${base}/_notebook.json`);
  let notebookId;
  try {
    notebookId = assertSafeId(file?.id, "notebook");
  } catch (_e) {
    notNotebooks.add(key); // an ordinary folder share: never touched
    return null;
  }

  const clash = records.find((r) => r.id === notebookId && !isShared(r));
  if (clash) {
    console.warn(`[Sharing] Ignoring share of notebook ${notebookId}: id used by an own notebook`);
    return null;
  }
  const other = records.find(
    (r) =>
      r.id === notebookId && isShared(r) && !r.shareEnded && !sameUser(r.ownerUid, group.ownerUid),
  );
  if (other) {
    console.warn(
      `[Sharing] Ignoring share of notebook ${notebookId}: already shared by ${other.ownerUid}`,
    );
    return null;
  }

  const moved = await normalizeMount(dav, base, notebookId);
  // The same notebook is already here: a frozen copy whose share ended, or a live
  // one the owner re-shared under a new share id before this device noticed the
  // old one go. It is re-attached as it is — its notes, unsynced changes and
  // stranded notes stay; only the share it hangs on changes.
  const previous = records.find((r) => r.id === notebookId && isShared(r));
  const sharing = {
    origin: "shared",
    remoteBasePath: moved.base,
    ownerUid: group.ownerUid,
    ownerDisplayName: group.ownerDisplayName ?? null,
    sharePermissions: group.permissions,
    shareId: group.shareIds[0],
    shareIds: group.shareIds,
    normalized: moved.normalized,
    shareEnded: false,
    strandedNoteIds: previous?.strandedNoteIds ?? [],
  };

  if (previous) {
    await store.update(notebookId, sharing);
    return {
      id: notebookId,
      kind: "updated",
      accessReduced: canEdit(previous) && !canEdit({ ...previous, ...sharing }),
    };
  }
  await store.upsert({
    ...stripLocalFields(file),
    id: notebookId,
    ...sharing,
    // Nothing of this notebook has been downloaded yet: the first pass fetches the file
    synced: true,
    lastSyncedEtag: null,
  });
  return { id: notebookId, kind: "registered" };
}

// ─── Leaving a share (§8) ─────────────────────────────────────────────────────

/**
 * Leave a share ("Remove from my list"): the server drops this user's access
 * (the owner and other recipients are unaffected), then the local copy goes.
 * The caller confirms first when there are unsynced changes.
 */
export async function leaveShare({ ocs, store, notebook }) {
  // Every share mounting the folder: one left behind would bring it back
  if (!notebook.shareEnded) {
    for (const id of shareIdsOf(notebook)) await ocs.deleteShare(id);
  }
  await store.forget(notebook.id);
}

/** Drop a frozen notebook (its share is already gone) after the user dismissed the notice. */
export async function dismissEndedShare({ store, notebook }) {
  await store.forget(notebook.id);
}
