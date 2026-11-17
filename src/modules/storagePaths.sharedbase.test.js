/**
 * src/modules/storagePaths.sharedbase.test.js
 * A notebook shared with this user lives under a base the server chose. The base
 * registry redirects every path helper at once, leaves own notebooks byte-for-byte
 * as they were, and refuses to fall back to the own tree once a share has ended.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  clearSharedNotebookBases,
  davHrefToPath,
  getMediaPath,
  getNotebookFolder,
  getNotebookNotesFolder,
  getNotebookPath,
  getNotebookTombstonePath,
  getNoteMediaFolder,
  getNotePath,
  getSharedNotebookBase,
  isPathWithin,
  markShareEnded,
  parseNotebookRelativePath,
  parsePath,
  ROOT_FOLDER,
  setSharedNotebookBases,
  validateBasePath,
} from "./storagePaths.js";

const SHARED = "nb-shared";
const OWN = "nb-own";
const BASE = "/Shared_NoteBerg/alice_Recipes";

afterEach(() => clearSharedNotebookBases());

/** Every helper that takes a notebook id, applied to one (note, notebook, file) triple. */
function allPaths(notebookId) {
  return {
    folder: getNotebookFolder(notebookId),
    notebook: getNotebookPath(notebookId),
    notes: getNotebookNotesFolder(notebookId),
    note: getNotePath("n1", notebookId),
    mediaFolder: getNoteMediaFolder("n1", notebookId),
    media: getMediaPath("n1", notebookId, "f.png"),
    tombstone: getNotebookTombstonePath(notebookId),
  };
}

describe("unregistered notebooks", () => {
  it("resolve exactly as before, with or without other shares registered", () => {
    const expected = {
      folder: `${ROOT_FOLDER}/notebooks/${OWN}`,
      notebook: `${ROOT_FOLDER}/notebooks/${OWN}/_notebook.json`,
      notes: `${ROOT_FOLDER}/notebooks/${OWN}/notes`,
      note: `${ROOT_FOLDER}/notebooks/${OWN}/notes/n1.json`,
      mediaFolder: `${ROOT_FOLDER}/notebooks/${OWN}/notes/n1_media`,
      media: `${ROOT_FOLDER}/notebooks/${OWN}/notes/n1_media/f.png`,
      tombstone: `${ROOT_FOLDER}/notebooks/${OWN}/_tombstones.json`,
    };
    expect(allPaths(OWN)).toEqual(expected);

    setSharedNotebookBases(new Map([[SHARED, BASE]]));
    expect(allPaths(OWN)).toEqual(expected);
  });

  it("keep quick note paths out of the registry entirely", () => {
    setSharedNotebookBases(new Map([[SHARED, BASE]]));
    expect(getNotePath("q1", null)).toBe(`${ROOT_FOLDER}/quickNotes/q1.json`);
    expect(getNoteMediaFolder("q1", null)).toBe(`${ROOT_FOLDER}/quickNotes/q1_media`);
  });
});

describe("registered notebooks", () => {
  it("map every helper under the registered base", () => {
    setSharedNotebookBases(new Map([[SHARED, BASE]]));
    expect(allPaths(SHARED)).toEqual({
      folder: BASE,
      notebook: `${BASE}/_notebook.json`,
      notes: `${BASE}/notes`,
      note: `${BASE}/notes/n1.json`,
      mediaFolder: `${BASE}/notes/n1_media`,
      media: `${BASE}/notes/n1_media/f.png`,
      tombstone: `${BASE}/_tombstones.json`,
    });
    expect(getSharedNotebookBase(SHARED)).toBe(BASE);
    expect(getSharedNotebookBase(OWN)).toBeNull();
  });

  it("drop a trailing slash from the server's base", () => {
    setSharedNotebookBases(new Map([[SHARED, `${BASE}/`]]));
    expect(getNotebookFolder(SHARED)).toBe(BASE);
  });

  it("replace the whole registry on every call", () => {
    setSharedNotebookBases(new Map([[SHARED, BASE]]));
    setSharedNotebookBases(new Map([["nb-other", "/Shared_NoteBerg/bob_X"]]));
    expect(getNotebookFolder(SHARED)).toBe(`${ROOT_FOLDER}/notebooks/${SHARED}`);
    expect(getNotebookFolder("nb-other")).toBe("/Shared_NoteBerg/bob_X");
  });

  it("follow a moved mount when the base is re-registered", () => {
    setSharedNotebookBases(new Map([[SHARED, BASE]]));
    setSharedNotebookBases(new Map([[SHARED, "/Documents/Recipes"]]));
    expect(getNotePath("n1", SHARED)).toBe("/Documents/Recipes/notes/n1.json");
  });

  it("reject an invalid base without touching the existing registry", () => {
    setSharedNotebookBases(new Map([[SHARED, BASE]]));
    expect(() => setSharedNotebookBases(new Map([["nb-evil", "/a/../../etc"]]))).toThrow();
    expect(getNotebookFolder(SHARED)).toBe(BASE);
  });

  it("reject an unsafe notebook id", () => {
    expect(() => setSharedNotebookBases(new Map([["../x", BASE]]))).toThrow(/Invalid notebook id/);
  });
});

describe("ended shares", () => {
  it("throw from every helper instead of falling back to the own tree", () => {
    setSharedNotebookBases(new Map([[SHARED, BASE]]));
    markShareEnded(SHARED);

    expect(() => getNotebookFolder(SHARED)).toThrow(/ended/);
    expect(() => getNotePath("n1", SHARED)).toThrow(/ended/);
    expect(() => getMediaPath("n1", SHARED, "f.png")).toThrow(/ended/);
    expect(() => getNotebookTombstonePath(SHARED)).toThrow(/ended/);
    expect(getSharedNotebookBase(SHARED)).toBeNull();
  });

  it("do not affect other notebooks", () => {
    setSharedNotebookBases(new Map([[SHARED, BASE]]));
    markShareEnded(SHARED);
    expect(getNotebookFolder(OWN)).toBe(`${ROOT_FOLDER}/notebooks/${OWN}`);
  });

  it("stay ended across registry refreshes that no longer list the notebook", () => {
    setSharedNotebookBases(new Map([[SHARED, BASE]]));
    markShareEnded(SHARED);
    setSharedNotebookBases(new Map());
    expect(() => getNotebookFolder(SHARED)).toThrow(/ended/);
  });

  it("come back to life when the share is registered again", () => {
    setSharedNotebookBases(new Map([[SHARED, BASE]]));
    markShareEnded(SHARED);
    setSharedNotebookBases(new Map([[SHARED, "/Shared_NoteBerg/alice_Recipes2"]]));
    expect(getNotebookFolder(SHARED)).toBe("/Shared_NoteBerg/alice_Recipes2");
  });

  it("clearSharedNotebookBases forgets ended shares too", () => {
    markShareEnded(SHARED);
    clearSharedNotebookBases();
    expect(getNotebookFolder(SHARED)).toBe(`${ROOT_FOLDER}/notebooks/${SHARED}`);
  });
});

describe("validateBasePath", () => {
  it("accepts ordinary absolute paths, including spaces and unicode", () => {
    expect(validateBasePath("/Shared_NoteBerg/alice_Recipes")).toBe(
      "/Shared_NoteBerg/alice_Recipes",
    );
    expect(validateBasePath("/Shared/Küche & Haus (2)")).toBe("/Shared/Küche & Haus (2)");
    expect(validateBasePath("/a")).toBe("/a");
  });

  it.each([
    ["relative", "Shared/x"],
    ["root only", "/"],
    ["empty", ""],
    ["parent segment", "/a/../b"],
    ["current segment", "/a/./b"],
    ["empty segment", "/a//b"],
    ["backslash", "/a\\b"],
    ["control character", "/a/b\u0000c"],
    ["newline", "/a/b\nc"],
    ["too long", `/${"a".repeat(1100)}`],
    ["segment too long", `/${"a".repeat(300)}`],
    ["not a string", 42],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(() => validateBasePath(value)).toThrow(/Invalid shared notebook path/);
  });
});

describe("parseNotebookRelativePath", () => {
  it("recognises every file a notebook folder holds", () => {
    expect(parseNotebookRelativePath("_notebook.json", "nb")).toEqual({
      type: "notebook",
      notebookId: "nb",
    });
    expect(parseNotebookRelativePath("_tombstones.json", "nb")).toEqual({
      type: "tombstone",
      notebookId: "nb",
    });
    expect(parseNotebookRelativePath("notes/n1.json", "nb")).toEqual({
      type: "note",
      notebookId: "nb",
      noteId: "n1",
    });
    expect(parseNotebookRelativePath("notes/n1_media/f.png", "nb")).toEqual({
      type: "media",
      notebookId: "nb",
      noteId: "n1",
      filename: "f.png",
    });
  });

  it("returns unknown for anything else", () => {
    for (const rel of [
      "",
      "notes",
      "notes/n1.txt",
      "notes/n1_media",
      "other/x.json",
      "x/_notebook.json",
    ]) {
      expect(parseNotebookRelativePath(rel, "nb").type).toBe("unknown");
    }
  });

  it("round-trips every helper's output for registered and own notebooks", () => {
    setSharedNotebookBases(new Map([[SHARED, BASE]]));
    for (const id of [SHARED, OWN]) {
      const folder = getNotebookFolder(id);
      const rel = (p) => p.slice(folder.length + 1);
      expect(parseNotebookRelativePath(rel(getNotebookPath(id)), id).type).toBe("notebook");
      expect(parseNotebookRelativePath(rel(getNotebookTombstonePath(id)), id).type).toBe(
        "tombstone",
      );
      expect(parseNotebookRelativePath(rel(getNotePath("n1", id)), id)).toMatchObject({
        type: "note",
        noteId: "n1",
      });
      expect(parseNotebookRelativePath(rel(getMediaPath("n1", id, "f.png")), id)).toMatchObject({
        type: "media",
        noteId: "n1",
        filename: "f.png",
      });
    }
  });
});

describe("parsePath (own tree)", () => {
  it("delegates notebook paths and keeps its answers unchanged", () => {
    expect(parsePath(getNotebookPath(OWN))).toEqual({ type: "notebook", notebookId: OWN });
    expect(parsePath(getNotePath("n1", OWN))).toEqual({
      type: "note",
      notebookId: OWN,
      noteId: "n1",
    });
    expect(parsePath(getMediaPath("n1", OWN, "f.png"))).toEqual({
      type: "media",
      notebookId: OWN,
      noteId: "n1",
      filename: "f.png",
    });
    expect(parsePath(getNotebookTombstonePath(OWN))).toEqual({
      type: "tombstone",
      notebookId: OWN,
    });
    expect(parsePath(`${ROOT_FOLDER}/notebooks/_tombstones.json`)).toEqual({
      type: "tombstone",
      notebookId: "global_notebooks",
    });
    expect(parsePath(`${ROOT_FOLDER}/notebooks/${OWN}/junk.txt`).type).toBe("unknown");
  });
});

describe("DAV href handling", () => {
  it("strips the files prefix whatever the uid and web root", () => {
    expect(davHrefToPath("/remote.php/dav/files/alice/NoteBerg/notebooks/x/")).toBe(
      "/NoteBerg/notebooks/x/",
    );
    expect(davHrefToPath("/nextcloud/remote.php/dav/files/Alice/NoteBerg/a%20b.json")).toBe(
      "/NoteBerg/a b.json",
    );
    expect(davHrefToPath("/remote.php/dav/files/alice")).toBe("/");
  });

  it("reads a user whose uid is NoteBerg correctly", () => {
    const path = davHrefToPath(
      "/remote.php/dav/files/NoteBerg/NoteBerg/notebooks/nb/_notebook.json",
    );
    expect(path).toBe("/NoteBerg/notebooks/nb/_notebook.json");
    expect(parsePath(path)).toEqual({ type: "notebook", notebookId: "nb" });
  });

  it("does not confuse a sibling folder with the root", () => {
    expect(isPathWithin("/NoteBerg", ROOT_FOLDER)).toBe(true);
    expect(isPathWithin("/NoteBerg/notebooks", ROOT_FOLDER)).toBe(true);
    expect(isPathWithin("/Shared_NoteBerg/alice_x", ROOT_FOLDER)).toBe(false);
    expect(isPathWithin("/NoteBerg2/notebooks", ROOT_FOLDER)).toBe(false);
    expect(
      parsePath(
        davHrefToPath("/remote.php/dav/files/alice/Shared_NoteBerg/alice_x/_notebook.json"),
      ),
    ).toEqual({ type: "unknown" });
  });
});
