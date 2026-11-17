/**
 * The Markers tab's task list, driven through the public renderOverview entry
 * point: the filter and sort controls, the status button, the options (⋮) flow
 * into the Task Properties dialog, and row navigation.
 *
 * Storage is an in-memory map of note objects that getNote hands out by
 * reference, so what the code writes back (updateNote) can be compared with what
 * the user did.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../i18n/index.js", () => ({ t: (key, fallback) => fallback || key }));
vi.mock("../modules/pdfManager.js", () => ({ extractPdfText: vi.fn(() => Promise.resolve("")) }));
vi.mock("../utils/icons.js", () => ({ getIcon: vi.fn(() => "") }));
vi.mock("../utils/noteRenderer.js", () => ({
  drawStroke: vi.fn(),
  getStrokeBounds: vi.fn(),
  getThemePalette: vi.fn(),
  renderNotePreview: vi.fn(),
  renderNoteSnapshot: vi.fn(),
}));
vi.mock("./modals.js", () => ({
  showConfirmDialog: vi.fn(),
  showEditNotebookModal: vi.fn(),
  showEditNoteModal: vi.fn(),
  showMoveCopyDialog: vi.fn(),
}));
vi.mock("./notebookCard.js", () => ({ renderNotebookCard: vi.fn() }));

const navigateTo = vi.fn();
vi.mock("../modules/router.js", () => ({ navigateTo: (...a) => navigateTo(...a) }));

const showTaskPropertiesDialog = vi.fn();
vi.mock("./TaskPropertiesDialog.js", () => ({
  showTaskPropertiesDialog: (...a) => showTaskPropertiesDialog(...a),
}));

const notes = new Map();
const updateNote = vi.fn(() => Promise.resolve());
vi.mock("../modules/storage.js", () => ({
  copyNote: vi.fn(),
  deleteNote: vi.fn(),
  deleteNotebook: vi.fn(),
  getAllNotebooks: vi.fn(() => Promise.resolve([])),
  getAllNotes: vi.fn(() => Promise.resolve([...notes.values()])),
  getDeletedNotebooks: vi.fn(() => Promise.resolve([])),
  getDeletedNotes: vi.fn(() => Promise.resolve([])),
  getNote: vi.fn((id) => Promise.resolve(notes.get(id) ?? null)),
  getNotebook: vi.fn(),
  getNotesByNotebook: vi.fn(() => Promise.resolve([])),
  getQuickNotes: vi.fn(() => Promise.resolve([])),
  getSetting: vi.fn(() => Promise.resolve(null)),
  moveNote: vi.fn(),
  purgeNote: vi.fn(),
  purgeNotebook: vi.fn(),
  restoreNote: vi.fn(),
  restoreNotebook: vi.fn(),
  updateNote: (...a) => updateNote(...a),
}));

function isoDay(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function textTask(id, label, extra = {}) {
  return { id, type: "text", title: label, status: "open", priority: "none", ...extra };
}

function addNote(id, tasks, extra = {}) {
  const note = { id, title: `Note ${id}`, content: "", strokes: [], tasks, ...extra };
  notes.set(id, note);
  return note;
}

async function openMarkersTab() {
  const { renderOverview } = await import("./overviewMode.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  await renderOverview(container);
  container.querySelector('[data-tab="markers"]').click();
  await vi.waitFor(() => {
    expect(container.querySelector(".tasks-controls, .empty-state")).not.toBeNull();
  });
  return container;
}

const labels = (container) =>
  [...container.querySelectorAll(".task-item .task-item__label")].map((el) => el.textContent);

/** Wait for the list to be re-rendered after a change. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("overviewMode - task list", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = "";
    notes.clear();
    navigateTo.mockReset();
    updateNote.mockClear();
    showTaskPropertiesDialog.mockReset();
  });

  it("shows an empty state when no note has tasks", async () => {
    addNote("n1", []);
    notes.get("n1").content = "";
    const container = await openMarkersTab();
    expect(container.querySelector(".task-item")).toBeNull();
    expect(container.querySelector(".empty-state")).not.toBeNull();
  });

  it("marks overdue, due-today, priority and done tasks with their classes", async () => {
    addNote("n1", [
      textTask("a", "Late", { dueDate: isoDay(-3), priority: "high" }),
      textTask("b", "Today", { dueDate: isoDay(0) }),
      textTask("c", "Finished", { status: "done", priority: "urgent" }),
    ]);
    const container = await openMarkersTab();
    // Done tasks are filtered out by the default "Active" filter; show everything.
    container.querySelector("#tasks-filter-select").value = "all";
    container.querySelector("#tasks-filter-select").dispatchEvent(new Event("change"));
    await settle();

    const item = (id) => container.querySelector(`.task-item[data-task-id="${id}"]`);
    expect(item("a").classList.contains("task-item--overdue")).toBe(true);
    expect(item("a").classList.contains("task-item--prio-high")).toBe(true);
    expect(item("b").classList.contains("task-item--today")).toBe(true);
    expect(item("c").classList.contains("task-item--done")).toBe(true);
    expect(item("c").classList.contains("task-item--prio-urgent")).toBe(true);
    expect(item("a").querySelector(".task-item__due-badge").textContent).toBe(isoDay(-3));
  });

  describe("filter and sort", () => {
    beforeEach(() => {
      addNote("n1", [
        textTask("open", "Open one", { priority: "low", dueDate: isoDay(5) }),
        textTask("doing", "Doing one", { status: "doing", priority: "urgent", dueDate: isoDay(9) }),
        textTask("late", "Late one", { priority: "medium", dueDate: isoDay(-2) }),
        textTask("done", "Done one", { status: "done" }),
      ]);
    });

    async function choose(container, selector, value) {
      const select = container.querySelector(selector);
      select.value = value;
      select.dispatchEvent(new Event("change"));
      await settle();
    }

    it("defaults to the active tasks, sorted by due date with undated last", async () => {
      const container = await openMarkersTab();
      expect(labels(container)).toEqual(["Late one", "Open one", "Doing one"]);
    });

    it.each([
      ["all", ["Late one", "Open one", "Doing one", "Done one"]],
      ["doing", ["Doing one"]],
      ["overdue", ["Late one"]],
      ["done", ["Done one"]],
    ])("filter '%s' shows the matching tasks only", async (filter, expected) => {
      const container = await openMarkersTab();
      await choose(container, "#tasks-filter-select", filter);
      expect(labels(container)).toEqual(expected);
    });

    it("sorts by priority, urgent first", async () => {
      const container = await openMarkersTab();
      await choose(container, "#tasks-sort-select", "priority");
      expect(labels(container)).toEqual(["Doing one", "Late one", "Open one"]);
    });

    it("sorts by note title", async () => {
      addNote("n0", [textTask("z", "Zebra"), textTask("a", "Apple")], { title: "A first note" });
      const container = await openMarkersTab();
      await choose(container, "#tasks-sort-select", "note");
      expect(container.querySelector(".task-item .task-item__note").textContent).toBe(
        "A first note",
      );
    });

    it("keeps the chosen filter and sort across re-renders", async () => {
      const container = await openMarkersTab();
      await choose(container, "#tasks-filter-select", "doing");
      await choose(container, "#tasks-sort-select", "priority");
      expect(container.querySelector("#tasks-filter-select").value).toBe("doing");
      expect(container.querySelector("#tasks-sort-select").value).toBe("priority");
    });

    it("says so when the filter matches nothing", async () => {
      notes.clear();
      addNote("n1", [textTask("only", "Only open")]);
      const container = await openMarkersTab();
      await choose(container, "#tasks-filter-select", "doing");
      expect(container.querySelector(".task-item")).toBeNull();
      expect(container.querySelector(".tasks-list .empty-state").textContent).toContain(
        "No matching tasks found.",
      );
    });
  });

  describe("status button", () => {
    it("cycles open → doing → done and saves each step to the note", async () => {
      const note = addNote("n1", [textTask("t", "Task")]);
      const container = await openMarkersTab();
      const statusOf = () => note.tasks[0].status;

      container.querySelector(".task-item__checkbox").click();
      await vi.waitFor(() => expect(statusOf()).toBe("doing"));
      expect(updateNote).toHaveBeenLastCalledWith(
        "n1",
        expect.objectContaining({ tasks: note.tasks }),
      );
      expect(note.tasks[0].checked).toBe(false);

      await settle();
      container.querySelector(".task-item__checkbox").click();
      await vi.waitFor(() => expect(statusOf()).toBe("done"));
      expect(note.tasks[0].checked).toBe(true);
      expect(typeof note.tasks[0].modified).toBe("number");
    });

    it("updates the list after the change and does not navigate", async () => {
      addNote("n1", [textTask("t", "Task")]);
      const container = await openMarkersTab();
      container.querySelector(".task-item__checkbox").click();
      await vi.waitFor(() => {
        expect(container.querySelector(".task-item__checkbox").dataset.status).toBe("doing");
      });
      expect(navigateTo).not.toHaveBeenCalled();
    });
  });

  describe("options (⋮) and the properties dialog", () => {
    const open = async () => {
      const container = await openMarkersTab();
      container.querySelector(".task-item__options").click();
      await vi.waitFor(() => expect(showTaskPropertiesDialog).toHaveBeenCalled());
      return container;
    };

    it("saves what the dialog returns to the note and shows the new title", async () => {
      const note = addNote("n1", [textTask("t", "Old title")]);
      showTaskPropertiesDialog.mockResolvedValue({
        status: "done",
        priority: "urgent",
        dueDate: isoDay(7),
        title: "Renamed",
      });
      const container = await open();
      await vi.waitFor(() => expect(updateNote).toHaveBeenCalled());

      const saved = note.tasks[0];
      expect(saved).toMatchObject({
        status: "done",
        checked: true,
        priority: "urgent",
        dueDate: isoDay(7),
        title: "Renamed",
        label: "Renamed",
      });
      expect(updateNote).toHaveBeenCalledWith("n1", expect.objectContaining({ tasks: note.tasks }));

      // "Active" hides the done task now; the row is re-rendered, not stale.
      await vi.waitFor(() => expect(container.querySelector(".task-item")).toBeNull());
    });

    it("writes nothing when the dialog is cancelled", async () => {
      const note = addNote("n1", [textTask("t", "Keep")]);
      showTaskPropertiesDialog.mockResolvedValue(null);
      await open();
      await settle();
      expect(updateNote).not.toHaveBeenCalled();
      expect(note.tasks[0].title).toBe("Keep");
    });

    it("clears the stored title when the dialog returns an empty one", async () => {
      const note = addNote("n1", [textTask("t", "Custom")]);
      showTaskPropertiesDialog.mockResolvedValue({
        status: "open",
        priority: "none",
        dueDate: "",
        title: "",
      });
      await open();
      await vi.waitFor(() => expect(updateNote).toHaveBeenCalled());
      expect(note.tasks[0].title).toBe("");
      expect(note.tasks[0].label).toBe("");
    });

    it("hands the dialog the details and the recognised text from the note", async () => {
      const bar = (id, y) => ({ id, x: [100, 300], y: [y, y + 20], width: 2 });
      addNote("n1", [{ id: "s", type: "stroke", strokeIds: ["h"], status: "open" }], {
        strokes: [bar("h", 100), bar("d1", 135)],
        recognition: { words: [{ text: "Call", strokeIds: ["h"] }] },
      });
      showTaskPropertiesDialog.mockResolvedValue(null);
      await open();

      const [task, options] = showTaskPropertiesDialog.mock.calls[0];
      expect(task.id).toBe("s");
      expect(options.suggestedTitle).toBe("Call");
      expect(options.details.strokes.map((s) => s.id)).toEqual(["d1"]);
    });

    it("offers a text task's detail lines", async () => {
      addNote("n1", [{ id: "x", type: "text", status: "open" }], {
        content: `<div><span class="task-text" data-task-id="x">Call Bob</span><br>about the offer</div>`,
      });
      showTaskPropertiesDialog.mockResolvedValue(null);
      await open();

      const [, options] = showTaskPropertiesDialog.mock.calls[0];
      expect(options.suggestedTitle).toBe("Call Bob");
      expect(options.details.text).toEqual(["about the offer"]);
    });

    it("does not navigate to the note", async () => {
      addNote("n1", [textTask("t", "Task")]);
      showTaskPropertiesDialog.mockResolvedValue(null);
      await open();
      expect(navigateTo).not.toHaveBeenCalled();
    });
  });

  it("opens the note at the task when its row is clicked", async () => {
    addNote("n1", [textTask("t", "Task")]);
    const container = await openMarkersTab();
    container.querySelector(".task-item .task-item__label").click();
    expect(navigateTo).toHaveBeenCalledWith("notebook", { noteId: "n1", taskId: "t" });
  });

  it("lists tasks from every note", async () => {
    addNote("n1", [textTask("a", "First")], { title: "One" });
    addNote("n2", [textTask("b", "Second")], { title: "Two" });
    const container = await openMarkersTab();
    expect(labels(container).sort()).toEqual(["First", "Second"]);
    expect(
      [...container.querySelectorAll(".task-item__note")].map((el) => el.textContent).sort(),
    ).toEqual(["One", "Two"]);
  });
});
