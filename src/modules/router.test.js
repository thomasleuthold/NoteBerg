/**
 * src/modules/router.test.js
 * Router is a small state machine (mode validation, context clearing rules,
 * param propagation) with DOM/event side effects. Uses the real jsdom DOM
 * and CustomEvent — no mocking needed beyond resetting module state.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let router;

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="main-content"></div>';
  router = await import("./router.js");
});

describe("initRouter", () => {
  it("resets to the default overview mode", () => {
    router.navigateTo("settings");
    router.initRouter();
    expect(router.getCurrentMode()).toBe("overview");
  });
});

describe("navigateTo mode validation", () => {
  it("navigates to a valid mode", () => {
    router.navigateTo("settings");
    expect(router.getCurrentMode()).toBe("settings");
  });

  it("falls back to the default mode for an invalid mode", () => {
    router.navigateTo("not-a-real-mode");
    expect(router.getCurrentMode()).toBe("overview");
  });
});

describe("context clearing rules", () => {
  it("clears noteId and notebookId when navigating to settings", () => {
    router.navigateTo("notebook", { noteId: "n1", notebookId: "nb1" });
    router.navigateTo("settings");
    expect(router.getCurrentNoteId()).toBeNull();
    expect(router.getCurrentNotebookId()).toBeNull();
  });

  it("clears noteId and notebookId when navigating to recyclebin", () => {
    router.navigateTo("notebook", { noteId: "n1", notebookId: "nb1" });
    router.navigateTo("recyclebin");
    expect(router.getCurrentNoteId()).toBeNull();
    expect(router.getCurrentNotebookId()).toBeNull();
  });

  it("clears noteId (always) and notebookId (unless provided) when navigating to overview", () => {
    router.navigateTo("notebook", { noteId: "n1", notebookId: "nb1" });
    router.navigateTo("overview");
    expect(router.getCurrentNoteId()).toBeNull();
    expect(router.getCurrentNotebookId()).toBeNull();
  });

  it("keeps notebookId when navigating to overview with notebookId param (drill-down view)", () => {
    router.navigateTo("overview", { notebookId: "nb1" });
    expect(router.getCurrentNotebookId()).toBe("nb1");
    expect(router.getCurrentNoteId()).toBeNull();
  });

  it("stores noteId/notebookId params when navigating to notebook mode", () => {
    router.navigateTo("notebook", { noteId: "n1", notebookId: "nb1" });
    expect(router.getCurrentNoteId()).toBe("n1");
    expect(router.getCurrentNotebookId()).toBe("nb1");
  });

  it("keeps the previous noteId/notebookId in notebook mode when params omit them", () => {
    router.navigateTo("notebook", { noteId: "n1", notebookId: "nb1" });
    router.navigateTo("notebook", {});
    expect(router.getCurrentNoteId()).toBe("n1");
    expect(router.getCurrentNotebookId()).toBe("nb1");
  });
});

describe("events", () => {
  it("dispatches beforenavigate then navigate with mode/params/previousMode", () => {
    const order = [];
    const before = vi.fn((e) => order.push(["beforenavigate", e.detail]));
    const after = vi.fn((e) => order.push(["navigate", e.detail]));
    window.addEventListener("beforenavigate", before);
    window.addEventListener("navigate", after);

    router.navigateTo("settings", { foo: "bar" });

    expect(order.map((o) => o[0])).toEqual(["beforenavigate", "navigate"]);
    expect(order[0][1]).toEqual({
      mode: "settings",
      params: { foo: "bar" },
      previousMode: "overview",
    });
    expect(order[1][1]).toEqual({
      mode: "settings",
      params: { foo: "bar" },
      previousMode: "overview",
    });

    window.removeEventListener("beforenavigate", before);
    window.removeEventListener("navigate", after);
  });

  it("dispatches the mode-specific render event", () => {
    const handler = vi.fn();
    window.addEventListener("rendersettings", handler);
    router.navigateTo("settings");
    expect(handler).toHaveBeenCalled();
    window.removeEventListener("rendersettings", handler);
  });

  it("dispatches renderoverview with the resolved notebookId", () => {
    const handler = vi.fn();
    window.addEventListener("renderoverview", handler);
    router.navigateTo("overview", { notebookId: "nb1" });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { notebookId: "nb1" } }),
    );
    window.removeEventListener("renderoverview", handler);
  });

  it("dispatches rendernotebook with noteId, notebookId, taskId, searchQuery", () => {
    const handler = vi.fn();
    window.addEventListener("rendernotebook", handler);
    router.navigateTo("notebook", {
      noteId: "n1",
      notebookId: "nb1",
      taskId: "t1",
      searchQuery: "q",
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { noteId: "n1", notebookId: "nb1", taskId: "t1", searchQuery: "q" },
      }),
    );
    window.removeEventListener("rendernotebook", handler);
  });

  it("dispatches renderrecyclebin", () => {
    const handler = vi.fn();
    window.addEventListener("renderrecyclebin", handler);
    router.navigateTo("recyclebin");
    expect(handler).toHaveBeenCalled();
    window.removeEventListener("renderrecyclebin", handler);
  });
});

describe("DOM view swapping", () => {
  it("creates a mode container and unhides it", () => {
    router.navigateTo("settings");
    const container = document.querySelector('[data-mode="settings"]');
    expect(container).not.toBeNull();
    expect(container.classList.contains("hidden")).toBe(false);
  });

  it("hides previously shown mode containers when switching modes", () => {
    router.navigateTo("settings");
    router.navigateTo("recyclebin");
    const settingsContainer = document.querySelector('[data-mode="settings"]');
    const recycleContainer = document.querySelector('[data-mode="recyclebin"]');
    expect(settingsContainer.classList.contains("hidden")).toBe(true);
    expect(recycleContainer.classList.contains("hidden")).toBe(false);
  });

  it("reuses an existing mode container instead of creating a duplicate", () => {
    router.navigateTo("settings");
    router.navigateTo("overview");
    router.navigateTo("settings");
    expect(document.querySelectorAll('[data-mode="settings"]')).toHaveLength(1);
  });

  it("does nothing when #main-content is missing", () => {
    document.body.innerHTML = "";
    expect(() => router.navigateTo("settings")).not.toThrow();
  });
});

describe("goBack", () => {
  it("navigates to overview", () => {
    router.navigateTo("settings");
    router.goBack();
    expect(router.getCurrentMode()).toBe("overview");
  });
});
