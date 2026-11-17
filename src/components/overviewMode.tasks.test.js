import { describe, expect, it, vi } from "vitest";
import { deriveTaskLabel, extractTasksFromNote } from "./overviewMode.js";

vi.mock("../i18n/index.js", () => ({ t: (key, fallback) => fallback || key }));
vi.mock("../modules/pdfManager.js", () => ({ extractPdfText: vi.fn(() => Promise.resolve("")) }));
vi.mock("../modules/storage.js", () => ({
  getNote: vi.fn(),
  getAllNotes: vi.fn(() => Promise.resolve([])),
  updateNote: vi.fn(),
  getSetting: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("../modules/taskManager.js", async () => {
  const actual = await vi.importActual("../modules/taskManager.js");
  return actual;
});

describe("overviewMode - task extraction and derivation", () => {
  it("extracts stroke tasks and normalizes status, priority, and due date", () => {
    const note = {
      id: "note-1",
      title: "Test Note",
      tasks: [
        {
          id: "task-1",
          strokeIds: ["s1", "s2"],
          checked: false,
          status: "doing",
          priority: "high",
          dueDate: "2026-09-25",
          customTitle: "Buy groceries",
        },
        {
          id: "task-2",
          strokeIds: ["s3"],
          checked: true,
          // no status, priority, or dueDate
        },
      ],
      strokes: [
        { id: "s1", points: [] },
        { id: "s2", points: [] },
        { id: "s3", points: [] },
      ],
    };

    const tasks = extractTasksFromNote(note);
    expect(tasks).toHaveLength(2);

    expect(tasks[0]).toMatchObject({
      id: "task-1",
      noteId: "note-1",
      noteTitle: "Test Note",
      type: "stroke",
      checked: false,
      status: "doing",
      priority: "high",
      dueDate: "2026-09-25",
      customTitle: "Buy groceries",
    });

    // Backward compatibility: checked: true maps to status: "done", priority: "none"
    expect(tasks[1]).toMatchObject({
      id: "task-2",
      type: "stroke",
      checked: true,
      status: "done",
      priority: "none",
      dueDate: "",
    });
  });

  it("extracts text tasks with data-status, data-priority, data-due-date, and data-title", () => {
    const note = {
      id: "note-2",
      title: "Work Notes",
      content: `
        <p>Regular text</p>
        <p><span class="task-checkbox" data-task-id="t-1" data-status="doing" data-priority="urgent"></span><span class="task-text" data-task-id="t-1" data-status="doing" data-priority="urgent" data-due-date="2026-09-21" data-title="Fix crash">Fix the urgent crash</span></p>
        <p><span class="task-checkbox is-checked" data-task-id="t-2"></span><span class="task-text is-checked" data-task-id="t-2">Review PR</span></p>
      `,
    };

    const tasks = extractTasksFromNote(note);
    expect(tasks).toHaveLength(2);

    expect(tasks[0]).toMatchObject({
      id: "t-1",
      noteId: "note-2",
      type: "text",
      status: "doing",
      priority: "urgent",
      dueDate: "2026-09-21",
      customTitle: "Fix crash",
      text: "Fix the urgent crash",
    });

    // Backward compat check
    expect(tasks[1]).toMatchObject({
      id: "t-2",
      noteId: "note-2",
      type: "text",
      checked: true,
      status: "done",
      priority: "none",
      text: "Review PR",
    });
  });

  it("derives task label prioritizing customTitle over recognition or text", () => {
    const strokeTaskWithCustom = {
      id: "t-1",
      type: "stroke",
      customTitle: "My Custom Title",
      strokes: [],
    };
    expect(deriveTaskLabel(strokeTaskWithCustom)).toBe("My Custom Title");

    const textTaskWithCustom = {
      id: "t-2",
      type: "text",
      customTitle: "Custom Text Title",
      text: "Underlying text content",
    };
    expect(deriveTaskLabel(textTaskWithCustom)).toBe("Custom Text Title");

    const textTaskWithoutCustom = {
      id: "t-3",
      type: "text",
      text: "Fallback text content",
    };
    expect(deriveTaskLabel(textTaskWithoutCustom)).toBe("Fallback text content");
  });
});
