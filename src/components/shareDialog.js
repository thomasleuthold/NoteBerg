/**
 * Share dialog: who a notebook is shared with, and how (DESIGN §3, §6).
 *
 * The owner picks a user from a type-to-search list, chooses view or edit
 * access, and can later change or withdraw each person's access. What the
 * server grants can be less than what was asked (admin policy), so every row
 * shows the permissions actually in force.
 */

import { t } from "../i18n/index.js";
import {
  createShare,
  deleteShare,
  listSharesForPath,
  searchSharees,
  updateSharePermissions,
} from "../modules/sharing/nextcloudShares.js";
import { recordOwnerShares } from "../modules/sharing/ownerShares.js";
import { PERMISSION, SHARE_MODE_PERMISSIONS } from "../modules/sharing/sharePermissions.js";
import { getNotebookFolder } from "../modules/storagePaths.js";
import { escapeHtml } from "../utils/escapeHtml.js";
import { showConfirmDialog } from "./modals.js";

const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";
const SEARCH_DEBOUNCE_MS = 250;

/** "collab" when the share lets the person change content, otherwise "readonly". */
export function modeOf(permissions) {
  const edit = PERMISSION.UPDATE | PERMISSION.CREATE;
  return (permissions & edit) === edit ? "collab" : "readonly";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function modeSelect(current) {
  const select = el("select", "form-input share-dialog__mode");
  for (const mode of ["readonly", "collab"]) {
    const option = el(
      "option",
      "",
      t(mode === "readonly" ? "sharing.share.modeReadonly" : "sharing.share.modeCollab"),
    );
    option.value = mode;
    option.selected = mode === current;
    select.appendChild(option);
  }
  return select;
}

/**
 * A notebook that has never reached the server cannot be shared: there is no
 * folder yet. The native app syncs first; the Nextcloud app always writes
 * straight to the server.
 */
async function ensureOnServer(notebook) {
  const isOnServer = (nb) => Boolean(nb && nb.synced !== false && nb.lastSyncedEtag);
  if (IS_NEXTCLOUD || isOnServer(notebook)) return;
  const { performSync, whenSyncIdle } = await import("../modules/sync.js");
  const { getNotebook } = await import("../modules/storage.js");
  // A sync that is already running skips a new one (performSync returns null), and
  // it may have started before this notebook existed: wait for it, then look again
  for (let attempt = 0; attempt < 2; attempt++) {
    await whenSyncIdle();
    if (isOnServer(await getNotebook(notebook.id))) return;
    if ((await performSync({ silent: true })) !== null) break;
  }
  // Without its folder on the server the share would fail with a cryptic path error
  if (!isOnServer(await getNotebook(notebook.id))) throw new Error(t("sharing.share.notOnServer"));
}

/**
 * Open the share dialog for one of the user's own notebooks.
 * @param {Object} notebook
 * @returns {Promise<void>} resolves when the dialog is closed
 */
export function showShareDialog(notebook) {
  return new Promise((resolve) => {
    document.getElementById("modal-overlay")?.remove();

    const path = getNotebookFolder(notebook.id);
    let shares = [];
    let selected = null; // { uid, displayName }
    let adding = false; // a share is being created
    let searchToken = 0;
    let searchTimer = null;

    // ── Skeleton ──────────────────────────────────────────────────────────────
    const overlay = el("div", "modal-overlay");
    overlay.id = "modal-overlay";
    const dialog = el("div", "modal-dialog share-dialog");
    const header = el("div", "modal-header");
    header.appendChild(
      el("h3", "modal-title", t("sharing.share.title", { title: notebook.title })),
    );
    const closeX = el("button", "modal-close", "×");
    closeX.setAttribute("aria-label", t("common.close"));
    header.appendChild(closeX);

    const body = el("div", "modal-body");
    body.appendChild(el("p", "form-hint", t("sharing.share.intro")));

    const addLabel = el("label", "form-label", t("sharing.share.searchLabel"));
    const searchInput = el("input", "form-input share-dialog__search");
    searchInput.type = "text";
    searchInput.placeholder = t("sharing.share.searchPlaceholder");
    searchInput.autocomplete = "off";
    addLabel.htmlFor = "share-dialog-search";
    searchInput.id = "share-dialog-search";
    const suggestions = el("div", "share-dialog__suggestions");
    const addRow = el("div", "share-dialog__add-row");
    const newMode = modeSelect("readonly");
    newMode.setAttribute("aria-label", t("sharing.share.modeLabel"));
    const addBtn = el("button", "btn-primary share-dialog__add", t("sharing.share.add"));
    addBtn.disabled = true;
    addRow.append(newMode, addBtn);

    const status = el("p", "share-dialog__status");
    status.setAttribute("role", "status");

    const listHeading = el("p", "form-label", t("sharing.share.recipients"));
    const list = el("div", "share-dialog__list");

    body.append(addLabel, searchInput, suggestions, addRow, status, listHeading, list);

    const footer = el("div", "modal-footer");
    const closeBtn = el("button", "btn-secondary modal-cancel", t("common.close"));
    footer.appendChild(closeBtn);

    dialog.append(header, body, footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const say = (message) => {
      status.textContent = message ?? "";
    };

    // ── Recipients ────────────────────────────────────────────────────────────
    function renderList() {
      list.replaceChildren();
      if (shares.length === 0) {
        list.appendChild(el("p", "share-dialog__empty", t("sharing.share.noRecipients")));
        return;
      }
      for (const share of shares) list.appendChild(renderRow(share));
    }

    function renderRow(share) {
      const row = el("div", "share-dialog__row");
      row.dataset.shareId = share.id;
      const name = share.shareWithDisplayName || share.shareWith;
      const who = el("span", "share-dialog__who", name);
      if (name !== share.shareWith) who.title = share.shareWith;

      const select = modeSelect(modeOf(share.permissions));
      select.setAttribute("aria-label", t("sharing.share.modeLabel"));
      select.addEventListener("change", async () => {
        select.disabled = true;
        try {
          const updated = await updateSharePermissions(
            share.id,
            SHARE_MODE_PERMISSIONS[select.value],
          );
          Object.assign(share, { permissions: updated.permissions });
          if (modeOf(updated.permissions) !== select.value) say(t("sharing.share.reduced"));
          else say("");
        } catch (error) {
          say(t("sharing.share.failed", { message: error.message }));
        }
        select.value = modeOf(share.permissions);
        select.disabled = false;
        recordOwnerShares(notebook.id, shares);
      });

      const revoke = el("button", "btn-secondary share-dialog__revoke", t("sharing.share.revoke"));
      revoke.addEventListener("click", async () => {
        const confirmed = await showConfirmDialog(
          t("sharing.share.revoke"),
          t("sharing.share.revokeMessage", {
            name: escapeHtml(name),
            title: escapeHtml(notebook.title),
          }),
          t("sharing.share.revoke"),
          "btn-danger",
        );
        if (!confirmed || revoke.disabled) return;
        revoke.disabled = true;
        try {
          await deleteShare(share.id);
          shares = shares.filter((s) => s.id !== share.id);
          recordOwnerShares(notebook.id, shares);
          renderList();
        } catch (error) {
          say(t("sharing.share.failed", { message: error.message }));
          revoke.disabled = false;
        }
      });

      row.append(who, select, revoke);
      return row;
    }

    async function loadShares() {
      try {
        shares = await listSharesForPath(path);
        recordOwnerShares(notebook.id, shares);
      } catch (error) {
        // A notebook that has no folder on the server yet simply has no shares
        shares = [];
        if (error.statusCode !== 404)
          say(t("sharing.share.loadFailed", { message: error.message }));
      }
      renderList();
    }

    // ── Adding a person ───────────────────────────────────────────────────────
    function choose(person) {
      selected = person;
      searchInput.value = person.displayName;
      suggestions.replaceChildren();
      // Not while a share is being created: a second click would share twice
      addBtn.disabled = adding;
    }

    async function search(query) {
      const token = ++searchToken;
      suggestions.replaceChildren();
      if (!query.trim()) return;
      suggestions.appendChild(el("p", "share-dialog__empty", t("sharing.share.searching")));
      let found = [];
      try {
        found = await searchSharees(query);
      } catch (error) {
        if (token === searchToken) say(t("sharing.share.failed", { message: error.message }));
      }
      // A newer keystroke has already replaced this answer
      if (token !== searchToken) return;

      const alreadyShared = new Set(shares.map((s) => s.shareWith));
      const people = found.filter((person) => !alreadyShared.has(person.uid));
      suggestions.replaceChildren();
      if (people.length === 0) {
        suggestions.appendChild(el("p", "share-dialog__empty", t("sharing.share.noResults")));
        return;
      }
      for (const person of people) {
        const item = el("button", "share-dialog__suggestion", person.displayName);
        item.type = "button";
        if (person.displayName !== person.uid) item.title = person.uid;
        item.addEventListener("click", () => choose(person));
        suggestions.appendChild(item);
      }
    }

    searchInput.addEventListener("input", () => {
      selected = null;
      addBtn.disabled = true;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => search(searchInput.value), SEARCH_DEBOUNCE_MS);
    });

    addBtn.addEventListener("click", async () => {
      if (!selected || adding) return;
      // The person chosen now: the user may type and pick again while this runs
      const person = selected;
      const requested = SHARE_MODE_PERMISSIONS[newMode.value];
      adding = true;
      addBtn.disabled = true;
      say("");
      try {
        await ensureOnServer(notebook);
        const created = await createShare(path, person.uid, requested);
        // The server may grant less than was asked (administrator policy)
        if ((created.permissions & requested) !== requested) say(t("sharing.share.reduced"));
        if (selected === person) {
          selected = null;
          searchInput.value = "";
        }
        await loadShares();
      } catch (error) {
        say(t("sharing.share.failed", { message: error.message }));
      } finally {
        adding = false;
        addBtn.disabled = !selected;
      }
    });

    // ── Closing ───────────────────────────────────────────────────────────────
    function close() {
      clearTimeout(searchTimer);
      searchToken++;
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve();
    }
    const onKey = (event) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    closeX.addEventListener("click", close);
    closeBtn.addEventListener("click", close);
    let pressedOnOverlay = false;
    overlay.addEventListener("mousedown", (event) => {
      pressedOnOverlay = event.target === overlay;
    });
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay && pressedOnOverlay) close();
    });

    renderList();
    dialog.dataset.state = "loading";
    loadShares().then(() => {
      dialog.dataset.state = "ready";
    });
    setTimeout(() => searchInput.focus(), 0);
  });
}
