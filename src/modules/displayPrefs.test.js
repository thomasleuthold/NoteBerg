/**
 * src/modules/displayPrefs.test.js
 *
 * displayPrefs is a thin persistence layer over localStorage. The design
 * requirements it must satisfy:
 *  - card size persists per-device (localStorage, not the settings store) so it
 *    works identically on native + NC builds — the NC build's setSetting is
 *    in-memory only and silently loses the value on reload;
 *  - an unset or corrupt stored value falls back to the default rather than
 *    producing an invalid `card-size-*` CSS class;
 *  - the one-time migration carries an existing native (IndexedDB) choice over,
 *    but must never overwrite a choice already made against localStorage.
 *
 * jsdom provides a real localStorage, so no mock is needed — asserting against
 * actual stored keys also pins the exact key name overviewMode relies on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAvailableCardSizes,
  getCardSize,
  migrateCardSizeFromSettings,
  setCardSize,
} from "./displayPrefs.js";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("getCardSize / setCardSize", () => {
  it("defaults to medium when nothing is stored", () => {
    expect(getCardSize()).toBe("medium");
  });

  it("round-trips each valid size", () => {
    for (const size of getAvailableCardSizes()) {
      setCardSize(size);
      expect(getCardSize()).toBe(size);
    }
  });

  it("persists to localStorage under the key overviewMode reads", () => {
    setCardSize("large");
    expect(localStorage.getItem("card_size")).toBe("large");
  });

  it("falls back to the default for a corrupt stored value", () => {
    // A stale/hand-edited value must not become a `card-size-bogus` CSS class.
    localStorage.setItem("card_size", "bogus");
    expect(getCardSize()).toBe("medium");
  });

  it("rejects an invalid size rather than storing it", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setCardSize("gigantic");
    expect(getCardSize()).toBe("medium");
  });
});

describe("migrateCardSizeFromSettings", () => {
  it("carries an existing native value over on first run", async () => {
    const getSetting = vi.fn().mockResolvedValue("small");
    await migrateCardSizeFromSettings(getSetting);

    expect(getSetting).toHaveBeenCalledWith("card_size");
    expect(getCardSize()).toBe("small");
  });

  it("does not overwrite a choice already made post-upgrade", async () => {
    setCardSize("large");
    const getSetting = vi.fn().mockResolvedValue("small");

    await migrateCardSizeFromSettings(getSetting);

    expect(getCardSize()).toBe("large");
    // Must not even consult the legacy store once localStorage is authoritative.
    expect(getSetting).not.toHaveBeenCalled();
  });

  it("leaves the default in place when there is nothing to migrate", async () => {
    // The NC build's in-memory getSetting always returns null on a fresh load —
    // precisely the case this move exists to fix.
    const getSetting = vi.fn().mockResolvedValue(null);
    await migrateCardSizeFromSettings(getSetting);

    expect(getCardSize()).toBe("medium");
    expect(localStorage.getItem("card_size")).toBeNull();
  });

  it("ignores a corrupt legacy value", async () => {
    const getSetting = vi.fn().mockResolvedValue("enormous");
    await migrateCardSizeFromSettings(getSetting);

    expect(getCardSize()).toBe("medium");
  });

  it("survives a failing settings store without blocking startup", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const getSetting = vi.fn().mockRejectedValue(new Error("IndexedDB unavailable"));

    await expect(migrateCardSizeFromSettings(getSetting)).resolves.toBeUndefined();
    expect(getCardSize()).toBe("medium");
  });
});
