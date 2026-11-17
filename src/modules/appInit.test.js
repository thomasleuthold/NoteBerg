/**
 * src/modules/appInit.test.js
 * Startup points the path helpers at shared notebooks' mounts before anything
 * (a poll, a late write) can resolve them into the own tree.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSharedNotebookBases, getNotebookFolder } from "./storagePaths.js";

vi.mock("./masterPassword.js", () => ({
  autoUnlockFromKeyring: vi.fn(),
  isAppUnlocked: vi.fn(() => false),
  isMasterPasswordSet: vi.fn(async () => false),
}));

const notebooks = [];
vi.mock("./storage.js", () => ({
  fixCorruptedNotes: vi.fn(async () => ({ fixed: 0 })),
  getSetting: vi.fn(async () => false),
  getAllNotebooksForSync: vi.fn(async () => notebooks),
}));

import { initializeApp } from "./appInit.js";

beforeEach(() => {
  notebooks.length = 0;
  clearSharedNotebookBases();
});

afterEach(() => clearSharedNotebookBases());

describe("initializeApp", () => {
  it("registers where shared notebooks live, and makes unusable ones unresolvable", async () => {
    notebooks.push(
      { id: "own" },
      { id: "shared", origin: "shared", remoteBasePath: "/Shared_NoteBerg/alice_X" },
      { id: "ended", origin: "shared", shareEnded: true, remoteBasePath: "/Shared_NoteBerg/b" },
    );

    expect(await initializeApp()).toBe(true);

    expect(getNotebookFolder("shared")).toBe("/Shared_NoteBerg/alice_X");
    expect(() => getNotebookFolder("ended")).toThrow(/ended/);
    expect(getNotebookFolder("own")).toBe("/NoteBerg/notebooks/own");
  });

  it("leaves everything as it was when there are no shares", async () => {
    notebooks.push({ id: "own" });
    await initializeApp();
    expect(getNotebookFolder("own")).toBe("/NoteBerg/notebooks/own");
  });
});
