import { fireEvent, screen } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteToolbar } from "./NoteToolbar.js";

// Mock dependencies
vi.mock("../../i18n/index.js", () => ({
  t: (key) => {
    const map = {
      "toolbar.modes.pan": "Pan Mode",
      "toolbar.modes.draw": "Draw Mode",
      "toolbar.modes.eraser": "Eraser Mode",
      "toolbar.modes.lasso": "Lasso Select",
      "toolbar.modes.text": "Text Mode",
      "toolbar.actions.undo": "Undo (Ctrl+Z)",
      "toolbar.actions.redo": "Redo (Ctrl+Y)",
      "toolbar.actions.insert": "Insert",
      "toolbar.actions.options": "Note Options",
      "toolbar.penDialog.collapse": "Collapse",
      "toolbar.penDialog.expand": "Expand Settings",
      "toolbar.penDialog.savePreset": "Save current settings to this preset",
      "toolbar.penDialog.lineWidth": "Line Width: ",
      "toolbar.penDialog.color": "Color",
      "toolbar.penDialog.colorTitle": "Color",
      "toolbar.insert.image": "Insert Image",
      "toolbar.insert.camera": "Take Photo",
      "toolbar.insert.pdf": "Insert PDF",
      "toolbar.insert.space": "Insert Vertical Space",
      "toolbar.background.label": "Background",
      "toolbar.background.none": "None",
      "toolbar.background.ruledNarrow": "Ruled - Narrow",
      "toolbar.background.ruledMedium": "Ruled - Medium",
      "toolbar.background.ruledWide": "Ruled - Wide",
      "toolbar.background.gridSmall": "Grid - Small",
      "toolbar.background.gridMedium": "Grid - Medium",
      "toolbar.background.gridLarge": "Grid - Large",
      "toolbar.deleteNote": "Delete Note",
    };
    return map[key] ?? key;
  },
}));

vi.mock("../../utils/icons.js", () => ({
  getIcon: (name) => `<svg data-testid="icon-${name}"></svg>`,
}));

vi.mock("../../utils/noteRenderer.js", () => ({
  getThemePalette: () => ["#000000", "#ff0000", "#00ff00", "#0000ff", "#ffff00"],
  getMarkerPalette: () => ["#FFFF00", "#00FF00", "#FF0000"],
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
      { width: 2, colorIndex: 0, type: "pen" },
      { width: 4, colorIndex: 1, type: "pen" },
      { width: 25, colorIndex: 0, type: "marker" },
      { width: 8, colorIndex: 3, type: "pen" },
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

  it("opens pen settings dialog on draw mode activation and toggles on second click", () => {
    const drawBtn = screen.getByTitle("Draw Mode");
    const dialog = container.querySelector(".note-canvas-toolbar__pen-dialog");

    // 1. Click to activate draw mode - dialog should open immediately
    fireEvent.click(drawBtn);
    expect(onModeChange).toHaveBeenCalledWith("draw");
    expect(dialog.classList.contains("note-canvas-toolbar__pen-dialog--open")).toBe(true);

    // Manually update mode since we mocked the callback
    toolbar.updateMode("draw");

    // 2. Click again to toggle dialog closed
    fireEvent.click(drawBtn);
    expect(dialog.classList.contains("note-canvas-toolbar__pen-dialog--open")).toBe(false);

    // 3. Click again to toggle dialog open
    fireEvent.click(drawBtn);
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
    expect(onPenSettingsChange).toHaveBeenCalledWith({ width: 4, colorIndex: 1, type: "pen" });
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
    expect(updatedPresets[0]).toEqual({ width: 5, colorIndex: 0, type: "pen" });
    expect(saveBtns[0].style.display).toBe("none");
  });

  it("updates settings and UI when switching to marker preset", () => {
    // Expand to check UI changes
    const expandBtn = container.querySelector(".note-canvas-toolbar__expand-btn");
    fireEvent.click(expandBtn);

    const presetBtns = container.querySelectorAll(".note-canvas-toolbar__preset-btn");
    // Click marker preset (index 2)
    fireEvent.click(presetBtns[2]);

    expect(toolbar.penType).toBe("marker");
    expect(toolbar.penWidth).toBe(25);
    expect(onPenSettingsChange).toHaveBeenCalledWith({ width: 25, colorIndex: 0, type: "marker" });

    // Check slider range for marker
    const slider = container.querySelector(".note-canvas-toolbar__width-slider");
    expect(slider.min).toBe("10");
    expect(slider.max).toBe("50");
    expect(slider.step).toBe("5");
  });

  it("updates settings and UI when switching back to pen preset", () => {
    // Expand to check UI changes
    const expandBtn = container.querySelector(".note-canvas-toolbar__expand-btn");
    fireEvent.click(expandBtn);

    const presetBtns = container.querySelectorAll(".note-canvas-toolbar__preset-btn");

    // Switch to marker first
    fireEvent.click(presetBtns[2]);

    // Switch back to pen (index 0)
    fireEvent.click(presetBtns[0]);

    expect(toolbar.penType).toBe("pen");
    expect(toolbar.penWidth).toBe(2);
    expect(onPenSettingsChange).toHaveBeenCalledWith({ width: 2, colorIndex: 0, type: "pen" });

    // Check slider range for pen
    const slider = container.querySelector(".note-canvas-toolbar__width-slider");
    expect(slider.min).toBe("0.2");
    expect(slider.max).toBe("15");
    expect(slider.step).toBe("0.1");
  });

  it("preserves pen type when saving preset", () => {
    // Expand
    const expandBtn = container.querySelector(".note-canvas-toolbar__expand-btn");
    fireEvent.click(expandBtn);

    const presetBtns = container.querySelectorAll(".note-canvas-toolbar__preset-btn");
    // Select marker preset
    fireEvent.click(presetBtns[2]);

    // Change width via slider
    const slider = container.querySelector(".note-canvas-toolbar__width-slider");
    fireEvent.input(slider, { target: { value: "30" } });

    // Save
    const saveBtns = container.querySelectorAll(".note-canvas-toolbar__save-preset-btn");
    fireEvent.click(saveBtns[2]);

    expect(onPresetChange).toHaveBeenCalled();
    const updatedPresets = onPresetChange.mock.calls[0][0];
    expect(updatedPresets[2]).toEqual({ width: 30, colorIndex: 0, type: "marker" });
  });
});

describe("NoteToolbar — show recognized text", () => {
  let container;
  let onOptionsChange;

  /**
   * Build a toolbar whose recognized text is whatever the getter returns.
   *
   * The getter is a function rather than a value because the real one reads the
   * note on every call: recognition can finish while the note is open, and the
   * menu has to reflect that without being rebuilt.
   */
  function buildToolbar(getRecognizedText) {
    return new NoteToolbar(container, vi.fn(), {
      penPresets: [{ width: 2, colorIndex: 0, type: "pen" }],
      onOptionsChange,
      getRecognizedText,
    });
  }

  function showTextBtn() {
    return container.querySelector("#nc-show-text-btn");
  }

  function openOptions() {
    fireEvent.click(screen.getByTitle("Note Options"));
  }

  function closeOptions() {
    // Same path the user takes: clicking the button again toggles it shut.
    fireEvent.click(screen.getByTitle("Note Options"));
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    onOptionsChange = vi.fn();
  });

  afterEach(() => {
    document.body.removeChild(container);
    vi.clearAllMocks();
  });

  it("disables the entry when the note has no recognized text", () => {
    buildToolbar(() => null);
    openOptions();
    expect(showTextBtn().disabled).toBe(true);
  });

  it("enables the entry when there is text to show", () => {
    buildToolbar(() => "some recognized words");
    openOptions();
    expect(showTextBtn().disabled).toBe(false);
  });

  it("enables the entry after recognition finishes while the note is open", () => {
    // The regression the per-open sync exists to prevent: the dialog markup is
    // built once, so an entry disabled at build time would stay disabled for
    // the rest of the session even after the note has been recognized.
    let text = null;
    buildToolbar(() => text);

    openOptions();
    expect(showTextBtn().disabled).toBe(true);
    closeOptions();

    text = "recognized after the fact";
    openOptions();
    expect(showTextBtn().disabled).toBe(false);
  });

  it("asks the canvas to show the text when clicked", () => {
    buildToolbar(() => "words");
    openOptions();
    fireEvent.click(showTextBtn());
    expect(onOptionsChange).toHaveBeenCalledWith({ type: "show-recognized-text" });
  });

  it("explains why the entry is unavailable", () => {
    buildToolbar(() => null);
    openOptions();
    expect(showTextBtn().title).toBe("toolbar.noRecognizedText");
  });

  it("drops the explanation once the entry is usable", () => {
    // A tooltip saying "no recognized text" left on an enabled button would
    // contradict what the button now does.
    let text = null;
    buildToolbar(() => text);
    openOptions();
    closeOptions();

    text = "words";
    openOptions();
    expect(showTextBtn().hasAttribute("title")).toBe(false);
  });
});

describe("NoteToolbar — separating the paid entry", () => {
  let container;
  let onOptionsChange;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    onOptionsChange = vi.fn();
    new NoteToolbar(container, vi.fn(), {
      penPresets: [{ width: 2, colorIndex: 0, type: "pen" }],
      onOptionsChange,
      getRecognizedText: () => "words",
    });
    fireEvent.click(screen.getByTitle("Note Options"));
  });

  afterEach(() => {
    document.body.removeChild(container);
    vi.clearAllMocks();
  });

  it("does not put recognize directly above show-text", () => {
    // The reason this matters: show-text is the entry a user clicks habitually,
    // and recognize is the one that spends money. Adjacent, a mis-tap on a
    // familiar target lands on a paid call.
    const buttons = [...container.querySelectorAll(".note-canvas-toolbar__option-btn")];
    const recognize = buttons.findIndex((b) => b.id === "nc-recognize-btn");
    const showText = buttons.findIndex((b) => b.id === "nc-show-text-btn");
    expect(recognize).toBeGreaterThanOrEqual(0);
    expect(showText).toBeGreaterThanOrEqual(0);
    expect(Math.abs(recognize - showText)).toBeGreaterThan(1);
  });

  it("puts recognize in a section of its own", () => {
    // A separator is what makes the distance visible rather than incidental —
    // without it a later menu addition could quietly close the gap again.
    const section = container
      .querySelector("#nc-recognize-btn")
      .closest(".note-canvas-toolbar__options-section");
    expect(section).not.toBeNull();
    expect(section.querySelectorAll("button")).toHaveLength(1);
  });

  it("still asks the canvas to start recognition when clicked", () => {
    // Moving the entry must not break it. The toolbar only reports the request;
    // the confirmation dialog lives in the canvas, so this stays a plain call.
    fireEvent.click(container.querySelector("#nc-recognize-btn"));
    expect(onOptionsChange).toHaveBeenCalledWith({ type: "recognize-now" });
  });
});
