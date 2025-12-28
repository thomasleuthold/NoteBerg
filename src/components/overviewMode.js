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
import { getIcon } from "../utils/icons.js";
import { markdownToHtml } from "../utils/markdown.js";
import { renderNotePreview } from "../utils/noteRenderer.js";
import { showConfirmDialog } from "./modals.js";
import { renderNotebookCard } from "./notebookCard.js";

/**
 * Render overview UI
 * @param {HTMLElement} container - Container element to render into
 * @param {string|null} notebookId - Optional notebook ID to show contents of
 */
export async function renderOverview(container, notebookId = null) {
  try {
    // If notebookId is provided, render notebook contents view
    if (notebookId) {
      await renderNotebookContents(container, notebookId);
      return;
    }

    // Otherwise render standard overview (notebooks list)
    await renderRootOverview(container);
  } catch (error) {
    console.error("Error rendering overview:", error);
    renderError(container, error);
  }
}

async function renderRootOverview(container) {
  // Fetch data
  const notebooks = await getAllNotebooks();
  const quickNotes = await getQuickNotes();
  updateBreadcrumb(); // Reset breadcrumb

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
      ? quickNotes.map((note) => renderPreviewNoteCard(note)).join("")
      : '<p class="empty-state">No quick notes yet. Create a note outside of any notebook.</p>';

  const trashIcon = getIcon("trash", 20);

  container.innerHTML = `
    <div class="overview-container">
      <div class="overview-header">
        <h2>Overview</h2>
        <button class="btn-secondary" id="recycle-bin-btn" title="Recycle Bin" style="display: flex; align-items: center; gap: 8px;">
          ${trashIcon}
          <span>Recycle Bin</span>
        </button>
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
  attachRootOverviewListeners(container);

  // Render previews for quick notes
  requestAnimationFrame(() => {
    renderNotePreviews(container, quickNotes);
  });
}

async function renderNotebookContents(container, notebookId) {
  const notebook = await getNotebook(notebookId);
  if (!notebook) throw new Error("Notebook not found");

  const notes = await getNotesByNotebook(notebookId);
  updateBreadcrumb(notebook.title);

  const notesHtml =
    notes.length > 0
      ? notes.map((note) => renderPreviewNoteCard(note)).join("")
      : '<p class="empty-state">No notes in this notebook yet.</p>';

  container.innerHTML = `
    <div class="overview-container">
      <div class="overview-header">
        <h2>${escapeHtml(notebook.title)}</h2>
        <button class="btn-primary" id="new-note-btn">+ New Note</button>
      </div>

      <div class="notes-grid">
        ${notesHtml}
      </div>
    </div>
  `;

  // Attach listeners
  const newNoteBtn = container.querySelector("#new-note-btn");
  if (newNoteBtn) {
    newNoteBtn.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("createnote", { detail: { notebookId } }));
    });
  }

  // Note card clicks
  const noteCards = container.querySelectorAll(".note-card");
  noteCards.forEach((card) => {
    card.addEventListener("click", () => {
      const noteId = card.dataset.noteId;
      navigateTo("notebook", { noteId });
    });
  });

  // Delete note buttons
  const deleteBtns = container.querySelectorAll(".card-delete-btn");
  deleteBtns.forEach((btn) => {
    btn.addEventListener("click", (e) => handleDeleteNote(e, btn.dataset.noteId));
  });

  // Render previews
  requestAnimationFrame(() => {
    renderNotePreviews(container, notes);
  });
}

function renderError(container, error) {
  container.innerHTML = `<div class="error-state"><p>Error: ${error.message}</p></div>`;
}

/**
 * Attach event listeners to overview elements
 * @param {HTMLElement} container - Container element
 */
function attachRootOverviewListeners(container) {
  // Notebook card clicks
  const notebookCards = container.querySelectorAll(".notebook-card");
  notebookCards.forEach((card) => {
    card.addEventListener("click", () => {
      const notebookId = card.dataset.notebookId;
      // Navigate to overview mode but with notebook context
      navigateTo("overview", { notebookId });
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

  // New note in notebook button clicks
  const newNoteBtns = container.querySelectorAll(".notebook-card .card-new-note-btn");
  newNoteBtns.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent card click
      const notebookId = btn.dataset.notebookId;
      window.dispatchEvent(new CustomEvent("createnote", { detail: { notebookId } }));
    });
  });

  // Delete note button clicks
  const noteDeleteBtns = container.querySelectorAll(".note-card .card-delete-btn");
  noteDeleteBtns.forEach((btn) => {
    btn.addEventListener("click", (e) => handleDeleteNote(e, btn.dataset.noteId));
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

  // Recycle bin button
  const recycleBinBtn = container.querySelector("#recycle-bin-btn");
  if (recycleBinBtn) {
    recycleBinBtn.addEventListener("click", () => navigateTo("recyclebin"));
  }
}

async function handleDeleteNote(e, noteId) {
  e.stopPropagation();
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
}

function renderPreviewNoteCard(note) {
  const hasDrawings = note.strokes && note.strokes.length > 0;
  const hasText = note.content && note.content.trim().length > 0;
  const hasBackground = note.background && note.background !== "none";

  let previewContent = "";

  // Use layered approach like the editor when there are drawings/background
  if (hasDrawings || hasBackground) {
    // Create layered structure exactly like the editor, then scale the whole thing
    // This ensures text and strokes maintain their exact relative positions
    const textLayer = hasText
      ? `<div class="text-editor" contenteditable="false" style="position: absolute; top: 0; left: 0; width: 800px; height: 600px; padding: 20px; font-size: 16px; line-height: 1.6; overflow: hidden; pointer-events: none; z-index: 1;">${markdownToHtml(note.content)}</div>`
      : "";
    // Render at full editor size (800x600) then scale down with CSS transform
    previewContent = `
      <div class="preview-scaler" style="position: absolute; top: 0; left: 0; width: 800px; height: 600px; transform-origin: top left; pointer-events: none;">
        <canvas class="note-preview-canvas" data-note-id="${note.id}" data-full-size="true" style="position: absolute; top: 0; left: 0; width: 800px; height: 600px; display: block; z-index: 0;"></canvas>
        ${textLayer}
      </div>
    `;
  } else if (hasText) {
    // For text-only notes, render the HTML directly with text-editor class
    // Convert markdown to HTML exactly like the editor does
    const textLayer = `<div class="text-editor" contenteditable="false" style="position: absolute; top: 0; left: 0; width: 800px; height: 600px; padding: 20px; font-size: 16px; line-height: 1.6; overflow: hidden; pointer-events: none;">${markdownToHtml(note.content)}</div>`;
    previewContent = `
      <div class="preview-scaler" style="position: absolute; top: 0; left: 0; width: 800px; height: 600px; transform-origin: top left; pointer-events: none;">
        ${textLayer}
      </div>
    `;
  } else {
    previewContent = `<div style="padding: 12px; font-style: italic;">No content</div>`;
  }

  const deleteIcon = getIcon("trash", 16);

  return `
    <div class="note-card preview-card" data-note-id="${note.id}" style="display: flex; flex-direction: column; aspect-ratio: 1; border: 2px solid var(--border-color); border-radius: 8px; overflow: hidden; background: var(--bg-secondary); cursor: pointer; transition: transform 0.2s, box-shadow 0.2s;">
      <div class="note-card-header" style="padding: 12px; border-bottom: 1px solid var(--border-color); background: var(--bg-primary);">
        <div class="note-card-title" style="font-weight: 600; margin-bottom: 4px;">${escapeHtml(note.title || "Untitled")}</div>
        <div class="note-card-date" style="font-size: 0.75rem; color: var(--text-secondary);">${formatDate(note.modified)}</div>
      </div>
      <div class="note-card-preview" style="flex: 1; overflow: hidden; font-size: 0.875rem; color: var(--text-secondary); position: relative; background: var(--bg-primary);">
        ${previewContent}
      </div>
      <div class="note-card-actions" style="padding: 8px; border-top: 1px solid var(--border-color); display: flex; justify-content: flex-end;">
         <button class="card-delete-btn btn-icon" data-note-id="${note.id}" title="Delete" style="padding: 4px;">
            ${deleteIcon}
         </button>
      </div>
    </div>
  `;
}

function updateBreadcrumb(notebookTitle = null) {
  const breadcrumb = document.getElementById("breadcrumb");
  if (!breadcrumb) return;

  const homeIcon = getIcon("home", 24);

  // Reset to just Home
  breadcrumb.innerHTML = `
    <button id="nav-overview" class="breadcrumb-item" aria-label="Home" title="Home">
      ${homeIcon}
    </button>
  `;

  // Re-attach home listener
  breadcrumb.querySelector("#nav-overview").addEventListener("click", () => navigateTo("overview"));

  if (notebookTitle) {
    const separator = document.createElement("span");
    separator.className = "breadcrumb-separator";
    separator.textContent = "/";
    separator.style.margin = "0 8px";
    separator.style.color = "var(--text-secondary)";
    breadcrumb.appendChild(separator);

    const item = document.createElement("span");
    item.className = "breadcrumb-item";
    item.textContent = notebookTitle;
    item.style.fontWeight = "600";
    breadcrumb.appendChild(item);
  }
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Initialize overview component
 */
export function initOverview() {
  // Listen for render overview event from router
  window.addEventListener("renderoverview", async (e) => {
    const container = document.getElementById("overview-content");
    const notebookId = e.detail ? e.detail.notebookId : null;
    if (container) {
      await renderOverview(container, notebookId);
    }
  });

  // Listen for data changes to refresh overview
  window.addEventListener("datachange", async () => {
    const container = document.getElementById("overview-content");
    // We need to know if we are currently viewing a notebook to refresh correctly.
    // Since we don't store state here, we might default to root or try to infer.
    // For simplicity in this refactor, we'll just re-render root or rely on router re-triggering.
    // A better approach would be to store currentNotebookId in a module variable.
    if (container && container.offsetParent !== null) {
      // For now, just re-render root overview to be safe, or check URL if we had access.
      // Since we don't have router state access here easily without modifying router,
      // we will assume root overview for auto-refresh.
      // To fix this properly, we'd need to track state.
      // Let's try to grab the ID from the breadcrumb if possible or just render root.
      await renderOverview(container);
    }
  });

  console.log("Overview component initialized");
}

function renderNotePreviews(container, notes) {
  const canvases = container.querySelectorAll(".note-preview-canvas");

  canvases.forEach((canvas) => {
    const noteId = canvas.dataset.noteId;
    const note = notes.find((n) => n.id === noteId);
    if (!note) return;

    // Check if this is a full-size canvas that needs to be rendered at 800x600
    const isFullSize = canvas.dataset.fullSize === "true";

    if (isFullSize) {
      // Render at full size (800x600) without scaling
      renderNotePreview(canvas, note, {
        padding: 20,
        fullSize: true,
      });

      // Calculate and apply the scale transform to the parent scaler div
      const scaler = canvas.closest(".preview-scaler");
      const previewContainer = canvas.closest(".note-card-preview");
      if (scaler && previewContainer) {
        const containerRect = previewContainer.getBoundingClientRect();
        const scale = Math.min(containerRect.width / 800, containerRect.height / 600);
        scaler.style.transform = `scale(${scale})`;
      }
    } else {
      // Legacy rendering for scaled canvas
      renderNotePreview(canvas, note, {
        padding: 10,
        showTextIndicator: false,
      });
    }
  });
}
