import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_CHECK_INTERVAL_MS, LiveRefresh, QUIET_MS } from "./liveRefresh.js";

const INTERVAL = 15_000;
const QUIET = 2_500;

let state;
let check;
let refresh;

function create(checkImpl = async () => undefined) {
  check = vi.fn(checkImpl);
  refresh = new LiveRefresh(
    {
      check,
      isBusy: () => state.drawing,
      isVisible: () => state.visible,
      isOnline: () => state.online,
      isEnabled: () => state.enabled,
    },
    { intervalMs: INTERVAL, quietMs: QUIET },
  );
  return refresh;
}

beforeEach(() => {
  vi.useFakeTimers();
  state = { drawing: false, visible: true, online: true, enabled: true };
});

afterEach(() => {
  refresh?.stop();
  vi.useRealTimers();
});

describe("LiveRefresh", () => {
  it("looks every few seconds by default, never faster than the quiet time", () => {
    expect(LIVE_CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(3_000);
    expect(LIVE_CHECK_INTERVAL_MS).toBeLessThanOrEqual(10_000);
    expect(LIVE_CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(QUIET_MS);
    expect(QUIET_MS).toBeGreaterThan(0);
  });

  it("looks once per interval while the user leaves the note alone", async () => {
    create().start();

    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("does not look while a stroke is being drawn, and looks once the user pauses", async () => {
    create().start();
    state.drawing = true;

    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(check).not.toHaveBeenCalled();

    // The pen lifts: that is input too, so the quiet period starts now
    state.drawing = false;
    refresh.noteInput();
    await vi.advanceTimersByTimeAsync(QUIET - 1);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("does not look shortly after input, and runs the deferred look once the user pauses", async () => {
    create().start();
    await vi.advanceTimersByTimeAsync(INTERVAL - 1000);
    refresh.noteInput(); // 1 s before the look was due

    await vi.advanceTimersByTimeAsync(1000);
    expect(check).not.toHaveBeenCalled();
    expect(refresh.isIdle()).toBe(false);

    await vi.advanceTimersByTimeAsync(QUIET - 1000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(refresh.isIdle()).toBe(true);
  });

  it("keeps deferring while the user keeps writing, without a timer per input", async () => {
    create().start();
    const timersBefore = vi.getTimerCount();
    for (let t = 0; t < INTERVAL * 2; t += 200) {
      refresh.noteInput();
      expect(vi.getTimerCount()).toBe(timersBefore);
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(check).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(QUIET);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("looks again at the next pause, not an interval later, when the check was deferred", async () => {
    create(async () => "deferred").start();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(check).toHaveBeenCalledTimes(1);

    check.mockImplementation(async () => undefined);
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(check).toHaveBeenCalledTimes(2);
    // Back to the interval afterwards
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("never runs two looks at once", async () => {
    let finish;
    create(() => new Promise((resolve) => (finish = resolve))).start();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(check).toHaveBeenCalledTimes(1);

    refresh.wake();
    refresh.soon();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(check).toHaveBeenCalledTimes(1);

    finish();
    // soon() during the look: the next one follows at the next pause
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("keeps looking after a check that failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    create(async () => {
      throw new Error("offline");
    }).start();
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(check).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("soon() looks at the next pause instead of waiting for the interval", async () => {
    create().start();
    refresh.noteInput();
    refresh.soon();
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(check).toHaveBeenCalledTimes(1);
  });

  describe("whenIdle", () => {
    it("runs a task at the user's next pause, never while they write", async () => {
      create().start();
      const task = vi.fn();
      refresh.noteInput();
      refresh.whenIdle(task);
      await vi.advanceTimersByTimeAsync(QUIET - 1);
      expect(task).not.toHaveBeenCalled();

      // The user writes on: the task keeps waiting
      state.drawing = true;
      await vi.advanceTimersByTimeAsync(QUIET * 4);
      expect(task).not.toHaveBeenCalled();
      state.drawing = false;
      refresh.noteInput();
      await vi.advanceTimersByTimeAsync(QUIET);
      expect(task).toHaveBeenCalledTimes(1);
    });

    it("runs only the newest of several tasks, with one timer", async () => {
      create().start();
      const timersBefore = vi.getTimerCount();
      const tasks = [vi.fn(), vi.fn(), vi.fn()];
      for (const task of tasks) {
        refresh.noteInput();
        refresh.whenIdle(task);
      }
      expect(vi.getTimerCount()).toBe(timersBefore + 1);
      await vi.advanceTimersByTimeAsync(QUIET);
      expect(tasks[0]).not.toHaveBeenCalled();
      expect(tasks[1]).not.toHaveBeenCalled();
      expect(tasks[2]).toHaveBeenCalledTimes(1);
    });

    it("drops a waiting task when the note closes", async () => {
      create().start();
      const task = vi.fn();
      refresh.noteInput();
      refresh.whenIdle(task);
      refresh.stop();
      await vi.advanceTimersByTimeAsync(QUIET * 2);
      expect(task).not.toHaveBeenCalled();
    });
  });

  describe("stopping and resuming", () => {
    it("stops when the note closes", async () => {
      create().start();
      refresh.stop();
      await vi.advanceTimersByTimeAsync(INTERVAL * 3);
      expect(check).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("schedules nothing more after a look that was under way when the note closed", async () => {
      let finish;
      create(() => new Promise((resolve) => (finish = resolve))).start();
      await vi.advanceTimersByTimeAsync(INTERVAL);
      refresh.stop();
      finish();
      await vi.advanceTimersByTimeAsync(INTERVAL * 3);
      expect(check).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("runs no timer while the window is hidden, and looks soon after it is visible again", async () => {
      create().start();
      state.visible = false;
      refresh.wake();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(INTERVAL * 3);
      expect(check).not.toHaveBeenCalled();

      state.visible = true;
      refresh.wake();
      await vi.advanceTimersByTimeAsync(QUIET);
      expect(check).toHaveBeenCalledTimes(1);
    });

    it("parks without a timer when the window turned hidden unannounced", async () => {
      create().start();
      state.visible = false;
      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(check).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stops while offline and resumes when back online", async () => {
      create().start();
      state.online = false;
      refresh.wake();
      await vi.advanceTimersByTimeAsync(INTERVAL * 3);
      expect(check).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      state.online = true;
      refresh.wake();
      await vi.advanceTimersByTimeAsync(QUIET);
      expect(check).toHaveBeenCalledTimes(1);
    });

    it("does not resume a note that was closed", async () => {
      create().start();
      refresh.stop();
      refresh.wake();
      refresh.soon();
      await vi.advanceTimersByTimeAsync(INTERVAL * 3);
      expect(check).not.toHaveBeenCalled();
    });
  });
});

// Looking for others' changes belongs to notebook sharing, a preview that is off
// until the user turns it on. Off, nothing is looked for every interval.
describe("LiveRefresh while looking is switched off", () => {
  beforeEach(() => {
    state.enabled = false;
  });

  it("never looks on its own", async () => {
    create().start();
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(check).not.toHaveBeenCalled();
  });

  it("does not look when the window comes back either", async () => {
    create().start();
    state.visible = false;
    refresh.wake();
    state.visible = true;
    refresh.wake();
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(check).not.toHaveBeenCalled();
  });

  it("still runs what waits for the user's pause (a change announced while writing)", async () => {
    create().start();
    refresh.noteInput();

    refresh.soon();
    await vi.advanceTimersByTimeAsync(QUIET - 1);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(check).toHaveBeenCalledTimes(1);

    // ... and goes back to not looking
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting for the pause when the user is still writing", async () => {
    create().start();
    state.drawing = true;
    refresh.soon();
    await vi.advanceTimersByTimeAsync(QUIET * 4);
    expect(check).not.toHaveBeenCalled();

    refresh.refresh(); // a change of the setting must not drop what waits
    state.drawing = false;
    await vi.advanceTimersByTimeAsync(QUIET * 2);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("still runs the idle tasks", async () => {
    create().start();
    const task = vi.fn();
    refresh.whenIdle(task);
    await vi.advanceTimersByTimeAsync(QUIET + 1);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("starts looking when it is switched on, and stops when it is switched off", async () => {
    create().start();

    state.enabled = true;
    refresh.refresh();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(check).toHaveBeenCalledTimes(1);

    state.enabled = false;
    refresh.refresh();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a note that is closed", async () => {
    create().start();
    refresh.stop();
    state.enabled = true;
    refresh.refresh();
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(check).not.toHaveBeenCalled();
  });
});
