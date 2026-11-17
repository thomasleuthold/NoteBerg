import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TASK_SETTINGS,
  filterTasks,
  getDueDateStatus,
  getNextTaskStatus,
  getTaskSettings,
  isTaskCompleted,
  normalizeTaskPriority,
  normalizeTaskStatus,
  saveTaskSettings,
  sortTasks,
  TASK_PRIORITY,
  TASK_STATUS,
} from "./taskManager.js";

const mockStore = new Map();

vi.mock("./storage.js", () => ({
  getSetting: vi.fn(async (key) => mockStore.get(key) ?? null),
  setSetting: vi.fn(async (key, val) => mockStore.set(key, val)),
}));

describe("taskManager", () => {
  beforeEach(() => {
    mockStore.clear();
  });

  describe("getNextTaskStatus", () => {
    it("cycles open -> doing -> done -> open", () => {
      expect(getNextTaskStatus(TASK_STATUS.OPEN)).toBe(TASK_STATUS.DOING);
      expect(getNextTaskStatus(TASK_STATUS.DOING)).toBe(TASK_STATUS.DONE);
      expect(getNextTaskStatus(TASK_STATUS.DONE)).toBe(TASK_STATUS.OPEN);
    });

    it("falls back to doing for unknown status", () => {
      expect(getNextTaskStatus("unknown")).toBe(TASK_STATUS.DOING);
      expect(getNextTaskStatus(undefined)).toBe(TASK_STATUS.DOING);
    });
  });

  describe("isTaskCompleted", () => {
    it("recognizes done status", () => {
      expect(isTaskCompleted(TASK_STATUS.DONE)).toBe(true);
      expect(isTaskCompleted({ status: TASK_STATUS.DONE })).toBe(true);
      expect(isTaskCompleted({ status: TASK_STATUS.DOING })).toBe(false);
      expect(isTaskCompleted({ status: TASK_STATUS.OPEN })).toBe(false);
    });

    it("falls back to checked boolean when status is missing", () => {
      expect(isTaskCompleted({ checked: true })).toBe(true);
      expect(isTaskCompleted({ checked: false })).toBe(false);
    });

    it("returns false for null/empty", () => {
      expect(isTaskCompleted(null)).toBe(false);
      expect(isTaskCompleted(undefined)).toBe(false);
    });
  });

  describe("normalizeTaskStatus", () => {
    it("returns valid status intact", () => {
      expect(normalizeTaskStatus({ status: "doing" })).toBe("doing");
      expect(normalizeTaskStatus({ status: "done" })).toBe("done");
      expect(normalizeTaskStatus({ status: "open" })).toBe("open");
    });

    it("derives from checked if status is missing or invalid", () => {
      expect(normalizeTaskStatus({ checked: true })).toBe("done");
      expect(normalizeTaskStatus({ checked: false })).toBe("open");
      expect(normalizeTaskStatus({ status: "invalid", checked: true })).toBe("done");
      expect(normalizeTaskStatus(null)).toBe("open");
    });
  });

  describe("normalizeTaskPriority", () => {
    it("validates priority levels", () => {
      expect(normalizeTaskPriority(TASK_PRIORITY.URGENT)).toBe("urgent");
      expect(normalizeTaskPriority(TASK_PRIORITY.HIGH)).toBe("high");
      expect(normalizeTaskPriority(TASK_PRIORITY.MEDIUM)).toBe("medium");
      expect(normalizeTaskPriority(TASK_PRIORITY.LOW)).toBe("low");
      expect(normalizeTaskPriority("invalid")).toBe("none");
      expect(normalizeTaskPriority(null)).toBe("none");
    });
  });

  describe("getDueDateStatus", () => {
    const referenceDate = new Date(2026, 8, 20, 12, 0, 0); // 2026-09-20

    it("identifies overdue dates", () => {
      expect(getDueDateStatus("2026-09-19", referenceDate)).toBe("overdue");
      expect(getDueDateStatus("2026-08-31", referenceDate)).toBe("overdue");
      expect(getDueDateStatus("2025-12-31", referenceDate)).toBe("overdue");
    });

    it("identifies today", () => {
      expect(getDueDateStatus("2026-09-20", referenceDate)).toBe("today");
    });

    it("identifies upcoming dates", () => {
      expect(getDueDateStatus("2026-09-21", referenceDate)).toBe("upcoming");
      expect(getDueDateStatus("2026-10-01", referenceDate)).toBe("upcoming");
    });

    it("returns null for invalid or missing dates", () => {
      expect(getDueDateStatus(null)).toBeNull();
      expect(getDueDateStatus("")).toBeNull();
      expect(getDueDateStatus("not-a-date")).toBeNull();
      expect(getDueDateStatus("2026-02-31")).toBeNull();
    });
  });

  describe("sortTasks", () => {
    const tasks = [
      {
        id: "1",
        noteTitle: "B Note",
        priority: "low",
        dueDate: "2026-09-25",
        status: "open",
        modified: 100,
      },
      {
        id: "2",
        noteTitle: "A Note",
        priority: "urgent",
        dueDate: "2026-09-15",
        status: "doing",
        modified: 200,
      },
      {
        id: "3",
        noteTitle: "C Note",
        priority: "medium",
        dueDate: "",
        status: "done",
        modified: 300,
      },
      {
        id: "4",
        noteTitle: "A Note",
        priority: "high",
        dueDate: "2026-09-20",
        status: "open",
        modified: 400,
      },
    ];

    it("sorts by dueDate ascending with missing dates last", () => {
      const sorted = sortTasks(tasks, "dueDate");
      expect(sorted.map((t) => t.id)).toEqual(["2", "4", "1", "3"]);
    });

    it("sorts by priority descending", () => {
      const sorted = sortTasks(tasks, "priority");
      expect(sorted.map((t) => t.id)).toEqual(["2", "4", "3", "1"]);
    });

    it("sorts by status (doing -> open -> done)", () => {
      const sorted = sortTasks(tasks, "status");
      expect(sorted[0].id).toBe("2"); // doing
      expect(["1", "4"]).toContain(sorted[1].id); // open
      expect(["1", "4"]).toContain(sorted[2].id); // open
      expect(sorted[3].id).toBe("3"); // done
    });

    it("sorts by noteTitle", () => {
      const sorted = sortTasks(tasks, "note");
      expect(sorted[0].noteTitle).toBe("A Note");
      expect(sorted[1].noteTitle).toBe("A Note");
      expect(sorted[2].noteTitle).toBe("B Note");
      expect(sorted[3].noteTitle).toBe("C Note");
    });

    it("handles empty or non-array input safely", () => {
      expect(sortTasks(null)).toEqual([]);
      expect(sortTasks([])).toEqual([]);
    });
  });

  describe("filterTasks", () => {
    const referenceDate = new Date(2026, 8, 20);
    const tasks = [
      { id: "1", status: "open", checked: false, dueDate: "2026-09-15" }, // overdue
      { id: "2", status: "doing", checked: false, dueDate: "2026-09-20" }, // today
      { id: "3", status: "done", checked: true, dueDate: "2026-09-10" }, // completed (even if overdue date)
    ];

    it("filters active tasks (open + doing)", () => {
      const active = filterTasks(tasks, "active", referenceDate);
      expect(active.map((t) => t.id)).toEqual(["1", "2"]);
    });

    it("filters doing tasks", () => {
      const doing = filterTasks(tasks, "doing", referenceDate);
      expect(doing.map((t) => t.id)).toEqual(["2"]);
    });

    it("filters done tasks", () => {
      const done = filterTasks(tasks, "done", referenceDate);
      expect(done.map((t) => t.id)).toEqual(["3"]);
    });

    it("filters overdue tasks (excluding completed ones)", () => {
      const overdue = filterTasks(tasks, "overdue", referenceDate);
      expect(overdue.map((t) => t.id)).toEqual(["1"]);
    });

    it("filters all", () => {
      expect(filterTasks(tasks, "all", referenceDate).length).toBe(3);
    });
  });

  describe("sortTasks tie-breakers", () => {
    const t = (id, extra) => ({
      id,
      priority: "none",
      status: "open",
      dueDate: "",
      noteTitle: "N",
      modified: 0,
      ...extra,
    });
    const ids = (list) => list.map((x) => x.id);

    it("priority ties fall back to due date, then to the most recently modified", () => {
      const list = [
        t("late", { priority: "high", dueDate: "2026-12-01" }),
        t("undated-old", { priority: "high", modified: 1 }),
        t("soon", { priority: "high", dueDate: "2026-10-01" }),
        t("undated-new", { priority: "high", modified: 9 }),
      ];
      expect(ids(sortTasks(list, "priority"))).toEqual([
        "soon",
        "late",
        "undated-new",
        "undated-old",
      ]);
    });

    it("status ties fall back to due date, then priority", () => {
      const list = [
        t("a", { status: "doing", priority: "low", dueDate: "2026-11-01" }),
        t("b", { status: "doing", priority: "urgent", dueDate: "2026-11-01" }),
        t("c", { status: "doing", dueDate: "2026-10-01" }),
      ];
      expect(ids(sortTasks(list, "status"))).toEqual(["c", "b", "a"]);
    });

    it("note-title ties fall back to due date", () => {
      const list = [
        t("b", { noteTitle: "Same", dueDate: "2026-12-01" }),
        t("a", { noteTitle: "Same", dueDate: "2026-10-01" }),
        t("z", { noteTitle: "Alpha" }),
      ];
      expect(ids(sortTasks(list, "note"))).toEqual(["z", "a", "b"]);
    });

    it("due date ties fall back to priority, then recency", () => {
      const list = [
        t("low", { dueDate: "2026-10-01", priority: "low" }),
        t("high", { dueDate: "2026-10-01", priority: "high" }),
        t("old", { dueDate: "2026-10-01", priority: "low", modified: 1 }),
        t("new", { dueDate: "2026-10-01", priority: "low", modified: 5 }),
      ];
      expect(ids(sortTasks(list, "dueDate"))).toEqual(["high", "new", "old", "low"]);
    });

    it("does not mutate its input", () => {
      const list = [t("b", { dueDate: "2026-12-01" }), t("a", { dueDate: "2026-10-01" })];
      sortTasks(list, "dueDate");
      expect(ids(list)).toEqual(["b", "a"]);
    });
  });

  describe("taskSettings", () => {
    it("returns defaults when no settings stored", async () => {
      const settings = await getTaskSettings();
      expect(settings).toEqual(DEFAULT_TASK_SETTINGS);
    });

    it("falls back to the defaults when storage fails", async () => {
      const { getSetting } = await import("./storage.js");
      getSetting.mockRejectedValueOnce(new Error("db closed"));
      expect(await getTaskSettings()).toEqual(DEFAULT_TASK_SETTINGS);
    });

    it("keeps earlier changes when another setting is saved", async () => {
      await saveTaskSettings({ enableDueDates: false });
      await saveTaskSettings({ defaultSort: "priority" });
      expect(await getTaskSettings()).toEqual({
        ...DEFAULT_TASK_SETTINGS,
        enableDueDates: false,
        defaultSort: "priority",
      });
    });

    it("merges saved settings over defaults", async () => {
      await saveTaskSettings({ enableDueDates: false });
      const settings = await getTaskSettings();
      expect(settings.enableDueDates).toBe(false);
      expect(settings.enablePriorities).toBe(true);
      expect(settings.defaultSort).toBe("dueDate");
    });
  });
});
