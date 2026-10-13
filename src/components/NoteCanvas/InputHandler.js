/**
 * InputHandler - Manages pointer events for drawing
 *
 * Handles:
 * - Raw pointer events (down, move, up, cancel)
 * - Coordinate transformation (Screen -> Content)
 * - Coalesced events for smooth curves
 * - Stylus vs Touch detection
 */

export class InputHandler {
  /**
   * @param {HTMLElement} element - DOM element to listen to (the viewport)
   * @param {Object} contextProvider - Provider for current view state { getZoom, getScroll, getRect }
   * @param {Object} callbacks - { onStrokeStart, onStrokeMove, onStrokeEnd }
   */
  constructor(element, contextProvider, callbacks) {
    this.element = element;
    this.contextProvider = contextProvider;
    this.callbacks = callbacks;

    this.activePointerId = null;
    // pointerType of the active stroke ("pen" | "touch" | "mouse"), so callers
    // can tell a finger stroke (cancellable by a pinch) from a stylus one.
    this.activePointerType = null;
    this.isDrawing = false;

    // Tracks every live touch pointerId regardless of whether it started a
    // stroke here (capture phase, so it always sees pointerdown/up/cancel).
    // When a second finger lands, Nav's bubble-phase handler cancels finger 1's
    // stroke before this class's own bubble-phase listener sees finger 2's
    // pointerdown; with isDrawing already false, only this count stops finger 2
    // from immediately starting a new stroke.
    this._touchPointerIds = new Set();

    // Bind methods
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._trackTouchDown = this._trackTouchDown.bind(this);
    this._trackTouchUp = this._trackTouchUp.bind(this);

    this._attachListeners();
  }

  _attachListeners() {
    // Capture phase, ahead of the bubble-phase listener below: multi-touch
    // bookkeeping must be in place before _onPointerDown decides whether a
    // second finger's own down event is allowed to start a stroke.
    this.element.addEventListener("pointerdown", this._trackTouchDown, true);
    this.element.addEventListener("pointerup", this._trackTouchUp, true);
    this.element.addEventListener("pointercancel", this._trackTouchUp, true);

    // Window-level backstop: a dropped pointerup/pointercancel on the element
    // (observed on iOS Safari during a system edge gesture or fast
    // multi-finger release; see the identical backstop in NoteCanvas for
    // activePointers) would otherwise leave a stale id in _touchPointerIds
    // forever and permanently block single-finger drawing for the rest of
    // the session. _trackTouchUp is idempotent (Set.delete of an absent id
    // is a no-op), so calling it again here for the same pointer is harmless.
    window.addEventListener("pointerup", this._trackTouchUp, true);
    window.addEventListener("pointercancel", this._trackTouchUp, true);

    this.element.addEventListener("pointerdown", this._onPointerDown);
    this.element.addEventListener("pointermove", this._onPointerMove);
    this.element.addEventListener("pointerup", this._onPointerUp);
    this.element.addEventListener("pointercancel", this._onPointerUp);
  }

  _detachListeners() {
    this.element.removeEventListener("pointerdown", this._trackTouchDown, true);
    this.element.removeEventListener("pointerup", this._trackTouchUp, true);
    this.element.removeEventListener("pointercancel", this._trackTouchUp, true);
    window.removeEventListener("pointerup", this._trackTouchUp, true);
    window.removeEventListener("pointercancel", this._trackTouchUp, true);

    this.element.removeEventListener("pointerdown", this._onPointerDown);
    this.element.removeEventListener("pointermove", this._onPointerMove);
    this.element.removeEventListener("pointerup", this._onPointerUp);
    this.element.removeEventListener("pointercancel", this._onPointerUp);
  }

  _trackTouchDown(e) {
    if (e.pointerType !== "touch") return;
    // A primary touch is by definition the first of a new interaction — no
    // other touch is down. Anything still in the set is stale (an end event
    // that was never delivered, e.g. iOS backgrounding mid-touch), and left
    // there it would block single-finger drawing for the rest of the session.
    if (e.isPrimary) this._touchPointerIds.clear();
    this._touchPointerIds.add(e.pointerId);
  }

  _trackTouchUp(e) {
    if (e.pointerType !== "touch") return;
    this._touchPointerIds.delete(e.pointerId);
  }

  getContentCoordinates(clientX, clientY) {
    const { getZoom, getScroll, getRect, getOffset } = this.contextProvider;
    const zoom = getZoom();
    const { left: scrollLeft, top: scrollTop } = getScroll();
    const rect = getRect();
    const offset = getOffset ? getOffset() : { x: 0, y: 0 };

    // Calculate position relative to viewport element
    const viewportX = clientX - rect.left - offset.x;
    const viewportY = clientY - rect.top - offset.y;

    // Convert to content coordinates
    // Content pos = (viewport pos + scroll offset) / zoom
    const x = (viewportX + scrollLeft) / zoom;
    const y = (viewportY + scrollTop) / zoom;

    return { x, y };
  }

  _onPointerDown(e) {
    // Ignore if already drawing
    if (this.isDrawing) return;

    // A second touch is already down (tracked in capture phase above, ahead
    // of this bubble-phase listener) — this is a pinch/pan gesture, not a
    // new stroke, even for the finger whose own pointerdown this is.
    if (e.pointerType === "touch" && this._touchPointerIds.size > 1) return;

    const { x, y } = this.getContentCoordinates(e.clientX, e.clientY);
    const pressure = e.pressure !== undefined ? e.pressure : 0.5;

    const shouldDraw = this.callbacks.onStrokeStart({
      x,
      y,
      pressure,
      pointerType: e.pointerType,
      pointerId: e.pointerId,
      clientX: e.clientX,
      clientY: e.clientY,
      target: e.target,
    });

    if (shouldDraw) {
      this.isDrawing = true;
      this.activePointerId = e.pointerId;
      this.activePointerType = e.pointerType;
      this.element.setPointerCapture(e.pointerId);

      // Prevent default to stop scrolling/selection
      if (e.cancelable) {
        e.preventDefault();
      }
    }
  }

  _onPointerMove(e) {
    if (!this.isDrawing || e.pointerId !== this.activePointerId) return;

    e.preventDefault();

    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const points = [];

    for (const event of events) {
      const { x, y } = this.getContentCoordinates(event.clientX, event.clientY);
      points.push({
        x,
        y,
        pressure: event.pressure !== undefined ? event.pressure : 0.5,
        time: event.timeStamp || Date.now(),
        clientX: event.clientX,
        clientY: event.clientY,
      });
    }

    this.callbacks.onStrokeMove(points);
  }

  _onPointerUp(e) {
    if (!this.isDrawing || e.pointerId !== this.activePointerId) return;

    this.isDrawing = false;
    this.activePointerId = null;
    this.activePointerType = null;

    if (this.element.hasPointerCapture(e.pointerId)) {
      this.element.releasePointerCapture(e.pointerId);
    }

    this.callbacks.onStrokeEnd();
  }

  /**
   * Abort an in-progress stroke without firing onStrokeEnd — used when a second
   * touch arrives mid-stroke and the gesture turns out to be a pinch/pan, not
   * drawing.
   *
   * Pointer capture on the viewport is deliberately kept: the same pointer now
   * carries on as one finger of the pinch, and navigation listens on this same
   * element. Releasing it would route the finger's moves to whatever is under
   * it and fire pointerleave as soon as it crosses the viewport edge (e.g. onto
   * the toolbar), which navigation treats as a lift and ends the pinch. Capture
   * is released implicitly when the pointer goes up.
   * @returns {boolean} true if a stroke was actually cancelled
   */
  cancelActiveStroke() {
    if (!this.isDrawing) return false;

    this.isDrawing = false;
    this.activePointerId = null;
    this.activePointerType = null;

    return true;
  }

  destroy() {
    this._detachListeners();
  }
}
