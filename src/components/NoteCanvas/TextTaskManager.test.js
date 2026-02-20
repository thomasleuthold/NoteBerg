import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextTaskManager } from "./TextTaskManager.js";

// Mock storage
vi.mock("../../modules/storage.js", () => ({
  generateId: vi.fn(() => "mock-task-id"),
}));

describe("TextTaskManager", () => {
  let editorElement;
  let callbacks;
  let manager;

  beforeEach(() => {
    editorElement = document.createElement("div");
    editorElement.contentEditable = "true";
    document.body.appendChild(editorElement);

    callbacks = {
      onTaskCreate: vi.fn(),
      onTaskToggle: vi.fn(),
      triggerChange: vi.fn(),
    };

    manager = new TextTaskManager(editorElement, callbacks);
  });

  afterEach(() => {
    document.body.removeChild(editorElement);
    vi.clearAllMocks();
  });

  describe("toggleTaskOnSelection", () => {
    // Helper to setup selection
    const setupSelection = (startNode, startOffset, endNode, endOffset) => {
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);

      const selection = {
        rangeCount: 1,
        getRangeAt: () => range,
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
      };

      window.getSelection = vi.fn(() => selection);
      return range;
    };

    it("creates a task for a simple paragraph", () => {
      editorElement.innerHTML = "<p>Hello World</p>";
      const p = editorElement.querySelector("p");
      const textNode = p.firstChild;

      setupSelection(textNode, 0, textNode, 5); // Select "Hello"

      manager.toggleTaskOnSelection();

      expect(callbacks.onTaskCreate).toHaveBeenCalledWith("mock-task-id");
      expect(callbacks.triggerChange).toHaveBeenCalled();

      // Check DOM structure
      const checkbox = p.querySelector(".task-text-checkbox");
      const taskText = p.querySelector(".task-text");

      expect(checkbox).toBeTruthy();
      expect(taskText).toBeTruthy();
      expect(taskText.textContent).toBe("Hello World"); // It wraps the whole block content
    });

    it("removes a task if already present", () => {
      // Setup existing task
      editorElement.innerHTML = `
        <p>
          <span class="task-text-checkbox" data-task-id="t1"></span>
          <span class="task-text" data-task-id="t1">Task Item</span>
        </p>
      `;
      const p = editorElement.querySelector("p");
      const textSpan = p.querySelector(".task-text");
      const textNode = textSpan.firstChild;

      setupSelection(textNode, 0, textNode, 4);

      manager.toggleTaskOnSelection();

      expect(p.querySelector(".task-text-checkbox")).toBeNull();
      expect(p.querySelector(".task-text")).toBeNull();
      expect(p.textContent.trim()).toBe("Task Item");
    });

    it("does nothing for bare root text without a block element", () => {
      editorElement.innerHTML = "Root text";
      const textNode = editorElement.firstChild;

      setupSelection(textNode, 0, textNode, 4);

      manager.toggleTaskOnSelection();

      // No block element found, so no task is created
      expect(callbacks.onTaskCreate).not.toHaveBeenCalled();
      expect(editorElement.textContent).toBe("Root text");
    });

    it("handles multiple blocks", () => {
      editorElement.innerHTML = "<p>Line 1</p><p>Line 2</p>";
      const p1 = editorElement.childNodes[0];
      const p2 = editorElement.childNodes[1];

      setupSelection(p1.firstChild, 0, p2.firstChild, 1);

      manager.toggleTaskOnSelection();

      expect(callbacks.onTaskCreate).toHaveBeenCalledTimes(2);
      expect(p1.querySelector(".task-text-checkbox")).toBeTruthy();
      expect(p2.querySelector(".task-text-checkbox")).toBeTruthy();
    });
  });

  describe("renderCheckboxes", () => {
    it("renders checkboxes for existing tasks", () => {
      editorElement.innerHTML = `<p><span class="task-text" data-task-id="t1">Task 1</span></p>`;
      const tasks = [{ id: "t1", type: "text", checked: false }];

      manager.renderCheckboxes(tasks);

      const checkbox = editorElement.querySelector(".task-text-checkbox[data-task-id='t1']");
      expect(checkbox).toBeTruthy();
      expect(checkbox.innerHTML).toBe(""); // Unchecked
    });

    it("renders checked state correctly", () => {
      editorElement.innerHTML = `<p><span class="task-text" data-task-id="t1">Task 1</span></p>`;
      const tasks = [{ id: "t1", type: "text", checked: true }];

      manager.renderCheckboxes(tasks);

      const checkbox = editorElement.querySelector(".task-text-checkbox[data-task-id='t1']");
      expect(checkbox.innerHTML).toContain("<svg"); // Checked icon

      const span = editorElement.querySelector(".task-text");
      expect(span.classList.contains("task-text--done")).toBe(true);
    });

    it("handles click events on checkboxes", () => {
      editorElement.innerHTML = `<p><span class="task-text" data-task-id="t1">Task 1</span></p>`;
      const tasks = [{ id: "t1", type: "text", checked: false }];
      manager.renderCheckboxes(tasks);

      const checkbox = editorElement.querySelector(".task-text-checkbox");
      checkbox.click();

      expect(callbacks.onTaskToggle).toHaveBeenCalledWith("t1", true);
    });

    it("removes orphaned checkboxes", () => {
      // Checkbox exists in DOM but not in tasks array
      editorElement.innerHTML = `<p><span class="task-text-checkbox" data-task-id="t1"></span><span class="task-text" data-task-id="t1">Task 1</span></p>`;
      const tasks = []; // Empty tasks

      manager.renderCheckboxes(tasks);

      expect(editorElement.querySelector(".task-text-checkbox")).toBeNull();
    });
  });

  describe("cleanupOrphans", () => {
    it("removes tasks from array if DOM element is missing", () => {
      const tasks = [
        { id: "t1", type: "text" },
        { id: "t2", type: "text" },
      ];

      // Only t1 exists in DOM
      editorElement.innerHTML = `<p><span class="task-text" data-task-id="t1">Task 1</span></p>`;

      const changed = manager.cleanupOrphans(tasks);

      expect(changed).toBe(true);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe("t1");
    });

    it("keeps tasks if DOM element exists", () => {
      const tasks = [{ id: "t1", type: "text" }];
      editorElement.innerHTML = `<p><span class="task-text" data-task-id="t1">Task 1</span></p>`;

      const changed = manager.cleanupOrphans(tasks);

      expect(changed).toBe(false);
      expect(tasks).toHaveLength(1);
    });
  });
});
