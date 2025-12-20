/**
 * Overview Mode Component
 * Displays notebooks and quick notes in grid/list layout
 */

import { navigateTo } from "../modules/router.js";
import {
  deleteNote,
  deleteNotebook,
  getAllNotebooks,
  getNote,
  getNotebook,
  getNotesByNotebook,
  getQuickNotes,
} from "../modules/storage.js";
import { showConfirmDialog } from "./modals.js";
import { renderNotebookCard } from "./notebookCard.js";
import { renderNoteCard } from "./noteCard.js";

/**
 * Render overview UI
 * @param {HTMLElement} container - Container element to render into
 */
export async function renderOverview(container) {
  try {
    // Fetch data
    const notebooks = await getAllNotebooks();
    const quickNotes = await getQuickNotes();

    // Get note counts for each notebook
    const notebookCounts = await Promise.all(
      notebooks.map(async (notebook) => {
        const notes = await getNotesByNotebook(notebook.id);
        return { notebook, count: notes.length };
      }),
    );

    // Build HTML
    const notebooksHtml =
      notebookCounts.length > 0
        ? notebookCounts.map(({ notebook, count }) => renderNotebookCard(notebook, count)).join("")
        : '<p class="empty-state">No notebooks yet. Create your first notebook!</p>';

    const quickNotesHtml =
      quickNotes.length > 0
        ? quickNotes.map((note) => renderNoteCard(note)).join("")
        : '<p class="empty-state">No quick notes yet. Create a note outside of any notebook.</p>';

    container.innerHTML = `
      <div class="overview-container">
        <div class="overview-header">
          <h2>Overview</h2>
        </div>

        <div class="notebooks-section">
          <div class="section-header">
            <h3>Notebooks</h3>
            <button class="btn-secondary" id="new-notebook-btn">+ New Notebook</button>
          </div>
          <div class="notebooks-grid">
            ${notebooksHtml}
          </div>
        </div>

        <div class="quick-notes-section">
          <div class="section-header">
            <h3>Quick Notes</h3>
            <button class="btn-secondary" id="new-quick-note-btn">+ New Quick Note</button>
          </div>
          <div class="quick-notes-list">
            ${quickNotesHtml}
          </div>
        </div>
      </div>
    `;

    // Attach event listeners
    attachOverviewListeners(container);
  } catch (error) {
    console.error("Error rendering overview:", error);
    container.innerHTML = `
      <div class="error-state">
        <p>Failed to load overview. Please refresh the page.</p>
        <p class="error-details">${error.message}</p>
      </div>
    `;
  }
}

/**
 * Attach event listeners to overview elements
 * @param {HTMLElement} container - Container element
 */
function attachOverviewListeners(container) {
  // Notebook card clicks
  const notebookCards = container.querySelectorAll(".notebook-card");
  notebookCards.forEach((card) => {
    card.addEventListener("click", () => {
      const notebookId = card.dataset.notebookId;
      navigateTo("notebook", { notebookId });
    });
  });

  // Note card clicks
  const noteCards = container.querySelectorAll(".note-card");
  noteCards.forEach((card) => {
    card.addEventListener("click", () => {
      const noteId = card.dataset.noteId;
      navigateTo("notebook", { noteId });
    });
  });

  // Delete notebook button clicks
  const notebookDeleteBtns = container.querySelectorAll(".notebook-card .card-delete-btn");
  notebookDeleteBtns.forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation(); // Prevent card click
      const notebookId = btn.dataset.notebookId;
      const notebook = await getNotebook(notebookId);

      const confirmed = await showConfirmDialog(
        "Delete Notebook",
        `Are you sure you want to delete "${notebook.title}"? This will also delete all notes in this notebook.`,
        "Delete",
        "btn-danger",
      );

      if (confirmed) {
        await deleteNotebook(notebookId);
        window.dispatchEvent(new CustomEvent("datachange"));
      }
    });
  });

  // Delete note button clicks
  const noteDeleteBtns = container.querySelectorAll(".note-card .card-delete-btn");
  noteDeleteBtns.forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation(); // Prevent card click
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

  // New notebook button
  const newNotebookBtn = container.querySelector("#new-notebook-btn");
  if (newNotebookBtn) {
    newNotebookBtn.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("createnotebook"));
    });
  }

  // New quick note button
  const newQuickNoteBtn = container.querySelector("#new-quick-note-btn");
  if (newQuickNoteBtn) {
    newQuickNoteBtn.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("createquicknote"));
    });
  }
}

/**
 * Initialize overview component
 */
export function initOverview() {
  // Listen for render overview event from router
  window.addEventListener("renderoverview", async () => {
    const container = document.getElementById("overview-content");
    if (container) {
      await renderOverview(container);
    }
  });

  // Listen for data changes to refresh overview
  window.addEventListener("datachange", async () => {
    const container = document.getElementById("overview-content");
    if (container && container.offsetParent !== null) {
      // Only refresh if overview is currently visible
      await renderOverview(container);
    }
  });

  console.log("Overview component initialized");
}
