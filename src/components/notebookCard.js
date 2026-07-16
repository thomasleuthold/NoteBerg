/**
 * Notebook Card Component
 * Renders a clickable card for a notebook with metadata
 */

import { t } from "../i18n/index.js";
import { getIcon } from "../utils/icons.js";

/**
 * Render a notebook card
 * @param {Object} notebook - Notebook object from storage
 * @param {number} noteCount - Number of notes in the notebook
 * @returns {string} HTML string for the notebook card
 */
export function renderNotebookCard(notebook, noteCount = 0) {
  const lastModified = new Date(notebook.modified).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const description = notebook.description
    ? truncateText(notebook.description, 80)
    : t("overview.notebook.noDescription");

  return `
    <div class="notebook-card" data-notebook-id="${notebook.id}">
      <button class="card-options-btn" data-notebook-id="${notebook.id}" title="${t("overview.notebook.optionsTitle")}" aria-label="${t("overview.notebook.optionsTitle")}">
        ${getIcon("moreVertical", 16)}
      </button>
      <div class="notebook-card-header">
        <div class="notebook-color-indicator" style="background-color: ${notebook.color}"></div>
        <h3 class="notebook-card-title">${escapeHtml(notebook.title)}</h3>
      </div>
      <p class="notebook-card-description">${escapeHtml(description)}</p>
      <div class="notebook-card-footer">
        <span class="notebook-card-count">${t("overview.notebook.noteCount", { count: noteCount })}</span>
        <span class="notebook-card-date">${lastModified}</span>
      </div>
      <button class="card-new-note-btn" data-notebook-id="${notebook.id}" title="${t("overview.notebook.newNote")}">
        ${t("overview.notebook.newNote")}
      </button>
    </div>
  `;
}

/**
 * Truncate text to specified length
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated text with ellipsis if needed
 */
function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.substring(0, maxLength).trim()}...`;
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
