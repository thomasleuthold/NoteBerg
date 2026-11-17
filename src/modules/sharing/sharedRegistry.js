/**
 * The Nextcloud app build's registry of notebooks shared with the user.
 *
 * This build keeps nothing locally, so registrations live in memory only and are
 * rebuilt from the server (discovery) on load, when the tab becomes visible,
 * after leaving a share, and at most once a minute when the notebook list is
 * read. The same discovery logic as the native build (sharedRoots.js) does the
 * work; this module only supplies where registrations are kept.
 */

import { markShareEnded, setSharedNotebookBases } from "../storagePaths.js";
import { setInvitations } from "./invitations.js";
import { NOTEBOOK_LOCAL_FIELDS, stripLocalFields } from "./notebookShareFields.js";
import { SHARE_REFRESH_INTERVAL_MS } from "./refreshInterval.js";
import { discoverShares, leaveShare } from "./sharedRoots.js";
import { announceAccessReduced, announceShareEnded } from "./shareEvents.js";

/**
 * @param {object} deps
 * @param {import("./sharedRoots.js").DavOps} deps.dav
 * @param {object} deps.ocs - the nextcloudShares.js API
 * @param {() => Promise<object[]>} deps.getOwnNotebooks - the user's own notebooks (for id collisions)
 * @param {() => void} [deps.onChange] - registrations changed
 * @param {() => number} [deps.now]
 */
export function createSharedRegistry({
  dav,
  ocs,
  getOwnNotebooks,
  onChange = () => {},
  now = Date.now,
}) {
  /** @type {Map<string, object>} notebookId -> notebook record with the sharing fields */
  const records = new Map();
  const notNotebooks = new Set();
  let lastRefresh = Number.NEGATIVE_INFINITY;
  let running = null;

  /** Point the path helpers at the registered mounts. */
  const syncBases = () =>
    setSharedNotebookBases(
      new Map([...records].map(([id, record]) => [id, record.remoteBasePath])),
    );

  const fingerprint = () =>
    JSON.stringify([...records.values()].map((r) => [r.id, r.remoteBasePath, r.sharePermissions]));

  /** @type {import("./sharedRoots.js").ShareStore} */
  const store = {
    list: async () => [...(await getOwnNotebooks()), ...records.values()],
    upsert: async (record) => void records.set(record.id, { ...record }),
    update: async (id, patch) => {
      if (records.has(id)) records.set(id, { ...records.get(id), ...patch });
    },
    forget: async (id) => {
      records.delete(id);
      // A write still in flight for this notebook must not land in the own tree
      markShareEnded(id);
    },
    // Nothing is kept locally here, so there is nothing to lose
    hasUnsyncedChanges: async () => false,
  };

  /**
   * Bring the registrations up to date.
   * @param {{force?: boolean}} [options] - without force, runs at most once a minute
   * @returns {Promise<boolean>} whether the registrations changed
   */
  async function refresh({ force = false } = {}) {
    if (running) return running;
    if (!force && now() - lastRefresh < SHARE_REFRESH_INTERVAL_MS) return false;

    running = (async () => {
      const before = fingerprint();
      const known = new Set(records.keys());
      try {
        const outcome = await discoverShares({
          dav,
          ocs,
          store,
          notNotebooks,
          onShareEnded: announceShareEnded,
          onAccessReduced: announceAccessReduced,
        });
        // A failed listing changes nothing, and does not count as a refresh
        if (outcome.ok) {
          lastRefresh = now();
          setInvitations(outcome.pending);
        }
      } catch (error) {
        console.warn("[Sharing] Share refresh failed:", error);
      }
      syncBases();
      const changed = before !== fingerprint() || known.size !== records.size;
      if (changed) onChange();
      return changed;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    refresh,
    store,
    /** The notebook record for a shared notebook id, or undefined for an own one. */
    get: (id) => records.get(id),
    isShared: (id) => records.has(id),
    /** All registered shared notebooks. */
    list: () => [...records.values()],
    /** A notebook file read from a shared root, carrying this user's sharing fields. */
    annotate(file) {
      const record = records.get(file?.id);
      if (!record) return file;
      const annotated = stripLocalFields(file);
      for (const field of NOTEBOOK_LOCAL_FIELDS)
        if (field in record) annotated[field] = record[field];
      return annotated;
    },
    /**
     * "Remove from my list": leave the share on the server (only this user's
     * access goes), then forget the registration. Same rules as the native build.
     */
    async leave(id) {
      const notebook = records.get(id);
      if (!notebook) return;
      await leaveShare({ ocs, store, notebook });
      syncBases();
      onChange();
    },
  };
}
