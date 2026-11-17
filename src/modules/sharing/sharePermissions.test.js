/**
 * src/modules/sharing/sharePermissions.test.js
 * Every gate is a pure function of the granted permission bits.
 */

import { describe, expect, it } from "vitest";
import {
  canEdit,
  canManage,
  isShared,
  isShareEnded,
  PERMISSION,
  SHARE_MODE_PERMISSIONS,
} from "./sharePermissions.js";

const shared = (sharePermissions, extra = {}) => ({
  id: "nb",
  origin: "shared",
  sharePermissions,
  ...extra,
});

describe("share modes", () => {
  it("request READ for read-only and READ+UPDATE+CREATE for collab, never DELETE or SHARE", () => {
    expect(SHARE_MODE_PERMISSIONS.readonly).toBe(1);
    expect(SHARE_MODE_PERMISSIONS.collab).toBe(7);
    expect(SHARE_MODE_PERMISSIONS.collab & (PERMISSION.DELETE | PERMISSION.SHARE)).toBe(0);
  });
});

describe("canEdit", () => {
  it.each([
    [1, false],
    [3, false], // UPDATE without CREATE: adding media would fail
    [5, false], // CREATE without UPDATE: existing files cannot be overwritten
    [7, true],
    [15, true],
    [31, true],
  ])("for granted permissions %i is %s", (granted, expected) => {
    expect(canEdit(shared(granted))).toBe(expected);
  });

  it("is false once the share ended, whatever was granted", () => {
    expect(canEdit(shared(7, { shareEnded: true }))).toBe(false);
  });

  it("is false while the granted permissions are unknown", () => {
    expect(canEdit(shared(undefined))).toBe(false);
    expect(canEdit(shared(null))).toBe(false);
    expect(canEdit(shared("7"))).toBe(false);
  });

  it("is always true for own notebooks and quick notes", () => {
    expect(canEdit({ id: "own" })).toBe(true);
    expect(canEdit({ id: "own", origin: "own", sharePermissions: 1 })).toBe(true);
    expect(canEdit(null)).toBe(true);
    expect(canEdit(undefined)).toBe(true);
  });
});

describe("canManage", () => {
  it("is true only for notebooks the user owns", () => {
    expect(canManage({ id: "own" })).toBe(true);
    expect(canManage(null)).toBe(true);
    expect(canManage(shared(31))).toBe(false);
    expect(canManage(shared(7))).toBe(false);
  });
});

describe("isShared / isShareEnded", () => {
  it("tell shared from own and live from ended", () => {
    expect(isShared(shared(7))).toBe(true);
    expect(isShared({ id: "own" })).toBe(false);
    expect(isShared(null)).toBe(false);
    expect(isShareEnded(shared(7, { shareEnded: true }))).toBe(true);
    expect(isShareEnded(shared(7))).toBe(false);
    expect(isShareEnded({ id: "own", shareEnded: true })).toBe(false);
  });
});
