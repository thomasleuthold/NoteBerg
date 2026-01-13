/**
 * Recycle Bin Mode Component
 * Displays deleted notebooks and notes with restore/permanent delete options
 */

import {
  getDeletedNotebooks,
  getDeletedNotes,
  restoreNote,
  restoreNotebook,
} from "../modules/storage.js";
import { getIcon } from "../utils/icons.js";

/**
 * Render recycle bin UI
 * @param {HTMLElement} container - Container element to render into
 */
export async function renderRecycleBin(container) {
  try {
    // Fetch deleted items
    const deletedNotebooks = await getDeletedNotebooks();
    const deletedNotes = await getDeletedNotes();

    const totalItems = deletedNotebooks.length + deletedNotes.length;

    const notebookIcon = getIcon("notebook", 24);
    const noteIcon = getIcon("note", 24);
    const restoreIcon = getIcon("restore", 16);

    // Build HTML for notebooks
    const notebooksHtml =
      deletedNotebooks.length > 0
        ? deletedNotebooks
            .map(
              (notebook) => `
      <div class="recycle-item" data-type="notebook" data-id="${notebook.id}">
        <div class="recycle-item-icon">
          ${notebookIcon}
        </div>
        <div class="recycle-item-content">
          <div class="recycle-item-title">${escapeHtml(notebook.title)}</div>
          <div class="recycle-item-meta">
            <span class="recycle-item-type">Notebook</span>
            <span class="recycle-item-date">Deleted ${formatDate(notebook.modified)}</span>
          </div>
        </div>
        <div class="recycle-item-actions">
          <button class="btn-restore" data-type="notebook" data-id="${notebook.id}" title="Restore">
            ${restoreIcon}
            Restore
          </button>
        </div>
      </div>
    `,
            )
            .join("")
        : '<p class="empty-state">No deleted notebooks</p>';

    // Build HTML for notes
    const notesHtml =
      deletedNotes.length > 0
        ? deletedNotes
            .map(
              (note) => `
      <div class="recycle-item" data-type="note" data-id="${note.id}">
        <div class="recycle-item-icon">
          ${noteIcon}
        </div>
        <div class="recycle-item-content">
          <div class="recycle-item-title">${escapeHtml(note.title || "Untitled")}</div>
          <div class="recycle-item-meta">
            <span class="recycle-item-type">Note</span>
            <span class="recycle-item-date">Deleted ${formatDate(note.modified)}</span>
          </div>
        </div>
        <div class="recycle-item-actions">
          <button class="btn-restore" data-type="note" data-id="${note.id}" title="Restore">
            ${restoreIcon}
            Restore
          </button>
        </div>
      </div>
    `,
            )
            .join("")
        : '<p class="empty-state">No deleted notes</p>';

    container.innerHTML = `
      <div class="recycle-bin-container">
        <div class="recycle-bin-header">
          <h2>Recycle Bin</h2>
        </div>

        ${
          totalItems === 0
            ? `
          <div class="empty-state">
            <div class="empty-state-icon" style="margin-bottom: 1rem; color: var(--text-secondary);">
              ${getIcon("trash", 64)}
            </div>
            <h3>Recycle Bin is Empty</h3>
            <p>Deleted notebooks and notes will appear here.</p>
          </div>
        `
            : `
          <div class="recycle-bin-section">
            <h3>Notebooks (${deletedNotebooks.length})</h3>
            <div class="recycle-items-list">
              ${notebooksHtml}
            </div>
          </div>

          <div class="recycle-bin-section">
            <h3>Notes (${deletedNotes.length})</h3>
            <div class="recycle-items-list">
              ${notesHtml}
            </div>
          </div>
        `
        }
      </div>
    `;

    // Attach event listeners
    attachRecycleBinListeners(container);
  } catch (error) {
    console.error("Error rendering recycle bin:", error);
    container.innerHTML = `
      <div class="error-state">
        <p>Failed to load recycle bin. Please refresh the page.</p>
        <p class="error-details">${error.message}</p>
      </div>
    `;
  }
}

/**
 * Attach event listeners to recycle bin elements
 * @param {HTMLElement} container - Container element
 */
function attachRecycleBinListeners(container) {
  // Restore buttons
  const restoreBtns = container.querySelectorAll(".btn-restore");
  restoreBtns.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const type = btn.dataset.type;
      const id = btn.dataset.id;

      try {
        if (type === "notebook") {
          await restoreNotebook(id);
        } else {
          await restoreNote(id);
        }

        window.dispatchEvent(new CustomEvent("datachange"));
      } catch (error) {
        console.error("Error restoring item:", error);
        alert(`Failed to restore item: ${error.message}`);
      }
    });
  });
}

/**
 * Format date for display
 * @param {number} timestamp - Unix timestamp
 * @returns {string} Formatted date
 */
function formatDate(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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

/**
 * Initialize recycle bin component
 */
export function initRecycleBin() {
  // Listen for render recycle bin event from router
  window.addEventListener("renderrecyclebin", async () => {
    const container = document.getElementById("recycle-bin-content");
    if (container) {
      await renderRecycleBin(container);
    }
  });

  // Listen for data changes to refresh recycle bin
  window.addEventListener("datachange", async () => {
    const container = document.getElementById("recycle-bin-content");
    if (container && container.offsetParent !== null) {
      // Only refresh if recycle bin is currently visible
      await renderRecycleBin(container);
    }
  });

  console.log("Recycle bin component initialized");
}
