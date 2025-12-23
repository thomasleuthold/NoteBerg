/**
 * Sidebar Component
 * Manages the sidebar with tree view structure (notebooks > notes)
 */

import {
  getCurrentMode,
  getCurrentNotebookId,
  getCurrentNoteId,
  navigateTo,
} from "../modules/router.js";
import {
  deleteNote,
  getAllNotebooks,
  getAllNotes,
  getNote,
  getNotesByNotebook,
} from "../modules/storage.js";
import { showConfirmDialog } from "./modals.js";

/**
 * Render sidebar header based on context
 */
async function renderSidebarHeader() {
  const sidebarHeader = document.getElementById("sidebar-header");
  if (!sidebarHeader) return;

  const mode = getCurrentMode();
  const notebookId = getCurrentNotebookId();

  // Only show "+ New Note" button when viewing a notebook
  if (mode === "notebook" && notebookId) {
    sidebarHeader.innerHTML = `
      <button id="new-note-btn" class="btn-primary">+ New Note</button>
    `;

    // Attach event listener
    const newNoteBtn = sidebarHeader.querySelector("#new-note-btn");
    if (newNoteBtn) {
      newNoteBtn.addEventListener("click", () => {
        window.dispatchEvent(new CustomEvent("createnote", { detail: { notebookId } }));
      });
    }
  } else {
    // No button in other modes
    sidebarHeader.innerHTML = "";
  }
}

/**
 * Render tree view in sidebar
 */
export async function renderSidebar() {
  const notesListContainer = document.getElementById("notes-list");
  if (!notesListContainer) return;

  await renderSidebarHeader();
  await renderSidebarFooter();

  const currentNotebookId = getCurrentNotebookId();
  const currentNoteId = getCurrentNoteId();

  try {
    // Always show tree view in all modes
    await renderTreeView(notesListContainer, currentNotebookId, currentNoteId);
  } catch (error) {
    console.error("Error rendering sidebar:", error);
    notesListContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-text">Error loading sidebar</div>
      </div>
    `;
  }
}

/**
 * Render sidebar footer with settings and recycle bin
 */
async function renderSidebarFooter() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  // Check if footer exists, if not create it dynamically
  let sidebarFooter = document.getElementById("sidebar-footer");
  if (!sidebarFooter) {
    sidebarFooter = document.createElement("div");
    sidebarFooter.id = "sidebar-footer";
    sidebarFooter.className = "sidebar-footer";
    // Ensure horizontal layout and bottom alignment
    sidebarFooter.style.display = "flex";
    sidebarFooter.style.justifyContent = "space-around";
    sidebarFooter.style.padding = "10px";
    sidebarFooter.style.borderTop = "1px solid var(--border-color)";
    sidebar.appendChild(sidebarFooter);
  }

  sidebarFooter.innerHTML = `
    <button class="sidebar-footer-btn btn-icon" id="nav-settings" title="Settings">⚙️</button>
    <button class="sidebar-footer-btn btn-icon" id="recycle-bin-btn" title="Recycle Bin">🗑️</button>
  `;

  // Attach event listeners
  const settingsBtn = sidebarFooter.querySelector("#nav-settings");
  if (settingsBtn) {
    settingsBtn.addEventListener("click", () => navigateTo("settings"));
  }

  const recycleBinBtn = sidebarFooter.querySelector("#recycle-bin-btn");
  if (recycleBinBtn) {
    recycleBinBtn.addEventListener("click", () => navigateTo("recyclebin"));
  }
}

/**
 * Render tree view with folders (notebooks) and files (notes)
 */
async function renderTreeView(container, currentNotebookId, currentNoteId) {
  const notebooks = await getAllNotebooks();
  const allNotes = await getAllNotes();

  // Separate quick notes (notes without notebook)
  const quickNotes = allNotes.filter((note) => !note.notebookId);

  if (notebooks.length === 0 && quickNotes.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📝</div>
        <div class="empty-state-text">No notes yet</div>
      </div>
    `;
    return;
  }

  let treeHtml = "";

  // Render notebooks as expandable folders
  for (const notebook of notebooks) {
    const notes = await getNotesByNotebook(notebook.id);
    const isExpanded =
      notes.some((note) => note.id === currentNoteId) || notebook.id === currentNotebookId;
    const isActiveNotebook = notebook.id === currentNotebookId;

    treeHtml += `
      <div class="tree-folder ${isActiveNotebook ? "active" : ""}" data-notebook-id="${notebook.id}">
        <div class="tree-folder-header ${isActiveNotebook ? "active" : ""}" data-notebook-id="${notebook.id}">
          <span class="tree-folder-icon">${isExpanded ? "📂" : "📁"}</span>
          <span class="tree-folder-title">${escapeHtml(notebook.title)}</span>
          <span class="tree-item-count">(${notes.length})</span>
        </div>
        <div class="tree-folder-content ${isExpanded ? "expanded" : "collapsed"}">
          ${notes.map((note) => renderTreeNote(note, currentNoteId)).join("")}
        </div>
      </div>
    `;
  }

  // Render quick notes at the bottom
  if (quickNotes.length > 0) {
    treeHtml += `
      <div class="tree-section">
        <div class="tree-section-header">Quick Notes</div>
        ${quickNotes.map((note) => renderTreeNote(note, currentNoteId)).join("")}
      </div>
    `;
  }

  container.innerHTML = treeHtml;

  // Attach event listeners
  attachTreeViewListeners(container);
}

/**
 * Render a single note item in tree view
 */
function renderTreeNote(note, currentNoteId) {
  const isActive = note.id === currentNoteId;
  return `
    <div class="tree-note ${isActive ? "active" : ""}" data-note-id="${note.id}">
      <span class="tree-note-icon">📄</span>
      <span class="tree-note-title">${escapeHtml(note.title || "Untitled")}</span>
      <button class="tree-note-delete" data-note-id="${note.id}" title="Delete note" aria-label="Delete note">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
        </svg>
      </button>
    </div>
  `;
}

/**
 * Attach event listeners for tree view
 */
function attachTreeViewListeners(container) {
  // Folder header clicks - toggle expand/collapse and navigate
  const folderHeaders = container.querySelectorAll(".tree-folder-header");
  for (const header of folderHeaders) {
    header.addEventListener("click", () => {
      const notebookId = header.dataset.notebookId;
      const folder = header.parentElement;
      const content = folder.querySelector(".tree-folder-content");
      const icon = header.querySelector(".tree-folder-icon");

      // Toggle expand/collapse
      if (content.classList.contains("collapsed")) {
        content.classList.remove("collapsed");
        content.classList.add("expanded");
        icon.textContent = "📂";
      } else {
        content.classList.remove("expanded");
        content.classList.add("collapsed");
        icon.textContent = "📁";
      }

      // Navigate to notebook
      navigateTo("notebook", { notebookId });
    });
  }

  // Attach note listeners
  attachNoteListeners(container);
}

/**
 * Attach event listeners for notes
 */
function attachNoteListeners(container) {
  // Note clicks
  const noteItems = container.querySelectorAll(".tree-note");
  for (const item of noteItems) {
    item.addEventListener("click", (e) => {
      // Don't navigate if clicking the delete button
      if (e.target.closest(".tree-note-delete")) return;

      const noteId = item.dataset.noteId;
      const currentNotebookId = getCurrentNotebookId();
      navigateTo("notebook", { noteId, notebookId: currentNotebookId });
    });
  }

  // Delete buttons
  const deleteButtons = container.querySelectorAll(".tree-note-delete");
  for (const btn of deleteButtons) {
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
  }
}

/**
 * Escape HTML to prevent XSS
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
    await renderSidebar();
  });

  // Update sidebar when data changes
  window.addEventListener("datachange", async () => {
    await renderSidebar();
  });

  console.log("Sidebar component initialized");
}
