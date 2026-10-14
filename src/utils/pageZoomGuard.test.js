import { describe, expect, it, vi } from "vitest";
import { preventPagePinchZoom } from "./pageZoomGuard.js";

function touchMove(target, touchCount) {
  return {
    target,
    touches: { length: touchCount },
    preventDefault: vi.fn(),
  };
}

describe("preventPagePinchZoom", () => {
  it("blocks a two-finger move outside the note canvas (page zoom)", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);

    const e = touchMove(button, 2);
    preventPagePinchZoom(e);

    expect(e.preventDefault).toHaveBeenCalled();
    button.remove();
  });

  it("leaves a single-finger move alone, so ordinary scrolling still works", () => {
    const e = touchMove(document.body, 1);
    preventPagePinchZoom(e);

    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("leaves a two-finger move inside the note canvas to the canvas's own pinch", () => {
    // Touches usually land on a child of the viewport (canvas layers, overlays).
    const viewport = document.createElement("div");
    viewport.className = "virtual-scroll-container__viewport";
    const layer = document.createElement("canvas");
    viewport.appendChild(layer);
    document.body.appendChild(viewport);

    const e = touchMove(layer, 2);
    preventPagePinchZoom(e);

    expect(e.preventDefault).not.toHaveBeenCalled();
    viewport.remove();
  });
});
