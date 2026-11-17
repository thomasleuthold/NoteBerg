/**
 * Task Properties Dialog
 *
 * Modal dialog for inspecting and updating a task's status, priority,
 * due date, and label override.
 */

import { t } from "../i18n/index.js";
import {
  getTaskSettings,
  normalizeTaskPriority,
  normalizeTaskStatus,
  TASK_PRIORITY,
  TASK_STATUS,
} from "../modules/taskManager.js";
import { getIcon } from "../utils/icons.js";
import { drawStroke, getStrokeBounds, getThemePalette } from "../utils/noteRenderer.js";

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Add days to the date in `value` (YYYY-MM-DD), or to today when it is empty
 * or not a valid date. Done in local time so DST changes cannot shift the day.
 */
function addDaysTo(value, days) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  const base = parts ? new Date(+parts[1], +parts[2] - 1, +parts[3]) : new Date();
  base.setDate(base.getDate() + days);
  return formatDate(base);
}

/** Headline height, in pixels, that detail ink is scaled relative to. */
const DETAIL_REFERENCE_PX = 40;
const DETAIL_MAX_HEIGHT_PX = 180;

/**
 * Draw the ink written below the headline. It keeps the headline's proportions
 * (the headline is the unit, so the detail reads as the same handwriting) and
 * shrinks only as far as needed to fit the width or the height cap.
 */
function drawDetailInk(canvas, strokes, referenceHeight) {
  const bounds = getStrokeBounds(strokes);
  if (!bounds) return;
  const padding = 4;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.getBoundingClientRect().width || 300;
  const scale = Math.min(
    DETAIL_REFERENCE_PX / Math.max(referenceHeight || DETAIL_REFERENCE_PX, 1),
    (width - padding * 2) / Math.max(1, bounds.width),
    (DETAIL_MAX_HEIGHT_PX - padding * 2) / Math.max(1, bounds.height),
  );
  const height = Math.ceil(bounds.height * scale + padding * 2);

  canvas.style.height = `${height}px`;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.translate(padding - bounds.minX * scale, padding - bounds.minY * scale);
  ctx.scale(scale, scale);
  const palette = getThemePalette();
  for (const stroke of strokes) drawStroke(ctx, stroke, palette);
}

/**
 * Show the Task Properties modal dialog.
 *
 * @param {Object} task - Task data object
 * @param {Object} [options]
 * @param {Function} [options.onSave] - Callback with updated task attributes
 * @param {string} [options.suggestedTitle] - Text already recognised for the task. Used
 *   as the field's default; saving it unchanged stores no title, so the task keeps
 *   following the recognition (a stored title would freeze it).
 * @param {{text?: string[], strokes?: object[], referenceHeight?: number|null}} [options.details]
 *   What the note holds right below the task's headline (see taskDetails.js).
 *   Shown read-only: the detail lives in the note, not on the task.
 * @returns {Promise<Object|null>} Resolves with updated data on save, or null on cancel
 */
export async function showTaskPropertiesDialog(task, options = {}) {
  // Remove any lingering task properties modal
  document.getElementById("task-properties-modal")?.remove();

  const settings = await getTaskSettings();
  const enableDueDates = options.enableDueDates ?? settings.enableDueDates;
  const enablePriorities = options.enablePriorities ?? settings.enablePriorities;

  let currentStatus = normalizeTaskStatus(task);
  let currentPriority = normalizeTaskPriority(task.priority);
  const currentDueDate = task.dueDate || "";
  const suggestedTitle = (options.suggestedTitle || "").trim();
  const initialTitle = task.title || task.label || suggestedTitle;
  const detailText = options.details?.text ?? [];
  const detailStrokes = options.details?.strokes ?? [];
  const hasDetails = detailText.length > 0 || detailStrokes.length > 0;

  return new Promise((resolve) => {
    let closed = false;

    const overlay = document.createElement("div");
    overlay.id = "task-properties-modal";
    overlay.className = "modal-overlay task-properties-overlay";

    overlay.innerHTML = `
      <div class="modal-dialog task-properties-dialog" role="dialog" aria-modal="true" aria-labelledby="task-prop-dialog-title">
        <div class="modal-header">
          <h3 class="modal-title" id="task-prop-dialog-title">${t("tasks.properties.title", "Task Properties")}</h3>
          <button class="modal-close task-prop-close" aria-label="${t("modals.close", "Close")}">&times;</button>
        </div>
        <div class="modal-body task-properties-body">
          <div class="task-prop-field">
            <label for="task-prop-title" class="task-prop-label">
              ${t("tasks.properties.name", "Task Name / Label")}
            </label>
            <input
              type="text"
              id="task-prop-title"
              class="task-prop-input"
              value="${escapeHtml(initialTitle)}"
              placeholder="${t("tasks.properties.namePlaceholder", "Handwritten task or custom title")}"
            />
          </div>

          <div class="task-prop-field">
            <span class="task-prop-label">${t("tasks.properties.status", "Status")}</span>
            <div class="task-prop-pill-group" id="task-status-group" role="radiogroup" aria-label="${t("tasks.properties.status", "Status")}">
              <button type="button" class="task-prop-pill ${currentStatus === TASK_STATUS.OPEN ? "active" : ""}" data-status="${TASK_STATUS.OPEN}" role="radio" aria-checked="${currentStatus === TASK_STATUS.OPEN}">
                ${getIcon("square", 16)} ${t("tasks.states.open", "Open")}
              </button>
              <button type="button" class="task-prop-pill ${currentStatus === TASK_STATUS.DOING ? "active" : ""}" data-status="${TASK_STATUS.DOING}" role="radio" aria-checked="${currentStatus === TASK_STATUS.DOING}">
                ${getIcon("clock", 16)} ${t("tasks.states.doing", "In Progress")}
              </button>
              <button type="button" class="task-prop-pill ${currentStatus === TASK_STATUS.DONE ? "active" : ""}" data-status="${TASK_STATUS.DONE}" role="radio" aria-checked="${currentStatus === TASK_STATUS.DONE}">
                ${getIcon("checkSquare", 16)} ${t("tasks.states.done", "Done")}
              </button>
            </div>
          </div>

          ${
            enablePriorities
              ? `
          <div class="task-prop-field">
            <span class="task-prop-label">${t("tasks.properties.priority", "Priority")}</span>
            <div class="task-prop-pill-group task-prop-prio-group" id="task-priority-group" role="radiogroup" aria-label="${t("tasks.properties.priority", "Priority")}">
              <button type="button" class="task-prop-pill prio-none ${currentPriority === TASK_PRIORITY.NONE ? "active" : ""}" data-priority="${TASK_PRIORITY.NONE}" role="radio" aria-checked="${currentPriority === TASK_PRIORITY.NONE}">
                ${t("tasks.priorities.none", "None")}
              </button>
              <button type="button" class="task-prop-pill prio-low ${currentPriority === TASK_PRIORITY.LOW ? "active" : ""}" data-priority="${TASK_PRIORITY.LOW}" role="radio" aria-checked="${currentPriority === TASK_PRIORITY.LOW}">
                ${t("tasks.priorities.low", "Low")}
              </button>
              <button type="button" class="task-prop-pill prio-medium ${currentPriority === TASK_PRIORITY.MEDIUM ? "active" : ""}" data-priority="${TASK_PRIORITY.MEDIUM}" role="radio" aria-checked="${currentPriority === TASK_PRIORITY.MEDIUM}">
                ${t("tasks.priorities.medium", "Medium")}
              </button>
              <button type="button" class="task-prop-pill prio-high ${currentPriority === TASK_PRIORITY.HIGH ? "active" : ""}" data-priority="${TASK_PRIORITY.HIGH}" role="radio" aria-checked="${currentPriority === TASK_PRIORITY.HIGH}">
                ${t("tasks.priorities.high", "High")}
              </button>
              <button type="button" class="task-prop-pill prio-urgent ${currentPriority === TASK_PRIORITY.URGENT ? "active" : ""}" data-priority="${TASK_PRIORITY.URGENT}" role="radio" aria-checked="${currentPriority === TASK_PRIORITY.URGENT}">
                ${t("tasks.priorities.urgent", "Urgent")}
              </button>
            </div>
          </div>
          `
              : ""
          }

          ${
            enableDueDates
              ? `
          <div class="task-prop-field">
            <label for="task-prop-due-date" class="task-prop-label">
              ${t("tasks.properties.dueDate", "Due Date")}
            </label>
            <div class="task-prop-date-row">
              <input
                type="date"
                id="task-prop-due-date"
                class="task-prop-input task-prop-date-input"
                value="${escapeHtml(currentDueDate)}"
              />
              <div class="task-prop-quick-dates">
                <button type="button" class="task-prop-chip" id="btn-due-today">
                  ${t("tasks.dueDate.today", "Today")}
                </button>
                <button type="button" class="task-prop-chip" id="btn-due-tomorrow">
                  ${t("tasks.dueDate.tomorrow", "Tomorrow")}
                </button>
                <button type="button" class="task-prop-chip" id="btn-due-day">
                  ${t("tasks.dueDate.nextDay", "+1 Day")}
                </button>
                <button type="button" class="task-prop-chip" id="btn-due-week">
                  ${t("tasks.dueDate.nextWeek", "+7 Days")}
                </button>
                <button type="button" class="task-prop-chip" id="btn-due-clear">
                  ${t("tasks.dueDate.clear", "Clear")}
                </button>
              </div>
            </div>
          </div>
          `
              : ""
          }

          ${
            hasDetails
              ? `
          <div class="task-prop-field">
            <span class="task-prop-label">${t("tasks.properties.details", "Details")}</span>
            <div class="task-prop-details">
              ${
                detailStrokes.length > 0
                  ? `<canvas class="task-prop-details-ink" id="task-prop-details-ink"></canvas>`
                  : `<div class="task-prop-details-text" id="task-prop-details-text">${escapeHtml(detailText.join("\n"))}</div>`
              }
            </div>
          </div>
          `
              : ""
          }
        </div>
        <div class="modal-footer">
          <button type="button" class="btn-secondary task-prop-cancel">
            ${t("common.cancel", "Cancel")}
          </button>
          <button type="button" class="btn-primary task-prop-save">
            ${t("common.save", "Save")}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const titleInput = overlay.querySelector("#task-prop-title");
    const dateInput = overlay.querySelector("#task-prop-due-date");

    const cleanup = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKeydown);
      overlay.remove();
    };

    const closeWithCancel = () => {
      cleanup();
      resolve(null);
    };

    const saveAndClose = () => {
      const typedTitle = titleInput ? titleInput.value.trim() : initialTitle;
      const result = {
        status: currentStatus,
        priority: currentPriority,
        dueDate: enableDueDates && dateInput ? dateInput.value.trim() : currentDueDate,
        // The recognised text is a default, not an override.
        title: typedTitle === suggestedTitle && !(task.title || task.label) ? "" : typedTitle,
      };
      cleanup();
      if (options.onSave) {
        options.onSave(result);
      }
      resolve(result);
    };

    const onKeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeWithCancel();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveAndClose();
      }
    };
    document.addEventListener("keydown", onKeydown);

    overlay.querySelector(".task-prop-close")?.addEventListener("click", closeWithCancel);
    overlay.querySelector(".task-prop-cancel")?.addEventListener("click", closeWithCancel);
    overlay.querySelector(".task-prop-save")?.addEventListener("click", saveAndClose);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeWithCancel();
    });

    // Status pill selection
    overlay.querySelectorAll("#task-status-group .task-prop-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        overlay.querySelectorAll("#task-status-group .task-prop-pill").forEach((b) => {
          b.classList.remove("active");
          b.setAttribute("aria-checked", "false");
        });
        btn.classList.add("active");
        btn.setAttribute("aria-checked", "true");
        currentStatus = btn.dataset.status;
      });
    });

    // Priority pill selection
    if (enablePriorities) {
      overlay.querySelectorAll("#task-priority-group .task-prop-pill").forEach((btn) => {
        btn.addEventListener("click", () => {
          overlay.querySelectorAll("#task-priority-group .task-prop-pill").forEach((b) => {
            b.classList.remove("active");
            b.setAttribute("aria-checked", "false");
          });
          btn.classList.add("active");
          btn.setAttribute("aria-checked", "true");
          currentPriority = btn.dataset.priority;
        });
      });
    }

    // Quick due date shortcuts
    if (enableDueDates && dateInput) {
      overlay.querySelector("#btn-due-today")?.addEventListener("click", () => {
        dateInput.value = formatDate(new Date());
      });
      overlay.querySelector("#btn-due-tomorrow")?.addEventListener("click", () => {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        dateInput.value = formatDate(tomorrow);
      });
      // "+N" buttons accumulate: each click adds to the date already shown.
      overlay.querySelector("#btn-due-day")?.addEventListener("click", () => {
        dateInput.value = addDaysTo(dateInput.value, 1);
      });
      overlay.querySelector("#btn-due-week")?.addEventListener("click", () => {
        dateInput.value = addDaysTo(dateInput.value, 7);
      });
      overlay.querySelector("#btn-due-clear")?.addEventListener("click", () => {
        dateInput.value = "";
      });
    }

    const inkCanvas = overlay.querySelector("#task-prop-details-ink");
    if (inkCanvas) drawDetailInk(inkCanvas, detailStrokes, options.details?.referenceHeight);

    // Auto focus title input
    titleInput?.focus();
  });
}
