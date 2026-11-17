/**
 * src/modules/sharing/shareActions.test.js
 * The same entry points on both builds: the native build delegates to its
 * notebook-record store, the Nextcloud build to the in-memory registry.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const native = {
  hasUnsyncedChangesInSharedNotebook: vi.fn(async () => true),
  leaveSharedNotebook: vi.fn(async () => {}),
  dismissEndedSharedNotebook: vi.fn(async () => {}),
  discardStrandedChanges: vi.fn(async () => {}),
  runDiscovery: vi.fn(async () => ({ ok: true })),
};
vi.mock("./nativeSharing.js", () => native);

const order = [];
const ocs = {
  acceptPendingShare: vi.fn(async () => void order.push("accept")),
  rejectPendingShare: vi.fn(async () => void order.push("reject")),
};
vi.mock("./nextcloudShares.js", () => ocs);
const performSync = vi.fn(async () => void order.push("sync"));
vi.mock("../sync.js", () => ({ performSync: (...args) => performSync(...args) }));
native.runDiscovery.mockImplementation(async () => {
  order.push("discover");
  return { ok: true };
});

const notebook = { id: "nb1", origin: "shared" };

beforeEach(async () => {
  vi.clearAllMocks();
  order.length = 0;
  const { resetInvitations } = await import("./invitations.js");
  resetInvitations();
});

const invitation = { shareId: "41", ownerUid: "alice", ownerDisplayName: "Alice" };

async function offer() {
  const { setInvitations } = await import("./invitations.js");
  setInvitations([
    { id: "41", ownerUid: "alice", fileTarget: "/3f2c9a1e-8b4d-4c2a-9f1e-7a6b5c4d3e2f" },
  ]);
}

describe("on the native build", () => {
  it("asks the notebook store whether anything would be lost", async () => {
    const { hasUnsyncedChanges } = await import("./shareActions.js");
    expect(await hasUnsyncedChanges(notebook)).toBe(true);
    expect(native.hasUnsyncedChangesInSharedNotebook).toHaveBeenCalledWith(notebook);
  });

  it("leaves, dismisses and discards through the native store", async () => {
    const actions = await import("./shareActions.js");

    await actions.leaveSharedNotebook(notebook);
    await actions.dismissEndedShare(notebook);
    await actions.discardStrandedChanges(notebook);

    expect(native.leaveSharedNotebook).toHaveBeenCalledWith(notebook);
    expect(native.dismissEndedSharedNotebook).toHaveBeenCalledWith(notebook);
    expect(native.discardStrandedChanges).toHaveBeenCalledWith(notebook);
  });
});

describe("an invitation to a shared notebook, on the native build", () => {
  it("is accepted on the server, then registered, then its notes fetched", async () => {
    await offer();
    const { acceptInvitation } = await import("./shareActions.js");
    const { getInvitations } = await import("./invitations.js");

    await acceptInvitation(invitation);

    expect(ocs.acceptPendingShare).toHaveBeenCalledWith("41");
    expect(order).toEqual(["accept", "discover", "sync"]);
    expect(getInvitations()).toEqual([]);
  });

  it("is declined on the server and no longer offered", async () => {
    await offer();
    const { declineInvitation } = await import("./shareActions.js");
    const { getInvitations } = await import("./invitations.js");

    await declineInvitation(invitation);

    expect(ocs.rejectPendingShare).toHaveBeenCalledWith("41");
    expect(getInvitations()).toEqual([]);
  });

  it("stays offered when the server refuses the answer", async () => {
    await offer();
    ocs.acceptPendingShare.mockRejectedValueOnce(new Error("503"));
    const { acceptInvitation } = await import("./shareActions.js");
    const { getInvitations } = await import("./invitations.js");

    await expect(acceptInvitation(invitation)).rejects.toThrow("503");

    expect(getInvitations()).toHaveLength(1);
    expect(native.runDiscovery).not.toHaveBeenCalled();
  });
});
