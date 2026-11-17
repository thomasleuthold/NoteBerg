/**
 * src/modules/liveSyncPlan.test.js
 * The open note's own sync (review P4, 4.3) must do what the full sync does for
 * one note, and leave to the full sync everything it does not handle.
 */

import { describe, expect, it } from "vitest";
import { planLiveSync } from "./liveSyncPlan.js";

const synced = (overrides = {}) => ({
  id: "n1",
  notebookId: "nb1",
  content: "<p>a</p>",
  strokes: [{ id: "s1", x: [1], y: [1], v: "000000001-000-a" }],
  deletedStrokes: [],
  media: [],
  recordings: [],
  modified: 1000,
  version: 1,
  synced: true,
  lastSyncedEtag: "e1",
  ...overrides,
});
const plan = (input) =>
  planLiveSync({
    encrypted: false,
    remoteText: null,
    remoteEtag: "e1",
    base: "<p>a</p>",
    uid: "bob",
    mediaOnServer: [],
    hasFile: () => true,
    ...input,
  });

describe("the open note's own sync", () => {
  it("uploads this device's changes against the etag it last synced", async () => {
    const local = synced({ synced: false, modified: 2000, content: "<p>b</p>" });
    const p = await plan({ local });
    expect(p).toMatchObject({ action: "upload", next: null, ifMatch: "e1", modified: 2000 });
    expect(p.upload.content).toBe("<p>b</p>");
  });

  it("takes the server's version as a download when only it changed", async () => {
    const remote = synced({ content: "<p>theirs</p>", modified: 3000 });
    delete remote.synced;
    delete remote.lastSyncedEtag;
    const p = await plan({ local: synced(), remoteText: JSON.stringify(remote), remoteEtag: "e2" });
    expect(p.action).toBe("downloaded");
    expect(p.upload).toBeNull();
    expect(p.next).toMatchObject({ content: "<p>theirs</p>", synced: true, lastSyncedEtag: "e2" });
    expect(p.baseContent).toBe("<p>theirs</p>");
  });

  it("merges both sides' changes and uploads the merge against the server's etag", async () => {
    const local = synced({
      synced: false,
      modified: 2000,
      strokes: [...synced().strokes, { id: "mine", x: [1], y: [5], v: "000000003-000-a" }],
    });
    const remote = synced({
      strokes: [...synced().strokes, { id: "theirs", x: [1], y: [9], v: "000000004-000-b" }],
    });
    const p = await plan({ local, remoteText: JSON.stringify(remote), remoteEtag: "e2" });
    expect(p.action).toBe("upload");
    expect(p.ifMatch).toBe("e2");
    expect(p.upload.strokes.map((s) => s.id).sort()).toEqual(["mine", "s1", "theirs"]);
    // Until the merge is uploaded, the server's text is the baseline
    expect(p.baseContent).toBe("<p>a</p>");
  });

  it("does nothing when nothing changed", async () => {
    await expect(plan({ local: synced() })).resolves.toEqual({ action: "none" });
  });

  describe("leaves to the full sync", () => {
    it.each([
      ["an encrypted note", { encrypted: true }],
      ["a moved note", { local: synced({ synced: false, previousNotebookId: "nb0" }) }],
      ["a restored note", { local: synced({ synced: false, restoredAt: 5 }) }],
      ["a note never uploaded", { local: synced({ synced: false, lastSyncedEtag: null }) }],
      ["a server copy it cannot read", { remoteText: "{not json", remoteEtag: "e2" }],
      [
        "another note's file",
        { remoteText: JSON.stringify(synced({ id: "n2" })), remoteEtag: "e2" },
      ],
      [
        "media this device has not uploaded",
        { local: synced({ synced: false, media: [{ id: "m", fileId: "f1" }] }), mediaOnServer: [] },
      ],
      [
        "media this device has not downloaded",
        {
          remoteText: JSON.stringify(synced({ media: [{ id: "m", fileId: "f9" }] })),
          remoteEtag: "e2",
          hasFile: () => false,
        },
      ],
    ])("%s", async (_label, input) => {
      const p = await plan({ local: synced(), ...input });
      expect(p.action).toBe("full");
    });
  });

  describe("the server's media folder", () => {
    it("is not needed for a note without files", async () => {
      const local = synced({ synced: false, modified: 2000 });
      expect(await plan({ local, mediaOnServer: null })).toMatchObject({ action: "upload" });
    });

    it("is asked for when the note refers to files, not guessed", async () => {
      const local = synced({ synced: false, media: [{ id: "m", fileId: "f1" }] });
      expect(await plan({ local, mediaOnServer: null })).toEqual({ action: "need-media" });
      expect(await plan({ local, mediaOnServer: ["f1"] })).toMatchObject({ action: "upload" });
    });
  });
});
