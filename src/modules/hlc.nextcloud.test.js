/**
 * src/modules/hlc.nextcloud.test.js
 * On the Nextcloud app build every page load is its own writer (DESIGN §10.7 B):
 * two tabs of one user edit as two writers, so their edits are told apart.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  localStorage.clear();
});

describe("the app's clock (Nextcloud app)", () => {
  it("gets a new writer id on every page load, and stores none", async () => {
    vi.resetModules();
    const first = (await import("./hlc.js")).getClock().device;
    vi.resetModules();
    const second = (await import("./hlc.js")).getClock().device;
    expect(first).toMatch(/^[0-9a-z]+$/);
    expect(second).not.toBe(first);
    expect(localStorage.length).toBe(0);
  });
});
