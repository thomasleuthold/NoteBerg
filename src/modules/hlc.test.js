/**
 * src/modules/hlc.test.js
 * The version clock (DESIGN §10.7 B): stamps order by plain string comparison,
 * never run behind what was seen, and name the writer that made them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createClock, maxStampOf, parseStamp, stampDevice } from "./hlc.js";

describe("hybrid logical clock", () => {
  it("makes stamps that grow, also within one millisecond and when the wall clock goes back", () => {
    let wall = 1_000_000;
    const clock = createClock({ device: "dev1", wall: () => wall });
    const a = clock.now();
    const b = clock.now(); // same millisecond
    wall -= 500; // the device's clock was set back
    const c = clock.now();
    wall += 10_000;
    const d = clock.now();
    expect([a, b, c, d]).toEqual([...[a, b, c, d]].sort());
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it("never stamps below a stamp it has seen, whatever its own wall clock says", () => {
    const fast = createClock({ device: "fast", wall: () => 5_000_000 });
    const slow = createClock({ device: "slow", wall: () => 1_000 });
    const seen = fast.now();
    slow.observe(seen);
    expect(slow.now() > seen).toBe(true);
  });

  it("observes the largest stamp anywhere in a note", () => {
    const clock = createClock({ device: "me", wall: () => 1 });
    const other = createClock({ device: "other", wall: () => 9_000_000 });
    const big = other.now();
    const note = {
      strokes: [{ v: "000000001-000-x" }],
      shifts: [{ v: big, y: 0, delta: 1 }],
      tombstones: { a: "000000002-000-x" },
    };
    expect(maxStampOf(note)).toBe(big);
    clock.observeNote(note);
    expect(clock.now() > big).toBe(true);
  });

  it("reads a stamp, also the first part of a compound element version", () => {
    const clock = createClock({ device: "abc", wall: () => 123_456 });
    const stamp = clock.now();
    expect(parseStamp(stamp)).toEqual({ time: 123_456, counter: 0, device: "abc" });
    expect(stampDevice(`${stamp}+000000009-000-zzz`)).toBe("abc");
    expect(parseStamp("not a stamp")).toBeNull();
    expect(parseStamp(undefined)).toBeNull();
  });

  it("borrows the next millisecond when the counter runs out", () => {
    const clock = createClock({ device: "d", wall: () => 77 });
    let last = "";
    for (let i = 0; i < 36 ** 3 + 5; i++) {
      const next = clock.now();
      expect(next > last).toBe(true);
      last = next;
    }
  });
});

describe("the app's clock", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    localStorage.clear();
  });

  it("keeps one writer id per installation on native", async () => {
    vi.resetModules();
    const first = (await import("./hlc.js")).getClock().device;
    vi.resetModules();
    const second = (await import("./hlc.js")).getClock().device;
    expect(first).toMatch(/^[0-9a-z]+$/);
    expect(second).toBe(first);
  });
});
