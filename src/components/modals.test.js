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

describe("showProgressDialog", () => {
  /**
   * A long operation drives this dialog from two sources: real progress events,
   * and a once-a-second ticker that refreshes the elapsed time. Both call the
   * same update(), so the contract for a caller that only wants to change the
   * label is what keeps the bar from being clobbered between real events.
   */

  const fill = () => document.querySelector(".modal-progress-fill");
  const label = () => document.querySelector(".modal-progress-label");

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("fills the bar in proportion to the work done", async () => {
    const { showProgressDialog } = await import("./modals.js");
    const dialog = showProgressDialog("Working");
    dialog.update(1, 4);
    expect(fill().style.width).toBe("25%");
    dialog.update(3, 4);
    expect(fill().style.width).toBe("75%");
  });

  it("empties the bar when told a total of zero", async () => {
    // Documents the trap rather than endorsing it: recognition's elapsed-time
    // ticker used to call update(0, 0, text) once a second purely to refresh
    // the label, which reset the bar to empty a second after every page and
    // made a multi-page run look like it was making no progress at all.
    const { showProgressDialog } = await import("./modals.js");
    const dialog = showProgressDialog("Working");
    dialog.update(3, 4);
    expect(fill().style.width).toBe("75%");

    dialog.update(0, 0, "still going");
    expect(fill().style.width).toBe("0%");
  });

  it("keeps the bar in place when a label refresh repeats the current position", async () => {
    // The fix: a ticker that only wants to update text re-sends the position it
    // already knows, so the bar holds steady between real progress events.
    const { showProgressDialog } = await import("./modals.js");
    const dialog = showProgressDialog("Working");
    dialog.update(3, 4, "page 3 of 4");
    dialog.update(3, 4, "page 3 of 4 - 12s");

    expect(fill().style.width).toBe("75%");
    expect(label().textContent).toBe("page 3 of 4 - 12s");
  });

  it("shows the supplied text in preference to a bare count", async () => {
    const { showProgressDialog } = await import("./modals.js");
    const dialog = showProgressDialog("Working");
    dialog.update(1, 2, "transcribing");
    expect(label().textContent).toBe("transcribing");
  });
});

describe("recognized text modal", () => {
  /** The read-only field holding the recognized text. */
  function field() {
    return document.querySelector(".recognized-text__field");
  }

  function copyButton() {
    return document.querySelector(".modal-copy");
  }

  function pressKey(key) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }

  /**
   * Install a clipboard whose write can be made to fail.
   *
   * Modelled on the real thing rather than stubbed to always succeed: the
   * fallback path exists precisely because `navigator.clipboard` is missing on
   * insecure origins (the Nextcloud build over plain HTTP), and a mock that
   * cannot fail could not show that the fallback runs.
   */
  function stubClipboard({ available = true, fails = false } = {}) {
    const writeText = vi.fn(async () => {
      if (fails) throw new Error("denied");
    });
    Object.defineProperty(navigator, "clipboard", {
      value: available ? { writeText } : undefined,
      configurable: true,
      writable: true,
    });
    return writeText;
  }

  it("shows the stored text in a field the user cannot edit", async () => {
    modals.showRecognizedTextModal({ fullText: "shopping list", engine: "sidecar-uwp" });

    expect(field().value).toBe("shopping list");
    // readonly, not disabled: a disabled field cannot be selected or scrolled,
    // which would defeat the point of showing the text at all.
    expect(field().readOnly).toBe(true);
    expect(field().disabled).toBe(false);
  });

  it("names the engine that produced the text", async () => {
    modals.showRecognizedTextModal({ fullText: "hi", engine: "openai:qwen2.5-vl" });
    expect(document.querySelector(".recognized-text__engine")).not.toBeNull();
  });

  it("omits the engine line for results stored before the field existed", async () => {
    // Saying "unknown engine" would state something about old notes that is not
    // known; the line is simply absent instead.
    modals.showRecognizedTextModal({ fullText: "old note" });
    expect(document.querySelector(".recognized-text__engine")).toBeNull();
  });

  it("copies the exact text to the clipboard", async () => {
    const writeText = stubClipboard();
    modals.showRecognizedTextModal({ fullText: "line one\nline two" });

    copyButton().click();
    await flush();

    expect(writeText).toHaveBeenCalledWith("line one\nline two");
  });

  it("falls back to execCommand when the clipboard API is unavailable", async () => {
    // The insecure-origin case: navigator.clipboard is undefined, so the async
    // API cannot even be called and the button would otherwise do nothing.
    stubClipboard({ available: false });
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;

    modals.showRecognizedTextModal({ fullText: "fallback text" });
    copyButton().click();
    await flush();

    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("falls back to execCommand when the clipboard write is refused", async () => {
    const writeText = stubClipboard({ fails: true });
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;

    modals.showRecognizedTextModal({ fullText: "denied text" });
    copyButton().click();
    await flush();

    expect(writeText).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("confirms on the button that the copy happened", async () => {
    stubClipboard();
    modals.showRecognizedTextModal({ fullText: "text" });
    const button = copyButton();
    const idle = button.textContent;

    button.click();
    await flush();

    // Silent success reads as a dead button, which matters most on touch where
    // there is no other feedback.
    expect(button.textContent).not.toBe(idle);
  });

  it("says so when both copy paths fail", async () => {
    stubClipboard({ available: false });
    document.execCommand = vi.fn(() => false);

    modals.showRecognizedTextModal({ fullText: "text" });
    copyButton().click();
    await flush();

    expect(copyButton().textContent).toBe("modals.recognizedText.copyFailed");
  });

  it("closes on ESC", async () => {
    modals.showRecognizedTextModal({ fullText: "text" });
    pressKey("Escape");
    expect(document.querySelector("#modal-overlay").classList.contains("modal-closing")).toBe(true);
  });

  it("does not close on ENTER, which is an ordinary key inside the text", async () => {
    // The other read-only dialogs dismiss on ENTER. Here the focus is a
    // multi-line field, so doing the same would fight the selection and
    // navigation this dialog exists to allow.
    modals.showRecognizedTextModal({ fullText: "text" });
    pressKey("Enter");
    expect(document.querySelector("#modal-overlay").classList.contains("modal-closing")).toBe(
      false,
    );
  });
});

describe("showRecognitionOptionsDialog", () => {
  /** The dialog animates out over 200ms before resolving. */
  const settle = () => new Promise((r) => setTimeout(r, 250));

  function punctuationToggle() {
    return document.getElementById("recognition-punctuation");
  }

  function breaksToggle() {
    return document.getElementById("recognition-breaks");
  }

  it("resolves null when cancelled, so nothing is spent", async () => {
    // The whole reason the dialog exists: a user who did not mean to start a
    // paid run must be able to leave without starting one.
    const choice = modals.showRecognitionOptionsDialog({ pageCount: 3, model: "m" });
    document.querySelector(".modal-cancel").click();
    await settle();
    expect(await choice).toBeNull();
  });

  it("resolves null on Escape", async () => {
    const choice = modals.showRecognitionOptionsDialog({ pageCount: 1, model: "m" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();
    expect(await choice).toBeNull();
  });

  it("starts with layout off, so it is opt-in", async () => {
    // Models place break markers unreliably, so recording the layout costs
    // accuracy on the text. A user who wants the page's shape asks for it.
    const choice = modals.showRecognitionOptionsDialog({ pageCount: 1, model: "m" });
    expect(breaksToggle().checked).toBe(false);
    document.querySelector(".modal-confirm").click();
    await settle();
    expect(await choice).toEqual({ punctuation: true, breaks: false });
  });

  it("reports the layout choice when the user asks for it", async () => {
    const choice = modals.showRecognitionOptionsDialog({ pageCount: 1, model: "m" });
    breaksToggle().checked = true;
    document.querySelector(".modal-confirm").click();
    await settle();
    expect(await choice).toEqual({ punctuation: true, breaks: true });
  });

  it("ignores ENTER while the layout toggle has focus", async () => {
    // Same reasoning as the punctuation toggle: both switches have to be safe
    // to reach for, not just the first one.
    const choice = modals.showRecognitionOptionsDialog({ pageCount: 1, model: "m" });
    breaksToggle().focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await settle();
    expect(document.getElementById("modal-overlay")).not.toBeNull();

    document.querySelector(".modal-cancel").click();
    await settle();
    expect(await choice).toBeNull();
  });

  it("starts with punctuation on, so the option is an opt-out", async () => {
    // Every run before this option existed transcribed punctuation. Opening the
    // dialog and pressing Start must not quietly change what a run produces.
    const choice = modals.showRecognitionOptionsDialog({ pageCount: 1, model: "m" });
    expect(punctuationToggle().checked).toBe(true);
    document.querySelector(".modal-confirm").click();
    await settle();
    expect(await choice).toEqual({ punctuation: true, breaks: false });
  });

  it("reports words-only when the user switches punctuation off", async () => {
    const choice = modals.showRecognitionOptionsDialog({ pageCount: 1, model: "m" });
    punctuationToggle().checked = false;
    document.querySelector(".modal-confirm").click();
    await settle();
    expect(await choice).toEqual({ punctuation: false, breaks: false });
  });

  it("does not remember the choice from a previous run", async () => {
    // This is a per-run decision about one note. A preference silently carried
    // over from a run months ago is the surprise the dialog exists to prevent.
    const first = modals.showRecognitionOptionsDialog({ pageCount: 1, model: "m" });
    punctuationToggle().checked = false;
    breaksToggle().checked = true;
    document.querySelector(".modal-confirm").click();
    await settle();
    await first;

    const second = modals.showRecognitionOptionsDialog({ pageCount: 1, model: "m" });
    expect(punctuationToggle().checked).toBe(true);
    expect(breaksToggle().checked).toBe(false);
    document.querySelector(".modal-cancel").click();
    await settle();
    await second;
  });

  it("ignores ENTER while the option has focus", async () => {
    // On the toggle, ENTER and SPACE are both reaching for the switch. Starting
    // a paid run from a keystroke aimed at an option is the exact mis-trigger
    // this dialog removes.
    const choice = modals.showRecognitionOptionsDialog({ pageCount: 1, model: "m" });
    punctuationToggle().focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await settle();
    expect(document.getElementById("modal-overlay")).not.toBeNull();

    document.querySelector(".modal-cancel").click();
    await settle();
    expect(await choice).toBeNull();
  });

  it("uses the same toggle markup as the settings screen", async () => {
    // The styling comes entirely from the shared .setting-item/.toggle-switch
    // rules, so the dialog only looks right while it keeps that structure.
    const choice = modals.showRecognitionOptionsDialog({ pageCount: 1, model: "m" });
    const rows = document.querySelectorAll(".recognition-option");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.classList.contains("setting-item")).toBe(true);
      expect(row.querySelector(".setting-label .setting-name")).not.toBeNull();
      expect(row.querySelector(".toggle-switch .toggle-slider")).not.toBeNull();
    }

    document.querySelector(".modal-cancel").click();
    await settle();
    await choice;
  });

  it("names the scope so the confirmation is a decision, not a speed bump", async () => {
    const choice = modals.showRecognitionOptionsDialog({ pageCount: 4, model: "some-model" });
    // t() is mocked to return keys, so this asserts the scope line is rendered
    // at all — an empty confirmation would tell the user nothing about cost.
    expect(document.querySelector(".confirm-message")).not.toBeNull();
    document.querySelector(".modal-cancel").click();
    await settle();
    await choice;
  });

  it("still confirms when the page count is unknown", async () => {
    // countBands returns nothing useful for a note it cannot plan. The run must
    // still be confirmable rather than the dialog breaking.
    const choice = modals.showRecognitionOptionsDialog({ model: "m" });
    expect(document.querySelector(".modal-confirm")).not.toBeNull();
    document.querySelector(".modal-confirm").click();
    await settle();
    expect(await choice).toEqual({ punctuation: true, breaks: false });
  });

  it("shows no quota line when quota is null", async () => {
    // Off Nextcloud, and under BYO, getQuota() resolves to null. Nothing about
    // an allowance applies there, so nothing should be said about one.
    const choice = modals.showRecognitionOptionsDialog({ pageCount: 1, model: "m", quota: null });
    expect(document.body.textContent).not.toContain("canvas.recognition.quotaRemaining");
    expect(document.body.textContent).not.toContain("canvas.recognition.quotaExhausted");
    document.querySelector(".modal-cancel").click();
    await settle();
    await choice;
  });

  it("shows no quota line when the administrator set no limit", async () => {
    // limit: 0 means unlimited. Nothing to decide about, so nothing shown.
    const choice = modals.showRecognitionOptionsDialog({
      pageCount: 1,
      model: "m",
      quota: { used: 40, limit: 0 },
    });
    expect(document.body.textContent).not.toContain("canvas.recognition.quotaRemaining");
    document.querySelector(".modal-cancel").click();
    await settle();
    await choice;
  });

  it("shows the remaining pages when a limit applies and Start stays enabled", async () => {
    const choice = modals.showRecognitionOptionsDialog({
      pageCount: 1,
      model: "m",
      quota: { used: 45, limit: 50 },
    });
    expect(document.body.textContent).toContain("canvas.recognition.quotaRemaining");
    expect(document.querySelector(".modal-confirm").disabled).toBe(false);
    document.querySelector(".modal-confirm").click();
    await settle();
    expect(await choice).toEqual({ punctuation: true, breaks: false });
  });

  it("disables Start and warns when the allowance is exhausted", async () => {
    // Offering a button that always fails is worse than not offering it: the
    // user finds out before tapping, not after a failed run.
    const choice = modals.showRecognitionOptionsDialog({
      pageCount: 1,
      model: "m",
      quota: { used: 50, limit: 50 },
    });
    expect(document.body.textContent).toContain("canvas.recognition.quotaExhausted");
    const confirmBtn = document.querySelector(".modal-confirm");
    expect(confirmBtn.disabled).toBe(true);

    confirmBtn.click();
    await settle();
    // Clicking a disabled button fires no click event, so the dialog is still
    // open and nothing has resolved yet.
    expect(document.getElementById("modal-overlay")).not.toBeNull();

    document.querySelector(".modal-cancel").click();
    await settle();
    expect(await choice).toBeNull();
  });

  it("ignores ENTER when the allowance is exhausted", async () => {
    const choice = modals.showRecognitionOptionsDialog({
      pageCount: 1,
      model: "m",
      quota: { used: 50, limit: 50 },
    });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await settle();
    expect(document.getElementById("modal-overlay")).not.toBeNull();

    document.querySelector(".modal-cancel").click();
    await settle();
    expect(await choice).toBeNull();
  });

  it("treats a used count past the limit as fully exhausted, not negative", async () => {
    // A usage count can outrun the limit slightly (e.g. a race at the boundary).
    // Remaining must clamp at 0 rather than showing a negative page count.
    const choice = modals.showRecognitionOptionsDialog({
      pageCount: 1,
      model: "m",
      quota: { used: 53, limit: 50 },
    });
    expect(document.body.textContent).toContain("canvas.recognition.quotaExhausted");
    expect(document.querySelector(".modal-confirm").disabled).toBe(true);
    document.querySelector(".modal-cancel").click();
    await settle();
    await choice;
  });
});
