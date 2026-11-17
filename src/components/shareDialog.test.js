// src/components/shareDialog.test.js
// The owner's share dialog, against a mock Nextcloud instance: finding a person,
// choosing view or edit access, seeing what the server actually granted, and
// withdrawing access again.

import { fetch } from "@tauri-apps/plugin-http";
import { fireEvent } from "@testing-library/dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockNextcloud, wireMockNextcloud } from "../modules/__fixtures__/mockOcsServer.js";

vi.mock("./modals.js", () => ({ showConfirmDialog: vi.fn(async () => true) }));
vi.mock("../i18n/index.js", () => ({
  t: (key, opts) => (opts ? `${key}${JSON.stringify(opts)}` : key),
}));
vi.mock("../modules/sharing/config.js", () => ({ SHARING_ENABLED: true }));
const performSync = vi.fn(async () => ({}));
const whenSyncIdle = vi.fn(async () => {});
vi.mock("../modules/sync.js", () => ({
  performSync: (...args) => performSync(...args),
  whenSyncIdle: (...args) => whenSyncIdle(...args),
}));
// The local notebook records, as a sync leaves them
const localNotebooks = new Map();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../modules/masterPassword.js", () => ({
  isAppUnlocked: vi.fn(() => false),
  getEncryptionKey: vi.fn(() => null),
}));
vi.mock("../modules/encryption.js", () => ({ decryptObject: vi.fn() }));
vi.mock("../modules/storage.js", async (importOriginal) => ({
  ...(await importOriginal()),
  initStorage: vi.fn(),
  getNotebook: vi.fn(async (id) => localNotebooks.get(id) ?? null),
}));

const secrets = new Map();
vi.mock("../modules/secureStorage.js", () => ({
  saveSecureCredential: vi.fn(async (key, value) => void secrets.set(key, value)),
  getSecureCredential: vi.fn(async (key) => secrets.get(key) ?? null),
  deleteSecureCredential: vi.fn(async (key) => void secrets.delete(key)),
}));

let nc;
let showShareDialog;
let showConfirmDialog;
let getRecipientCount;
let resetOwnerShares;

const NOTEBOOK = { id: "nb1", title: "Recipes", synced: true, lastSyncedEtag: "etag" };
const FOLDER = "/NoteBerg/notebooks/nb1";
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const type = async (text) => {
  const input = $(".share-dialog__search");
  input.value = text;
  fireEvent.input(input);
  await vi.waitFor(() => expect($$(".share-dialog__suggestion").length).toBeGreaterThan(0), {
    timeout: 1500,
  });
};
const status = () => $(".share-dialog__status").textContent;
const rows = () => $$(".share-dialog__row");
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Open the dialog and wait until it has loaded the notebook's shares. */
async function open(notebook = NOTEBOOK) {
  const closed = showShareDialog(notebook);
  await vi.waitFor(() => expect($('.share-dialog[data-state="ready"]')).not.toBeNull());
  // Not returned: an async function that returns a promise waits for it, and this one
  // only settles when the dialog is closed
  return { closed };
}

async function shareWith(displayName, mode = "readonly") {
  await type(displayName);
  fireEvent.click($$(".share-dialog__suggestion").find((b) => b.textContent === displayName));
  $(".share-dialog__add-row select").value = mode;
  fireEvent.click($(".share-dialog__add"));
  await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0));
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  localNotebooks.clear();
  performSync.mockImplementation(async () => ({}));
  whenSyncIdle.mockImplementation(async () => {});
  document.body.innerHTML = "";
  secrets.clear();
  nc = new MockNextcloud();
  nc.addUser("alice", { displayName: "Alice" });
  nc.addUser("bob", { displayName: "Bob Brown" });
  nc.addUser("bobby", { displayName: "Bobby Tables" });
  nc.addUser("carol", { displayName: "Carol Clark" });
  nc.dav("alice").seedNotebook("nb1");
  wireMockNextcloud(fetch, nc);
  secrets.set(
    "nextcloud_credentials",
    JSON.stringify({
      serverUrl: nc.baseUrl,
      loginName: "alice",
      appPassword: "app-password-123",
      userId: "alice",
    }),
  );
  // Modules are loaded fresh for every test; nextcloudSync registers the native OCS transport
  await import("../modules/nextcloudSync.js");
  ({ getRecipientCount, resetOwnerShares } = await import("../modules/sharing/ownerShares.js"));
  resetOwnerShares();
  ({ showShareDialog } = await import("./shareDialog.js"));
  ({ showConfirmDialog } = await import("./modals.js"));
  showConfirmDialog.mockResolvedValue(true);
});

describe("opening the dialog", () => {
  it("names the notebook and explains what recipients can and cannot do", async () => {
    await open();
    expect($(".modal-title").textContent).toContain("Recipes");
    expect($(".modal-body .form-hint").textContent).toBe("sharing.share.intro");
  });

  it("says so when nobody has access yet", async () => {
    await open();
    expect($(".share-dialog__list").textContent).toBe("sharing.share.noRecipients");
  });

  it("lists the people who have access, with the access they have", async () => {
    await nc.share("alice", FOLDER, "bob", 1);
    await nc.share("alice", FOLDER, "carol", 7);

    await open();

    expect(rows().map((r) => r.querySelector(".share-dialog__who").textContent)).toEqual([
      "Bob Brown",
      "Carol Clark",
    ]);
    expect(rows().map((r) => r.querySelector("select").value)).toEqual(["readonly", "collab"]);
  });

  it("treats update-without-create as view-only: that is what the app can do with it", async () => {
    await nc.share("alice", FOLDER, "bob", 3);
    await open();
    expect(rows()[0].querySelector("select").value).toBe("readonly");
  });

  it("is quiet about a notebook that is not on the server yet", async () => {
    nc.dav("alice").files.delete(FOLDER);
    await open();
    expect(status()).toBe("");
    expect($(".share-dialog__list").textContent).toBe("sharing.share.noRecipients");
  });

  it("reports a failure to read the shares", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    nc.v1Errors = false;
    secrets.set(
      "nextcloud_credentials",
      JSON.stringify({
        serverUrl: nc.baseUrl,
        loginName: "mallory",
        appPassword: "x",
        userId: "m",
      }),
    );
    await open();
    expect(status()).toContain("sharing.share.loadFailed");
    warn.mockRestore();
  });
});

describe("adding a person", () => {
  it("finds people by name and never offers the user themself", async () => {
    await open();
    await type("a");
    const names = $$(".share-dialog__suggestion").map((b) => b.textContent);
    expect(names).toContain("Carol Clark");
    expect(names).not.toContain("Alice");
  });

  it("cannot share before a person is chosen", async () => {
    await open();
    expect($(".share-dialog__add").disabled).toBe(true);
    await type("carol");
    expect($(".share-dialog__add").disabled).toBe(true);
    fireEvent.click($(".share-dialog__suggestion"));
    expect($(".share-dialog__add").disabled).toBe(false);
  });

  it("shares once, even when a person is picked while the first share is being created", async () => {
    await open();
    // Hold the share request until the user has picked someone else
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const answer = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, options) => {
      if (options?.method === "POST") await held;
      return answer(url, options);
    });

    await type("carol");
    fireEvent.click($(".share-dialog__suggestion"));
    fireEvent.click($(".share-dialog__add"));
    await type("bob");
    fireEvent.click($$(".share-dialog__suggestion")[0]);
    expect($(".share-dialog__add").disabled).toBe(true);
    fireEvent.click($(".share-dialog__add"));

    release();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(nc.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("shares read-only by default", async () => {
    await open();
    await shareWith("Carol Clark");
    expect(nc.requests.findLast((r) => r.method === "POST").form).toMatchObject({
      shareWith: "carol",
      permissions: "1",
      path: FOLDER,
    });
  });

  it("shares with edit access when asked", async () => {
    await open();
    await shareWith("Carol Clark", "collab");
    expect(nc.requests.findLast((r) => r.method === "POST").form.permissions).toBe("7");
    expect(rows()[0].querySelector("select").value).toBe("collab");
  });

  it("shows the new person and lets the overview know", async () => {
    await open();
    await shareWith("Carol Clark");
    expect(rows()).toHaveLength(1);
    expect(getRecipientCount("nb1")).toBe(1);
  });

  it("does not offer people who already have access", async () => {
    await nc.share("alice", FOLDER, "carol", 1);
    await open();
    const input = $(".share-dialog__search");
    input.value = "carol";
    fireEvent.input(input);
    await vi.waitFor(() =>
      expect($(".share-dialog__suggestions").textContent).toBe("sharing.share.noResults"),
    );
    expect($$(".share-dialog__suggestion")).toHaveLength(0);
  });

  it("tells the user when the server only allowed viewing", async () => {
    nc.maxPermissions = 1;
    await open();
    await shareWith("Carol Clark", "collab");
    expect(status()).toBe("sharing.share.reduced");
    expect(rows()[0].querySelector("select").value).toBe("readonly");
  });

  it("says when nobody matches", async () => {
    await open();
    const input = $(".share-dialog__search");
    input.value = "zzzz";
    fireEvent.input(input);
    await vi.waitFor(() =>
      expect($(".share-dialog__suggestions").textContent).toBe("sharing.share.noResults"),
    );
  });

  it("shows the answer to the latest keystroke, not an earlier slower one", async () => {
    await open();
    const input = $(".share-dialog__search");
    input.value = "carol";
    fireEvent.input(input);
    await vi.waitFor(() => expect($$(".share-dialog__suggestion")).toHaveLength(1));
    input.value = "bob";
    fireEvent.input(input);
    await vi.waitFor(() =>
      expect($$(".share-dialog__suggestion").map((b) => b.textContent)).toEqual([
        "Bob Brown",
        "Bobby Tables",
      ]),
    );
  });

  it("reports a failed share and lets the user try again", async () => {
    await open();
    await type("carol");
    fireEvent.click($(".share-dialog__suggestion"));
    nc.users.delete("carol"); // the account vanished meanwhile
    fireEvent.click($(".share-dialog__add"));
    await vi.waitFor(() => expect(status()).toContain("sharing.share.failed"));
    expect($(".share-dialog__add").disabled).toBe(false);
  });

  it("syncs a notebook that never reached the server before sharing it", async () => {
    const local = { ...NOTEBOOK, synced: false, lastSyncedEtag: null };
    localNotebooks.set("nb1", local);
    performSync.mockImplementation(async () => {
      localNotebooks.set("nb1", { ...local, synced: true, lastSyncedEtag: "etag" });
      return {};
    });
    await open(local);
    await shareWith("Carol Clark");
    expect(performSync).toHaveBeenCalledTimes(1);
    expect(nc.shares.size).toBe(1);
  });

  it("waits for a sync already running, which may upload the notebook itself", async () => {
    const local = { ...NOTEBOOK, synced: false, lastSyncedEtag: null };
    localNotebooks.set("nb1", local);
    let finishRunningSync;
    whenSyncIdle.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRunningSync = () => {
            localNotebooks.set("nb1", { ...local, synced: true, lastSyncedEtag: "etag" });
            resolve();
          };
        }),
    );
    await open(local);
    await type("Carol Clark");
    fireEvent.click($$(".share-dialog__suggestion").find((b) => b.textContent === "Carol Clark"));
    fireEvent.click($(".share-dialog__add"));
    await settle();
    expect(nc.shares.size).toBe(0); // nothing is shared while the notebook is not there

    finishRunningSync();

    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(performSync).not.toHaveBeenCalled();
  });

  it("tries again when its own sync was skipped because another one started", async () => {
    const local = { ...NOTEBOOK, synced: false, lastSyncedEtag: null };
    localNotebooks.set("nb1", local);
    performSync
      .mockImplementationOnce(async () => null) // skipped: a sync was running
      .mockImplementationOnce(async () => {
        localNotebooks.set("nb1", { ...local, synced: true, lastSyncedEtag: "etag" });
        return {};
      });
    await open(local);
    await shareWith("Carol Clark");
    expect(performSync).toHaveBeenCalledTimes(2);
    expect(whenSyncIdle).toHaveBeenCalledTimes(2);
  });

  it("says plainly that the notebook is not on the server yet, instead of a path error", async () => {
    const local = { ...NOTEBOOK, synced: false, lastSyncedEtag: null };
    localNotebooks.set("nb1", local); // the sync runs but cannot upload it (offline)
    await open(local);
    await type("Carol Clark");
    fireEvent.click($$(".share-dialog__suggestion").find((b) => b.textContent === "Carol Clark"));
    fireEvent.click($(".share-dialog__add"));

    await vi.waitFor(() => expect(status()).toContain("sharing.share.notOnServer"));
    expect(nc.requests.filter((r) => r.method === "POST")).toEqual([]);
    expect($(".share-dialog__add").disabled).toBe(false);
  });

  it("does not sync an already uploaded notebook first", async () => {
    await open();
    await shareWith("Carol Clark");
    expect(performSync).not.toHaveBeenCalled();
  });
});

describe("changing and withdrawing access", () => {
  beforeEach(async () => {
    await nc.share("alice", FOLDER, "bob", 1);
    await open();
  });

  it("changes the access of one person", async () => {
    const select = rows()[0].querySelector("select");
    select.value = "collab";
    fireEvent.change(select);
    await vi.waitFor(() => expect(nc.shares.get("1").permissions).toBe(7));
    await settle();
    expect(select.value).toBe("collab");
    expect(select.disabled).toBe(false);
  });

  it("shows what the server really granted when it granted less", async () => {
    nc.maxPermissions = 1;
    const select = rows()[0].querySelector("select");
    select.value = "collab";
    fireEvent.change(select);
    await vi.waitFor(() => expect(status()).toBe("sharing.share.reduced"));
    expect(select.value).toBe("readonly");
  });

  it("puts the old choice back when the change fails", async () => {
    nc.shares.delete("1");
    const select = rows()[0].querySelector("select");
    select.value = "collab";
    fireEvent.change(select);
    await vi.waitFor(() => expect(status()).toContain("sharing.share.failed"));
    expect(select.value).toBe("readonly");
  });

  it("withdraws access after confirming", async () => {
    fireEvent.click(rows()[0].querySelector(".share-dialog__revoke"));
    await vi.waitFor(() => expect(rows()).toHaveLength(0));

    expect(showConfirmDialog).toHaveBeenCalled();
    expect(nc.shares.size).toBe(0);
    expect(getRecipientCount("nb1")).toBe(0);
    expect($(".share-dialog__list").textContent).toBe("sharing.share.noRecipients");
  });

  it("withdraws access once, however often the button is pressed", async () => {
    // Two clicks, two confirmations (a double tap, or a dialog answered twice)
    const answers = [];
    showConfirmDialog.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const button = rows()[0].querySelector(".share-dialog__revoke");
    fireEvent.click(button);
    fireEvent.click(button);
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    for (const answer of answers) answer(true);
    await vi.waitFor(() => expect(rows()).toHaveLength(0));
    expect(nc.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("leaves access alone when the user changes their mind", async () => {
    showConfirmDialog.mockResolvedValue(false);
    fireEvent.click(rows()[0].querySelector(".share-dialog__revoke"));
    await settle();
    expect(nc.shares.size).toBe(1);
    expect(rows()).toHaveLength(1);
  });
});

describe("closing", () => {
  it("closes with the button and resolves", async () => {
    const { closed } = await open();
    fireEvent.click($(".modal-cancel"));
    await expect(closed).resolves.toBeUndefined();
    expect($(".modal-overlay")).toBeNull();
  });

  it("closes with the cross, Escape and a click outside", async () => {
    for (const close of [
      () => fireEvent.click($(".modal-close")),
      () => fireEvent.keyDown(document, { key: "Escape" }),
      () => {
        const overlay = $(".modal-overlay");
        fireEvent.mouseDown(overlay);
        fireEvent.click(overlay);
      },
    ]) {
      const promise = showShareDialog(NOTEBOOK);
      await settle();
      close();
      await expect(promise).resolves.toBeUndefined();
      expect($(".modal-overlay")).toBeNull();
    }
  });

  it("stays open when the press started inside the dialog", async () => {
    showShareDialog(NOTEBOOK);
    await settle();
    fireEvent.mouseDown($(".modal-title"));
    fireEvent.click($(".modal-overlay"));
    expect($(".modal-overlay")).not.toBeNull();
  });

  it("replaces another open modal instead of stacking on it", async () => {
    document.body.insertAdjacentHTML("beforeend", '<div id="modal-overlay" class="old"></div>');
    showShareDialog(NOTEBOOK);
    await settle();
    expect($$("#modal-overlay")).toHaveLength(1);
    expect($("#modal-overlay").classList.contains("old")).toBe(false);
  });
});

describe("modeOf", () => {
  it("is collab only with both update and create", async () => {
    const { modeOf } = await import("./shareDialog.js");
    expect(modeOf(7)).toBe("collab");
    expect(modeOf(31)).toBe("collab");
    expect(modeOf(3)).toBe("readonly");
    expect(modeOf(5)).toBe("readonly");
    expect(modeOf(1)).toBe("readonly");
  });
});

describe("names other users chose", () => {
  it("are shown as text and escaped in the revoke confirmation, which renders HTML", async () => {
    // Any user can set their display name; this one is markup
    nc.addUser("eve", { displayName: '<img src=x id="injected">' });
    await nc.share("alice", FOLDER, "eve", 1);
    await open({ ...NOTEBOOK, title: "<b>Recipes</b>" });

    expect($(".share-dialog__who").textContent).toBe('<img src=x id="injected">');
    expect($("#injected")).toBeNull();

    fireEvent.click(rows()[0].querySelector(".share-dialog__revoke"));
    await settle();

    const [, message] = showConfirmDialog.mock.calls[0];
    expect(message).not.toContain("<img");
    expect(message).not.toContain("<b>");
    expect(message).toContain("&lt;img");
    expect(message).toContain("&lt;b&gt;Recipes");
  });
});
