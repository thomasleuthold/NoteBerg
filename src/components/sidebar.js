/**
 * Sidebar Component
 * Manages the sidebar notes list based on current context
 */

import {
  getCurrentMode,
  getCurrentNotebookId,
  getCurrentNoteId,
  navigateTo,
} from "../modules/router.js";
import { deleteNote, getAllNotes, getNote, getNotesByNotebook } from "../modules/storage.js";
import { showConfirmDialog } from "./modals.js";

/**
 * Render notes list in sidebar
 * @param {string|null} notebookId - Optional notebook ID to filter notes
 */
export async function renderSidebar(notebookId = null) {
  const notesListContainer = document.getElementById("notes-list");
  if (!notesListContainer) return;

  try {
    let notes;
    if (notebookId) {
      // Get notes for specific notebook
      notes = await getNotesByNotebook(notebookId);
    } else {
      // Get all notes
      notes = await getAllNotes();
    }

    if (notes.length === 0) {
      notesListContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📝</div>
          <div class="empty-state-text">No notes yet</div>
        </div>
      `;
      return;
    }

    // Render notes as simple list items with delete buttons
    const notesHtml = notes
      .map(
        (note) => `
      <div class="sidebar-note-item" data-note-id="${note.id}">
        <div class="sidebar-note-content">
          <div class="sidebar-note-title">${escapeHtml(note.title || "Untitled")}</div>
          <div class="sidebar-note-date">${formatDate(note.modified)}</div>
        </div>
        <button class="sidebar-note-delete" data-note-id="${note.id}" title="Delete note" aria-label="Delete note">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
          </svg>
        </button>
      </div>
    `,
      )
      .join("");

    notesListContainer.innerHTML = notesHtml;

    // Highlight active note
    const currentNoteId = getCurrentNoteId();
    if (currentNoteId) {
      const activeItem = notesListContainer.querySelector(`[data-note-id="${currentNoteId}"]`);
      if (activeItem) {
        activeItem.classList.add("active");
      }
    }

    // Attach click handlers for notes
    const noteItems = notesListContainer.querySelectorAll(".sidebar-note-item");
    noteItems.forEach((item) => {
      item.addEventListener("click", (e) => {
        // Don't navigate if clicking the delete button
        if (e.target.closest(".sidebar-note-delete")) return;

        const noteId = item.dataset.noteId;
        const currentNotebookId = getCurrentNotebookId();
        navigateTo("notebook", { noteId, notebookId: currentNotebookId });
      });
    });

    // Attach delete handlers
    const deleteButtons = notesListContainer.querySelectorAll(".sidebar-note-delete");
    deleteButtons.forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation(); // Prevent note click
        const noteId = btn.dataset.noteId;
        const note = await getNote(noteId);

        const confirmed = await showConfirmDialog(
          "Delete Note",
          `Are you sure you want to delete "${note.title}"?`,
          "Delete",
          "btn-danger",
        );

        if (confirmed) {
          await deleteNote(noteId);
          window.dispatchEvent(new CustomEvent("datachange"));
        }
      });
    });
  } catch (error) {
    console.error("Error rendering sidebar:", error);
    notesListContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-text">Error loading notes</div>
      </div>
    `;
  }
}

/**
 * Update sidebar based on navigation
 */
async function updateSidebarOnNavigate() {
  const mode = getCurrentMode();
  const notebookId = getCurrentNotebookId();

  if (mode === "notebook" && notebookId) {
    // Show notes for current notebook
    await renderSidebar(notebookId);
  } else if (mode === "overview" || mode === "notebook") {
    // Show all notes in overview OR when viewing a quick note (notebook mode without notebookId)
    await renderSidebar(null);
  } else {
    // Clear sidebar for settings or other modes
    const notesListContainer = document.getElementById("notes-list");
    if (notesListContainer) {
      notesListContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📝</div>
          <div class="empty-state-text">No notes yet</div>
        </div>
      `;
    }
  }
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

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
 * Initialize sidebar component
 */
export function initSidebar() {
  // Update sidebar on navigation
  window.addEventListener("navigate", async () => {
    await updateSidebarOnNavigate();
  });

  // Update sidebar when data changes
  window.addEventListener("datachange", async () => {
    await updateSidebarOnNavigate();
  });

  console.log("Sidebar component initialized");
}
