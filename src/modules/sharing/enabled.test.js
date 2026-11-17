// src/modules/sharing/enabled.test.js
// Sharing is a preview: off until the user turns it on, on the native clients
// and in the Nextcloud app alike, and always off when the build does not
// release it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function load({ released = true, platform = "tauri" } = {}) {
  vi.resetModules();
  vi.stubEnv("VITE_PLATFORM", platform);
  vi.doMock("./config.js", () => ({ SHARING_ENABLED: released }));
  return import("./enabled.js");
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("./config.js");
});

describe("on the native clients", () => {
  it("is off until the user turns it on", async () => {
    const sharing = await load();
    expect(sharing.isSharingEnabled()).toBe(false);

    sharing.setSharingEnabled(true);
    expect(sharing.isSharingEnabled()).toBe(true);

    sharing.setSharingEnabled(false);
    expect(sharing.isSharingEnabled()).toBe(false);
  });

  it("remembers the choice for this device", async () => {
    (await load()).setSharingEnabled(true);
    expect((await load()).isSharingEnabled()).toBe(true);
  });

  it("tells the app when the choice changes", async () => {
    const sharing = await load();
    const heard = vi.fn();
    window.addEventListener(sharing.SHARING_PREF_EVENT, heard);

    sharing.setSharingEnabled(true);
    window.removeEventListener(sharing.SHARING_PREF_EVENT, heard);

    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0][0].detail).toEqual({ enabled: true });
  });

  it("stays off when the build does not release sharing, whatever was chosen", async () => {
    localStorage.setItem("sharing_enabled", "true");
    const sharing = await load({ released: false });
    expect(sharing.isSharingEnabled()).toBe(false);
  });

  it("treats anything but an explicit yes as no", async () => {
    const sharing = await load();
    for (const value of ["false", "", "1", "yes", "null"]) {
      localStorage.setItem("sharing_enabled", value);
      expect(sharing.isSharingEnabled()).toBe(false);
    }
  });

  it("is off, not an error, when the browser storage cannot be read", async () => {
    const sharing = await load();
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      expect(sharing.isSharingEnabled()).toBe(false);
      expect(sharing.isForeignGuardActive()).toBe(false);
    } finally {
      get.mockRestore();
    }
  });
});

describe("in the Nextcloud app", () => {
  it("is off until the user turns it on, like on the native clients", async () => {
    const sharing = await load({ platform: "nextcloud" });
    expect(sharing.isSharingEnabled()).toBe(false);

    sharing.setSharingEnabled(true);
    expect(sharing.isSharingEnabled()).toBe(true);
  });

  it("is off when not released, whatever was chosen", async () => {
    localStorage.setItem("sharing_enabled", "true");
    expect((await load({ platform: "nextcloud", released: false })).isSharingEnabled()).toBe(false);
  });
});

// The guard that keeps other people's data out of the own tree. A share accepted
// into /NoteBerg stays mounted there after sharing is switched off, so the guard
// must outlive the switch; before sharing was ever used it is not needed, and the
// requests stay as they were before sharing existed.
describe("the guard against foreign items in the own tree", () => {
  it("is not active while sharing was never used", async () => {
    expect((await load()).isForeignGuardActive()).toBe(false);
  });

  it("is active while sharing is on", async () => {
    const sharing = await load();
    sharing.setSharingEnabled(true);
    expect(sharing.isForeignGuardActive()).toBe(true);
  });

  it("stays active after sharing is switched off again", async () => {
    const sharing = await load();
    sharing.setSharingEnabled(true);
    sharing.setSharingEnabled(false);
    expect(sharing.isSharingEnabled()).toBe(false);
    expect(sharing.isForeignGuardActive()).toBe(true);
  });

  it("is never active when the build does not release sharing", async () => {
    localStorage.setItem("sharing_ever_enabled", "true");
    expect((await load({ released: false })).isForeignGuardActive()).toBe(false);
  });
});
