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
    this.isDrawing = false;

    // Bind methods
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);

    this._attachListeners();
  }

  _attachListeners() {
    this.element.addEventListener("pointerdown", this._onPointerDown);
    this.element.addEventListener("pointermove", this._onPointerMove);
    this.element.addEventListener("pointerup", this._onPointerUp);
    this.element.addEventListener("pointercancel", this._onPointerUp);
  }

  _detachListeners() {
    this.element.removeEventListener("pointerdown", this._onPointerDown);
    this.element.removeEventListener("pointermove", this._onPointerMove);
    this.element.removeEventListener("pointerup", this._onPointerUp);
    this.element.removeEventListener("pointercancel", this._onPointerUp);
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

    if (this.element.hasPointerCapture(e.pointerId)) {
      this.element.releasePointerCapture(e.pointerId);
    }

    this.callbacks.onStrokeEnd();
  }

  destroy() {
    this._detachListeners();
  }
}
