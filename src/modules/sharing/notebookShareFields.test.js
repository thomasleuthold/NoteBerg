/**
 * src/modules/sharing/notebookShareFields.test.js
 * The sharing fields describe this user's relationship to a notebook, so they
 * must never be uploaded, adopted from the server, or backed up.
 */

import { describe, expect, it } from "vitest";
import {
  adoptRemoteNotebook,
  NOTEBOOK_LOCAL_FIELDS,
  stripLocalFields,
} from "./notebookShareFields.js";

const shared = {
  id: "nb1",
  title: "Recipes",
  origin: "shared",
  remoteBasePath: "/Shared_NoteBerg/alice_Recipes",
  ownerUid: "alice",
  ownerDisplayName: "Alice",
  sharePermissions: 7,
  shareId: "42",
  normalized: true,
  shareEnded: false,
  strandedNoteIds: ["n1"],
};

describe("stripLocalFields", () => {
  it("removes every local-only field and keeps the notebook's own data", () => {
    const stripped = stripLocalFields(shared);
    for (const field of NOTEBOOK_LOCAL_FIELDS) expect(stripped).not.toHaveProperty(field);
    expect(stripped).toEqual({ id: "nb1", title: "Recipes" });
  });

  it("does not mutate its input", () => {
    stripLocalFields(shared);
    expect(shared.origin).toBe("shared");
  });

  it("covers the ten documented fields", () => {
    expect([...NOTEBOOK_LOCAL_FIELDS].sort()).toEqual(
      [
        "normalized",
        "origin",
        "ownerDisplayName",
        "ownerUid",
        "remoteBasePath",
        "shareEnded",
        "shareId",
        "shareIds",
        "sharePermissions",
        "strandedNoteIds",
      ].sort(),
    );
  });
});

describe("adoptRemoteNotebook", () => {
  it("takes content from the server and local-only fields from the local record", () => {
    const remote = { id: "nb1", title: "Renamed by owner", color: "#fff", modified: 5 };
    const adopted = adoptRemoteNotebook(remote, shared);
    expect(adopted).toMatchObject({ title: "Renamed by owner", origin: "shared", shareId: "42" });
    expect(adopted.sharePermissions).toBe(7);
  });

  it("ignores local-only fields a remote file claims to carry", () => {
    const remote = {
      id: "nb1",
      title: "Hijack",
      origin: "shared",
      sharePermissions: 31,
      ownerUid: "mallory",
    };
    const adopted = adoptRemoteNotebook(remote, { id: "nb1", title: "Mine" });
    expect(adopted).toEqual({ id: "nb1", title: "Hijack" });
  });

  it("does not turn an own notebook into a shared one", () => {
    const own = { id: "nb1", title: "Mine", synced: true };
    const adopted = adoptRemoteNotebook({ id: "nb1", title: "x", origin: "shared" }, own);
    expect(adopted.origin).toBeUndefined();
  });

  it("strips the fields when there is no local record (first download)", () => {
    expect(adoptRemoteNotebook({ id: "nb2", origin: "shared", shareId: "9" }, undefined)).toEqual({
      id: "nb2",
    });
  });
});
