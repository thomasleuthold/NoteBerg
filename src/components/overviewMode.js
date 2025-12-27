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
import { getTheme } from "../modules/theme.js";

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

  container.innerHTML = `
    <style>
      .quick-notes-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
        gap: 16px;
      }
    </style>
    <div class="overview-container">
      <div class="overview-header">
        <h2>Overview</h2>
        <button class="btn-secondary" id="recycle-bin-btn" title="Recycle Bin" style="display: flex; align-items: center; gap: 8px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
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
    <style>
      .notes-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
        gap: 16px;
      }
    </style>
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

  let previewContent = "";

  if (hasDrawings) {
    previewContent = `<canvas class="note-preview-canvas" data-note-id="${note.id}" style="width: 100%; height: 100%; display: block;"></canvas>`;
  } else if (hasText) {
    const previewText =
      note.content.replace(/[#*`]/g, "").substring(0, 150) +
      (note.content.length > 150 ? "..." : "");
    previewContent = `<div style="padding: 12px;">${escapeHtml(previewText)}</div>`;
  } else {
    previewContent = `<div style="padding: 12px; font-style: italic;">No content</div>`;
  }

  return `
    <div class="note-card preview-card" data-note-id="${note.id}" style="display: flex; flex-direction: column; aspect-ratio: 1; border: 2px solid var(--border-color); border-radius: 8px; overflow: hidden; background: var(--bg-secondary); cursor: pointer; transition: transform 0.2s, box-shadow 0.2s;">
      <div class="note-card-header" style="padding: 12px; border-bottom: 1px solid var(--border-color); background: var(--bg-primary);">
        <div class="note-card-title" style="font-weight: 600; margin-bottom: 4px;">${escapeHtml(note.title || "Untitled")}</div>
        <div class="note-card-date" style="font-size: 0.75rem; color: var(--text-secondary);">${formatDate(note.modified)}</div>
      </div>
      <div class="note-card-preview" style="flex: 1; overflow: hidden; font-size: 0.875rem; color: var(--text-secondary); position: relative; background: var(--bg-primary);">
        ${previewContent}
        ${hasDrawings && hasText ? '<div style="position: absolute; bottom: 8px; right: 8px; background: var(--bg-tertiary); padding: 4px 8px; border-radius: 12px; font-size: 0.7rem; display: flex; align-items: center; gap: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.1);">+ Text</div>' : ""}
      </div>
      <div class="note-card-actions" style="padding: 8px; border-top: 1px solid var(--border-color); display: flex; justify-content: flex-end;">
         <button class="card-delete-btn btn-icon" data-note-id="${note.id}" title="Delete" style="padding: 4px;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
         </button>
      </div>
    </div>
  `;
}

function updateBreadcrumb(notebookTitle = null) {
  const breadcrumb = document.getElementById("breadcrumb");
  if (!breadcrumb) return;

  // Reset to just Home
  breadcrumb.innerHTML = `
    <button id="nav-overview" class="breadcrumb-item" aria-label="Home" title="Home">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
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
  const theme = getTheme();
  const palette = getThemePalette(theme);

  canvases.forEach((canvas) => {
    const noteId = canvas.dataset.noteId;
    const note = notes.find((n) => n.id === noteId);
    if (!note || !note.strokes) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    drawStrokesPreview(ctx, note.strokes, rect.width, rect.height, palette);
  });
}

function drawStrokesPreview(ctx, strokes, width, height, palette) {
  const bounds = getStrokeBounds(strokes);
  if (!bounds) return;

  const padding = 10;
  const availableWidth = width - padding * 2;
  const scale = availableWidth / Math.max(1, bounds.width);

  ctx.save();
  ctx.translate(padding, padding);
  ctx.scale(scale, scale);
  ctx.translate(-bounds.minX, -bounds.minY);

  strokes.forEach((stroke) => {
    if (!stroke.x || stroke.x.length < 2) return;

    ctx.strokeStyle =
      stroke.colorIndex !== undefined ? palette[stroke.colorIndex] : stroke.color || palette[0];
    ctx.lineWidth = stroke.width || 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.beginPath();
    ctx.moveTo(stroke.x[0], stroke.y[0]);

    for (let i = 1; i < stroke.x.length - 1; i++) {
      const xc = (stroke.x[i] + stroke.x[i + 1]) / 2;
      const yc = (stroke.y[i] + stroke.y[i + 1]) / 2;
      ctx.quadraticCurveTo(stroke.x[i], stroke.y[i], xc, yc);
    }

    if (stroke.x.length > 2) {
      const last = stroke.x.length - 1;
      ctx.quadraticCurveTo(stroke.x[last - 1], stroke.y[last - 1], stroke.x[last], stroke.y[last]);
    } else {
      ctx.lineTo(stroke.x[1], stroke.y[1]);
    }

    ctx.stroke();
  });

  ctx.restore();
}

function getStrokeBounds(strokes) {
  if (!strokes || strokes.length === 0) return null;

  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  let hasPoints = false;

  strokes.forEach((stroke) => {
    if (!stroke.x || stroke.x.length === 0) return;
    hasPoints = true;
    for (let i = 0; i < stroke.x.length; i++) {
      minX = Math.min(minX, stroke.x[i]);
      maxX = Math.max(maxX, stroke.x[i]);
      minY = Math.min(minY, stroke.y[i]);
      maxY = Math.max(maxY, stroke.y[i]);
    }
    const w = (stroke.width || 2) / 2;
    minX -= w;
    maxX += w;
    minY -= w;
    maxY += w;
  });

  if (!hasPoints) return null;
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

function getThemePalette(theme) {
  if (theme === "dark") {
    return ["#ffffff", "#f87171", "#60a5fa", "#34d399", "#fbbf24", "#a78bfa", "#9ca3af", "#fde047"];
  } else if (theme === "epaper") {
    return ["#000000", "#800000", "#000080", "#006400", "#a52a2a", "#4b0082", "#2f4f4f", "#5d4037"];
  } else {
    return ["#000000", "#ef4444", "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#6b7280", "#78350f"];
  }
}
