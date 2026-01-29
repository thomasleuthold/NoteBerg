import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualScroller } from "./VirtualScroller.js";

describe("VirtualScroller", () => {
  let container;
  let scroller;
  let onScroll;
  let onViewportResize;

  beforeEach(() => {
    container = document.createElement("div");
    // Mock getBoundingClientRect for all elements so internal scroller div gets dimensions
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
    });

    onScroll = vi.fn();
    onViewportResize = vi.fn();

    // Mock ResizeObserver
    globalThis.ResizeObserver = vi.fn().mockImplementation((cb) => ({
      observe: vi.fn(),
      disconnect: vi.fn(),
      callback: cb, // Expose callback for testing
    }));

    scroller = new VirtualScroller(container, { onScroll, onViewportResize });
  });

  afterEach(() => {
    scroller.destroy();
    vi.restoreAllMocks();
  });

  it("initializes DOM structure", () => {
    expect(container.querySelector(".virtual-scroll-container")).toBeTruthy();
    expect(container.querySelector(".virtual-scroll-container__phantom")).toBeTruthy();
    expect(container.querySelector(".virtual-scroll-container__viewport")).toBeTruthy();
  });

  it("handles scroll events", () => {
    const scrollContainer = container.querySelector(".virtual-scroll-container");
    scrollContainer.scrollTop = 100;
    scrollContainer.scrollLeft = 50;

    // Trigger scroll event
    scrollContainer.dispatchEvent(new Event("scroll"));

    expect(onScroll).toHaveBeenCalledWith(100, 50, 600);
    expect(scroller.getScrollTop()).toBe(100);
  });

  it("updates phantom size when content size changes", () => {
    scroller.setContentSize(2000, 3000);
    const phantom = container.querySelector(".virtual-scroll-container__phantom");
    expect(phantom.style.width).toBe("2000px");
    expect(phantom.style.height).toBe("3000px");
  });

  it("updates phantom size when zoom changes", () => {
    scroller.setContentSize(1000, 1000);
    scroller.setZoom(2.0);
    const phantom = container.querySelector(".virtual-scroll-container__phantom");
    expect(phantom.style.width).toBe("2000px"); // 1000 * 2
    expect(phantom.style.height).toBe("2000px");
  });

  it("handles resize observer events", () => {
    // Simulate resize
    const callback = globalThis.ResizeObserver.mock.results[0].value.callback;

    callback([{ contentRect: { width: 1000, height: 800 } }]);

    expect(onViewportResize).toHaveBeenCalledWith(1000, 800);
    expect(scroller.getViewportSize()).toEqual({ width: 1000, height: 800 });
  });

  it("adjusts scroll position when zooming with fixed point", () => {
    scroller.setContentSize(1000, 1000);
    scroller.setZoom(1.0);

    // Zoom in to 2x at point 100,100
    // Content point at 100,100 should remain at 100,100 in viewport
    // Old content pos: 100. New content pos: 200.
    // Scroll should increase by 100 to keep it in place.
    scroller.setZoom(2.0, { x: 100, y: 100 });

    expect(scroller.getScrollLeft()).toBe(100);
    expect(scroller.getScrollTop()).toBe(100);
  });
});
