import { fireEvent } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaOverlay } from "./MediaOverlay.js";

vi.mock("../../utils/icons.js", () => ({
  getIcon: (name) => `<svg data-testid="icon-${name}"></svg>`,
}));

describe("MediaOverlay", () => {
  let container;
  let overlay;
  let callbacks;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    callbacks = {
      onDelete: vi.fn(),
      onCrop: vi.fn(),
      onToFront: vi.fn(),
      onToBack: vi.fn(),
    };
    overlay = new MediaOverlay(container, callbacks);
  });

  afterEach(() => {
    overlay.destroy();
    document.body.removeChild(container);
  });

  it("creates DOM elements", () => {
    expect(container.querySelector(".note-canvas__media-overlay")).toBeTruthy();
    expect(container.querySelector(".note-canvas__media-btn")).toBeTruthy();
  });

  it("shows and hides", () => {
    const mediaItem = { id: "m1", x: 10, y: 10, width: 100, height: 100 };
    const viewportRect = { left: 0, top: 0, width: 800, height: 600 };

    overlay.show(mediaItem, 1, 0, 0, viewportRect);
    expect(overlay.element.classList.contains("note-canvas__media-overlay--visible")).toBe(true);

    overlay.hide();
    expect(overlay.element.classList.contains("note-canvas__media-overlay--visible")).toBe(false);
  });

  it("handles menu actions", () => {
    const mediaItem = { id: "m1", x: 10, y: 10, width: 100, height: 100 };
    overlay.show(mediaItem, 1, 0, 0, { left: 0, top: 0, width: 800, height: 600 });

    // Open menu
    const optionBtn = container.querySelector(".note-canvas__media-btn");
    fireEvent.click(optionBtn);

    // Click delete
    const deleteBtn = container.querySelector("#media-delete-btn");
    fireEvent.click(deleteBtn);
    expect(callbacks.onDelete).toHaveBeenCalledWith("m1");

    // Re-show overlay to reset activeMediaId (delete action hides it)
    overlay.show(mediaItem, 1, 0, 0, { left: 0, top: 0, width: 800, height: 600 });

    // Click crop
    const cropBtn = container.querySelector("#media-crop-btn");
    fireEvent.click(cropBtn);
    expect(callbacks.onCrop).toHaveBeenCalledWith("m1");
  });

  it("closes menu when clicking outside", () => {
    const mediaItem = { id: "m1", x: 10, y: 10, width: 100, height: 100 };
    overlay.show(mediaItem, 1, 0, 0, {});
    overlay.menu.classList.add("note-canvas-toolbar__options-dialog--open");

    // Click on document body
    fireEvent.pointerDown(document.body);
    expect(overlay.menu.classList.contains("note-canvas-toolbar__options-dialog--open")).toBe(
      false,
    );
  });
});
