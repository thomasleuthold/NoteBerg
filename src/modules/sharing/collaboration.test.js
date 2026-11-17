/**
 * src/modules/sharing/collaboration.test.js
 * A note is collaborative when more than one person edits it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCollaborativeNote } from "./collaboration.js";
import { recordOwnerShares, resetOwnerShares } from "./ownerShares.js";

const notebooks = new Map();
vi.mock("../storage.js", () => ({ getNotebook: vi.fn(async (id) => notebooks.get(id) ?? null) }));
vi.mock("./config.js", () => ({ SHARING_ENABLED: true }));
vi.mock("./nextcloudShares.js", () => ({ listSharesInFolder: vi.fn(async () => []) }));

beforeEach(() => {
  notebooks.clear();
  resetOwnerShares();
});

describe("isCollaborativeNote", () => {
  it("is true for a note in a notebook shared with the user", async () => {
    notebooks.set("nb", { id: "nb", origin: "shared", sharePermissions: 1 });
    expect(await isCollaborativeNote({ notebookId: "nb" })).toBe(true);
  });

  it("is true for a note in an own notebook that has recipients", async () => {
    notebooks.set("nb", { id: "nb" });
    recordOwnerShares("nb", [{ id: "1", permissions: 7 }]);
    expect(await isCollaborativeNote({ notebookId: "nb" })).toBe(true);
  });

  it("is false for an own notebook nobody shares, and once the last share is gone", async () => {
    notebooks.set("nb", { id: "nb" });
    expect(await isCollaborativeNote({ notebookId: "nb" })).toBe(false);

    recordOwnerShares("nb", [{ id: "1", permissions: 7 }]);
    recordOwnerShares("nb", []);
    expect(await isCollaborativeNote({ notebookId: "nb" })).toBe(false);
  });

  it("is false for quick notes and missing notes", async () => {
    expect(await isCollaborativeNote({ notebookId: null })).toBe(false);
    expect(await isCollaborativeNote(null)).toBe(false);
    expect(await isCollaborativeNote({ notebookId: "unknown" })).toBe(false);
  });
});
