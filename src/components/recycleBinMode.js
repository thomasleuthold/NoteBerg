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

    // Build HTML for notebooks
    const notebooksHtml =
      deletedNotebooks.length > 0
        ? deletedNotebooks
            .map(
              (notebook) => `
      <div class="recycle-item" data-type="notebook" data-id="${notebook.id}">
        <div class="recycle-item-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M16 2v20"/></svg>
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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
              <path d="M21 3v5h-5"/>
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
            </svg>
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
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
              <path d="M21 3v5h-5"/>
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
            </svg>
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
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
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
