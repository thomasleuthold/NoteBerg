/**
 * Nextcloud-only fullscreen mode for the note editor.
 *
 * "Fullscreen" here is two independent mechanisms that are deliberately kept
 * separable:
 *
 *   1. Browser chrome — the Fullscreen API. Requires a user gesture, so it can
 *      only ever be entered from a click handler, never restored on load.
 *   2. Nextcloud's own shell (#header, app navigation) — a body class picked up
 *      by the CSS in templates/index.php.
 *
 * (2) works everywhere; (1) does not (notably iOS Safari, which does not
 * support the Fullscreen API on non-video elements). Treating them separately
 * means the feature degrades to "NC chrome hidden" instead of failing outright.
 *
 * State is never persisted: the CSS half could be restored on load but the
 * browser half legally cannot, which would reopen the app in a half-applied
 * state. Every reload starts windowed.
 *
 * No-ops entirely outside the Nextcloud build.
 */

const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

const BODY_CLASS = "noteberg-fullscreen";

/** Listeners notified on every state change, so UI can follow Esc-to-exit. */
const _listeners = new Set();

/** Mirrors the body class; the single source of truth for `isFullscreen()`. */
let _active = false;

/** True once the document-level fullscreenchange listener is attached. */
let _wired = false;

/**
 * Whether the browser is currently in native fullscreen. Kept separate from
 * `_active` because the two can legitimately diverge — the API can be
 * unavailable or refused while the NC-chrome half still applies.
 */
function _isNativeFullscreen() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

function _requestNativeFullscreen() {
  const el = document.documentElement;
  const request = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!request) return Promise.reject(new Error("Fullscreen API unavailable"));
  // Safari's prefixed form returns undefined rather than a promise.
  return Promise.resolve(request.call(el));
}

function _exitNativeFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!exit) return Promise.resolve();
  return Promise.resolve(exit.call(document));
}

function _notify() {
  for (const fn of _listeners) {
    try {
      fn(_active);
    } catch {
      // A misbehaving listener must not strand the others or the toggle.
    }
  }
}

function _applyChrome(active) {
  _active = active;
  document.body.classList.toggle(BODY_CLASS, active);
  _notify();
}

/**
 * Keeps our state in sync when the browser leaves fullscreen without going
 * through `toggleFullscreen` — pressing Esc or F11 is the common case. Without
 * this the NC chrome would stay hidden with no visible way back.
 */
function _onNativeFullscreenChange() {
  if (!_isNativeFullscreen() && _active) _applyChrome(false);
}

function _wire() {
  if (_wired) return;
  document.addEventListener("fullscreenchange", _onNativeFullscreenChange);
  document.addEventListener("webkitfullscreenchange", _onNativeFullscreenChange);
  _wired = true;
}

/**
 * @returns {boolean} Whether fullscreen mode is currently active.
 */
export function isFullscreen() {
  return _active;
}

/**
 * Whether fullscreen can be offered at all. False outside the Nextcloud build,
 * so callers can hide the entry point rather than showing a dead control.
 * Note this stays true when only the Fullscreen API is missing — the NC-chrome
 * half is still worth offering on its own.
 */
export function isFullscreenAvailable() {
  return IS_NEXTCLOUD;
}

/**
 * Subscribe to fullscreen state changes (including Esc-initiated exits).
 * @param {(active: boolean) => void} fn
 * @returns {() => void} Unsubscribe function.
 */
export function onFullscreenChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Toggle fullscreen. Must be called from a user gesture to enter, since the
 * Fullscreen API requires one.
 *
 * @param {boolean} [force] - Target state; toggles when omitted.
 * @returns {Promise<boolean>} The resulting state.
 */
export async function toggleFullscreen(force) {
  if (!IS_NEXTCLOUD) return false;
  _wire();

  const target = force === undefined ? !_active : force;
  if (target === _active) return _active;

  if (target) {
    // Hide NC chrome first so the layout is already correct when the native
    // transition paints, and so a rejected request still leaves a usable
    // fullscreen-ish view rather than no change at all.
    _applyChrome(true);
    try {
      await _requestNativeFullscreen();
    } catch {
      // Refused (no gesture) or unsupported (iOS Safari) — NC chrome stays
      // hidden and the exit control remains available.
    }
  } else {
    _applyChrome(false);
    if (_isNativeFullscreen()) {
      try {
        await _exitNativeFullscreen();
      } catch {
        // Nothing actionable; the chrome is already restored.
      }
    }
  }

  return _active;
}

/**
 * Leave fullscreen if active. Safe to call unconditionally — used when the note
 * editor closes, so overview mode is never left without an exit control.
 */
export async function exitFullscreen() {
  if (!_active) return;
  await toggleFullscreen(false);
}
