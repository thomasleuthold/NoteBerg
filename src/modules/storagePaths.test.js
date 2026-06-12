/**
 * src/modules/storagePaths.test.js
 * Path-builder validation: ids and filenames parsed from synced JSON are
 * untrusted and must not be able to steer WebDAV writes/deletes outside the
 * NoteBerg folder (e.g. id = "../../Photos").
 */

import { describe, expect, it } from "vitest";
import {
  getMediaPath,
  getNotebookFolder,
  getNotebookPath,
  getNoteMediaFolder,
  getNotePath,
  parsePath,
} from "./storagePaths.js";

const UUID = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";

describe("storagePaths id validation", () => {
  it("builds paths for normal ids", () => {
    expect(getNotePath(UUID, "nb-1")).toBe(`/NoteBerg/notebooks/nb-1/notes/${UUID}.json`);
    expect(getNotePath(UUID, null)).toBe(`/NoteBerg/quickNotes/${UUID}.json`);
    expect(getNotebookPath("nb_1")).toBe("/NoteBerg/notebooks/nb_1/_notebook.json");
    expect(getMediaPath(UUID, "nb-1", `${UUID}.png`)).toBe(
      `/NoteBerg/notebooks/nb-1/notes/${UUID}_media/${UUID}.png`,
    );
  });

  it.each([
    ["../../Photos", null],
    ["..", null],
    ["a/b", null],
    ["a\\b", null],
    ["", null],
    [null, null],
    [UUID, "../escape"], // traversal via notebookId
  ])("rejects unsafe note path components (noteId=%j, notebookId=%j)", (noteId, notebookId) => {
    expect(() => getNotePath(noteId, notebookId)).toThrow(/Invalid/);
  });

  it("rejects unsafe notebook ids", () => {
    expect(() => getNotebookFolder("../..")).toThrow(/Invalid notebook id/);
    expect(() => getNoteMediaFolder("note-1", "x/y")).toThrow(/Invalid notebook id/);
  });

  it("rejects unsafe media filenames but allows dots in extensions", () => {
    expect(() => getMediaPath(UUID, null, "../../evil.bin")).toThrow(/Invalid filename/);
    expect(() => getMediaPath(UUID, null, "a/b.png")).toThrow(/Invalid filename/);
    expect(getMediaPath(UUID, null, "file.tar.gz")).toContain("file.tar.gz");
  });

  it("parsePath still handles regular paths", () => {
    expect(parsePath(`/NoteBerg/notebooks/nb-1/notes/${UUID}.json`)).toEqual({
      type: "note",
      notebookId: "nb-1",
      noteId: UUID,
    });
  });
});
