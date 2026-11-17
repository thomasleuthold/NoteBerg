/**
 * Where the main thread is busy while the user writes (review P4, 4.10).
 *
 * Writing must never stall: a task on the main thread longer than a frame
 * delays the pen's next points. This logs every long task (50 ms and more, the
 * browser's own "long task") with the steps that were running at the time
 * (a stroke save, a live look, a take-in, a sync), and says whether the user
 * was writing then: a stroke under way, or pen-down less than 500 ms before.
 *
 * On in development builds, and anywhere after
 * `localStorage.setItem("noteberg_perf", "1")`. Off, every call is a no-op.
 * The browser reports long tasks in Chromium-based ones (WebView2 on Windows,
 * Android WebView, Chrome); steps are still timed everywhere.
 */

/** Pen-down this recently counts as writing. */
const WRITING_WINDOW_MS = 500;
/** A step itself this long is logged even without long-task support. */
const SLOW_STEP_MS = 16;

function isEnabled() {
  if (import.meta.env?.DEV) return true;
  try {
    return globalThis.localStorage?.getItem("noteberg_perf") === "1";
  } catch {
    return false;
  }
}

const enabled = isEnabled();
const now = () => globalThis.performance?.now?.() ?? Date.now();

// Steps under way and recently finished: { name, start, end }
const steps = [];
let lastPenDown = Number.NEGATIVE_INFINITY;
let drawing = false;

function writingAt(time) {
  return drawing || (time >= lastPenDown && time - lastPenDown < WRITING_WINDOW_MS);
}

function stepsDuring(start, end) {
  return steps
    .filter((step) => step.start < end && (step.end ?? Number.POSITIVE_INFINITY) > start)
    .map((step) => step.name);
}

function forget(before) {
  while (steps.length > 0 && steps[0].end !== undefined && steps[0].end < before) steps.shift();
}

if (enabled && typeof PerformanceObserver !== "undefined") {
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const end = entry.startTime + entry.duration;
        const names = stepsDuring(entry.startTime, end);
        const writing = writingAt(entry.startTime);
        const log = writing ? console.warn : console.info;
        log(
          `[Perf] long task ${Math.round(entry.duration)} ms${writing ? " WHILE WRITING" : ""}` +
            `${names.length ? ` during ${[...new Set(names)].join(", ")}` : ""}`,
        );
      }
      forget(now() - 10_000);
    }).observe({ type: "longtask", buffered: false });
  } catch {
    // No long-task support here (Firefox, Safari): the step timings below still log
  }
}

/**
 * A step begins; call the returned function when it ends. Async steps may
 * overlap: each is tracked on its own.
 * @param {string} name - e.g. "live look", "take-in", "stroke save"
 * @returns {() => void}
 */
export function perfStep(name) {
  if (!enabled) return () => {};
  const step = { name, start: now(), end: undefined };
  steps.push(step);
  return () => {
    step.end = now();
  };
}

/**
 * Time a synchronous piece of main-thread work.
 * @template T
 * @param {string} name
 * @param {() => T} fn
 * @returns {T}
 */
export function perfSync(name, fn) {
  if (!enabled) return fn();
  const step = { name, start: now(), end: undefined, sync: true };
  steps.push(step);
  try {
    return fn();
  } finally {
    step.end = now();
    const ms = step.end - step.start;
    if (ms >= SLOW_STEP_MS) {
      const writing = writingAt(step.start);
      (writing ? console.warn : console.info)(
        `[Perf] ${name} took ${Math.round(ms)} ms on the main thread${writing ? " WHILE WRITING" : ""}`,
      );
    }
  }
}

/** The pen (or a finger, or the mouse) went down on the canvas. */
export function notePenDown() {
  if (!enabled) return;
  lastPenDown = now();
  drawing = true;
}

/** The stroke ended (or was cancelled). */
export function notePenUp() {
  if (!enabled) return;
  drawing = false;
}

/** Whether timing is on (for callers that would otherwise collect data for nothing). */
export function perfEnabled() {
  return enabled;
}

/**
 * Track an asynchronous step (its long tasks are named after it).
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function perfAsync(name, fn) {
  const end = perfStep(name);
  try {
    return await fn();
  } finally {
    end();
  }
}
