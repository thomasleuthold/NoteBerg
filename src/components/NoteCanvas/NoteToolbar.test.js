import { fireEvent, screen } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteToolbar } from "./NoteToolbar.js";

// Mock dependencies
vi.mock("../../utils/icons.js", () => ({
  getIcon: (name) => `<svg data-testid="icon-${name}"></svg>`,
}));

vi.mock("../../utils/noteRenderer.js", () => ({
  getThemePalette: () => ["#000000", "#ff0000", "#00ff00", "#0000ff", "#ffff00"],
}));

describe("NoteToolbar", () => {
  let container;
  let onModeChange;
  let onPresetChange;
  let onPenSettingsChange;
  let toolbar;
  let initialPresets;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    onModeChange = vi.fn();
    onPresetChange = vi.fn();
    onPenSettingsChange = vi.fn();
    initialPresets = [
      { width: 2, colorIndex: 0 },
      { width: 4, colorIndex: 1 },
      { width: 6, colorIndex: 2 },
      { width: 8, colorIndex: 3 },
    ];
    toolbar = new NoteToolbar(container, onModeChange, {
      penPresets: initialPresets,
      onPresetChange: onPresetChange,
      onPenSettingsChange: onPenSettingsChange,
    });
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

  it("renders pen presets", () => {
    const presetBtns = container.querySelectorAll(".note-canvas-toolbar__preset-btn");
    expect(presetBtns.length).toBe(4);
  });

  it("updates settings when preset clicked", () => {
    const presetBtns = container.querySelectorAll(".note-canvas-toolbar__preset-btn");

    // Click 2nd preset (width 4, colorIndex 1)
    fireEvent.click(presetBtns[1]);

    expect(toolbar.penWidth).toBe(4);
    expect(toolbar.penColorIndex).toBe(1);
    expect(onPenSettingsChange).toHaveBeenCalledWith({ width: 4, colorIndex: 1 });
    expect(presetBtns[1].classList.contains("note-canvas-toolbar__preset-btn--active")).toBe(true);
  });

  it("toggles expanded mode", () => {
    const expandBtn = container.querySelector(".note-canvas-toolbar__expand-btn");

    // Initially collapsed
    expect(container.querySelector(".note-canvas-toolbar__settings-container")).toBeNull();

    // Expand
    fireEvent.click(expandBtn);
    expect(container.querySelector(".note-canvas-toolbar__settings-container")).toBeTruthy();

    // Collapse (re-query button as DOM was rebuilt)
    const collapseBtn = container.querySelector(".note-canvas-toolbar__expand-btn");
    fireEvent.click(collapseBtn);
    expect(container.querySelector(".note-canvas-toolbar__settings-container")).toBeNull();
  });

  it("shows save button when settings modified", () => {
    // Expand to access settings
    const expandBtn = container.querySelector(".note-canvas-toolbar__expand-btn");
    fireEvent.click(expandBtn);

    // Select first preset (width 2, color 0)
    const presetBtns = container.querySelectorAll(".note-canvas-toolbar__preset-btn");
    fireEvent.click(presetBtns[0]);

    // Verify save button hidden initially
    const saveBtns = container.querySelectorAll(".note-canvas-toolbar__save-preset-btn");
    expect(saveBtns[0].style.display).toBe("none");

    // Change width via slider
    const slider = container.querySelector(".note-canvas-toolbar__width-slider");
    fireEvent.input(slider, { target: { value: "5" } });

    // Verify save button visible on first preset (last selected)
    expect(saveBtns[0].style.display).toBe("flex");
    expect(presetBtns[0].classList.contains("note-canvas-toolbar__preset-btn--active")).toBe(false);

    // Click save
    fireEvent.click(saveBtns[0]);

    // Verify callback
    expect(onPresetChange).toHaveBeenCalled();
    const updatedPresets = onPresetChange.mock.calls[0][0];
    expect(updatedPresets[0]).toEqual({ width: 5, colorIndex: 0 });
    expect(saveBtns[0].style.display).toBe("none");
  });
});
