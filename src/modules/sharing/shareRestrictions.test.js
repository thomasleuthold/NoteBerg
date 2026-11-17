/**
 * src/modules/sharing/shareRestrictions.test.js
 */

import { describe, expect, it } from "vitest";
import { assertEditable, assertManageable, ShareRestrictedError } from "./shareRestrictions.js";

const shared = (sharePermissions, extra = {}) => ({
  id: "nb",
  origin: "shared",
  sharePermissions,
  ...extra,
});

describe("assertManageable", () => {
  it("lets the owner (and quick notes) through", () => {
    expect(() => assertManageable({ id: "own" }, "deleteNote")).not.toThrow();
    expect(() => assertManageable(null, "deleteNote")).not.toThrow();
  });

  it.each([1, 7, 15, 31])("never lets a recipient through, whatever is granted (%i)", (bits) => {
    expect(() => assertManageable(shared(bits), "deleteNote")).toThrow(ShareRestrictedError);
  });

  it("names the action and the notebook", () => {
    const error = (() => {
      try {
        assertManageable(shared(31), "purgeNotebook");
      } catch (e) {
        return e;
      }
    })();
    expect(error).toMatchObject({
      name: "ShareRestrictedError",
      action: "purgeNotebook",
      notebookId: "nb",
    });
    expect(error.message).toContain("purgeNotebook");
  });
});

describe("assertEditable", () => {
  it("lets collaborators, owners and quick notes through", () => {
    expect(() => assertEditable(shared(7), "updateNote")).not.toThrow();
    expect(() => assertEditable({ id: "own" }, "updateNote")).not.toThrow();
    expect(() => assertEditable(null, "updateNote")).not.toThrow();
  });

  it.each([
    ["read-only", shared(1)],
    ["update without create", shared(3)],
    ["ended", shared(7, { shareEnded: true })],
    ["unknown permissions", shared(undefined)],
  ])("refuses a %s share", (_label, notebook) => {
    expect(() => assertEditable(notebook, "updateNote")).toThrow(ShareRestrictedError);
  });
});
