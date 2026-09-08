/**
 * Covers the footer's summary of the recognition queue.
 *
 * The badge is the only surface that reports a job after its dialog is closed,
 * so what it chooses to show — and which state wins when several are present —
 * is the whole of what a user learns about background work.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../i18n/index.js", () => ({
  t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

vi.mock("../config.js", () => ({ APP_FULL_VERSION: "9.9.9" }));

import { summarizeQueue } from "./footer.js";

function job(state, extra = {}) {
  return { id: `j${Math.random()}`, noteId: "n", state, current: 0, total: 0, ...extra };
}

describe("summarizeQueue", () => {
  it("hides the badge when nothing is queued", () => {
    expect(summarizeQueue([]).visible).toBe(false);
    expect(summarizeQueue(undefined).visible).toBe(false);
  });

  it("shows page progress for the running job", () => {
    const s = summarizeQueue([job("running", { current: 2, total: 3 })]);
    expect(s.visible).toBe(true);
    expect(s.state).toBe("running");
    expect(s.text).toBe("2/3");
  });

  it("shows how much is waiting behind the running job", () => {
    // Without this the badge would look identical whether one note or six were
    // outstanding, which is exactly the decision the user needs it for.
    const s = summarizeQueue([job("running", { current: 1, total: 2 }), job("queued")]);
    expect(s.text).toBe("1/2 +1");
  });

  it("counts waiting jobs when nothing has started yet", () => {
    const s = summarizeQueue([job("queued"), job("queued")]);
    expect(s.state).toBe("queued");
    expect(s.text).toBe("2");
  });

  it("reports failures once the queue drains", () => {
    // A failure nobody saw is the one that matters, so it stays visible after
    // the work stops.
    const s = summarizeQueue([job("failed", { error: "boom" })]);
    expect(s.state).toBe("failed");
    expect(s.text).toBe("1");
  });

  it("prefers running over a failure still awaiting dismissal", () => {
    // Active work is what is happening now; the failed row remains in the panel
    // either way, so the badge reports the live state.
    const s = summarizeQueue([job("failed"), job("running", { current: 1, total: 1 })]);
    expect(s.state).toBe("running");
  });

  it("does not let a finished job keep the badge alive", () => {
    // `done` lingers briefly in the queue so the panel can show it; that must
    // not read as outstanding work.
    expect(summarizeQueue([job("done")]).visible).toBe(false);
  });

  it("omits page numbers before the running job reports a total", () => {
    // total is 0 between starting a job and the rasterizer counting pages;
    // "0/0" would be worse than nothing.
    const s = summarizeQueue([job("running")]);
    expect(s.text).toBe("");
    expect(s.visible).toBe(true);
  });
});
