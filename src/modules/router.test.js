/**
 * src/modules/router.test.js
 * Router is a small state machine (mode validation, context clearing rules,
 * param propagation) with DOM/event side effects. Uses the real jsdom DOM
 * and CustomEvent — no mocking needed beyond resetting module state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let router;

/**
 * router.js binds its popstate listener at module scope. vi.resetModules()
 * hands each test a fresh module, but listeners registered by *previous*
 * instances stay attached to the shared jsdom window and would keep handling
 * popstate against their own stale module state. Swapping in a fresh window
 * shim per test isolates them.
 */
let popStateListeners;
const realAddEventListener = window.addEventListener.bind(window);
const realRemoveEventListener = window.removeEventListener.bind(window);

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="main-content"></div>';

  popStateListeners = [];
  window.addEventListener = (type, handler, options) => {
    if (type === "popstate") popStateListeners.push(handler);
    return realAddEventListener(type, handler, options);
  };

  router = await import("./router.js");
});

afterEach(() => {
  for (const handler of popStateListeners) {
    realRemoveEventListener("popstate", handler);
  }
  window.addEventListener = realAddEventListener;
});

describe("initRouter", () => {
  it("resets to the default overview mode", () => {
    router.navigateTo("recyclebin");
    router.initRouter();
    expect(router.getCurrentMode()).toBe("overview");
  });
});

describe("navigateTo mode validation", () => {
  it("navigates to a valid mode", () => {
    router.navigateTo("recyclebin");
    expect(router.getCurrentMode()).toBe("recyclebin");
  });

  it("falls back to the default mode for an invalid mode", () => {
    router.navigateTo("not-a-real-mode");
    expect(router.getCurrentMode()).toBe("overview");
  });

  // Settings is a dialog, not a mode (see settingsDialog.js). Navigating to it
  // must not silently produce a blank view: it is not a mode, so it falls back
  // to the default like any other unknown name.
  it("treats settings as an unknown mode", () => {
    router.navigateTo("settings");
    expect(router.getCurrentMode()).toBe("overview");
  });
});

describe("context clearing rules", () => {
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

    router.navigateTo("recyclebin", { foo: "bar" });

    expect(order.map((o) => o[0])).toEqual(["beforenavigate", "navigate"]);
    expect(order[0][1]).toEqual({
      mode: "recyclebin",
      params: { foo: "bar" },
      previousMode: "overview",
    });
    expect(order[1][1]).toEqual({
      mode: "recyclebin",
      params: { foo: "bar" },
      previousMode: "overview",
    });

    window.removeEventListener("beforenavigate", before);
    window.removeEventListener("navigate", after);
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
    router.navigateTo("recyclebin");
    const container = document.querySelector('[data-mode="recyclebin"]');
    expect(container).not.toBeNull();
    expect(container.classList.contains("hidden")).toBe(false);
  });

  it("hides previously shown mode containers when switching modes", () => {
    router.navigateTo("notebook");
    router.navigateTo("recyclebin");
    const notebookContainer = document.querySelector('[data-mode="notebook"]');
    const recycleContainer = document.querySelector('[data-mode="recyclebin"]');
    expect(notebookContainer.classList.contains("hidden")).toBe(true);
    expect(recycleContainer.classList.contains("hidden")).toBe(false);
  });

  it("reuses an existing mode container instead of creating a duplicate", () => {
    router.navigateTo("recyclebin");
    router.navigateTo("overview");
    router.navigateTo("recyclebin");
    expect(document.querySelectorAll('[data-mode="recyclebin"]')).toHaveLength(1);
  });

  it("does nothing when #main-content is missing", () => {
    document.body.innerHTML = "";
    expect(() => router.navigateTo("recyclebin")).not.toThrow();
  });
});

describe("goBack", () => {
  it("navigates to overview", () => {
    router.navigateTo("recyclebin");
    router.goBack();
    expect(router.getCurrentMode()).toBe("overview");
  });
});

/**
 * Android's hardware Back exits the app whenever the WebView has no history to
 * go back through (WryActivity.onKeyDown → canGoBack()). These tests pin the
 * requirement that navigation produces real history entries and that popping
 * them drives the router rather than unwinding out of the app.
 */
describe("history integration (Android hardware Back)", () => {
  it("records a history entry identifying the destination", () => {
    router.navigateTo("notebook", { noteId: "n1", notebookId: "nb1" });
    expect(history.state).toMatchObject({ nbMode: "notebook" });
    expect(history.state.nbParams).toMatchObject({ noteId: "n1", notebookId: "nb1" });
  });

  it("adds entries as the user goes deeper, so Back has somewhere to go", () => {
    const before = history.length;
    router.navigateTo("overview", { notebookId: "nb1" });
    router.navigateTo("notebook", { noteId: "n1", notebookId: "nb1" });
    expect(history.length).toBeGreaterThan(before);
  });

  it("navigates to the popped entry's mode instead of exiting", () => {
    router.navigateTo("overview");
    router.navigateTo("notebook", { noteId: "n1", notebookId: "nb1" });
    expect(router.getCurrentMode()).toBe("notebook");

    // jsdom does not run the back/forward queue, so dispatch the event the
    // browser would deliver for the previous entry.
    window.dispatchEvent(
      new PopStateEvent("popstate", { state: { nbMode: "overview", nbParams: {} } }),
    );

    expect(router.getCurrentMode()).toBe("overview");
  });

  it("restores the popped entry's params, not just its mode", () => {
    window.dispatchEvent(
      new PopStateEvent("popstate", {
        state: { nbMode: "notebook", nbParams: { noteId: "n9", notebookId: "nb9" } },
      }),
    );

    expect(router.getCurrentNoteId()).toBe("n9");
    expect(router.getCurrentNotebookId()).toBe("nb9");
  });

  it("does not re-push while handling a pop (Back must keep unwinding)", () => {
    router.navigateTo("overview");
    router.navigateTo("notebook", { noteId: "n1" });
    const lengthAfterForwardNav = history.length;

    window.dispatchEvent(
      new PopStateEvent("popstate", { state: { nbMode: "overview", nbParams: {} } }),
    );

    // A pushState here would re-add the entry just popped, so the next Back
    // press would land on the same view forever instead of unwinding.
    expect(history.length).toBe(lengthAfterForwardNav);
  });

  it("ignores popstate entries that are not the router's", () => {
    router.navigateTo("notebook", { noteId: "n1" });
    window.dispatchEvent(new PopStateEvent("popstate", { state: { someHostPageState: 1 } }));
    expect(router.getCurrentMode()).toBe("notebook");
  });

  it("ignores a null popstate state (initial entry)", () => {
    router.navigateTo("notebook", { noteId: "n1" });
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    expect(router.getCurrentMode()).toBe("notebook");
  });

  it("handles each Back press once even after repeated initRouter calls", () => {
    // initRouter is called on every app init; the popstate listener is bound at
    // module scope precisely so extra calls cannot stack handlers that would
    // each drive their own navigation for a single Back press.
    router.initRouter();
    router.initRouter();
    router.navigateTo("notebook", { noteId: "n1" });

    const navigations = vi.fn();
    window.addEventListener("navigate", navigations);
    window.dispatchEvent(
      new PopStateEvent("popstate", { state: { nbMode: "overview", nbParams: {} } }),
    );
    window.removeEventListener("navigate", navigations);

    expect(navigations).toHaveBeenCalledTimes(1);
  });
});
