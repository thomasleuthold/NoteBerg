/**
 * src/modules/appRating.test.js
 *
 * The "Rate this app" entry points at the Google Play page, so it must exist only
 * on the Android build; Windows has no Play Store, and a button there would do nothing.
 * Opening the page goes through the native plugin.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args) => invoke(...args) }));

import { isRatingSupported, openStoreListing } from "./appRating.js";

function setUserAgent(ua) {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
}

beforeEach(() => {
  invoke.mockReset();
});

describe("isRatingSupported", () => {
  it("is true on Android", () => {
    setUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36");
    expect(isRatingSupported()).toBe(true);
  });

  it("is false on Windows", () => {
    setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(isRatingSupported()).toBe(false);
  });
});

describe("openStoreListing", () => {
  it("asks the native plugin to open the store page", async () => {
    invoke.mockResolvedValue(undefined);
    await openStoreListing();
    expect(invoke).toHaveBeenCalledWith("open_store_listing");
  });
});
