import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeBareLines, TextTaskManager } from "./TextTaskManager.js";

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

    // Regression: bare inline content at the editor root (first typed line,
    // Chromium's list→text conversion) has no block ancestor, so the toggle
    // silently no-op'd — tasks on such lines could be neither marked nor
    // unmarked. Bare lines are now wrapped in <div>s before operating.
    it("wraps bare root text in a block and creates a task", () => {
      editorElement.innerHTML = "Root text";
      const textNode = editorElement.firstChild;

      setupSelection(textNode, 0, textNode, 4);

      manager.toggleTaskOnSelection();

      expect(callbacks.onTaskCreate).toHaveBeenCalledTimes(1);
      const div = editorElement.querySelector("div");
      expect(div).toBeTruthy();
      expect(div.querySelector(".task-text-checkbox")).toBeTruthy();
      expect(div.querySelector(".task-text").textContent).toBe("Root text");
    });

    it("unmarks a task that sits bare at the editor root", () => {
      editorElement.innerHTML =
        `<span class="task-text-checkbox" data-task-id="t1"></span>` +
        `<span class="task-text" data-task-id="t1">Task line</span>&nbsp;`;
      const textNode = editorElement.querySelector(".task-text").firstChild;

      setupSelection(textNode, 0, textNode, 4);

      manager.toggleTaskOnSelection();

      expect(editorElement.querySelector(".task-text")).toBeNull();
      expect(editorElement.querySelector(".task-text-checkbox")).toBeNull();
      expect(editorElement.textContent).toBe("Task line");
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

    // C-01 regression: selecting text that spans a list (or spans a paragraph
    // across a ul/ol) previously wrapped the whole <ul> — moving its <li>s into
    // a <span> and appending the checkbox as a direct child of <ul>. That
    // invalid markup was discarded on the next parse, blanking the note.
    describe("C-01: list selections must not corrupt markup", () => {
      const assertListIntegrity = (ul) => {
        // A <ul>/<ol> may only contain <li> children.
        for (const child of ul.children) {
          expect(child.tagName).toBe("LI");
        }
        // No <li> may be nested inside a task span.
        expect(ul.querySelector(".task-text li")).toBeNull();
      };

      it("wraps each <li> individually when selecting across list items", () => {
        editorElement.innerHTML = "<ul><li>First item</li><li>Second item</li></ul>";
        const li1 = editorElement.querySelectorAll("li")[0];
        const li2 = editorElement.querySelectorAll("li")[1];
        setupSelection(li1.firstChild, 0, li2.firstChild, 6);

        manager.toggleTaskOnSelection();

        const ul = editorElement.querySelector("ul");
        assertListIntegrity(ul);
        expect(ul.querySelectorAll("li").length).toBe(2);
        expect(ul.querySelectorAll("li .task-text").length).toBe(2);
        expect(editorElement.textContent).toContain("First item");
        expect(editorElement.textContent).toContain("Second item");
      });

      it("does not wrap the <ul> when selection spans a paragraph into a list", () => {
        editorElement.innerHTML = "<p>Intro</p><ul><li>First</li><li>Second</li></ul>";
        const intro = editorElement.querySelector("p").firstChild;
        const li2 = editorElement.querySelectorAll("li")[1].firstChild;
        setupSelection(intro, 0, li2, 6);

        manager.toggleTaskOnSelection();

        assertListIntegrity(editorElement.querySelector("ul"));
        expect(editorElement.textContent).toContain("Intro");
        expect(editorElement.textContent).toContain("First");
        expect(editorElement.textContent).toContain("Second");
      });

      it("does not wrap the <ul> when selection spans a list into a following paragraph", () => {
        editorElement.innerHTML = "<p>Intro</p><ul><li>First</li><li>Second</li></ul><p>Outro</p>";
        const intro = editorElement.querySelector("p").firstChild;
        const outro = editorElement.querySelectorAll("p")[1].firstChild;
        setupSelection(intro, 0, outro, 5);

        manager.toggleTaskOnSelection();

        assertListIntegrity(editorElement.querySelector("ul"));
        expect(editorElement.textContent).toContain("First");
        expect(editorElement.textContent).toContain("Second");
        expect(editorElement.textContent).toContain("Outro");
      });

      // Regression: selecting an entire list places the range boundaries on the
      // <ul> container (or the editor itself), not on a leaf block. Previously
      // that resolved to no block and the whole operation silently no-op'd.
      it("wraps each <li> when the whole list is selected (range on the ul)", () => {
        editorElement.innerHTML = "<ul><li>First item</li><li>Second item</li></ul>";
        setupSelection(editorElement, 0, editorElement, 1);

        manager.toggleTaskOnSelection();

        const ul = editorElement.querySelector("ul");
        assertListIntegrity(ul);
        expect(callbacks.onTaskCreate).toHaveBeenCalledTimes(2);
        expect(ul.querySelectorAll("li .task-text").length).toBe(2);
      });

      it("wraps a single selected list item without touching siblings", () => {
        editorElement.innerHTML = "<ul><li>First item</li><li>Second item</li></ul>";
        const li1 = editorElement.querySelectorAll("li")[0];
        setupSelection(li1.firstChild, 0, li1.firstChild, 5);

        manager.toggleTaskOnSelection();

        const ul = editorElement.querySelector("ul");
        assertListIntegrity(ul);
        expect(ul.querySelectorAll("li").length).toBe(2);
        // Only the first item became a task
        expect(ul.querySelectorAll("li")[0].querySelector(".task-text")).toBeTruthy();
        expect(ul.querySelectorAll("li")[1].querySelector(".task-text")).toBeNull();
      });
    });

    // Regression: converting a list back to normal text yields a single block
    // whose lines are separated by <br> (e.g. "<div>A<br>B<br>C</div>").
    // Previously the whole block was wrapped in one task span, so only the first
    // line got a checkbox and the rest were swallowed into it.
    describe("<br>-separated lines each become their own task", () => {
      it("wraps each line of a <br>-separated block individually", () => {
        editorElement.innerHTML = "<div>Line one<br>Line two<br>Line three</div>";
        const div = editorElement.querySelector("div");
        setupSelection(div.childNodes[0], 0, div.childNodes[4], 10);

        manager.toggleTaskOnSelection();

        expect(callbacks.onTaskCreate).toHaveBeenCalledTimes(3);
        const spans = div.querySelectorAll(".task-text");
        expect(spans.length).toBe(3);
        expect(spans[0].textContent).toBe("Line one");
        expect(spans[1].textContent).toBe("Line two");
        expect(spans[2].textContent).toBe("Line three");
        // The <br> separators between lines are preserved.
        expect(div.querySelectorAll("br").length).toBe(2);
      });

      it("does not create a task for a trailing empty line", () => {
        editorElement.innerHTML = "<div>Only line<br></div>";
        const div = editorElement.querySelector("div");
        setupSelection(div.childNodes[0], 0, div, div.childNodes.length);

        manager.toggleTaskOnSelection();

        expect(callbacks.onTaskCreate).toHaveBeenCalledTimes(1);
        expect(div.querySelectorAll(".task-text").length).toBe(1);
      });

      // Regression: a collapsed cursor in one line of a <br>-separated block
      // previously converted every line of the block, so marking a line also
      // marked its (unrelated) neighbours.
      it("marks only the line containing the cursor, not its siblings", () => {
        editorElement.innerHTML = "<div>Line one<br>Line two</div>";
        const div = editorElement.querySelector("div");
        const lineTwo = div.childNodes[2];
        setupSelection(lineTwo, 2, lineTwo, 2); // collapsed cursor in "Line two"

        manager.toggleTaskOnSelection();

        expect(callbacks.onTaskCreate).toHaveBeenCalledTimes(1);
        const spans = div.querySelectorAll(".task-text");
        expect(spans.length).toBe(1);
        expect(spans[0].textContent).toBe("Line two");
        expect(div.textContent).toContain("Line one");
      });

      it("unmarks only the line containing the cursor", () => {
        editorElement.innerHTML =
          `<div><span class="task-text-checkbox" data-task-id="a"></span>` +
          `<span class="task-text" data-task-id="a">Alpha</span>&nbsp;<br>` +
          `<span class="task-text-checkbox" data-task-id="b"></span>` +
          `<span class="task-text" data-task-id="b">Beta</span>&nbsp;</div>`;
        const div = editorElement.querySelector("div");
        const betaText = div.querySelector('.task-text[data-task-id="b"]').firstChild;
        setupSelection(betaText, 1, betaText, 1);

        manager.toggleTaskOnSelection();

        const spans = div.querySelectorAll(".task-text");
        expect(spans.length).toBe(1);
        expect(spans[0].dataset.taskId).toBe("a");
        expect(div.textContent).toContain("Beta");
        expect(div.querySelectorAll(".task-text-checkbox").length).toBe(1);
      });

      // Toggle convention: a mixed selection (some lines tasks, some not)
      // adds tasks to the missing lines instead of flip-flopping based on
      // whatever the first block happened to contain.
      it("fills in tasks on a mixed selection without touching existing ones", () => {
        editorElement.innerHTML =
          `<div><span class="task-text-checkbox" data-task-id="a"></span>` +
          `<span class="task-text" data-task-id="a">Alpha</span>&nbsp;<br>Beta</div>`;
        const div = editorElement.querySelector("div");
        setupSelection(div, 0, div, div.childNodes.length);

        manager.toggleTaskOnSelection();

        // Only "Beta" got a new task; "Alpha" kept its existing id
        expect(callbacks.onTaskCreate).toHaveBeenCalledTimes(1);
        const spans = div.querySelectorAll(".task-text");
        expect(spans.length).toBe(2);
        expect(spans[0].dataset.taskId).toBe("a");
        expect(spans[1].textContent).toBe("Beta");
      });
    });

    // Regression: unmarking left the   spacer appended at task creation,
    // so every mark/unmark cycle grew the text by one non-breaking space.
    it("mark/unmark round-trip leaves the block byte-identical", () => {
      editorElement.innerHTML = "<p>Hello</p>";
      const p = editorElement.querySelector("p");

      for (let cycle = 0; cycle < 2; cycle++) {
        setupSelection(p.firstChild, 0, p.firstChild, 2);
        manager.toggleTaskOnSelection(); // mark
        expect(p.querySelector(".task-text")).toBeTruthy();

        const taskTextNode = p.querySelector(".task-text").firstChild;
        setupSelection(taskTextNode, 0, taskTextNode, 2);
        manager.toggleTaskOnSelection(); // unmark

        expect(p.innerHTML).toBe("Hello");
      }
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

    // Regression: browser editing (Enter inside a task, list conversions)
    // clones task spans including their id. The clones could never be managed
    // or removed and accumulated as task-styled zombie text.
    it("unwraps duplicate task spans sharing the same id", () => {
      editorElement.innerHTML =
        `<p><span class="task-text" data-task-id="t1">First</span></p>` +
        `<p><span class="task-text" data-task-id="t1">Clone</span></p>`;
      const tasks = [{ id: "t1", type: "text", checked: false }];

      manager.renderCheckboxes(tasks);

      const spans = editorElement.querySelectorAll(".task-text");
      expect(spans.length).toBe(1);
      expect(spans[0].textContent).toBe("First");
      // The clone's text survives as plain text
      expect(editorElement.textContent).toContain("Clone");
      // Exactly one checkbox, restored before the surviving span
      expect(editorElement.querySelectorAll(".task-text-checkbox").length).toBe(1);
    });
  });

  describe("normalizeBareLines", () => {
    it("wraps bare <br>-separated root lines into divs", () => {
      editorElement.innerHTML = "One<br>Two";

      expect(normalizeBareLines(editorElement)).toBe(true);
      expect(editorElement.innerHTML).toBe("<div>One</div><div>Two</div>");
    });

    it("keeps empty lines as their own blocks", () => {
      editorElement.innerHTML = "One<br><br>Two";

      normalizeBareLines(editorElement);
      expect(editorElement.innerHTML).toBe("<div>One</div><div><br></div><div>Two</div>");
    });

    it("wraps bare runs but leaves existing blocks untouched", () => {
      editorElement.innerHTML = "Lead<p>Block</p>Tail";

      normalizeBareLines(editorElement);
      expect(editorElement.innerHTML).toBe("<div>Lead</div><p>Block</p><div>Tail</div>");
    });

    it("wraps bare inline elements (task markup after list conversion)", () => {
      editorElement.innerHTML =
        `<span class="task-text-checkbox" data-task-id="t1"></span>` +
        `<span class="task-text" data-task-id="t1">Task</span>&nbsp;<br>Plain`;

      normalizeBareLines(editorElement);

      const divs = editorElement.querySelectorAll(":scope > div");
      expect(divs.length).toBe(2);
      expect(divs[0].querySelector(".task-text")).toBeTruthy();
      expect(divs[1].textContent).toBe("Plain");
    });

    it("returns false and changes nothing when content is already normalized", () => {
      editorElement.innerHTML = "<p>One</p><p>Two</p>";
      const before = editorElement.innerHTML;

      expect(normalizeBareLines(editorElement)).toBe(false);
      expect(editorElement.innerHTML).toBe(before);
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
