/**
 * src/modules/breadcrumb.test.js
 *
 * updateBreadcrumb awaits storage between clearing the trail and refilling it.
 * Two overlapping calls (two rapid navigations — e.g. a double-submitted create)
 * used to interleave their clear and append phases, rendering the trail twice:
 * home → notebook → note → notebook → note. That looks like nested notebooks,
 * which the data model does not allow, but it is really one container written by
 * two concurrent renders.
 *
 * The storage mock resolves on a gate the test controls, since the interleaving
 * only exists when a lookup is genuinely slower than the next navigation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getNote = vi.fn();
const getNotebook = vi.fn();

vi.mock("./storage.js", () => ({
  getNote: (...args) => getNote(...args),
  getNotebook: (...args) => getNotebook(...args),
}));

vi.mock("./router.js", () => ({
  navigateTo: vi.fn(),
}));

vi.mock("../i18n/index.js", () => ({
  t: (key) => key,
}));

vi.mock("../utils/icons.js", () => ({
  getIcon: () => "<svg></svg>",
}));

let breadcrumb;

const flush = () => new Promise((r) => setTimeout(r, 0));

function trail() {
  return Array.from(document.getElementById("breadcrumb").children)
    .filter((el) => !el.classList.contains("breadcrumb-separator"))
    .map((el) => el.textContent.trim() || "home");
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = '<nav id="breadcrumb"></nav>';
  breadcrumb = await import("./breadcrumb.js");
});

describe("updateBreadcrumb", () => {
  it("renders home → notebook → note for an open note", async () => {
    getNote.mockResolvedValue({ id: "n1", title: "My Note", notebookId: "nb1" });
    getNotebook.mockResolvedValue({ id: "nb1", title: "My Notebook" });

    await breadcrumb.updateBreadcrumb("notebook", "nb1", "n1");

    expect(trail()).toEqual(["home", "My Notebook", "My Note"]);
  });

  it("does not duplicate the trail when two renders overlap", async () => {
    // First render's note lookup is still pending when the second starts — the
    // exact ordering produced by two navigations in quick succession.
    let releaseFirst;
    getNote
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve({ id: "n1", title: "First", notebookId: "nb1" });
          }),
      )
      .mockResolvedValue({ id: "n2", title: "Second", notebookId: "nb1" });
    getNotebook.mockResolvedValue({ id: "nb1", title: "My Notebook" });

    const first = breadcrumb.updateBreadcrumb("notebook", "nb1", "n1");
    const second = breadcrumb.updateBreadcrumb("notebook", "nb1", "n2");

    releaseFirst();
    await Promise.all([first, second]);
    await flush();

    // The newest navigation wins, and it appears exactly once.
    expect(trail()).toEqual(["home", "My Notebook", "Second"]);
  });

  it("leaves the trail intact while a render is in flight", async () => {
    getNote.mockResolvedValue({ id: "n1", title: "My Note", notebookId: "nb1" });
    getNotebook.mockResolvedValue({ id: "nb1", title: "My Notebook" });
    await breadcrumb.updateBreadcrumb("notebook", "nb1", "n1");

    // A slow second render must not blank the visible trail while it works.
    getNote.mockImplementation(() => new Promise(() => {}));
    breadcrumb.updateBreadcrumb("notebook", "nb1", "n2");
    await flush();

    expect(trail()).toEqual(["home", "My Notebook", "My Note"]);
  });

  it("renders home alone at the root overview", async () => {
    await breadcrumb.updateBreadcrumb("overview", null, null);

    expect(trail()).toEqual(["home"]);
    expect(getNote).not.toHaveBeenCalled();
  });

  it("marks the notebook as current when no note is open", async () => {
    getNotebook.mockResolvedValue({ id: "nb1", title: "My Notebook" });

    await breadcrumb.updateBreadcrumb("overview", "nb1", null);

    expect(trail()).toEqual(["home", "My Notebook"]);
    expect(document.querySelector(".breadcrumb-current").textContent).toBe("My Notebook");
  });
});
