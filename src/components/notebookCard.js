/**
 * Notebook Card Component
 * Renders a clickable card for a notebook with metadata
 */

/**
 * Render a notebook card
 * @param {Object} notebook - Notebook object from storage
 * @param {number} noteCount - Number of notes in the notebook
 * @returns {string} HTML string for the notebook card
 */
export function renderNotebookCard(notebook, noteCount = 0) {
  const lastModified = new Date(notebook.modified).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const description = notebook.description
    ? truncateText(notebook.description, 80)
    : "No description";

  return `
    <div class="notebook-card" data-notebook-id="${notebook.id}">
      <button class="card-delete-btn" data-notebook-id="${notebook.id}" title="Delete notebook" aria-label="Delete notebook">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
        </svg>
      </button>
      <div class="notebook-card-header">
        <div class="notebook-color-indicator" style="background-color: ${notebook.color}"></div>
        <h3 class="notebook-card-title">${escapeHtml(notebook.title)}</h3>
      </div>
      <p class="notebook-card-description">${escapeHtml(description)}</p>
      <div class="notebook-card-footer">
        <span class="notebook-card-count">${noteCount} ${noteCount === 1 ? "note" : "notes"}</span>
        <span class="notebook-card-date">${lastModified}</span>
      </div>
      <button class="card-new-note-btn" data-notebook-id="${notebook.id}" title="New note in this notebook">
        + New Note
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
