/**
 * When an open note looks for changes someone else made to it.
 *
 * While a note is open, a collaborator (or the user's other device) can change
 * it. The editor finds out by asking now and then: a cheap request that
 * downloads nothing unless something changed (the caller's `check`). This
 * module only decides WHEN that happens, because pen input is what the app
 * lives on and nothing here may get in its way:
 *
 *  - never while a stroke is drawn, a finger is down, or within QUIET_MS of the
 *    last pen, touch or key input: the check waits until the user pauses
 *  - never while the window is hidden or the device is offline: no timer runs
 *    then at all, and the first look after coming back is soon
 *  - one timer at a time, never faster than QUIET_MS; recording an input is a
 *    single assignment, so the input handlers pay nothing for it
 *
 * `check` reports "deferred" when it found a change but the user started
 * writing again before it could be taken in; it then runs again at the next
 * pause instead of a whole interval later.
 */

/**
 * How often an open note looks for someone else's changes. One small request
 * per look (the note file's etag); what follows a change runs in a worker
 * (review P4, 4.1 and 4.3), so a short interval costs the main thread nothing.
 */
export const LIVE_CHECK_INTERVAL_MS = 5_000;
/** How long the user must have left the note alone before anything is done. */
export const QUIET_MS = 2_500;

export class LiveRefresh {
  /**
   * @param {object} io
   * @param {() => Promise<"deferred"|unknown>} io.check - look once (and take in what changed)
   * @param {() => boolean} io.isBusy - a stroke or gesture is under way
   * @param {() => boolean} [io.isVisible]
   * @param {() => boolean} [io.isOnline]
   * @param {() => boolean} [io.isEnabled] - whether to look every interval at all.
   *   Not enabled, only what is waiting (soon()) and the idle tasks run; refresh()
   *   tells the timer when this changed
   * @param {object} [options]
   * @param {number} [options.intervalMs]
   * @param {number} [options.quietMs]
   * @param {() => number} [options.now]
   */
  constructor(
    {
      check,
      isBusy,
      isVisible = defaultIsVisible,
      isOnline = defaultIsOnline,
      isEnabled = () => true,
    },
    { intervalMs = LIVE_CHECK_INTERVAL_MS, quietMs = QUIET_MS, now = () => Date.now() } = {},
  ) {
    this._check = check;
    this._isBusy = isBusy;
    this._isVisible = isVisible;
    this._isOnline = isOnline;
    this._isEnabled = isEnabled;
    this._intervalMs = intervalMs;
    this._quietMs = quietMs;
    this._now = now;
    this._lastInput = Number.NEGATIVE_INFINITY;
    this._timer = null;
    this._running = false;
    this._soonAfterRun = false;
    this._soonPending = false;
    this._active = false;
    this._idleTimer = null;
    this._idleTask = null;
    this._tick = this._tick.bind(this);
  }

  /** The note is open: look every interval from now on. */
  start() {
    if (this._active) return;
    this._active = true;
    if (this._isEnabled()) this._schedule(this._intervalMs);
  }

  /** Whether looking every interval is switched on or off now: start or stop the timer. */
  refresh() {
    if (!this._active) return;
    if (!this._isEnabled()) {
      // What waits for a pause (soon()) runs without the interval
      if (!this._soonPending && !this._running) this._clear();
      return;
    }
    if (!this._timer && !this._running && this._canRun()) this._schedule(this._intervalMs);
  }

  /** The note is closing: no more looks. A look already under way finishes on its own. */
  stop() {
    this._active = false;
    this._clear();
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = null;
    this._idleTask = null;
  }

  /**
   * Run `task` at the user's next pause (QUIET_MS after the last input, never
   * while busy). One task waits at a time: a newer one replaces it, so calling
   * this on every stroke still arms only one timer.
   * @param {() => unknown} task
   */
  whenIdle(task) {
    if (!this._active) return;
    this._idleTask = task;
    if (!this._idleTimer) this._armIdle(this._waitForIdle());
  }

  _armIdle(ms) {
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (!this._active || !this._idleTask) return;
      const wait = this._waitForIdle();
      if (wait > 0) {
        this._armIdle(wait);
        return;
      }
      const task = this._idleTask;
      this._idleTask = null;
      Promise.resolve()
        .then(task)
        .catch((e) => console.warn("[LiveRefresh] Idle task failed:", e));
    }, ms);
  }

  /** The user just wrote, touched or typed. Cheap enough for every input event. */
  noteInput() {
    this._lastInput = this._now();
  }

  /** Whether the user has paused long enough for work to be done now. */
  isIdle() {
    return this._waitForIdle() === 0;
  }

  /**
   * Visibility or connectivity changed: stop while hidden or offline, and look
   * again soon after coming back (changes are most likely to have piled up then).
   */
  wake() {
    if (!this._active) return;
    if (!this._canRun()) {
      this._clear();
      return;
    }
    if (!this._timer && !this._running && this._isEnabled()) this._schedule(this._quietMs);
  }

  /** Something is waiting to be taken in: look at the user's next pause, not an interval later. */
  soon() {
    if (!this._active) return;
    if (this._running) {
      this._soonAfterRun = true;
      return;
    }
    if (this._canRun()) {
      this._soonPending = true;
      this._schedule(this._quietMs);
    }
  }

  _canRun() {
    return this._isVisible() && this._isOnline();
  }

  /** Milliseconds until the user counts as idle; 0 when they already do. */
  _waitForIdle() {
    if (this._isBusy()) return this._quietMs;
    const since = this._now() - this._lastInput;
    return since >= this._quietMs ? 0 : this._quietMs - since;
  }

  _schedule(ms) {
    this._clear();
    this._timer = setTimeout(this._tick, ms);
  }

  _clear() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  async _tick() {
    this._timer = null;
    const wasSoon = this._soonPending;
    this._soonPending = false;
    if (!this._active || this._running) return;
    // Hidden or offline: park without a timer; wake() resumes
    if (!this._canRun()) return;
    const wait = this._waitForIdle();
    if (wait > 0) {
      this._soonPending = wasSoon;
      this._schedule(wait);
      return;
    }
    this._running = true;
    this._soonAfterRun = false;
    let outcome;
    try {
      outcome = await this._check();
    } catch (e) {
      console.warn("[LiveRefresh] Check failed:", e);
    } finally {
      this._running = false;
    }
    if (!this._active || this._timer) return;
    const again = outcome === "deferred" || this._soonAfterRun;
    if (again) {
      this._soonPending = true;
      this._schedule(this._quietMs);
    } else if (this._isEnabled()) {
      this._schedule(this._intervalMs);
    }
  }
}

function defaultIsVisible() {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function defaultIsOnline() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}
