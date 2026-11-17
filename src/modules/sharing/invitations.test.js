/**
 * src/modules/sharing/invitations.test.js
 * Pending notebook shares the user is asked about. A pending share's contents
 * cannot be read before accepting, so only its folder name tells a notebook
 * (always named by its id) from an ordinary folder, which is left to Nextcloud.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dropInvitation,
  getInvitations,
  looksLikeNotebookShare,
  resetInvitations,
  setInvitations,
} from "./invitations.js";

const ID = "3f2c9a1e-8b4d-4c2a-9f1e-7a6b5c4d3e2f";
const pending = (overrides = {}) => ({
  id: "41",
  ownerUid: "alice",
  ownerDisplayName: "Alice Anderson",
  fileTarget: `/${ID}`,
  ...overrides,
});

let changes;
beforeEach(() => {
  resetInvitations();
  changes = vi.fn();
  window.addEventListener("datachange", changes);
  return () => window.removeEventListener("datachange", changes);
});

describe("looksLikeNotebookShare", () => {
  it("recognises a folder named by a notebook id", () => {
    expect(looksLikeNotebookShare(pending())).toBe(true);
    expect(looksLikeNotebookShare(pending({ fileTarget: `/Shared/${ID.toUpperCase()}/` }))).toBe(
      true,
    );
  });

  it("recognises it when Nextcloud added a number because the name was taken", () => {
    expect(looksLikeNotebookShare(pending({ fileTarget: `/${ID} (2)` }))).toBe(true);
  });

  it("leaves ordinary folders alone", () => {
    for (const fileTarget of ["/Photos", "/Holiday 2026", "/abc-def", `/${ID}x`, ""]) {
      expect(looksLikeNotebookShare(pending({ fileTarget }))).toBe(false);
    }
  });
});

describe("the invitations", () => {
  it("are the pending notebook shares, with who offers them", () => {
    setInvitations([pending(), pending({ id: "42", fileTarget: "/Photos" })]);
    expect(getInvitations()).toEqual([
      { shareId: "41", ownerUid: "alice", ownerDisplayName: "Alice Anderson" },
    ]);
  });

  it("tell the overview when they change, and only then", () => {
    setInvitations([pending()]);
    setInvitations([pending()]);
    expect(changes).toHaveBeenCalledTimes(1);

    setInvitations([]);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it("lose one that was answered", () => {
    setInvitations([pending(), pending({ id: "43" })]);
    changes.mockClear();

    dropInvitation("41");

    expect(getInvitations().map((i) => i.shareId)).toEqual(["43"]);
    expect(changes).toHaveBeenCalledTimes(1);
    dropInvitation("41"); // already gone: nothing to announce
    expect(changes).toHaveBeenCalledTimes(1);
  });
});
