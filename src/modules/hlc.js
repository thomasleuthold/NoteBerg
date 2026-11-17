/**
 * The version clock of note edits: a hybrid logical clock (DESIGN §10.7 B).
 *
 * Every change to an element of a note (a stroke, a media item, a task...) is
 * stamped with a value from this clock. Two versions of an element are then
 * compared by their stamps, not by the note they came in. A stamp is
 *
 *     <wall time, base36, 9 digits>-<counter, base36, 3 digits>-<device id>
 *
 * so plain string comparison orders stamps. The clock never runs behind a stamp
 * it has seen (observe()), so an edit made after taking in another always
 * carries the larger stamp, whatever the devices' wall clocks say.
 *
 * Stamps are made on the main thread only (the editor, the storage layer);
 * merging never makes one, so merge results do not depend on who merged.
 */

const TIME_DIGITS = 9;
const COUNTER_DIGITS = 3;
const MAX_COUNTER = 36 ** COUNTER_DIGITS - 1;
const DEVICE_KEY = "noteberg_device_id";
const STAMP = /^([0-9a-z]{9})-([0-9a-z]{3})-([0-9a-z]+)/;

function randomId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

/**
 * The time and counter of a stamp, or null when it is not one. Compound
 * element versions (`<stamp>+<shift stamp>...`, §10.7 D) are read by their first part.
 */
export function parseStamp(stamp) {
  const match = typeof stamp === "string" ? STAMP.exec(stamp) : null;
  if (!match) return null;
  return {
    time: Number.parseInt(match[1], 36),
    counter: Number.parseInt(match[2], 36),
    device: match[3],
  };
}

/** The device that made a (plain) stamp. */
export function stampDevice(stamp) {
  return parseStamp(stamp)?.device ?? "";
}

/** The largest stamp a note carries anywhere, or "". */
export function maxStampOf(note) {
  if (!note || typeof note !== "object") return "";
  let max = "";
  const consider = (stamp) => {
    if (typeof stamp === "string" && stamp > max) max = stamp;
  };
  for (const key of ["strokes", "media", "tasks", "recordings"]) {
    const items = note[key];
    if (!Array.isArray(items)) continue;
    for (const item of items) consider(item?.v);
  }
  for (const stamp of Object.values(note.tombstones ?? {})) consider(stamp);
  for (const stamp of Object.values(note.fieldVersions ?? {})) consider(stamp);
  for (const shift of Array.isArray(note.shifts) ? note.shifts : []) consider(shift?.v);
  return max;
}

/**
 * A clock for one writer.
 * @param {{device: string, wall?: () => number}} options
 */
export function createClock({ device, wall = () => Date.now() }) {
  let lastTime = 0;
  let lastCounter = 0;
  const clock = {
    device,
    /** A new stamp, larger than every stamp this clock made or observed. */
    now() {
      const time = wall();
      if (time > lastTime) {
        lastTime = time;
        lastCounter = 0;
      } else if (lastCounter < MAX_COUNTER) {
        lastCounter++;
      } else {
        // Counter exhausted within one millisecond: borrow the next one
        lastTime++;
        lastCounter = 0;
      }
      return `${lastTime.toString(36).padStart(TIME_DIGITS, "0")}-${lastCounter
        .toString(36)
        .padStart(COUNTER_DIGITS, "0")}-${clock.device}`;
    },
    /** Never stamp below `stamp` from now on. */
    observe(stamp) {
      const parsed = parseStamp(stamp);
      if (!parsed) return;
      if (parsed.time > lastTime || (parsed.time === lastTime && parsed.counter > lastCounter)) {
        lastTime = parsed.time;
        lastCounter = parsed.counter;
      }
    },
    /** Observe every stamp a note carries; called when a version of it is taken in. */
    observeNote(note) {
      clock.observe(maxStampOf(note));
    },
  };
  return clock;
}

/**
 * This writer's id. Native: one per installation. Nextcloud app: one per page
 * load, so two tabs (or a reload next to an open tab) are two writers.
 */
function loadDeviceId() {
  const perInstallation = import.meta.env.VITE_PLATFORM !== "nextcloud";
  let id = null;
  if (perInstallation) {
    try {
      id = localStorage.getItem(DEVICE_KEY);
    } catch {
      id = null;
    }
  }
  if (!id || !/^[0-9a-z]+$/.test(id)) {
    id = randomId();
    if (perInstallation) {
      try {
        localStorage.setItem(DEVICE_KEY, id);
      } catch {
        // Not persisted: this run is one writer, the next another
      }
    }
  }
  return id;
}

let defaultClock = null;

/** This app's clock (created on first use: the worker never needs one). */
export function getClock() {
  if (!defaultClock) defaultClock = createClock({ device: loadDeviceId() });
  return defaultClock;
}
