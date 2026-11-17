/**
 * src/modules/sharing/shareActions.nextcloud.test.js
 * On the Nextcloud app build nothing is kept locally, so there is nothing to
 * lose, dismiss or discard: only leaving does anything, through the registry.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const leave = vi.fn(async () => {});
vi.mock("../storage.js", () => ({ leaveSharedNotebook: (...args) => leave(...args) }));

const native = vi.hoisted(() => ({ loaded: false }));
vi.mock("./nativeSharing.js", () => {
  native.loaded = true;
  return {};
});

const notebook = { id: "nb1", origin: "shared" };

beforeEach(() => vi.clearAllMocks());

describe("on the Nextcloud app build", () => {
  it("has no unsynced changes to lose", async () => {
    const { hasUnsyncedChanges } = await import("./shareActions.js");
    expect(await hasUnsyncedChanges(notebook)).toBe(false);
  });

  it("leaves through the in-memory registry", async () => {
    const { leaveSharedNotebook } = await import("./shareActions.js");
    await leaveSharedNotebook(notebook);
    expect(leave).toHaveBeenCalledWith("nb1");
  });

  it("has nothing to dismiss or discard, and never touches the native store", async () => {
    const { dismissEndedShare, discardStrandedChanges } = await import("./shareActions.js");
    await dismissEndedShare(notebook);
    await discardStrandedChanges(notebook);
    expect(native.loaded).toBe(false);
  });
});
