/**
 * Async action helpers
 *
 * An async click handler returns at its first `await`, so the button that
 * triggered it stays live for the whole operation. Anything that remains in the
 * DOM while it works — a restore/purge button, a modal confirm — can therefore
 * be activated again mid-flight and run the operation twice. Handlers that
 * remove their own trigger (a menu that closes on click) are not affected.
 */

/**
 * Wrap an async click handler so it cannot run concurrently with itself.
 *
 * The button is disabled for the duration, which both blocks the second
 * activation and shows the operation is under way. The guard flag is the real
 * protection: `disabled` alone is not enough, since a queued event can already
 * be in flight before it is set.
 *
 * A rejection from `handler` is logged and swallowed — a listener's promise has
 * no caller to reject to — and the button is restored either way. Handlers that
 * need to tell the user something must catch and report it themselves.
 *
 * @param {HTMLElement} button - Element whose clicks trigger the action
 * @param {Function} handler - Async handler to run at most once at a time
 * @param {object} [options]
 * @param {string} [options.busyLabel] - Text to show while running; the original
 *   label is restored afterwards. Omit to leave the label untouched.
 * @returns {Function} The bound listener (already attached to the button)
 */
export function bindGuardedClick(button, handler, { busyLabel } = {}) {
  let running = false;

  const listener = async (event) => {
    if (running) return;
    running = true;

    const idleLabel = button.textContent;
    button.disabled = true;
    if (busyLabel !== undefined) {
      button.textContent = busyLabel;
    }
    button.classList.add("btn-busy");

    try {
      await handler(event);
    } catch (error) {
      // A click listener's promise has no caller to reject to, so an escaping
      // error would surface only as an unhandled rejection. The call sites
      // handle their own failures (alert dialogs); this is the backstop that
      // keeps one from going silent.
      console.error("[asyncAction] Guarded click handler failed:", error);
    } finally {
      // Always restored: unlike a modal confirm, these buttons stay on screen
      // after the operation and must be usable again. If the surrounding view
      // re-rendered meanwhile, this element is detached and the writes are
      // harmless.
      running = false;
      button.disabled = false;
      if (busyLabel !== undefined) {
        button.textContent = idleLabel;
      }
      button.classList.remove("btn-busy");
    }
  };

  button.addEventListener("click", listener);
  return listener;
}
