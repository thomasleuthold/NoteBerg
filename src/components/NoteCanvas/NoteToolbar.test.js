import { fireEvent, screen } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteToolbar } from "./NoteToolbar.js";

// Mock dependencies
vi.mock("../../utils/icons.js", () => ({
  getIcon: (name) => `<svg data-testid="icon-${name}"></svg>`,
}));

vi.mock("../../utils/noteRenderer.js", () => ({
  getThemePalette: () => ["#000000", "#ff0000", "#00ff00"],
}));

describe("NoteToolbar", () => {
  let container;
  let onModeChange;
  let toolbar;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    onModeChange = vi.fn();
    toolbar = new NoteToolbar(container, onModeChange);
  });

  afterEach(() => {
    document.body.removeChild(container);
    vi.clearAllMocks();
  });

  it("renders all main tool buttons", () => {
    expect(screen.getByTitle("Pan Mode")).toBeTruthy();
    expect(screen.getByTitle("Draw Mode")).toBeTruthy();
    expect(screen.getByTitle("Eraser Mode")).toBeTruthy();
    expect(screen.getByTitle("Lasso Select")).toBeTruthy();
  });

  it("calls onModeChange when tool buttons are clicked", () => {
    const eraserBtn = screen.getByTitle("Eraser Mode");
    fireEvent.click(eraserBtn);
    expect(onModeChange).toHaveBeenCalledWith("eraser");

    const panBtn = screen.getByTitle("Pan Mode");
    fireEvent.click(panBtn);
    expect(onModeChange).toHaveBeenCalledWith("pan");
  });

  it("toggles pen settings dialog when clicking draw button while active", () => {
    // 1. Click to activate draw mode
    const drawBtn = screen.getByTitle("Draw Mode");
    fireEvent.click(drawBtn);
    expect(onModeChange).toHaveBeenCalledWith("draw");

    // Manually update mode since we mocked the callback
    toolbar.updateMode("draw");

    // 2. Click again to toggle dialog
    fireEvent.click(drawBtn);

    // Check if dialog is visible (class check)
    const dialog = container.querySelector(".note-canvas-toolbar__pen-dialog");
    expect(dialog.classList.contains("note-canvas-toolbar__pen-dialog--open")).toBe(true);
  });

  it("updates visual state when mode changes", () => {
    toolbar.updateMode("eraser");
    const eraserBtn = screen.getByTitle("Eraser Mode");
    expect(eraserBtn.classList.contains("note-canvas-toolbar__button--active")).toBe(true);
  });
});
