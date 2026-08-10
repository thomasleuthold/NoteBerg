/**
 * src/components/masterPasswordModals.test.js
 *
 * showConfirmDialog awaits onConfirm before closing, so without a guard the
 * button stays live for the whole operation and a second click runs the action
 * again — the same defect fixed in modals.js showModal. onConfirm gates on a
 * test-controlled promise, because the window only exists while it is pending.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../i18n/index.js", () => ({ t: (key) => key }));
vi.mock("../modules/encryption.js", () => ({
  calculatePasswordStrength: () => 100,
  getPasswordStrengthColor: () => "#000",
  getPasswordStrengthLabel: () => "strong",
}));
vi.mock("../modules/masterPassword.js", () => ({
  getPasswordHint: vi.fn(),
  setupMasterPassword: vi.fn(),
  unlockApp: vi.fn(),
  unlockWithBiometric: vi.fn(),
}));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * The dialog uses a fixed #confirm-modal id and does not remove a previous one,
 * so a leftover from an earlier assertion would shadow the live dialog. Query
 * the last one in the DOM — the most recently opened.
 */
const currentDialog = () => {
  const all = document.querySelectorAll("#confirm-modal");
  return all[all.length - 1] ?? null;
};
// Scoped to `button`: the dialog element itself also carries .modal-confirm, so
// a bare class lookup returns that wrapper instead of the button.
const confirmBtn = () => currentDialog()?.querySelector("button.modal-confirm") ?? null;
const cancelBtn = () => currentDialog()?.querySelector("button.modal-cancel") ?? null;

let modals;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = "";
  modals = await import("./masterPasswordModals.js");
});

describe("showConfirmDialog — element wiring", () => {
  it("binds the confirm listener to the button, not the dialog wrapper", async () => {
    // The dialog element carries .modal-confirm as a width modifier, so a bare
    // .modal-confirm lookup matches the wrapper before the button and leaves the
    // confirm button inert.
    const onConfirm = vi.fn(async () => {});
    modals.showConfirmDialog({ message: "sure?", onConfirm });

    const button = currentDialog().querySelector("button.modal-confirm");
    button.click();
    await flush();

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("showConfirmDialog — double submit", () => {
  it("runs onConfirm once when the button is clicked twice during the action", async () => {
    const gate = deferred();
    const onConfirm = vi.fn(async () => {
      await gate.promise;
    });

    modals.showConfirmDialog({ message: "sure?", onConfirm });

    confirmBtn().click();
    await flush();
    confirmBtn().click();
    await flush();

    gate.resolve();
    await flush();

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("resolves true once the action completes", async () => {
    const onConfirm = vi.fn(async () => {});
    const result = modals.showConfirmDialog({ message: "sure?", onConfirm });

    confirmBtn().click();
    await flush();

    await expect(result).resolves.toBe(true);
    expect(document.getElementById("confirm-modal")).toBeNull();
  });

  it("blocks cancel while the action is in flight, so it cannot be abandoned half-done", async () => {
    const gate = deferred();
    modals.showConfirmDialog({
      message: "sure?",
      onConfirm: async () => {
        await gate.promise;
      },
    });

    confirmBtn().click();
    await flush();

    cancelBtn().click();
    await flush();

    expect(document.getElementById("confirm-modal")).not.toBeNull();

    gate.resolve();
    await flush();
  });

  it("re-enables the dialog after a failed action so the user can retry", async () => {
    const gate = deferred();
    let calls = 0;
    modals.showConfirmDialog({
      message: "sure?",
      confirmText: "Delete",
      onConfirm: async () => {
        calls += 1;
        if (calls === 1) {
          await gate.promise;
        }
      },
    });

    confirmBtn().click();
    await flush();

    gate.reject(new Error("boom"));
    await flush();

    // Dialog stays open, controls usable, original label restored.
    expect(document.getElementById("confirm-modal")).not.toBeNull();
    expect(confirmBtn().disabled).toBe(false);
    expect(cancelBtn().disabled).toBe(false);
    expect(confirmBtn().textContent).toBe("Delete");

    confirmBtn().click();
    await flush();
    expect(calls).toBe(2);
  });

  it("resolves false and closes when cancelled before confirming", async () => {
    const onConfirm = vi.fn();
    const result = modals.showConfirmDialog({ message: "sure?", onConfirm });

    cancelBtn().click();

    await expect(result).resolves.toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("works without an onConfirm callback", async () => {
    const result = modals.showConfirmDialog({ message: "sure?" });

    confirmBtn().click();
    await flush();

    await expect(result).resolves.toBe(true);
  });
});
