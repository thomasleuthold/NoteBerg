/**
 * src/modules/ncFullscreen.nextcloud.test.js
 *
 * Exercises ncFullscreen.js under the Nextcloud build (IS_NEXTCLOUD = true).
 * The module is a no-op on every other platform, so its behaviour is only
 * reachable through vitest.config.nextcloud.js (`npm run test:nextcloud`),
 * which defines VITE_PLATFORM=nextcloud. See StrokeManager.nextcloud.test.js
 * for why this is a separate Vitest invocation rather than a project.
 *
 * These assert the feature's stated requirements rather than its
 * implementation:
 *   - the two halves (NC chrome / browser chrome) are independent, so a
 *     browser that refuses or lacks the Fullscreen API still gets the NC-chrome
 *     half instead of nothing;
 *   - Esc (a fullscreenchange the app did not initiate) must resync state, or
 *     the NC header stays hidden with no advertised way back;
 *   - state is never persisted anywhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BODY_CLASS = "noteberg-fullscreen";

/** Drives the fake Fullscreen API and lets tests simulate Esc. */
let fullscreenEl = null;

function setNativeFullscreen(el) {
  fullscreenEl = el;
  document.dispatchEvent(new Event("fullscreenchange"));
}

/**
 * Fresh module per test: the module holds listener/active state in closures,
 * so tests would otherwise leak into each other.
 */
async function loadModule() {
  vi.resetModules();
  return await import("./ncFullscreen.js");
}

beforeEach(() => {
  fullscreenEl = null;
  document.body.className = "";

  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenEl,
  });

  document.documentElement.requestFullscreen = vi.fn(function () {
    fullscreenEl = this;
    return Promise.resolve();
  });
  document.exitFullscreen = vi.fn(() => {
    fullscreenEl = null;
    return Promise.resolve();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.className = "";
});

describe("ncFullscreen (Nextcloud build)", () => {
  it("is available, so the editor offers the menu entry", async () => {
    const { isFullscreenAvailable } = await loadModule();
    expect(isFullscreenAvailable()).toBe(true);
  });

  it("hides Nextcloud chrome and requests browser fullscreen when entering", async () => {
    const { toggleFullscreen, isFullscreen } = await loadModule();

    await toggleFullscreen();

    expect(document.body.classList.contains(BODY_CLASS)).toBe(true);
    expect(document.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(isFullscreen()).toBe(true);
  });

  it("restores Nextcloud chrome and leaves browser fullscreen when exiting", async () => {
    const { toggleFullscreen, isFullscreen } = await loadModule();

    await toggleFullscreen();
    await toggleFullscreen();

    expect(document.body.classList.contains(BODY_CLASS)).toBe(false);
    expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(isFullscreen()).toBe(false);
  });

  it("still hides Nextcloud chrome when the Fullscreen API is unavailable", async () => {
    // iOS Safari: no requestFullscreen on non-video elements. The NC-chrome
    // half is independent and must still apply.
    document.documentElement.requestFullscreen = undefined;
    document.documentElement.webkitRequestFullscreen = undefined;

    const { toggleFullscreen, isFullscreen } = await loadModule();
    await toggleFullscreen();

    expect(document.body.classList.contains(BODY_CLASS)).toBe(true);
    expect(isFullscreen()).toBe(true);
  });

  it("still hides Nextcloud chrome when the browser refuses the request", async () => {
    document.documentElement.requestFullscreen = vi.fn(() =>
      Promise.reject(new Error("gesture required")),
    );

    const { toggleFullscreen, isFullscreen } = await loadModule();
    await toggleFullscreen();

    expect(document.body.classList.contains(BODY_CLASS)).toBe(true);
    expect(isFullscreen()).toBe(true);
  });

  it("restores Nextcloud chrome when the user presses Esc", async () => {
    const { toggleFullscreen, isFullscreen } = await loadModule();
    await toggleFullscreen();

    // Esc exits browser fullscreen without going through toggleFullscreen.
    setNativeFullscreen(null);

    expect(document.body.classList.contains(BODY_CLASS)).toBe(false);
    expect(isFullscreen()).toBe(false);
  });

  it("notifies subscribers on Esc so the exit button can hide itself", async () => {
    const { toggleFullscreen, onFullscreenChange } = await loadModule();
    const seen = [];
    onFullscreenChange((active) => seen.push(active));

    await toggleFullscreen();
    setNativeFullscreen(null);

    expect(seen).toEqual([true, false]);
  });

  it("stops notifying after unsubscribe", async () => {
    const { toggleFullscreen, onFullscreenChange } = await loadModule();
    const fn = vi.fn();
    const unsubscribe = onFullscreenChange(fn);

    unsubscribe();
    await toggleFullscreen();

    expect(fn).not.toHaveBeenCalled();
  });

  it("keeps notifying the remaining subscribers when one throws", async () => {
    const { toggleFullscreen, onFullscreenChange } = await loadModule();
    const good = vi.fn();
    onFullscreenChange(() => {
      throw new Error("boom");
    });
    onFullscreenChange(good);

    await expect(toggleFullscreen()).resolves.toBe(true);
    expect(good).toHaveBeenCalledWith(true);
  });

  it("honours an explicit target state and ignores redundant calls", async () => {
    const { toggleFullscreen } = await loadModule();

    await toggleFullscreen(true);
    await toggleFullscreen(true);

    expect(document.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("exitFullscreen is a no-op when not in fullscreen", async () => {
    const { exitFullscreen } = await loadModule();

    await exitFullscreen();

    expect(document.exitFullscreen).not.toHaveBeenCalled();
    expect(document.body.classList.contains(BODY_CLASS)).toBe(false);
  });

  it("exitFullscreen leaves fullscreen when active, so closing the note restores chrome", async () => {
    const { toggleFullscreen, exitFullscreen, isFullscreen } = await loadModule();
    await toggleFullscreen();

    await exitFullscreen();

    expect(document.body.classList.contains(BODY_CLASS)).toBe(false);
    expect(isFullscreen()).toBe(false);
  });

  it("does not persist state — a fresh load starts windowed", async () => {
    const { toggleFullscreen } = await loadModule();
    await toggleFullscreen();
    expect(document.body.classList.contains(BODY_CLASS)).toBe(true);

    // Simulate a page reload: new module instance, fresh document.
    document.body.className = "";
    fullscreenEl = null;
    const reloaded = await loadModule();

    expect(reloaded.isFullscreen()).toBe(false);
    expect(document.body.classList.contains(BODY_CLASS)).toBe(false);
  });

  it("writes nothing to localStorage or sessionStorage", async () => {
    const localSpy = vi.spyOn(Storage.prototype, "setItem");

    const { toggleFullscreen, exitFullscreen } = await loadModule();
    await toggleFullscreen();
    await exitFullscreen();

    expect(localSpy).not.toHaveBeenCalled();
  });
});
