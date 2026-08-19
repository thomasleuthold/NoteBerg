/**
 * src/components/modals.test.js
 *
 * These tests cover the double-submit defect seen on slow systems (notably the
 * Nextcloud build, where createNote writes over WebDAV rather than to
 * IndexedDB): the confirm handler is async, so between the first keypress and
 * the modal actually leaving the DOM there is a window in which a second ENTER
 * starts a second, independent create.
 *
 * The storage mock models that reality — createNote resolves only when the test
 * releases it — because a mock that resolves immediately cannot express the bug
 * at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const createNote = vi.fn();
const createNotebook = vi.fn();
const navigateTo = vi.fn();

vi.mock("../modules/storage.js", () => ({
  createNote: (...args) => createNote(...args),
  createNotebook: (...args) => createNotebook(...args),
  updateNote: vi.fn(),
  updateNotebook: vi.fn(),
  getNotebook: vi.fn(async () => ({ id: "nb1", title: "Notebook" })),
}));

vi.mock("../modules/router.js", () => ({
  navigateTo: (...args) => navigateTo(...args),
}));

vi.mock("../i18n/index.js", () => ({
  t: (key) => key,
}));

let modals;

/** A promise plus its resolver, so a test can hold a write open. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let queued microtasks (the awaits inside the confirm handler) run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function titleInput() {
  return document.getElementById("note-title") || document.getElementById("notebook-title");
}

function pressEnter() {
  const input = titleInput();
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
}

function confirmButton() {
  return document.querySelector(".modal-confirm");
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = "";
  vi.useRealTimers();
  modals = await import("./modals.js");
});

describe("create note modal — double submit on a slow write", () => {
  it("creates exactly one note when ENTER is pressed twice during the write", async () => {
    const write = deferred();
    createNote.mockImplementation(async () => {
      await write.promise;
      return { id: "note1" };
    });

    await modals.showCreateNoteModal("nb1");
    titleInput().value = "My note";

    pressEnter();
    await flush();
    // Write still in flight — this is the window the user hits on a slow system.
    pressEnter();
    await flush();

    write.resolve();
    await flush();

    expect(createNote).toHaveBeenCalledTimes(1);
  });

  it("navigates to a single note, so the editor cannot open an orphan", async () => {
    // Each create gets its own gate and its own id: the reported symptom is that
    // the *second* note is the one the editor opens, leaving the first as an
    // empty orphan. Sharing one gate would let both navigations settle after the
    // assertion and hide that.
    const gates = [deferred(), deferred()];
    let n = 0;
    createNote.mockImplementation(async () => {
      const i = n++;
      await gates[i].promise;
      return { id: `note${i + 1}` };
    });

    await modals.showCreateNoteModal("nb1");
    titleInput().value = "My note";

    pressEnter();
    await flush();
    pressEnter();
    await flush();

    // Release both writes and let every continuation drain before asserting.
    gates[0].resolve();
    gates[1].resolve();
    await flush();
    await flush();

    expect(createNote).toHaveBeenCalledTimes(1);
    expect(navigateTo).toHaveBeenCalledTimes(1);
    expect(navigateTo).toHaveBeenCalledWith("notebook", { noteId: "note1", notebookId: "nb1" });
  });

  it("ignores auto-repeat from a held ENTER key", async () => {
    createNote.mockResolvedValue({ id: "note1" });

    await modals.showCreateNoteModal("nb1");
    titleInput().value = "My note";

    titleInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true }),
    );
    await flush();

    expect(createNote).not.toHaveBeenCalled();
  });

  it("does not start a second create when the button is clicked during the write", async () => {
    const write = deferred();
    createNote.mockImplementation(async () => {
      await write.promise;
      return { id: "note1" };
    });

    await modals.showCreateNoteModal("nb1");
    titleInput().value = "My note";

    confirmButton().click();
    await flush();
    confirmButton().click();
    await flush();

    write.resolve();
    await flush();

    expect(createNote).toHaveBeenCalledTimes(1);
  });
});

describe("create note modal — busy feedback", () => {
  it("disables the confirm button while the write is in flight", async () => {
    const write = deferred();
    createNote.mockImplementation(async () => {
      await write.promise;
      return { id: "note1" };
    });

    await modals.showCreateNoteModal("nb1");
    titleInput().value = "My note";

    expect(confirmButton().disabled).toBe(false);

    pressEnter();
    await flush();

    expect(confirmButton().disabled).toBe(true);

    write.resolve();
    await flush();
  });

  it("blocks cancel and close while the write is in flight, so a create cannot be abandoned half-done", async () => {
    const write = deferred();
    createNote.mockImplementation(async () => {
      await write.promise;
      return { id: "note1" };
    });

    await modals.showCreateNoteModal("nb1");
    titleInput().value = "My note";

    pressEnter();
    await flush();

    document.querySelector(".modal-cancel").click();
    document.querySelector(".modal-close").click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();

    expect(document.getElementById("modal-overlay")).not.toBeNull();
    expect(document.getElementById("modal-overlay").classList.contains("modal-closing")).toBe(
      false,
    );

    write.resolve();
    await flush();
  });
});

describe("create note modal — failure recovery", () => {
  it("re-enables confirm after a failed write so the user can retry", async () => {
    createNote.mockRejectedValueOnce(new Error("network down"));

    await modals.showCreateNoteModal("nb1");
    titleInput().value = "My note";

    pressEnter();
    await flush();

    expect(confirmButton().disabled).toBe(false);
    expect(document.querySelector(".modal-error").textContent).toBe("network down");

    createNote.mockResolvedValueOnce({ id: "note1" });
    pressEnter();
    await flush();

    expect(createNote).toHaveBeenCalledTimes(2);
  });

  it("keeps the modal open and creates nothing when the title is empty", async () => {
    await modals.showCreateNoteModal("nb1");
    titleInput().value = "   ";

    pressEnter();
    await flush();

    expect(createNote).not.toHaveBeenCalled();
    expect(document.getElementById("modal-overlay")).not.toBeNull();
    expect(confirmButton().disabled).toBe(false);
  });
});

describe("create notebook modal", () => {
  it("creates exactly one notebook when ENTER is pressed twice during the write", async () => {
    const write = deferred();
    createNotebook.mockImplementation(async () => {
      await write.promise;
      return { id: "nb1" };
    });

    modals.showCreateNotebookModal();
    titleInput().value = "My notebook";

    pressEnter();
    await flush();
    pressEnter();
    await flush();

    write.resolve();
    await flush();

    expect(createNotebook).toHaveBeenCalledTimes(1);
  });
});
