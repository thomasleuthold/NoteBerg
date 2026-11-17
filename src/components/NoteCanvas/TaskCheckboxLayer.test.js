import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCheckboxLayer } from "./TaskCheckboxLayer.js";

describe("TaskCheckboxLayer", () => {
  let viewportElement;
  let callbacks;
  let layer;

  beforeEach(() => {
    viewportElement = document.createElement("div");
    document.body.appendChild(viewportElement);
    callbacks = {
      onToggle: vi.fn(),
      onTaskClick: vi.fn(),
    };
    layer = new TaskCheckboxLayer(viewportElement, callbacks);
  });

  afterEach(() => {
    layer.destroy();
    document.body.removeChild(viewportElement);
    vi.clearAllMocks();
  });

  it("creates container", () => {
    expect(viewportElement.querySelector(".note-canvas__task-checkbox-layer")).toBeTruthy();
  });

  it("updates checkboxes based on tasks and strokes", () => {
    const tasks = [{ id: "t1", type: "stroke", strokeIds: ["s1"], checked: false }];
    const strokes = [{ id: "s1", x: [10, 20], y: [10, 20], _deleted: false }];

    // Zoom 1, no scroll
    layer.update(tasks, strokes, 1, 0, 0, 0);

    const checkbox = viewportElement.querySelector(".note-canvas__task-checkbox");
    const boundingBox = viewportElement.querySelector(".note-canvas__task-bounding-box");

    expect(checkbox).toBeTruthy();
    expect(checkbox.dataset.taskId).toBe("t1");
    expect(boundingBox).toBeTruthy();
    expect(boundingBox.dataset.taskId).toBe("t1");

    // Check positioning logic roughly
    // Bounds: minX 10, maxX 20, minY 10, maxY 20.
    // Checkbox is to the left.
    expect(checkbox.style.display).toBe("block");
  });

  it("hides checkbox if strokes are missing or deleted", () => {
    const tasks = [{ id: "t1", type: "stroke", strokeIds: ["s1"], checked: false }];
    const strokes = [
      { id: "s1", x: [10], y: [10], _deleted: true }, // Deleted stroke
    ];

    layer.update(tasks, strokes, 1, 0, 0, 0);

    expect(viewportElement.querySelector(".note-canvas__task-checkbox")).toBeNull();
  });

  it("removes checkbox if task is removed", () => {
    const tasks = [{ id: "t1", type: "stroke", strokeIds: ["s1"], checked: false }];
    const strokes = [{ id: "s1", x: [10], y: [10], _deleted: false }];

    // First update creates it
    layer.update(tasks, strokes, 1, 0, 0, 0);
    expect(viewportElement.querySelector(".note-canvas__task-checkbox")).toBeTruthy();

    // Second update removes it
    layer.update([], strokes, 1, 0, 0, 0);
    expect(viewportElement.querySelector(".note-canvas__task-checkbox")).toBeNull();
  });

  it("handles toggle interaction", () => {
    const tasks = [{ id: "t1", type: "stroke", strokeIds: ["s1"], checked: false }];
    const strokes = [{ id: "s1", x: [10], y: [10], _deleted: false }];

    layer.update(tasks, strokes, 1, 0, 0, 0);

    const checkbox = viewportElement.querySelector(".note-canvas__task-checkbox");
    checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(callbacks.onToggle).toHaveBeenCalledWith("t1", true);
  });

  it("handles bounding box click interaction", () => {
    const tasks = [{ id: "t1", type: "stroke", strokeIds: ["s1"], checked: false }];
    const strokes = [{ id: "s1", x: [10], y: [10], _deleted: false }];

    layer.update(tasks, strokes, 1, 0, 0, 0);

    const boundingBox = viewportElement.querySelector(".note-canvas__task-bounding-box");
    boundingBox.click();

    expect(callbacks.onTaskClick).toHaveBeenCalledWith("t1");
  });

  it("sets data-status and data-priority attributes on checkbox", () => {
    const tasks = [
      {
        id: "t1",
        type: "stroke",
        strokeIds: ["s1"],
        status: "doing",
        priority: "urgent",
        checked: false,
      },
    ];
    const strokes = [{ id: "s1", x: [10], y: [10], _deleted: false }];

    layer.update(tasks, strokes, 1, 0, 0, 0);

    const checkbox = viewportElement.querySelector(".note-canvas__task-checkbox");
    expect(checkbox.getAttribute("data-status")).toBe("doing");
    expect(checkbox.getAttribute("data-priority")).toBe("urgent");
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
  });

  it("calls onCycleStatus when available on click", () => {
    callbacks.onCycleStatus = vi.fn();
    const tasks = [{ id: "t1", type: "stroke", strokeIds: ["s1"], status: "open" }];
    const strokes = [{ id: "s1", x: [10], y: [10], _deleted: false }];

    layer.update(tasks, strokes, 1, 0, 0, 0);

    const checkbox = viewportElement.querySelector(".note-canvas__task-checkbox");
    checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(callbacks.onCycleStatus).toHaveBeenCalledWith("t1");
    expect(callbacks.onToggle).not.toHaveBeenCalled();
  });

  it("destroys correctly", () => {
    const tasks = [{ id: "t1", type: "stroke", strokeIds: ["s1"], checked: false }];
    const strokes = [{ id: "s1", x: [10], y: [10], _deleted: false }];

    layer.update(tasks, strokes, 1, 0, 0, 0);
    expect(viewportElement.querySelector(".note-canvas__task-checkbox-layer")).toBeTruthy();

    layer.destroy();
    expect(viewportElement.querySelector(".note-canvas__task-checkbox-layer")).toBeNull();
  });
});

describe("TaskCheckboxLayer - read-only", () => {
  let viewportElement;
  let callbacks;
  let layer;

  const tasks = [{ id: "t1", type: "stroke", strokeIds: ["s1"], checked: false }];
  const strokes = [{ id: "s1", x: [10, 20], y: [10, 20] }];

  beforeEach(() => {
    viewportElement = document.createElement("div");
    document.body.appendChild(viewportElement);
    callbacks = { onToggle: vi.fn(), onTaskClick: vi.fn() };
    layer = new TaskCheckboxLayer(viewportElement, callbacks);
    layer.update(tasks, strokes, 1, 0, 0, 0);
  });

  afterEach(() => {
    layer.destroy();
    document.body.removeChild(viewportElement);
  });

  it("shows tasks but neither ticks them nor selects their strokes", () => {
    layer.setReadOnly(true);
    const checkbox = viewportElement.querySelector(".note-canvas__task-checkbox");

    checkbox.click();
    viewportElement.querySelector(".note-canvas__task-bounding-box").click();

    expect(callbacks.onToggle).not.toHaveBeenCalled();
    expect(callbacks.onTaskClick).not.toHaveBeenCalled();
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    expect(
      viewportElement.querySelector(".note-canvas__task-checkbox-layer--readonly"),
    ).toBeTruthy();
  });

  it("works as before when not read-only, and again after being switched back", () => {
    const checkbox = viewportElement.querySelector(".note-canvas__task-checkbox");
    checkbox.click();
    expect(callbacks.onToggle).toHaveBeenCalledWith("t1", true);

    layer.setReadOnly(true);
    layer.setReadOnly(false);
    checkbox.click();
    expect(callbacks.onToggle).toHaveBeenCalledTimes(2);
    expect(viewportElement.querySelector(".note-canvas__task-checkbox-layer--readonly")).toBeNull();
  });
});
