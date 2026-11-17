// src/components/overviewMode.sharing.test.js
// How the overview presents notebooks other people shared with the user, and
// what it offers for them: a section of their own, read-only and collaborative
// variants, the notices that need a decision, and no way to delete, move or
// copy what belongs to somebody else.

import { fireEvent } from "@testing-library/dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../i18n/index.js", () => ({
  t: (key, opts) => (opts ? `${key}${JSON.stringify(opts)}` : key),
}));
vi.mock("../modules/pdfManager.js", () => ({ extractPdfText: vi.fn() }));
vi.mock("../modules/router.js", () => ({ navigateTo: vi.fn() }));
vi.mock("../modules/displayPrefs.js", () => ({ getCardSize: () => "medium" }));
vi.mock("../utils/icons.js", () => ({ getIcon: vi.fn(() => "") }));
vi.mock("../utils/noteRenderer.js", () => ({
  drawStroke: vi.fn(),
  getStrokeBounds: vi.fn(),
  getThemePalette: vi.fn(),
  renderNotePreview: vi.fn(),
  renderNoteSnapshot: vi.fn(),
}));

const notebooks = [];
const notesByNotebook = new Map();
const notesById = new Map();

vi.mock("../modules/storage.js", () => ({
  copyNote: vi.fn(),
  deleteNote: vi.fn(async () => {}),
  deleteNotebook: vi.fn(async () => {}),
  getAllNotebooks: vi.fn(async () => notebooks.filter((nb) => !nb.deleted)),
  getAllNotes: vi.fn(async () => []),
  getDeletedNotebooks: vi.fn(async () => []),
  getDeletedNotes: vi.fn(async () => []),
  getNote: vi.fn(async (id) => notesById.get(id) ?? null),
  getNoteIndex: vi.fn(async (id) => notesById.get(id) ?? null),
  getNotebook: vi.fn(async (id) => notebooks.find((nb) => nb.id === id) ?? null),
  getNotesByNotebook: vi.fn(async (id) => notesByNotebook.get(id) ?? []),
  getQuickNotes: vi.fn(async () => []),
  getSetting: vi.fn(),
  moveNote: vi.fn(),
  purgeNote: vi.fn(),
  purgeNotebook: vi.fn(),
  restoreNote: vi.fn(),
  restoreNotebook: vi.fn(),
}));

const modals = {
  showAlertDialog: vi.fn(async () => {}),
  showConfirmDialog: vi.fn(async () => true),
  showEditNotebookModal: vi.fn(),
  showEditNoteModal: vi.fn(),
  showMoveCopyDialog: vi.fn(),
};
vi.mock("./modals.js", () => modals);

let sharingAvailable = true;
vi.mock("../modules/sharing/availability.js", () => ({
  isSharingAvailable: vi.fn(async () => sharingAvailable),
}));
const recipients = new Map();
vi.mock("../modules/sharing/ownerShares.js", () => ({
  ensureOwnerShares: vi.fn(async () => false),
  getRecipientCount: vi.fn((id) => recipients.get(id) ?? 0),
}));
const showShareDialog = vi.fn(async () => {});
vi.mock("./shareDialog.js", () => ({ showShareDialog: (...args) => showShareDialog(...args) }));

const actions = {
  discardStrandedChanges: vi.fn(async () => {}),
  dismissEndedShare: vi.fn(async () => {}),
  hasUnsyncedChanges: vi.fn(async () => false),
  leaveSharedNotebook: vi.fn(async () => {}),
  acceptInvitation: vi.fn(async () => {}),
  declineInvitation: vi.fn(async () => {}),
};
vi.mock("../modules/sharing/shareActions.js", () => actions);

const OWN = { id: "nb-own", title: "Mine", color: "#111", modified: 100 };
const sharedNb = (overrides = {}) => ({
  id: "nb-shared",
  title: "Recipes",
  color: "#222",
  modified: 200,
  origin: "shared",
  ownerUid: "alice",
  ownerDisplayName: "Alice Anderson",
  sharePermissions: 7,
  shareId: "42",
  ...overrides,
});

let container;
let renderOverview;
let navigateTo;

async function render(notebookId = null) {
  await renderOverview(container, notebookId);
}

const click = (selector) => fireEvent.click(container.querySelector(selector));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  notebooks.length = 0;
  notesByNotebook.clear();
  notesById.clear();
  document.body.innerHTML = "";
  document.getElementById("note-options-menu")?.remove();
  container = document.createElement("div");
  document.body.appendChild(container);
  sharingAvailable = true;
  recipients.clear();
  modals.showConfirmDialog.mockResolvedValue(true);
  actions.hasUnsyncedChanges.mockResolvedValue(false);
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  ({ renderOverview } = await import("./overviewMode.js"));
  ({ navigateTo } = await import("../modules/router.js"));
});

describe("the notebooks overview", () => {
  it("shows no section for shares when nothing is shared", async () => {
    notebooks.push(OWN);
    await render();
    expect(container.querySelector(".shared-notebooks-section")).toBeNull();
    expect(container.querySelector(".notebook-card--shared")).toBeNull();
  });

  it("keeps shared notebooks out of the user's own list, in a section of their own", async () => {
    notebooks.push(OWN, sharedNb());

    await render();

    const own = container.querySelector(".notebooks-section:not(.shared-notebooks-section)");
    const shared = container.querySelector(".shared-notebooks-section");
    expect([...own.querySelectorAll(".notebook-card")].map((c) => c.dataset.notebookId)).toEqual([
      "nb-own",
    ]);
    expect([...shared.querySelectorAll(".notebook-card")].map((c) => c.dataset.notebookId)).toEqual(
      ["nb-shared"],
    );
    expect(shared.querySelector("h3").textContent).toBe("sharing.section.title");
  });

  it("says who shared a notebook and what the user may do with it", async () => {
    notebooks.push(sharedNb({ sharePermissions: 1 }), sharedNb({ id: "nb-edit" }));
    await render();

    const readOnly = container.querySelector('[data-notebook-id="nb-shared"]');
    expect(readOnly.querySelector(".share-badge--owner").textContent).toContain("Alice Anderson");
    expect(readOnly.querySelector(".share-badge--readonly")).not.toBeNull();
    expect(readOnly.querySelector(".share-badge--edit")).toBeNull();

    const collab = container.querySelector('[data-notebook-id="nb-edit"]');
    expect(collab.querySelector(".share-badge--edit")).not.toBeNull();
  });

  it("falls back to the owner's user id when no display name is known", async () => {
    notebooks.push(sharedNb({ ownerDisplayName: null }));
    await render();
    expect(container.querySelector(".share-badge--owner").textContent).toContain("alice");
  });

  it("offers a new note only where the user may edit", async () => {
    notebooks.push(sharedNb({ sharePermissions: 1 }), sharedNb({ id: "nb-edit" }), OWN);
    await render();

    const newNote = (id) =>
      container.querySelector(`[data-notebook-id="${id}"] .card-new-note-btn`);
    expect(newNote("nb-shared")).toBeNull();
    expect(newNote("nb-edit")).not.toBeNull();
    expect(newNote("nb-own")).not.toBeNull();
  });

  it("escapes a notebook title that tries to inject markup", async () => {
    notebooks.push(sharedNb({ title: '<img src=x onerror="alert(1)">' }));
    await render();
    expect(container.querySelector(".notebook-card img")).toBeNull();
  });
});

describe("notices that need a decision", () => {
  it("tells the user a share ended, and dismissing it forgets the notebook", async () => {
    notebooks.push(sharedNb({ shareEnded: true, strandedNoteIds: ["n1", "n2"] }));
    await render();

    const notice = container.querySelector(".share-notice--ended");
    expect(notice.textContent).toContain('"count":2');
    expect(container.querySelector(".share-badge--edit")).toBeNull();

    click('[data-share-action="dismiss"]');
    await flush();

    expect(actions.dismissEndedShare).toHaveBeenCalledWith(
      expect.objectContaining({ id: "nb-shared" }),
    );
  });

  it("keeps the notice short when nothing was lost", async () => {
    notebooks.push(sharedNb({ shareEnded: true }));
    await render();
    expect(container.querySelector(".share-notice--ended").textContent).toContain(
      "sharing.ended.noticeClean",
    );
  });

  it("offers to discard changes that can no longer be saved, after asking", async () => {
    notebooks.push(sharedNb({ sharePermissions: 1, strandedNoteIds: ["n1"] }));
    await render();

    expect(container.querySelector(".share-notice--stranded")).not.toBeNull();
    click('[data-share-action="discard"]');
    await flush();

    expect(modals.showConfirmDialog).toHaveBeenCalled();
    expect(actions.discardStrandedChanges).toHaveBeenCalledWith(
      expect.objectContaining({ id: "nb-shared" }),
    );
  });

  it("does not discard anything when the user says no", async () => {
    modals.showConfirmDialog.mockResolvedValue(false);
    notebooks.push(sharedNb({ strandedNoteIds: ["n1"] }));
    await render();

    click('[data-share-action="discard"]');
    await flush();

    expect(actions.discardStrandedChanges).not.toHaveBeenCalled();
  });

  it("does not open the notebook when a notice button is clicked", async () => {
    notebooks.push(sharedNb({ strandedNoteIds: ["n1"] }));
    await render();
    click('[data-share-action="discard"]');
    await flush();
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("shows no notice for a healthy shared notebook", async () => {
    notebooks.push(sharedNb());
    await render();
    expect(container.querySelector(".share-notice")).toBeNull();
  });
});

describe("notebook options", () => {
  const openMenu = async (id) => {
    click(`[data-notebook-id="${id}"] .card-options-btn`);
    await flush();
    return [...document.querySelectorAll("#note-options-menu [data-action]")].map(
      (el) => el.dataset.action,
    );
  };

  it("lets the owner edit and delete", async () => {
    sharingAvailable = false; // Share has its own tests below
    notebooks.push(OWN);
    await render();
    expect(await openMenu("nb-own")).toEqual(["edit", "delete"]);
  });

  it("lets a collaborator edit and remove from the list, never delete", async () => {
    notebooks.push(sharedNb());
    await render();
    expect(await openMenu("nb-shared")).toEqual(["edit", "leave"]);
  });

  it("lets a read-only viewer only remove from the list", async () => {
    notebooks.push(sharedNb({ sharePermissions: 1 }));
    await render();
    expect(await openMenu("nb-shared")).toEqual(["leave"]);
  });

  it("removes a notebook from the list after confirming, naming the owner", async () => {
    notebooks.push(sharedNb());
    await render();
    await openMenu("nb-shared");

    document.querySelector('[data-action="leave"]').click();
    await flush();

    const [, message] = modals.showConfirmDialog.mock.calls[0];
    expect(message).toContain("Alice Anderson");
    expect(actions.leaveSharedNotebook).toHaveBeenCalledWith(
      expect.objectContaining({ id: "nb-shared" }),
    );
  });

  it("warns that unsaved changes would be lost", async () => {
    actions.hasUnsyncedChanges.mockResolvedValue(true);
    notebooks.push(sharedNb());
    await render();
    await openMenu("nb-shared");

    document.querySelector('[data-action="leave"]').click();
    await flush();

    expect(modals.showConfirmDialog.mock.calls[0][1]).toContain("sharing.leave.messageUnsynced");
    expect(modals.showConfirmDialog.mock.calls[0][3]).toBe("btn-danger");
  });

  it("leaves the notebook alone when the user changes their mind", async () => {
    modals.showConfirmDialog.mockResolvedValue(false);
    notebooks.push(sharedNb());
    await render();
    await openMenu("nb-shared");

    document.querySelector('[data-action="leave"]').click();
    await flush();

    expect(actions.leaveSharedNotebook).not.toHaveBeenCalled();
  });

  it("reports a failure to leave instead of pretending it worked", async () => {
    actions.leaveSharedNotebook.mockRejectedValueOnce(new Error("503"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    notebooks.push(sharedNb());
    await render();
    await openMenu("nb-shared");

    document.querySelector('[data-action="leave"]').click();
    await flush();

    expect(modals.showAlertDialog).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("inside a shared notebook", () => {
  const note = (id, notebookId) => ({
    id,
    notebookId,
    title: `Note ${id}`,
    modified: 1,
    version: 1,
  });

  const openNoteMenu = async (noteId) => {
    click(`[data-note-id="${noteId}"] .card-options-btn`);
    await flush();
    return [...document.querySelectorAll("#note-options-menu [data-action]")].map(
      (el) => el.dataset.action,
    );
  };

  beforeEach(() => {
    const n1 = note("n1", "nb-shared");
    notesByNotebook.set("nb-shared", [n1]);
    notesById.set("n1", n1);
    const own = note("n-own", "nb-own");
    notesByNotebook.set("nb-own", [own]);
    notesById.set("n-own", own);
  });

  it("offers a collaborator a new note and renaming, but not move, copy or delete", async () => {
    notebooks.push(sharedNb());
    await render("nb-shared");

    expect(container.querySelector("#new-note-btn")).not.toBeNull();
    expect(await openNoteMenu("n1")).toEqual(["edit"]);
  });

  it("offers a read-only viewer nothing to change", async () => {
    notebooks.push(sharedNb({ sharePermissions: 1 }));
    await render("nb-shared");

    expect(container.querySelector("#new-note-btn")).toBeNull();
    expect(container.querySelector(".note-card .card-options-btn")).toBeNull();
    expect(container.querySelector(".note-card")).not.toBeNull(); // notes can still be opened
  });

  it("shows who shared the notebook in its header", async () => {
    notebooks.push(sharedNb({ sharePermissions: 1 }));
    await render("nb-shared");
    expect(container.querySelector(".notebook-back-group .share-badge--owner")).not.toBeNull();
    expect(container.querySelector(".notebook-back-group .share-badge--readonly")).not.toBeNull();
  });

  it("shows the notices there too, and leaves the notebook once it is dismissed", async () => {
    notebooks.push(sharedNb({ shareEnded: true }));
    await render("nb-shared");

    click('[data-share-action="dismiss"]');
    await flush();

    expect(actions.dismissEndedShare).toHaveBeenCalled();
  });

  it("goes back to the list when the notebook has vanished (its share was dropped)", async () => {
    await render("nb-gone");
    expect(navigateTo).toHaveBeenCalledWith("overview");
    expect(container.querySelector(".error-state")).toBeNull();
  });

  it("keeps everything for the owner's own notebook", async () => {
    notebooks.push(OWN);
    await render("nb-own");

    expect(container.querySelector("#new-note-btn")).not.toBeNull();
    expect(await openNoteMenu("n-own")).toEqual(["edit", "movecopy", "delete"]);
    expect(container.querySelector(".share-badge")).toBeNull();
  });

  it("tells the user when the storage layer refused something the menu missed", async () => {
    const { ShareRestrictedError } = await import("../modules/sharing/shareRestrictions.js");
    const storage = await import("../modules/storage.js");
    storage.deleteNote.mockRejectedValueOnce(new ShareRestrictedError("deleteNote", "nb-own"));
    notebooks.push(OWN);
    await render("nb-own");
    await openNoteMenu("n-own");

    document.querySelector('[data-action="delete"]').click();
    await flush();
    await flush();

    expect(modals.showAlertDialog).toHaveBeenCalledWith(
      "sharing.restricted.title",
      "sharing.restricted.message",
    );
  });
});

describe("sharing an own notebook", () => {
  const openMenu = async (id) => {
    click(`[data-notebook-id="${id}"] .card-options-btn`);
    await flush();
    return [...document.querySelectorAll("#note-options-menu [data-action]")].map(
      (el) => el.dataset.action,
    );
  };

  it("offers Share next to Edit and Delete", async () => {
    notebooks.push(OWN);
    await render();
    expect(await openMenu("nb-own")).toEqual(["edit", "share", "delete"]);
  });

  it("opens the share dialog for that notebook", async () => {
    notebooks.push(OWN);
    await render();
    await openMenu("nb-own");

    document.querySelector('[data-action="share"]').click();
    await flush();

    expect(showShareDialog).toHaveBeenCalledWith(expect.objectContaining({ id: "nb-own" }));
  });

  it("does not offer it while sharing is unavailable (not released, or not connected)", async () => {
    sharingAvailable = false;
    notebooks.push(OWN);
    await render();
    expect(await openMenu("nb-own")).toEqual(["edit", "delete"]);
  });

  it("never offers it for a notebook shared with the user: no re-sharing", async () => {
    notebooks.push(sharedNb());
    await render();
    expect(await openMenu("nb-shared")).not.toContain("share");
  });

  it("marks own notebooks that have recipients", async () => {
    recipients.set("nb-own", 2);
    notebooks.push(OWN, { ...OWN, id: "nb-private", title: "Private" });
    await render();

    expect(container.querySelector('[data-notebook-id="nb-own"] .share-badge')).not.toBeNull();
    expect(container.querySelector('[data-notebook-id="nb-private"] .share-badge')).toBeNull();
    expect(container.querySelector('[data-notebook-id="nb-own"]').className).not.toContain(
      "--shared",
    );
  });

  it("warns, when trashing a shared notebook, that recipients lose access once it is purged", async () => {
    recipients.set("nb-own", 1);
    notebooks.push(OWN);
    await render();
    await openMenu("nb-own");

    document.querySelector('[data-action="delete"]').click();
    await flush();

    expect(modals.showConfirmDialog.mock.calls[0][1]).toContain("sharing.purge.warning");
  });

  it("does not add the warning for a notebook nobody has access to", async () => {
    notebooks.push(OWN);
    await render();
    await openMenu("nb-own");

    document.querySelector('[data-action="delete"]').click();
    await flush();

    expect(modals.showConfirmDialog.mock.calls[0][1]).not.toContain("sharing.purge.warning");
  });
});

describe("the recycle bin", () => {
  async function openBinWith(deleted) {
    const storage = await import("../modules/storage.js");
    storage.getDeletedNotebooks.mockResolvedValue(deleted);
    await render();
    click('[data-tab="recyclebin"]');
    await vi.waitFor(() => expect(container.querySelector(".btn-purge")).not.toBeNull());
  }

  it("warns that recipients lose access when a shared notebook is purged", async () => {
    recipients.set("nb-own", 3);
    await openBinWith([{ ...OWN, deleted: true }]);

    click(".btn-purge");
    await flush();

    expect(modals.showConfirmDialog.mock.calls[0][1]).toContain("sharing.purge.warning");
  });

  it("asks in the user's language", async () => {
    await openBinWith([{ ...OWN, deleted: true }]);

    click(".btn-purge");
    await flush();

    const [title, message, button] = modals.showConfirmDialog.mock.calls[0];
    expect([title, message, button]).toEqual([
      "recycleBin.purgeTitle",
      "recycleBin.purgeConfirm",
      "common.delete",
    ]);
  });

  it("opens on the bin when asked to (the restore summary's button)", async () => {
    const storage = await import("../modules/storage.js");
    storage.getDeletedNotebooks.mockResolvedValue([{ ...OWN, deleted: true }]);
    const { showRecycleBinTab } = await import("./overviewMode.js");

    showRecycleBinTab();
    await render();

    await vi.waitFor(() => expect(container.querySelector(".btn-purge")).not.toBeNull());
    expect(container.querySelector('[data-tab="recyclebin"]').classList.contains("active")).toBe(
      true,
    );
  });

  it("does not add it for a notebook nobody has access to", async () => {
    await openBinWith([{ ...OWN, deleted: true }]);

    click(".btn-purge");
    await flush();

    expect(modals.showConfirmDialog.mock.calls[0][1]).not.toContain("sharing.purge.warning");
  });
});

describe("what another user wrote", () => {
  // The title, description and color of a shared notebook come from the owner's
  // file, and the owner's display name from the server: none of it is markup
  const hostile = () =>
    sharedNb({
      title: '<img src=x id="t-injected">',
      ownerDisplayName: '<b id="o-injected">Eve</b>',
      color: 'red"><span id="c-injected"></span><div x="',
    });

  it("cannot break out of the notebook card, color included", async () => {
    notebooks.push(hostile());
    await render();

    const card = container.querySelector('[data-notebook-id="nb-shared"].notebook-card');
    expect(container.querySelector("#t-injected, #o-injected, #c-injected")).toBeNull();
    expect(card.querySelector(".notebook-color-indicator").style.backgroundColor).not.toBe("red");
    expect(card.querySelector(".notebook-card-title").textContent).toContain("<img");
  });

  it("is escaped in the leave dialog, which renders its message as HTML", async () => {
    notebooks.push(hostile());
    await render();
    click('[data-notebook-id="nb-shared"] .card-options-btn');
    await flush();

    document.querySelector('[data-action="leave"]').click();
    await flush();

    const [, message] = modals.showConfirmDialog.mock.calls[0];
    expect(message).not.toContain("<img");
    expect(message).not.toContain("<b ");
    expect(message).toContain("&lt;img");
    expect(message).toContain("&lt;b id=");
  });

  it("is escaped in the discard dialog", async () => {
    notebooks.push({ ...hostile(), strandedNoteIds: ["n1"] });
    await render("nb-shared");

    click('[data-share-action="discard"]');
    await flush();

    const [, message] = modals.showConfirmDialog.mock.calls[0];
    expect(message).not.toContain("<img");
    expect(message).toContain("&lt;img");
  });
});

describe("notebooks offered to the user", () => {
  const ID = "3f2c9a1e-8b4d-4c2a-9f1e-7a6b5c4d3e2f";
  async function offer(ownerDisplayName = "Alice Anderson") {
    const { setInvitations } = await import("../modules/sharing/invitations.js");
    setInvitations([{ id: "41", ownerUid: "alice", ownerDisplayName, fileTarget: `/${ID}` }]);
  }

  it("are shown under Shared with me, even before anything is shared", async () => {
    notebooks.push(OWN);
    await offer();
    await render();

    const section = container.querySelector(".shared-notebooks-section");
    expect(section.querySelector(".share-invitation").textContent).toContain("Alice Anderson");
    expect(section.querySelector('[data-invite-action="accept"]')).not.toBeNull();
    expect(section.querySelector('[data-invite-action="decline"]')).not.toBeNull();
  });

  it("show the owner's name as text", async () => {
    await offer('<img src=x id="o-injected">');
    await render();
    expect(container.querySelector("#o-injected")).toBeNull();
  });

  it("are accepted with Accept", async () => {
    await offer();
    await render();

    click('[data-invite-action="accept"]');
    await flush();

    expect(actions.acceptInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ shareId: "41", ownerUid: "alice" }),
    );
  });

  it("are declined only after confirming", async () => {
    await offer();
    await render();
    modals.showConfirmDialog.mockResolvedValueOnce(false);

    click('[data-invite-action="decline"]');
    await flush();
    expect(actions.declineInvitation).not.toHaveBeenCalled();

    click('[data-invite-action="decline"]');
    await flush();
    expect(actions.declineInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ shareId: "41" }),
    );
  });

  it("say so when the answer could not be given", async () => {
    actions.acceptInvitation.mockRejectedValueOnce(new Error("503"));
    await offer();
    await render();

    click('[data-invite-action="accept"]');
    await flush();
    await flush();

    expect(modals.showAlertDialog).toHaveBeenCalledWith(
      "sharing.invite.title",
      expect.stringContaining("503"),
    );
  });
});
