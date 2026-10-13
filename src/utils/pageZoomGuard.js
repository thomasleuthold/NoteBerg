/**
 * pageZoomGuard.js - Keeps multi-finger touches from zooming the whole page
 * (Android/Chrome WebView and browsers) while leaving the note canvas's own
 * pinch gesture alone.
 */

/** The note canvas viewport — it handles its own two-finger pan/zoom. */
const CANVAS_VIEWPORT_SELECTOR = ".virtual-scroll-container__viewport";

/**
 * `touchmove` listener (register with `{ passive: false }`) that blocks the
 * browser's page pinch-zoom.
 *
 * Not applied inside the note canvas viewport: it declares touch-action:none,
 * which the compositor enforces, so a pinch there can never become a page
 * zoom. The canvas handles its own two-finger pan/zoom via Pointer Events, and
 * leaving the viewport's touch stream untouched keeps that gesture under
 * Pointer Events alone.
 *
 * @param {TouchEvent} e
 */
export function preventPagePinchZoom(e) {
  if (e.touches.length < 2) return;
  if (e.target?.closest?.(CANVAS_VIEWPORT_SELECTOR)) return;
  e.preventDefault();
}
