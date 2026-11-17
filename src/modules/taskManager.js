/**
 * Task Manager Module
 *
 * Core constants, utilities, state transitions, due date evaluations,
 * and settings for task markers.
 */
import { getSetting, setSetting } from "./storage.js";

export const TASK_STATUS = Object.freeze({
  OPEN: "open",
  DOING: "doing",
  DONE: "done",
});

export const TASK_PRIORITY = Object.freeze({
  NONE: "none",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  URGENT: "urgent",
});

export const PRIORITY_RANK = Object.freeze({
  [TASK_PRIORITY.URGENT]: 4,
  [TASK_PRIORITY.HIGH]: 3,
  [TASK_PRIORITY.MEDIUM]: 2,
  [TASK_PRIORITY.LOW]: 1,
  [TASK_PRIORITY.NONE]: 0,
});

export const TASKS_SETTINGS_KEY = "tasks_settings";

export const DEFAULT_TASK_SETTINGS = Object.freeze({
  enableDueDates: true,
  enablePriorities: true,
  defaultSort: "dueDate",
});

/**
 * Return the next status in the sequential cycle:
 * open -> doing -> done -> open
 *
 * @param {string} currentStatus
 * @returns {string}
 */
export function getNextTaskStatus(currentStatus) {
  switch (currentStatus) {
    case TASK_STATUS.OPEN:
      return TASK_STATUS.DOING;
    case TASK_STATUS.DOING:
      return TASK_STATUS.DONE;
    case TASK_STATUS.DONE:
      return TASK_STATUS.OPEN;
    default:
      return TASK_STATUS.DOING;
  }
}

/**
 * Check if a task or status string is considered completed.
 *
 * @param {Object|string} taskOrStatus
 * @returns {boolean}
 */
export function isTaskCompleted(taskOrStatus) {
  if (!taskOrStatus) return false;
  if (typeof taskOrStatus === "object") {
    if (taskOrStatus.status) {
      return taskOrStatus.status === TASK_STATUS.DONE;
    }
    return Boolean(taskOrStatus.checked);
  }
  return taskOrStatus === TASK_STATUS.DONE;
}

/**
 * Normalize a task object's status, falling back to checked boolean if status is unset.
 *
 * @param {Object} task
 * @returns {string}
 */
export function normalizeTaskStatus(taskOrStatus) {
  if (!taskOrStatus) return TASK_STATUS.OPEN;
  const status = typeof taskOrStatus === "object" ? taskOrStatus.status : taskOrStatus;
  if (status === TASK_STATUS.OPEN || status === TASK_STATUS.DOING || status === TASK_STATUS.DONE) {
    return status;
  }
  if (typeof taskOrStatus === "object" && taskOrStatus.checked) {
    return TASK_STATUS.DONE;
  }
  return TASK_STATUS.OPEN;
}

/**
 * Normalize priority value with safe fallback.
 *
 * @param {string} priority
 * @returns {string}
 */
export function normalizeTaskPriority(priority) {
  if (
    priority === TASK_PRIORITY.LOW ||
    priority === TASK_PRIORITY.MEDIUM ||
    priority === TASK_PRIORITY.HIGH ||
    priority === TASK_PRIORITY.URGENT
  ) {
    return priority;
  }
  return TASK_PRIORITY.NONE;
}

/**
 * Evaluate due date relative to today's local date.
 *
 * @param {string} dueDateStr - Formatted as YYYY-MM-DD
 * @param {Date} [now] - Current date reference
 * @returns {"overdue"|"today"|"upcoming"|null}
 */
export function getDueDateStatus(dueDateStr, now = new Date()) {
  if (!dueDateStr || typeof dueDateStr !== "string") return null;

  const parts = dueDateStr.split("-").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;

  const [year, month, day] = parts;
  const targetDate = new Date(year, month - 1, day);
  // Guard against invalid dates like Feb 31
  if (
    targetDate.getFullYear() !== year ||
    targetDate.getMonth() !== month - 1 ||
    targetDate.getDate() !== day
  ) {
    return null;
  }

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (targetDate.getTime() < today.getTime()) {
    return "overdue";
  }
  if (targetDate.getTime() === today.getTime()) {
    return "today";
  }
  return "upcoming";
}

/**
 * Sort tasks according to criteria.
 *
 * @param {Array<Object>} tasks
 * @param {string} sortBy - "dueDate" | "priority" | "status" | "note"
 * @returns {Array<Object>}
 */
export function sortTasks(tasks, sortBy = "dueDate") {
  if (!Array.isArray(tasks)) return [];
  const list = [...tasks];

  return list.sort((a, b) => {
    if (sortBy === "priority") {
      const pA = PRIORITY_RANK[normalizeTaskPriority(a.priority)] ?? 0;
      const pB = PRIORITY_RANK[normalizeTaskPriority(b.priority)] ?? 0;
      if (pA !== pB) return pB - pA; // higher priority first
    } else if (sortBy === "status") {
      const sOrder = { [TASK_STATUS.DOING]: 0, [TASK_STATUS.OPEN]: 1, [TASK_STATUS.DONE]: 2 };
      const sA = sOrder[normalizeTaskStatus(a)] ?? 1;
      const sB = sOrder[normalizeTaskStatus(b)] ?? 1;
      if (sA !== sB) return sA - sB;
    } else if (sortBy === "note") {
      const tA = (a.noteTitle || "").toLowerCase();
      const tB = (b.noteTitle || "").toLowerCase();
      const cmp = tA.localeCompare(tB);
      if (cmp !== 0) return cmp;
    } else if (sortBy === "dueDate") {
      const dA = a.dueDate || "";
      const dB = b.dueDate || "";
      if (dA && dB && dA !== dB) return dA.localeCompare(dB);
      if (dA && !dB) return -1;
      if (!dA && dB) return 1;
    }

    // Secondary sort: due date if not primary
    if (sortBy !== "dueDate") {
      const dA = a.dueDate || "";
      const dB = b.dueDate || "";
      if (dA && dB && dA !== dB) return dA.localeCompare(dB);
      if (dA && !dB) return -1;
      if (!dA && dB) return 1;
    }

    // Tertiary: priority if not primary
    if (sortBy !== "priority") {
      const pA = PRIORITY_RANK[normalizeTaskPriority(a.priority)] ?? 0;
      const pB = PRIORITY_RANK[normalizeTaskPriority(b.priority)] ?? 0;
      if (pA !== pB) return pB - pA;
    }

    // Final fallback: modified or created timestamp descending
    return (b.modified || b.created || 0) - (a.modified || a.created || 0);
  });
}

/**
 * Filter tasks by criterion.
 *
 * @param {Array<Object>} tasks
 * @param {string} filterBy - "all" | "active" | "doing" | "done" | "overdue"
 * @param {Date} [now]
 * @returns {Array<Object>}
 */
export function filterTasks(tasks, filterBy = "all", now = new Date()) {
  if (!Array.isArray(tasks)) return [];

  switch (filterBy) {
    case "active":
      return tasks.filter((t) => !isTaskCompleted(t));
    case "doing":
      return tasks.filter((t) => normalizeTaskStatus(t) === TASK_STATUS.DOING);
    case "done":
      return tasks.filter((t) => isTaskCompleted(t));
    case "overdue":
      return tasks.filter(
        (t) => !isTaskCompleted(t) && getDueDateStatus(t.dueDate, now) === "overdue",
      );
    default:
      return tasks;
  }
}

/**
 * Load tasks settings from storage with defaults.
 *
 * @returns {Promise<Object>}
 */
export async function getTaskSettings() {
  try {
    const saved = await getSetting(TASKS_SETTINGS_KEY);
    return { ...DEFAULT_TASK_SETTINGS, ...(saved || {}) };
  } catch (_e) {
    return { ...DEFAULT_TASK_SETTINGS };
  }
}

/**
 * Save updated tasks settings to storage.
 *
 * @param {Object} patch
 * @returns {Promise<Object>}
 */
export async function saveTaskSettings(patch) {
  const current = await getTaskSettings();
  const updated = { ...current, ...patch };
  await setSetting(TASKS_SETTINGS_KEY, updated);
  return updated;
}
