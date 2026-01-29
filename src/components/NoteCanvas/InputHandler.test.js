import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InputHandler } from './InputHandler.js';

// Polyfill PointerEvent for jsdom
global.PointerEvent = class PointerEvent extends Event {
  constructor(type, props = {}) {
    super(type, props);
    this.clientX = props.clientX || 0;
    this.clientY = props.clientY || 0;
    this.pointerId = props.pointerId || 0;
    this.pressure = props.pressure || 0;
    this.pointerType = props.pointerType || 'mouse';
  }
};

describe('InputHandler', () => {
  let element;
  let contextProvider;
  let callbacks;
  let inputHandler;

  beforeEach(() => {
    element = document.createElement('div');
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

  it('handles pointer down', () => {
    const event = new PointerEvent('pointerdown', { clientX: 10, clientY: 10, pointerId: 1, pressure: 0.5 });
    element.dispatchEvent(event);

    expect(callbacks.onStrokeStart).toHaveBeenCalledWith(expect.objectContaining({
      x: 10,
      y: 10,
      pressure: 0.5
    }));
    expect(element.setPointerCapture).toHaveBeenCalledWith(1);
    expect(inputHandler.isDrawing).toBe(true);
  });

  it('handles pointer move when drawing', () => {
    // Start drawing first
    const downEvent = new PointerEvent('pointerdown', { clientX: 10, clientY: 10, pointerId: 1 });
    element.dispatchEvent(downEvent);

    const moveEvent = new PointerEvent('pointermove', { clientX: 20, clientY: 20, pointerId: 1, pressure: 0.6 });
    element.dispatchEvent(moveEvent);

    expect(callbacks.onStrokeMove).toHaveBeenCalled();
    const points = callbacks.onStrokeMove.mock.calls[0][0];
    expect(points[0]).toMatchObject({ x: 20, y: 20, pressure: 0.6 });
  });

  it('ignores pointer move when not drawing', () => {
    const moveEvent = new PointerEvent('pointermove', { clientX: 20, clientY: 20, pointerId: 1 });
    element.dispatchEvent(moveEvent);
    expect(callbacks.onStrokeMove).not.toHaveBeenCalled();
  });

  it('handles pointer up', () => {
    // Start drawing
    const downEvent = new PointerEvent('pointerdown', { clientX: 10, clientY: 10, pointerId: 1 });
    element.dispatchEvent(downEvent);

    const upEvent = new PointerEvent('pointerup', { clientX: 20, clientY: 20, pointerId: 1 });
    element.dispatchEvent(upEvent);

    expect(callbacks.onStrokeEnd).toHaveBeenCalled();
    expect(element.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(inputHandler.isDrawing).toBe(false);
  });

  it('calculates coordinates with zoom and scroll', () => {
    contextProvider.getZoom.mockReturnValue(2);
    contextProvider.getScroll.mockReturnValue({ left: 50, top: 50 });
    
    // Screen: 100, 100
    // Viewport relative: 100, 100
    // Content: (100 + 50) / 2 = 75
    
    const coords = inputHandler.getContentCoordinates(100, 100);
    expect(coords).toEqual({ x: 75, y: 75 });
  });

  it('applies offset correctly', () => {
    // Simulate centered canvas (offset x=20)
    contextProvider.getOffset.mockReturnValue({ x: 20, y: 0 });
    
    // Screen X = 100. 
    // Viewport relative = 100.
    // Content X = (100 - 20) / 1 = 80.
    const coords = inputHandler.getContentCoordinates(100, 100);
    expect(coords.x).toBe(80);
  });
});