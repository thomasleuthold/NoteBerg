import { beforeEach, describe, expect, it, vi } from "vitest";
import { InputHandler } from "./InputHandler.js";

// Polyfill PointerEvent for jsdom
global.PointerEvent = class PointerEvent extends Event {
  constructor(type, props = {}) {
    super(type, props);
    this.clientX = props.clientX || 0;
    this.clientY = props.clientY || 0;
    this.pointerId = props.pointerId || 0;
    this.pressure = props.pressure || 0;
    this.pointerType = props.pointerType || "mouse";
    this.isPrimary = props.isPrimary || false;
  }
};

describe("InputHandler", () => {
  let element;
  let contextProvider;
  let callbacks;
  let inputHandler;

  beforeEach(() => {
    element = document.createElement("div");
    element.setPointerCapture = vi.fn();
    element.releasePointerCapture = vi.fn();
    element.hasPointerCapture = vi.fn(() => true);
    element.getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 100, height: 100 }));

    contextProvider = {
      getZoom: vi.fn(() => 1),
      getScroll: vi.fn(() => ({ left: 0, top: 0 })),
      getRect: element.getBoundingClientRect,
      getOffset: vi.fn(() => ({ x: 0, y: 0 })),
    };

    callbacks = {
      onStrokeStart: vi.fn(() => true),
      onStrokeMove: vi.fn(),
      onStrokeEnd: vi.fn(),
    };

    inputHandler = new InputHandler(element, contextProvider, callbacks);
  });

  it("handles pointer down", () => {
    const event = new PointerEvent("pointerdown", {
      clientX: 10,
      clientY: 10,
      pointerId: 1,
      pressure: 0.5,
    });
    element.dispatchEvent(event);

    expect(callbacks.onStrokeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        x: 10,
        y: 10,
        pressure: 0.5,
      }),
    );
    expect(element.setPointerCapture).toHaveBeenCalledWith(1);
    expect(inputHandler.isDrawing).toBe(true);
  });

  it("handles pointer move when drawing", () => {
    // Start drawing first
    const downEvent = new PointerEvent("pointerdown", { clientX: 10, clientY: 10, pointerId: 1 });
    element.dispatchEvent(downEvent);

    const moveEvent = new PointerEvent("pointermove", {
      clientX: 20,
      clientY: 20,
      pointerId: 1,
      pressure: 0.6,
    });
    element.dispatchEvent(moveEvent);

    expect(callbacks.onStrokeMove).toHaveBeenCalled();
    const points = callbacks.onStrokeMove.mock.calls[0][0];
    expect(points[0]).toMatchObject({ x: 20, y: 20, pressure: 0.6 });
  });

  it("ignores pointer move when not drawing", () => {
    const moveEvent = new PointerEvent("pointermove", { clientX: 20, clientY: 20, pointerId: 1 });
    element.dispatchEvent(moveEvent);
    expect(callbacks.onStrokeMove).not.toHaveBeenCalled();
  });

  it("handles pointer up", () => {
    // Start drawing
    const downEvent = new PointerEvent("pointerdown", { clientX: 10, clientY: 10, pointerId: 1 });
    element.dispatchEvent(downEvent);

    const upEvent = new PointerEvent("pointerup", { clientX: 20, clientY: 20, pointerId: 1 });
    element.dispatchEvent(upEvent);

    expect(callbacks.onStrokeEnd).toHaveBeenCalled();
    expect(element.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(inputHandler.isDrawing).toBe(false);
  });

  it("calculates coordinates with zoom and scroll", () => {
    contextProvider.getZoom.mockReturnValue(2);
    contextProvider.getScroll.mockReturnValue({ left: 50, top: 50 });

    // Screen: 100, 100
    // Viewport relative: 100, 100
    // Content: (100 + 50) / 2 = 75

    const coords = inputHandler.getContentCoordinates(100, 100);
    expect(coords).toEqual({ x: 75, y: 75 });
  });

  it("applies offset correctly", () => {
    // Simulate centered canvas (offset x=20)
    contextProvider.getOffset.mockReturnValue({ x: 20, y: 0 });

    // Screen X = 100.
    // Viewport relative = 100.
    // Content X = (100 - 20) / 1 = 80.
    const coords = inputHandler.getContentCoordinates(100, 100);
    expect(coords.x).toBe(80);
  });

  describe("second finger landing mid-stroke", () => {
    it("does not start a new stroke for the second finger's own pointerdown, even if the first stroke was just cancelled", () => {
      // Finger 1 starts a stroke.
      element.dispatchEvent(
        new PointerEvent("pointerdown", {
          clientX: 10,
          clientY: 10,
          pointerId: 1,
          pointerType: "touch",
        }),
      );
      expect(inputHandler.isDrawing).toBe(true);
      callbacks.onStrokeStart.mockClear();

      // Something upstream (e.g. NoteCanvas's nav handler, reacting to this
      // same pointerdown bubbling up) decides this is a pinch and cancels
      // finger 1's stroke *before* InputHandler's own pointerdown listener
      // for finger 2 runs. isDrawing is now false, which previously let
      // finger 2's pointerdown sail through _onPointerDown's `if (isDrawing)
      // return` guard and start a brand new stroke immediately after.
      inputHandler.cancelActiveStroke();
      expect(inputHandler.isDrawing).toBe(false);

      // Finger 2 lands — dispatched on the same element, same tick, as a
      // second real touch would be. Internal touch-pointer tracking (set in
      // capture phase, ahead of _onPointerDown) must refuse this one too.
      element.dispatchEvent(
        new PointerEvent("pointerdown", {
          clientX: 20,
          clientY: 10,
          pointerId: 2,
          pointerType: "touch",
        }),
      );

      expect(callbacks.onStrokeStart).not.toHaveBeenCalled();
      expect(inputHandler.isDrawing).toBe(false);
    });

    it("allows a fresh single-finger stroke again once both touches have lifted", () => {
      element.dispatchEvent(
        new PointerEvent("pointerdown", {
          clientX: 10,
          clientY: 10,
          pointerId: 1,
          pointerType: "touch",
        }),
      );
      element.dispatchEvent(
        new PointerEvent("pointerdown", {
          clientX: 20,
          clientY: 10,
          pointerId: 2,
          pointerType: "touch",
        }),
      );
      element.dispatchEvent(
        new PointerEvent("pointerup", {
          clientX: 10,
          clientY: 10,
          pointerId: 1,
          pointerType: "touch",
        }),
      );
      element.dispatchEvent(
        new PointerEvent("pointerup", {
          clientX: 20,
          clientY: 10,
          pointerId: 2,
          pointerType: "touch",
        }),
      );
      callbacks.onStrokeStart.mockClear();

      element.dispatchEvent(
        new PointerEvent("pointerdown", {
          clientX: 30,
          clientY: 30,
          pointerId: 3,
          pointerType: "touch",
        }),
      );

      expect(callbacks.onStrokeStart).toHaveBeenCalled();
      expect(inputHandler.isDrawing).toBe(true);
    });

    it("recovers from a touch whose end event was never delivered once a new primary touch lands", () => {
      // Finger 1's pointerup is lost (e.g. iOS backgrounded mid-touch), so its
      // id stays tracked.
      element.dispatchEvent(
        new PointerEvent("pointerdown", { pointerId: 1, pointerType: "touch", isPrimary: true }),
      );
      inputHandler.cancelActiveStroke();
      callbacks.onStrokeStart.mockClear();

      // Later a fresh single finger: primary means no other touch is down, so
      // the stale id must not make this look like a second finger.
      element.dispatchEvent(
        new PointerEvent("pointerdown", { pointerId: 7, pointerType: "touch", isPrimary: true }),
      );

      expect(callbacks.onStrokeStart).toHaveBeenCalled();
      expect(inputHandler.isDrawing).toBe(true);
    });
  });

  describe("cancelActiveStroke", () => {
    it("keeps pointer capture so the finger carries on as part of the pinch", () => {
      element.dispatchEvent(
        new PointerEvent("pointerdown", { pointerId: 1, pointerType: "touch" }),
      );
      expect(element.setPointerCapture).toHaveBeenCalledWith(1);

      expect(inputHandler.cancelActiveStroke()).toBe(true);

      // Releasing would let the finger's pointerleave at the viewport edge end
      // the pinch; capture is dropped implicitly when the finger lifts.
      expect(element.releasePointerCapture).not.toHaveBeenCalled();
      expect(callbacks.onStrokeEnd).not.toHaveBeenCalled();
    });

    it("is a no-op when nothing is being drawn", () => {
      expect(inputHandler.cancelActiveStroke()).toBe(false);
    });
  });

  describe("touch tracking backstop", () => {
    it("forgets a touch whose pointerup reaches only the window", () => {
      element.dispatchEvent(
        new PointerEvent("pointerdown", { pointerId: 1, pointerType: "touch" }),
      );
      element.dispatchEvent(
        new PointerEvent("pointerdown", { pointerId: 2, pointerType: "touch" }),
      );
      inputHandler.cancelActiveStroke();

      // Both lifts dispatched outside the element (e.g. finger slid off and
      // the element never got the end event).
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, pointerType: "touch" }));
      window.dispatchEvent(
        new PointerEvent("pointercancel", { pointerId: 2, pointerType: "touch" }),
      );
      callbacks.onStrokeStart.mockClear();

      // A non-primary touch (no reset path) must still be able to draw.
      element.dispatchEvent(
        new PointerEvent("pointerdown", { pointerId: 3, pointerType: "touch" }),
      );
      expect(callbacks.onStrokeStart).toHaveBeenCalled();
    });
  });

  describe("activePointerType", () => {
    it("records the pointer type of the active stroke and clears it when the stroke ends", () => {
      element.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, pointerType: "pen" }));
      expect(inputHandler.activePointerType).toBe("pen");

      element.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, pointerType: "pen" }));
      expect(inputHandler.activePointerType).toBeNull();
    });

    it("clears the pointer type when the stroke is cancelled", () => {
      element.dispatchEvent(
        new PointerEvent("pointerdown", { pointerId: 1, pointerType: "touch" }),
      );
      expect(inputHandler.activePointerType).toBe("touch");

      inputHandler.cancelActiveStroke();
      expect(inputHandler.activePointerType).toBeNull();
    });
  });
});
