/**
 * src/utils/asyncAction.test.js
 *
 * bindGuardedClick exists because an async click handler returns at its first
 * await, leaving the button live for the whole operation. Buttons that stay in
 * the DOM while they work (restore, purge) would otherwise run twice on a double
 * click. The handlers here gate on a test-controlled promise, since the defect
 * only exists while an operation is genuinely in flight.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { bindGuardedClick } from "./asyncAction.js";

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

let button;

beforeEach(() => {
  document.body.innerHTML = '<button id="b">Restore</button>';
  button = document.getElementById("b");
});

describe("bindGuardedClick", () => {
  it("runs the action once when clicked twice during the operation", async () => {
    const gate = deferred();
    const handler = vi.fn(async () => {
      await gate.promise;
    });
    bindGuardedClick(button, handler);

    button.click();
    await flush();
    button.click();
    await flush();

    gate.resolve();
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("allows a second run after the first completes", async () => {
    const handler = vi.fn(async () => {});
    bindGuardedClick(button, handler);

    button.click();
    await flush();
    button.click();
    await flush();

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("disables the button while the operation runs and re-enables it after", async () => {
    const gate = deferred();
    bindGuardedClick(button, async () => {
      await gate.promise;
    });

    button.click();
    await flush();
    expect(button.disabled).toBe(true);

    gate.resolve();
    await flush();
    expect(button.disabled).toBe(false);
  });

  it("re-enables the button when the action throws, so the user can retry", async () => {
    const gate = deferred();
    // The handler owns its failure, mirroring the call sites: both the recycle
    // bin and overview handlers try/catch internally and surface an alert.
    // bindGuardedClick only restores the button, so an uncaught rejection here
    // would escape as an unhandled rejection rather than reaching a caller.
    bindGuardedClick(button, async () => {
      try {
        await gate.promise;
      } catch {
        // Swallowed by the action itself, as the real handlers do.
      }
    });

    button.click();
    await flush();

    gate.reject(new Error("failed"));
    await flush();

    expect(button.disabled).toBe(false);
  });

  it("re-enables the button even when the action rejects without handling it", async () => {
    const gate = deferred();
    bindGuardedClick(button, async () => {
      await gate.promise;
    });

    button.click();
    await flush();

    gate.reject(new Error("failed"));
    // Attach a handler so the rejection is observed; the finally block in
    // bindGuardedClick still runs and must restore the button.
    await gate.promise.catch(() => {});
    await flush();

    expect(button.disabled).toBe(false);
  });

  it("swaps in the busy label and restores the original afterwards", async () => {
    const gate = deferred();
    bindGuardedClick(
      button,
      async () => {
        await gate.promise;
      },
      { busyLabel: "Working..." },
    );

    button.click();
    await flush();
    expect(button.textContent).toBe("Working...");

    gate.resolve();
    await flush();
    expect(button.textContent).toBe("Restore");
  });

  it("leaves the label untouched when no busy label is given", async () => {
    const gate = deferred();
    bindGuardedClick(button, async () => {
      await gate.promise;
    });

    button.click();
    await flush();
    expect(button.textContent).toBe("Restore");

    gate.resolve();
    await flush();
  });
});
