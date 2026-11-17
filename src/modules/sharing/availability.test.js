// src/modules/sharing/availability.test.js
// Whether the sharing UI is offered: sharing switched on, and a Nextcloud account.

import { beforeEach, describe, expect, it, vi } from "vitest";

const isAuthenticated = vi.fn();
vi.mock("../nextcloudSync.js", () => ({ isAuthenticated: () => isAuthenticated() }));
vi.mock("./config.js", () => ({ SHARING_ENABLED: true }));

let isSharingAvailable;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("VITE_PLATFORM", "tauri");
  localStorage.clear();
  isAuthenticated.mockResolvedValue(true);
  ({ isSharingAvailable } = await import("./availability.js"));
});

describe("isSharingAvailable", () => {
  it("is false while sharing is switched off, even when connected", async () => {
    expect(await isSharingAvailable()).toBe(false);
    expect(isAuthenticated).not.toHaveBeenCalled();
  });

  it("is true when sharing is on and the app is connected", async () => {
    localStorage.setItem("sharing_enabled", "true");
    expect(await isSharingAvailable()).toBe(true);
  });

  it("is false when sharing is on but there is no Nextcloud account", async () => {
    localStorage.setItem("sharing_enabled", "true");
    isAuthenticated.mockResolvedValue(false);
    expect(await isSharingAvailable()).toBe(false);
  });
});
