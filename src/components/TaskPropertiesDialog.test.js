import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showTaskPropertiesDialog } from "./TaskPropertiesDialog.js";

vi.mock("../modules/taskManager.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getTaskSettings: vi.fn(async () => ({
      enableDueDates: true,
      enablePriorities: true,
      defaultSort: "dueDate",
    })),
  };
});

describe("TaskPropertiesDialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.getElementById("task-properties-modal")?.remove();
  });

  it("renders with task attributes and status pills", async () => {
    const task = {
      id: "t1",
      status: "open",
      priority: "medium",
      dueDate: "2026-09-25",
      label: "My task label",
    };

    const promise = showTaskPropertiesDialog(task);
    await vi.waitFor(() => {
      expect(document.getElementById("task-properties-modal")).toBeTruthy();
    });

    const overlay = document.getElementById("task-properties-modal");
    const titleInput = overlay.querySelector("#task-prop-title");
    expect(titleInput.value).toBe("My task label");

    const activeStatusPill = overlay.querySelector("#task-status-group .task-prop-pill.active");
    expect(activeStatusPill.dataset.status).toBe("open");

    const activePrioPill = overlay.querySelector("#task-priority-group .task-prop-pill.active");
    expect(activePrioPill.dataset.priority).toBe("medium");

    const dateInput = overlay.querySelector("#task-prop-due-date");
    expect(dateInput.value).toBe("2026-09-25");

    // Close via cancel
    overlay.querySelector(".task-prop-cancel").click();
    const result = await promise;
    expect(result).toBeNull();
    expect(document.getElementById("task-properties-modal")).toBeNull();
  });

  it("saves updated status, priority, dueDate, and title", async () => {
    const task = {
      id: "t1",
      status: "open",
      priority: "none",
      dueDate: "",
    };

    const onSave = vi.fn();
    const promise = showTaskPropertiesDialog(task, { onSave });
    await vi.waitFor(() => {
      expect(document.getElementById("task-properties-modal")).toBeTruthy();
    });

    const overlay = document.getElementById("task-properties-modal");

    // Switch status to doing
    const doingBtn = overlay.querySelector('#task-status-group [data-status="doing"]');
    doingBtn.click();

    // Switch priority to urgent
    const urgentBtn = overlay.querySelector('#task-priority-group [data-priority="urgent"]');
    urgentBtn.click();

    // Set due date
    const dateInput = overlay.querySelector("#task-prop-due-date");
    dateInput.value = "2026-10-15";

    // Set title
    const titleInput = overlay.querySelector("#task-prop-title");
    titleInput.value = "Updated title";

    // Save
    overlay.querySelector(".task-prop-save").click();

    const result = await promise;
    expect(result).toEqual({
      status: "doing",
      priority: "urgent",
      dueDate: "2026-10-15",
      title: "Updated title",
    });
    expect(onSave).toHaveBeenCalledWith(result);
    expect(document.getElementById("task-properties-modal")).toBeNull();
  });

  it("handles quick date buttons (Today, Tomorrow, +7 Days, Clear)", async () => {
    const task = { id: "t1", status: "open" };
    const promise = showTaskPropertiesDialog(task);
    await vi.waitFor(() => {
      expect(document.getElementById("task-properties-modal")).toBeTruthy();
    });

    const overlay = document.getElementById("task-properties-modal");
    const dateInput = overlay.querySelector("#task-prop-due-date");

    overlay.querySelector("#btn-due-today").click();
    expect(dateInput.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    overlay.querySelector("#btn-due-clear").click();
    expect(dateInput.value).toBe("");

    overlay.querySelector(".task-prop-close").click();
    await promise;
  });

  it("+1 Day and +7 Days add to the date already shown, from today when empty", async () => {
    const promise = showTaskPropertiesDialog({ id: "t1", status: "open", dueDate: "2026-12-30" });
    await vi.waitFor(() => {
      expect(document.getElementById("task-properties-modal")).toBeTruthy();
    });
    const overlay = document.getElementById("task-properties-modal");
    const dateInput = overlay.querySelector("#task-prop-due-date");

    overlay.querySelector("#btn-due-day").click();
    expect(dateInput.value).toBe("2026-12-31");
    overlay.querySelector("#btn-due-day").click();
    expect(dateInput.value).toBe("2027-01-01");
    overlay.querySelector("#btn-due-week").click();
    expect(dateInput.value).toBe("2027-01-08");

    overlay.querySelector("#btn-due-clear").click();
    overlay.querySelector("#btn-due-day").click();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const pad = (n) => String(n).padStart(2, "0");
    expect(dateInput.value).toBe(
      `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`,
    );

    overlay.querySelector(".task-prop-close").click();
    await promise;
  });

  it("shows text details read-only, and no Details section without any", async () => {
    let promise = showTaskPropertiesDialog(
      { id: "t1", status: "open" },
      { details: { text: ["about the offer", "by Friday"], strokes: [] } },
    );
    await vi.waitFor(() => {
      expect(document.getElementById("task-properties-modal")).toBeTruthy();
    });
    let overlay = document.getElementById("task-properties-modal");
    expect(overlay.querySelector("#task-prop-details-text").textContent).toBe(
      "about the offer\nby Friday",
    );
    overlay.querySelector(".task-prop-cancel").click();
    await promise;

    promise = showTaskPropertiesDialog(
      { id: "t1", status: "open" },
      { details: { text: [], strokes: [] } },
    );
    await vi.waitFor(() => {
      expect(document.getElementById("task-properties-modal")).toBeTruthy();
    });
    overlay = document.getElementById("task-properties-modal");
    expect(overlay.querySelector(".task-prop-details")).toBeNull();
    overlay.querySelector(".task-prop-cancel").click();
    await promise;
  });

  it("shows detail ink on a canvas", async () => {
    const strokes = [{ id: "d1", x: [0, 100], y: [0, 20], width: 2 }];
    const promise = showTaskPropertiesDialog(
      { id: "t1", status: "open" },
      { details: { text: [], strokes, referenceHeight: 20 } },
    );
    await vi.waitFor(() => {
      expect(document.getElementById("task-properties-modal")).toBeTruthy();
    });
    const overlay = document.getElementById("task-properties-modal");
    expect(overlay.querySelector("canvas#task-prop-details-ink")).toBeTruthy();
    expect(overlay.querySelector("#task-prop-details-text")).toBeNull();
    overlay.querySelector(".task-prop-cancel").click();
    await promise;
  });

  it("fills in the recognised text, and does not store it as a title when unchanged", async () => {
    let promise = showTaskPropertiesDialog(
      { id: "t1", status: "open" },
      { suggestedTitle: "Call Bob" },
    );
    await vi.waitFor(() => {
      expect(document.getElementById("task-properties-modal")).toBeTruthy();
    });
    let overlay = document.getElementById("task-properties-modal");
    expect(overlay.querySelector("#task-prop-title").value).toBe("Call Bob");
    overlay.querySelector(".task-prop-save").click();
    expect((await promise).title).toBe("");

    promise = showTaskPropertiesDialog(
      { id: "t1", status: "open" },
      { suggestedTitle: "Call Bob" },
    );
    await vi.waitFor(() => {
      expect(document.getElementById("task-properties-modal")).toBeTruthy();
    });
    overlay = document.getElementById("task-properties-modal");
    overlay.querySelector("#task-prop-title").value = "Call Rob";
    overlay.querySelector(".task-prop-save").click();
    expect((await promise).title).toBe("Call Rob");
  });

  it("a stored title wins over the recognised text", async () => {
    const promise = showTaskPropertiesDialog(
      { id: "t1", status: "open", title: "Mine" },
      { suggestedTitle: "Call Bob" },
    );
    await vi.waitFor(() => {
      expect(document.getElementById("task-properties-modal")).toBeTruthy();
    });
    const overlay = document.getElementById("task-properties-modal");
    expect(overlay.querySelector("#task-prop-title").value).toBe("Mine");
    overlay.querySelector(".task-prop-save").click();
    expect((await promise).title).toBe("Mine");
  });

  it("saves with Ctrl+Enter", async () => {
    const promise = showTaskPropertiesDialog({ id: "t1", status: "open", title: "T" });
    await vi.waitFor(() => {
      expect(document.getElementById("task-properties-modal")).toBeTruthy();
    });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
    expect((await promise).title).toBe("T");
    expect(document.getElementById("task-properties-modal")).toBeNull();
  });

  it("a plain Enter does not save", async () => {
    const promise = showTaskPropertiesDialog({ id: "t1", status: "open" });
    await vi.waitFor(() => {
      expect(document.getElementById("task-properties-modal")).toBeTruthy();
    });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(document.getElementById("task-properties-modal")).toBeTruthy();
    document.getElementById("task-properties-modal").querySelector(".task-prop-cancel").click();
    await promise;
  });

  it("cancels when the backdrop is clicked, but not when the dialog itself is", async () => {
    const promise = showTaskPropertiesDialog({ id: "t1", status: "open" });
    await vi.waitFor(() => {
      expect(document.getElementById("task-properties-modal")).toBeTruthy();
    });
    const overlay = document.getElementById("task-properties-modal");
    overlay.querySelector(".task-properties-dialog").click();
    expect(document.getElementById("task-properties-modal")).toBeTruthy();
    overlay.click();
    expect(await promise).toBeNull();
    expect(document.getElementById("task-properties-modal")).toBeNull();
  });

  it("keeps exactly one pill checked per group as the selection changes", async () => {
    const promise = showTaskPropertiesDialog({ id: "t1", status: "open", priority: "none" });
    await vi.waitFor(() => {
      expect(document.getElementById("task-properties-modal")).toBeTruthy();
    });
    const overlay = document.getElementById("task-properties-modal");
    const checked = (group) =>
      [...overlay.querySelectorAll(`#${group} [aria-checked="true"]`)].map(
        (b) => b.dataset.status ?? b.dataset.priority,
      );

    overlay.querySelector('#task-status-group [data-status="done"]').click();
    overlay.querySelector('#task-priority-group [data-priority="high"]').click();
    overlay.querySelector('#task-priority-group [data-priority="low"]').click();
    expect(checked("task-status-group")).toEqual(["done"]);
    expect(checked("task-priority-group")).toEqual(["low"]);

    overlay.querySelector(".task-prop-save").click();
    expect(await promise).toMatchObject({ status: "done", priority: "low" });
  });

  it("does not let an invalid stored status or priority through", async () => {
    const promise = showTaskPropertiesDialog({ id: "t1", status: "bogus", priority: "bogus" });
    await vi.waitFor(() => {
      expect(document.getElementById("task-properties-modal")).toBeTruthy();
    });
    document.getElementById("task-properties-modal").querySelector(".task-prop-save").click();
    expect(await promise).toMatchObject({ status: "open", priority: "none" });
  });

  it("closes on Escape key", async () => {
    const task = { id: "t1" };
    const promise = showTaskPropertiesDialog(task);
    await vi.waitFor(() => {
      expect(document.getElementById("task-properties-modal")).toBeTruthy();
    });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    const result = await promise;
    expect(result).toBeNull();
    expect(document.getElementById("task-properties-modal")).toBeNull();
  });

  it("hides priority or due date when disabled in options/settings", async () => {
    const task = { id: "t1" };
    const promise = showTaskPropertiesDialog(task, {
      enableDueDates: false,
      enablePriorities: false,
    });
    await vi.waitFor(() => {
      expect(document.getElementById("task-properties-modal")).toBeTruthy();
    });

    const overlay = document.getElementById("task-properties-modal");
    expect(overlay.querySelector("#task-priority-group")).toBeNull();
    expect(overlay.querySelector("#task-prop-due-date")).toBeNull();

    overlay.querySelector(".task-prop-cancel").click();
    await promise;
  });
});
