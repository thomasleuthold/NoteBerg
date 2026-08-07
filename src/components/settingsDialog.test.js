/**
 * src/components/settingsDialog.test.js
 *
 * The settings dialog exists so opening settings does not tear down an open
 * note. The design requirements it must satisfy:
 *  - it renders over the current view without replacing #main-content, and
 *    without emitting the `navigate` event that makes NoteCanvas destroy the
 *    open note (NoteCanvas/index.js reacts to previousMode === "notebook");
 *  - it uses its own overlay id, so the nested confirm/alert/prompt dialogs
 *    that settings itself opens (all of which reuse #modal-overlay and remove
 *    any existing one) cannot destroy it;
 *  - Escape closes only the topmost dialog;
 *  - closing is idempotent and restores focus to the opener.
 *
 * renderSettings is mocked: it pulls in storage, sync, MCP and Tauri modules
 * that are irrelevant here — this file is about the dialog shell.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./settingsMode.js", () => ({
  renderSettings: vi.fn(async (container) => {
    container.innerHTML = '<div class="settings-panel"></div>';
  }),
}));

vi.mock("../i18n/index.js", () => ({
  t: (key) => key,
}));

let dialog;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="main-content"></div>';
  dialog = await import("./settingsDialog.js");
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/** The close animation removes the overlay on a timer. */
function flushClose() {
  vi.advanceTimersByTime(250);
}

describe("opening", () => {
  it("renders the settings panel into its own overlay", async () => {
    await dialog.openSettingsDialog();

    const overlay = document.getElementById("settings-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector(".settings-panel")).not.toBeNull();
  });

  it("leaves the view underneath mounted", async () => {
    const mainContent = document.getElementById("main-content");
    mainContent.innerHTML = '<div id="the-open-note">strokes</div>';

    await dialog.openSettingsDialog();

    // The whole point: the note's DOM is untouched, so scroll position, zoom
    // and selected tool survive.
    expect(document.getElementById("the-open-note")).not.toBeNull();
  });

  it("does not emit navigate (which would destroy the open note)", async () => {
    const onNavigate = vi.fn();
    window.addEventListener("navigate", onNavigate);

    await dialog.openSettingsDialog();

    window.removeEventListener("navigate", onNavigate);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("reports itself open, so Back can close it instead of navigating", async () => {
    expect(dialog.isSettingsDialogOpen()).toBe(false);
    await dialog.openSettingsDialog();
    expect(dialog.isSettingsDialogOpen()).toBe(true);
  });

  it("does not stack a second overlay when opened twice", async () => {
    await dialog.openSettingsDialog();
    await dialog.openSettingsDialog();

    expect(document.querySelectorAll("#settings-overlay")).toHaveLength(1);
  });
});

describe("nested dialogs", () => {
  it("uses an id distinct from the shared modal overlay", async () => {
    await dialog.openSettingsDialog();

    // modals.js removes any existing #modal-overlay before showing its own, so
    // sharing that id would make the first confirm opened from settings (revoke
    // token, purge data, ...) destroy the settings dialog behind it.
    expect(document.getElementById("settings-overlay")).not.toBeNull();
    expect(document.getElementById("modal-overlay")).toBeNull();
  });

  it("survives a nested modal being opened and removed", async () => {
    await dialog.openSettingsDialog();

    // Simulate modals.js: remove any #modal-overlay, then insert its own.
    document.getElementById("modal-overlay")?.remove();
    document.body.insertAdjacentHTML("beforeend", '<div id="modal-overlay"></div>');
    document.getElementById("modal-overlay").remove();

    expect(document.getElementById("settings-overlay")).not.toBeNull();
    expect(dialog.isSettingsDialogOpen()).toBe(true);
  });

  it("ignores Escape while a nested dialog is on top", async () => {
    await dialog.openSettingsDialog();
    document.body.insertAdjacentHTML("beforeend", '<div id="modal-overlay"></div>');

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushClose();

    // The nested dialog owns that Escape; closing settings too would dismiss
    // both at once.
    expect(dialog.isSettingsDialogOpen()).toBe(true);
    expect(document.getElementById("settings-overlay")).not.toBeNull();
  });
});

/**
 * As a router mode, settings was re-localized by changeLanguage's navigateTo.
 * The dialog sits outside the router's view tree, so it must refresh itself —
 * otherwise picking a language leaves the panel in the previous one until it is
 * closed and reopened.
 */
describe("language change", () => {
  it("re-renders the panel so the new language takes effect immediately", async () => {
    const { renderSettings } = await import("./settingsMode.js");
    await dialog.openSettingsDialog();
    vi.mocked(renderSettings).mockClear();

    window.dispatchEvent(new CustomEvent("languagechange", { detail: { lang: "de" } }));
    await vi.waitFor(() => expect(renderSettings).toHaveBeenCalled());
  });

  it("keeps the dialog open across the re-render", async () => {
    await dialog.openSettingsDialog();

    window.dispatchEvent(new CustomEvent("languagechange", { detail: { lang: "de" } }));
    await vi.waitFor(() => {
      expect(document.getElementById("settings-overlay")).not.toBeNull();
    });
    expect(dialog.isSettingsDialogOpen()).toBe(true);
  });

  it("preserves scroll position, so picking a language does not jump to the top", async () => {
    await dialog.openSettingsDialog();
    const body = document.querySelector(".settings-dialog__body");
    // jsdom reports 0 height, so scrollTop only holds a value we set directly.
    Object.defineProperty(body, "scrollTop", { value: 0, writable: true });
    body.scrollTop = 420;

    window.dispatchEvent(new CustomEvent("languagechange", { detail: { lang: "de" } }));
    await vi.waitFor(() => expect(body.scrollTop).toBe(420));
  });

  it("does not re-render once closed", async () => {
    const { renderSettings } = await import("./settingsMode.js");
    await dialog.openSettingsDialog();
    dialog.closeSettingsDialog();
    flushClose();
    vi.mocked(renderSettings).mockClear();

    window.dispatchEvent(new CustomEvent("languagechange", { detail: { lang: "de" } }));

    // A leaked listener would render into a detached container forever.
    expect(renderSettings).not.toHaveBeenCalled();
  });
});

describe("closing", () => {
  it("closes on Escape when it is the topmost dialog", async () => {
    await dialog.openSettingsDialog();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushClose();

    expect(dialog.isSettingsDialogOpen()).toBe(false);
    expect(document.getElementById("settings-overlay")).toBeNull();
  });

  it("closes on backdrop click", async () => {
    await dialog.openSettingsDialog();
    const overlay = document.getElementById("settings-overlay");

    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flushClose();

    expect(document.getElementById("settings-overlay")).toBeNull();
  });

  it("stays open when a click lands inside the dialog", async () => {
    await dialog.openSettingsDialog();
    const panel = document.querySelector(".settings-dialog");

    panel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flushClose();

    expect(document.getElementById("settings-overlay")).not.toBeNull();
  });

  it("closes on the close button", async () => {
    await dialog.openSettingsDialog();

    document.querySelector(".settings-dialog__close").click();
    flushClose();

    expect(document.getElementById("settings-overlay")).toBeNull();
  });

  it("is idempotent when already closed", async () => {
    await dialog.openSettingsDialog();
    dialog.closeSettingsDialog();
    flushClose();

    expect(() => dialog.closeSettingsDialog()).not.toThrow();
    expect(dialog.isSettingsDialogOpen()).toBe(false);
  });

  it("detaches its Escape handler when closed", async () => {
    const added = [];
    const removed = [];
    const addSpy = vi
      .spyOn(document, "addEventListener")
      .mockImplementation(function (type, handler, opts) {
        if (type === "keydown") added.push(handler);
        return EventTarget.prototype.addEventListener.call(this, type, handler, opts);
      });
    const removeSpy = vi
      .spyOn(document, "removeEventListener")
      .mockImplementation(function (type, handler, opts) {
        if (type === "keydown") removed.push(handler);
        return EventTarget.prototype.removeEventListener.call(this, type, handler, opts);
      });

    await dialog.openSettingsDialog();
    dialog.closeSettingsDialog();
    flushClose();

    addSpy.mockRestore();
    removeSpy.mockRestore();

    // Every keydown handler the dialog attached must be handed back on close —
    // a leaked one would keep closing dialogs it no longer owns.
    expect(added.length).toBeGreaterThan(0);
    expect(removed).toEqual(expect.arrayContaining(added));
  });

  it("restores focus to the element that opened it", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    await dialog.openSettingsDialog();
    dialog.closeSettingsDialog();
    flushClose();

    expect(document.activeElement).toBe(opener);
  });
});
