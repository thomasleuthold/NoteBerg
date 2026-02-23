/**
 * Overview Mode Component
 * Displays notebooks and quick notes in grid/list layout
 */

import { t } from "../i18n/index.js";
import { extractPdfText } from "../modules/pdfManager.js";
import { navigateTo } from "../modules/router.js";
import {
  copyNote,
  deleteNote,
  deleteNotebook,
  getAllNotebooks,
  getAllNotes,
  getFile,
  getNote,
  getNotebook,
  getNotesByNotebook,
  getQuickNotes,
  moveNote,
} from "../modules/storage.js";
import { getIcon } from "../utils/icons.js";
import { markdownToHtml } from "../utils/markdown.js";
import {
  drawStroke,
  getStrokeBounds,
  getThemePalette,
  renderNotePreview,
} from "../utils/noteRenderer.js";
import { showConfirmDialog, showMoveCopyDialog } from "./modals.js";
import { renderNotebookCard } from "./notebookCard.js";
import "./overviewMode.css";

/** Debug toggle: force stroke rendering even when recognition text is available */
let forceStrokeRender = false;

/** Lookup map for task strokes, keyed by task ID. Populated during renderMarkersTab. */
let taskStrokesMap = new Map();

// Search state persistence
const searchState = {
  query: "",
  results: [],
};

// Module state for active tab
let currentActiveTab = "notes";

/**
 * Render overview UI
 * @param {HTMLElement} container - Container element to render into
 * @param {string|null} notebookId - Optional notebook ID to show contents of
 */
export async function renderOverview(container, notebookId = null) {
  try {
    // Render Shell
    const trashIcon = getIcon("trash", 18);
    const notebookIcon = getIcon("notebook", 18);
    const searchIcon = getIcon("search", 18);
    const markersIcon = getIcon("checkSquare", 18);

    container.innerHTML = `
      <div class="overview-container">
        <div class="overview-tabs">
          <button class="tab-btn ${currentActiveTab === "notes" ? "active" : ""}" data-tab="notes">
            ${notebookIcon} ${t("overview.tabs.notes")}
          </button>
          <button class="tab-btn ${currentActiveTab === "search" ? "active" : ""}" data-tab="search">
            ${searchIcon} ${t("overview.tabs.search")}
          </button>
          <button class="tab-btn ${currentActiveTab === "markers" ? "active" : ""}" data-tab="markers">
            ${markersIcon} ${t("overview.tabs.markers")}
          </button>

          <button class="tab-btn recycle-bin-tab" id="recycle-bin-btn">
            ${trashIcon}
            ${t("overview.tabs.recycleBin")}
          </button>
        </div>

        <div id="overview-tab-content" class="overview-tab-content"></div>
      </div>
    `;

    // Attach Shell Listeners
    attachShellListeners(container, notebookId);

    // Render Initial Tab
    await renderActiveTab(container.querySelector("#overview-tab-content"), notebookId);
  } catch (error) {
    console.error("Error rendering overview:", error);
    renderError(container, error);
  }
}

async function renderNotesList(container) {
  // Fetch data
  const notebooks = await getAllNotebooks();
  const quickNotes = await getQuickNotes();

  // Get note counts for each notebook
  const notebookData = await Promise.all(
    notebooks.map(async (notebook) => {
      const notes = await getNotesByNotebook(notebook.id);
      const lastNoteModified = notes.length > 0 ? Math.max(...notes.map((n) => n.modified)) : 0;
      const effectiveUpdatedAt = Math.max(notebook.modified || 0, lastNoteModified);
      return { notebook, count: notes.length, effectiveUpdatedAt };
    }),
  );

  // Sort by effectiveUpdatedAt descending
  notebookData.sort((a, b) => b.effectiveUpdatedAt - a.effectiveUpdatedAt);

  // Build HTML
  const notebooksHtml =
    notebookData.length > 0
      ? notebookData.map(({ notebook, count }) => renderNotebookCard(notebook, count)).join("")
      : `<p class="empty-state">${t("overview.empty.noNotebooks")}</p>`;

  const quickNotesHtml =
    quickNotes.length > 0
      ? quickNotes.map((note) => renderPreviewNoteCard(note)).join("")
      : `<p class="empty-state">${t("overview.empty.noQuickNotes")}</p>`;

  container.innerHTML = `
      <div class="notebooks-section">
        <div class="section-header">
          <h3>${t("overview.sections.notebooks")}</h3>
          <button class="btn-secondary" id="new-notebook-btn">${t("overview.actions.newNotebook")}</button>
        </div>
        <div class="notebooks-grid">
          ${notebooksHtml}
        </div>
      </div>

      <div class="quick-notes-section">
        <div class="section-header">
          <h3>${t("overview.sections.quickNotes")}</h3>
          <button class="btn-secondary" id="new-quick-note-btn">${t("overview.actions.newQuickNote")}</button>
        </div>
        <div class="quick-notes-list">
          ${quickNotesHtml}
        </div>
      </div>
  `;

  // Attach event listeners
  attachNotesListListeners(container);

  // Render previews for quick notes
  requestAnimationFrame(() => {
    renderNotePreviews(container, quickNotes);
  });
}

async function renderNotebookContents(container, notebookId) {
  const notebook = await getNotebook(notebookId);
  if (!notebook) throw new Error("Notebook not found");

  const notes = await getNotesByNotebook(notebookId);

  const notesHtml =
    notes.length > 0
      ? notes.map((note) => renderPreviewNoteCard(note)).join("")
      : `<p class="empty-state">${t("overview.empty.noNotesInNotebook")}</p>`;

  container.innerHTML = `
    <div class="section-header">
      <h3>${t("overview.sections.notes")}</h3>
      <button class="btn-primary" id="new-note-btn">${t("overview.actions.newNote")}</button>
    </div>
    <div class="notes-grid">
      ${notesHtml}
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

  // Note options buttons
  const optionsBtns = container.querySelectorAll(".card-options-btn");
  optionsBtns.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleNoteOptions(btn, btn.dataset.noteId);
    });
  });

  // Render previews
  requestAnimationFrame(() => {
    renderNotePreviews(container, notes);
  });
}

async function renderSearchTab(container) {
  const closeIcon = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

  container.innerHTML = `
    <div class="overview-search">
      <div class="overview-search-row">
        <div class="overview-search-field">
          <input type="text" id="search-input" class="overview-search-input" placeholder="${t("overview.search.placeholder")}">
          <button id="search-clear-btn" class="overview-search-clear" type="button" title="${t("overview.search.clearTitle")}">
            ${closeIcon}
          </button>
        </div>
        <button id="search-btn" class="btn-primary">${t("overview.search.button")}</button>
      </div>
      <div id="search-results" class="overview-search-results"></div>
    </div>
  `;

  attachSearchListeners(container);
}

async function renderMarkersTab(container) {
  // Collect tasks from all notes
  const allNotes = await getAllNotes();
  const allTasks = [];
  for (const note of allNotes) {
    const tasks = note.tasks || [];

    let recognition = note.recognition;
    if (typeof recognition === "string") {
      try {
        recognition = JSON.parse(recognition);
      } catch (_e) {
        recognition = null;
      }
    }

    for (const task of tasks) {
      const taskStrokeIds = new Set(task.strokeIds || []);
      const taskStrokes = (note.strokes || []).filter(
        (s) => taskStrokeIds.has(s.id) && !s._deleted && !s.isDeleted,
      );
      allTasks.push({
        ...task,
        noteId: note.id,
        noteTitle: note.title || t("common.untitled"),
        noteContent: note.content || "",
        recognition,
        strokes: taskStrokes,
      });
    }
  }
  const openTasks = allTasks.filter((t) => !t.checked);
  const doneTasks = allTasks.filter((t) => t.checked);

  taskStrokesMap = new Map();

  const tasksHtml =
    allTasks.length > 0
      ? `
      <div class="tasks-section">
        <div class="section-header tasks-section__header">
          <h3>${getIcon("checkSquare", 20)} ${t("overview.sections.tasks")}</h3>
          <button class="tasks-display-toggle btn-icon" id="toggle-task-display" title="${forceStrokeRender ? t("overview.tasks.showAsText") : t("overview.tasks.showAsStrokes")}">
            ${forceStrokeRender ? getIcon("fileText", 16) : getIcon("pen", 16)}
          </button>
          <span class="tasks-count">${t("overview.tasks.openCount_other", { count: openTasks.length })}</span>
        </div>
        <div class="tasks-list">
          ${openTasks.map((t) => renderTaskItem(t)).join("")}
        </div>
        ${
          doneTasks.length > 0
            ? `
          <button class="tasks-done-toggle" id="toggle-done-tasks">
            ${t("overview.tasks.showCompleted_other", { count: doneTasks.length })}
          </button>
          <div class="tasks-done-list" id="done-tasks-list" style="display: none;">
            ${doneTasks.map((t) => renderTaskItem(t)).join("")}
          </div>
        `
            : ""
        }
      </div>`
      : `<p class="empty-state">${t("overview.empty.noTasks")}</p>`;

  container.innerHTML = tasksHtml;
  drawTaskStrokeCanvases(container);
  attachTaskListeners(container);

  // Toggle between stroke/text display
  const toggleBtn = container.querySelector("#toggle-task-display");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      forceStrokeRender = !forceStrokeRender;
      renderMarkersTab(container);
    });
  }
}

async function renderActiveTab(container, notebookId) {
  container.innerHTML = `<div class="loading-state">${t("overview.loading")}</div>`;

  try {
    if (currentActiveTab === "notes") {
      if (notebookId) {
        await renderNotebookContents(container, notebookId);
      } else {
        await renderNotesList(container);
      }
    } else if (currentActiveTab === "search") {
      await renderSearchTab(container);
    } else if (currentActiveTab === "markers") {
      await renderMarkersTab(container);
    }
  } catch (error) {
    console.error("Error rendering tab:", error);
    container.innerHTML = `<div class="error-state"><p>${t("overview.errorTab", { message: error.message })}</p></div>`;
  }
}

function renderError(container, error) {
  container.innerHTML = `<div class="error-state"><p>${t("overview.errorRender", { message: error.message })}</p></div>`;
}

function attachShellListeners(container, notebookId) {
  const tabs = container.querySelectorAll(".tab-btn");
  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabs.forEach((t) => {
        t.classList.remove("active");
      });
      btn.classList.add("active");
      currentActiveTab = btn.dataset.tab;
      renderActiveTab(container.querySelector("#overview-tab-content"), notebookId);
    });
  });

  const recycleBinBtn = container.querySelector("#recycle-bin-btn");
  if (recycleBinBtn) {
    recycleBinBtn.addEventListener("click", () => {
      currentActiveTab = "notes";
      navigateTo("recyclebin");
    });
  }
}

function attachNotesListListeners(container) {
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
        t("overview.delete.notebookTitle"),
        t("overview.delete.notebookMessage", { title: notebook.title }),
        t("common.delete"),
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

  // Note options button clicks
  const noteOptionsBtns = container.querySelectorAll(".note-card .card-options-btn");
  noteOptionsBtns.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleNoteOptions(btn, btn.dataset.noteId);
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

function attachSearchListeners(container) {
  const searchInput = container.querySelector("#search-input");
  const searchBtn = container.querySelector("#search-btn");
  const searchClearBtn = container.querySelector("#search-clear-btn");
  const searchResults = container.querySelector("#search-results");

  if (searchInput && searchBtn && searchResults) {
    const updateClearBtn = () => {
      if (searchClearBtn) {
        searchClearBtn.style.display = searchInput.value.length > 0 ? "flex" : "none";
      }
    };

    const performSearch = async () => {
      const rawQuery = searchInput.value.trim();
      searchState.query = rawQuery;

      if (!rawQuery) {
        searchResults.style.display = "none";
        searchState.results = [];
        updateClearBtn();
        return;
      }

      updateClearBtn();
      searchResults.style.display = "block";
      searchResults.innerHTML = `<div class="search-status">${t("overview.search.searching")}</div>`;

      try {
        const notebooks = await getAllNotebooks();
        const quickNotes = await getQuickNotes();
        const notebookNotes = await Promise.all(notebooks.map((nb) => getNotesByNotebook(nb.id)));
        const allNotes = [...quickNotes, ...notebookNotes.flat()];

        // Create regex pattern from query with wildcard support
        // 1. Escape special regex characters
        // 2. Convert wildcards: * -> .* and ? -> .
        const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = escapeRegex(rawQuery).replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
        const searchRegex = new RegExp(pattern, "i");

        // Extract PDF text for notes that have PDF pages
        const pdfTextByNote = new Map();
        const notesWithPdfs = allNotes.filter((note) => {
          return note.media?.some((m) => m.type === "pdf-page");
        });
        await Promise.all(
          notesWithPdfs.map(async (note) => {
            // Get unique fileIds from PDF pages
            const fileIds = [
              ...new Set(note.media.filter((m) => m.type === "pdf-page").map((m) => m.fileId)),
            ];
            const texts = await Promise.all(fileIds.map((fid) => extractPdfText(fid)));
            pdfTextByNote.set(note.id, texts.join("\n"));
          }),
        );

        const results = [];
        for (const note of allNotes) {
          const contentMatch = searchRegex.test(note.content || "");
          const recognitionMatch = searchRegex.test(note.recognition?.fullText || "");
          const pdfMatch = searchRegex.test(pdfTextByNote.get(note.id) || "");
          if (contentMatch || recognitionMatch || pdfMatch) {
            results.push({ note, contentMatch, recognitionMatch, pdfMatch });
          }
        }

        searchState.results = results;
        renderSearchResultsList(searchResults, results);
      } catch (error) {
        console.error("Search error:", error);
        searchResults.innerHTML = '<div class="search-error">Error performing search</div>';
      }
    };

    searchBtn.addEventListener("click", performSearch);
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") performSearch();
    });
    searchInput.addEventListener("input", updateClearBtn);

    if (searchClearBtn) {
      searchClearBtn.addEventListener("click", () => {
        searchInput.value = "";
        searchState.query = "";
        searchState.results = [];
        searchResults.style.display = "none";
        updateClearBtn();
        searchInput.focus();
      });
    }

    // Restore state
    if (searchState.query) {
      searchInput.value = searchState.query;
      updateClearBtn();
      if (searchState.results) {
        searchResults.style.display = "block";
        renderSearchResultsList(searchResults, searchState.results);
      }
    }
  }
}

async function handleDeleteNote(noteId) {
  const note = await getNote(noteId);
  const confirmed = await showConfirmDialog(
    t("overview.delete.noteTitle"),
    t("overview.delete.noteMessage", { title: note.title }),
    t("common.delete"),
    "btn-danger",
  );
  if (confirmed) {
    await deleteNote(noteId);
    window.dispatchEvent(new CustomEvent("datachange"));
  }
}

async function handleNoteOptions(btn, noteId) {
  const note = await getNote(noteId);
  showNoteOptionsMenu(btn, note);
}

function showNoteOptionsMenu(anchor, note) {
  // Remove any existing menu
  const existing = document.getElementById("note-options-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.id = "note-options-menu";
  menu.className = "note-options-menu";
  menu.innerHTML = `
    <button class="note-options-menu__item" data-action="movecopy">${t("overview.noteOptions.moveCopy")}</button>
    <hr class="note-options-menu__separator">
    <button class="note-options-menu__item note-options-menu__item--danger" data-action="delete">${t("overview.noteOptions.delete")}</button>
  `;

  // Position below the anchor button
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 4;
  let left = rect.right - menuRect.width;
  // Keep within viewport
  if (left < 4) left = 4;
  if (top + menuRect.height > window.innerHeight - 4) top = rect.top - menuRect.height - 4;
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;

  const closeMenu = () => menu.remove();

  menu.querySelector("[data-action='movecopy']").addEventListener("click", async () => {
    closeMenu();
    const notebooks = await getAllNotebooks();
    const result = await showMoveCopyDialog(note, notebooks);
    if (!result) return;
    if (result.action === "move") {
      await moveNote(note.id, result.targetNotebookId);
    } else {
      await copyNote(note.id, result.targetNotebookId);
    }
    window.dispatchEvent(new CustomEvent("datachange"));
  });

  menu.querySelector("[data-action='delete']").addEventListener("click", async () => {
    closeMenu();
    await handleDeleteNote(note.id);
  });

  // Close on outside click or Escape
  const onOutside = (e) => {
    if (!menu.contains(e.target) && e.target !== anchor) {
      closeMenu();
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onKey);
    }
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      closeMenu();
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onKey);
    }
  };
  // Use setTimeout so the current click doesn't immediately close the menu
  setTimeout(() => {
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onKey);
  }, 0);
}

function renderSearchResultsList(container, results) {
  if (results.length === 0) {
    container.innerHTML = `<div class="search-status">${t("overview.search.noResults")}</div>`;
    return;
  }

  container.innerHTML = results
    .map(
      ({ note, contentMatch, recognitionMatch, pdfMatch }) => `
    <div class="search-result-item" data-note-id="${note.id}">
      <div class="search-result-title">${escapeHtml(note.title || t("common.untitled"))}</div>
      <div class="search-result-meta">
        <span>${formatDate(note.modified)}</span>
        <span class="search-result-sources">
          ${contentMatch ? `<span title="${t("overview.search.foundInText")}">T</span>` : ""}
          ${recognitionMatch ? `<span title="${t("overview.search.foundInHandwriting")}">✍</span>` : ""}
          ${pdfMatch ? `<span title="${t("overview.search.foundInPdf")}">PDF</span>` : ""}
        </span>
      </div>
    </div>
  `,
    )
    .join("");

  container.querySelectorAll(".search-result-item").forEach((item) => {
    item.addEventListener("click", () => {
      if (searchState.query) {
        sessionStorage.setItem("noteberg_search_query", searchState.query);
      }
      navigateTo("notebook", {
        noteId: item.dataset.noteId,
        searchQuery: searchState.query,
      });
    });
  });
}

function renderPreviewNoteCard(note) {
  // Defensive check: ensure content is a string
  const content = typeof note.content === "string" ? note.content : "";
  if (typeof note.content !== "string" && note.content) {
    console.error(
      "[OverviewMode] Note content is not a string:",
      note.id,
      typeof note.content,
      note.content,
    );
  }

  const hasDrawings = note.strokes && note.strokes.length > 0;
  const hasText = content && content.trim().length > 0;
  const hasBackground = note.background && note.background !== "none";

  let previewContent = "";

  // Use layered approach like the editor when there are drawings/background
  if (hasDrawings || hasBackground) {
    // Create layered structure exactly like the editor, then scale the whole thing
    // This ensures text and strokes maintain their exact relative positions
    const textLayer = hasText
      ? `<div class="text-editor" contenteditable="false">${markdownToHtml(content)}</div>`
      : "";
    // Render at full editor size (800x600) then scale down with CSS transform
    previewContent = `
      <div class="preview-scaler">
        <canvas class="note-preview-canvas" data-note-id="${note.id}" data-full-size="true"></canvas>
        ${textLayer}
      </div>
    `;
  } else if (hasText) {
    // For text-only notes, render the HTML directly with text-editor class
    // Convert markdown to HTML exactly like the editor does
    const textLayer = `<div class="text-editor" contenteditable="false">${markdownToHtml(content)}</div>`;
    previewContent = `
      <div class="preview-scaler">
        ${textLayer}
      </div>
    `;
  } else {
    previewContent = `<div class="preview-no-content">${t("overview.search.noContent")}</div>`;
  }

  return `
    <div class="note-card preview-card" data-note-id="${note.id}">
      <div class="note-card-header">
        <div class="note-card-title">${escapeHtml(note.title || t("common.untitled"))}</div>
        <div class="note-card-date">${formatDate(note.modified)}</div>
      </div>
      <div class="note-card-preview">
        ${previewContent}
      </div>
      <div class="note-card-actions">
         <button class="card-options-btn btn-icon" data-note-id="${note.id}" title="${t("overview.noteOptions.title")}">
            ${getIcon("moreVertical", 16)}
         </button>
      </div>
    </div>
  `;
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Draw strokes on all task canvas elements after DOM insertion.
 * Uses the taskStrokesMap populated during renderTaskItem().
 */
function drawTaskStrokeCanvases(container) {
  const canvases = container.querySelectorAll(".task-item__strokes");
  if (canvases.length === 0) return;

  const palette = getThemePalette();
  const padding = 2;

  const dpr = window.devicePixelRatio || 1;

  for (const canvas of canvases) {
    const taskId = canvas.dataset.taskId;
    const strokes = taskStrokesMap.get(taskId);
    if (!strokes || strokes.length === 0) continue;

    const bounds = getStrokeBounds(strokes);
    if (!bounds) continue;

    const rect = canvas.getBoundingClientRect();
    const canvasWidth = rect.width || 200;
    const canvasHeight = rect.height || 48;

    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    // Scale to fit canvas height; left-aligned, vertically centered
    const availableHeight = canvasHeight - padding * 2;
    const scale = availableHeight / Math.max(1, bounds.height);

    const offsetX = padding - bounds.minX * scale;
    const offsetY = padding - bounds.minY * scale;

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    for (const stroke of strokes) {
      drawStroke(ctx, stroke, palette);
    }

    ctx.restore();
  }
}

/**
 * Render a single task item for the overview tasks section
 */
function renderTaskItem(task) {
  const isDone = task.checked;
  const checkIcon = isDone ? getIcon("checkSquare", 16) : getIcon("square", 16);

  // Extract display text for text tasks from HTML content
  let label = "";
  if (task.type === "text" && task.noteContent) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(task.noteContent, "text/html");
    const span = doc.querySelector(`[data-task-id="${task.id}"]`);
    label = span?.textContent || "";
  } else if (task.type === "stroke" && task.recognition?.words && task.strokeIds?.length > 0) {
    const taskStrokeIds = new Set(task.strokeIds);
    const matchedWords = task.recognition.words.filter((word) =>
      word.strokeIds?.some((id) => taskStrokeIds.has(id)),
    );
    if (matchedWords.length > 0) {
      label = matchedWords.map((w) => w.text).join(" ");
    }
  }
  if (!label) {
    label = task.type === "text" ? t("overview.tasks.textTask") : "";
  }

  // Render strokes as mini canvas when no recognition text or debug toggle is on
  const useStrokeCanvas =
    task.type === "stroke" && task.strokes?.length > 0 && (!label || forceStrokeRender);

  let labelHtml;
  if (useStrokeCanvas) {
    taskStrokesMap.set(task.id, task.strokes);
    labelHtml = `<canvas class="task-item__strokes" data-task-id="${task.id}"></canvas>`;
  } else {
    labelHtml = `<span class="task-item__label">${escapeHtml(label || t("overview.tasks.strokeTask"))}</span>`;
  }

  return `
    <div class="task-item ${isDone ? "task-item--done" : ""}" data-note-id="${task.noteId}" data-task-id="${task.id}">
      <span class="task-item__checkbox">${checkIcon}</span>
      ${labelHtml}
      <span class="task-item__note">${escapeHtml(task.noteTitle)}</span>
    </div>
  `;
}

/**
 * Attach event listeners for the tasks section
 */
function attachTaskListeners(container) {
  // Task items: navigate to note on click
  container.querySelectorAll(".task-item").forEach((item) => {
    item.addEventListener("click", () => {
      const noteId = item.dataset.noteId;
      const taskId = item.dataset.taskId;
      if (noteId) navigateTo("notebook", { noteId, taskId });
    });
  });

  // Toggle done tasks visibility
  const toggleBtn = container.querySelector("#toggle-done-tasks");
  const doneList = container.querySelector("#done-tasks-list");
  if (toggleBtn && doneList) {
    toggleBtn.addEventListener("click", () => {
      const isHidden = doneList.style.display === "none";
      doneList.style.display = isHidden ? "" : "none";
      if (isHidden) {
        drawTaskStrokeCanvases(doneList);
      }
      const count = doneList.querySelectorAll(".task-item").length;
      toggleBtn.textContent = isHidden
        ? t("overview.tasks.hideCompleted_other", { count })
        : t("overview.tasks.showCompleted_other", { count });
    });
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Initialize overview component
 */
let currentNotebookId = null;

export function initOverview() {
  // Listen for render overview event from router
  window.addEventListener("renderoverview", async (e) => {
    const container = document.getElementById("overview-content");
    const notebookId = e.detail ? e.detail.notebookId : null;
    currentNotebookId = notebookId || null;
    if (container) {
      await renderOverview(container, notebookId);
    }
  });

  // Listen for data changes to refresh overview (skip search tab to avoid clearing input)
  window.addEventListener("datachange", async () => {
    if (currentActiveTab === "search") return;
    const container = document.getElementById("overview-content");
    if (container && container.offsetParent !== null) {
      await renderOverview(container, currentNotebookId);
    }
  });

  console.log("Overview component initialized");
}

async function renderNotePreviews(container, notes) {
  const canvases = container.querySelectorAll(".note-preview-canvas");

  const promises = Array.from(canvases).map(async (canvas) => {
    const noteId = canvas.dataset.noteId;
    const note = notes.find((n) => n.id === noteId);
    if (!note) return;

    // Check if this is a full-size canvas that needs to be rendered at 800x600
    const isFullSize = canvas.dataset.fullSize === "true";

    // Setup layout scaling (must happen for both thumbnails and live rendering)
    if (isFullSize) {
      // Set bitmap size to match the CSS size of the scaler
      canvas.width = 800;
      canvas.height = 600;

      // Calculate and apply the scale transform to the parent scaler div
      const scaler = canvas.closest(".preview-scaler");
      const previewContainer = canvas.closest(".note-card-preview");
      if (scaler && previewContainer) {
        const containerRect = previewContainer.getBoundingClientRect();
        // Use a default if rect is zero (e.g. hidden) to avoid divide by zero
        const containerWidth = containerRect.width || 300;
        const scale = containerWidth / 800;
        scaler.style.transform = `scale(${scale})`;
      }
    }

    // Check if we have a stored thumbnail
    if (note.thumbnailFileId) {
      try {
        const blob = await getFile(note.thumbnailFileId);
        if (blob) {
          const url = URL.createObjectURL(blob);
          const ctx = canvas.getContext("2d");
          const img = new Image();

          await new Promise((resolve, reject) => {
            img.onload = () => {
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              URL.revokeObjectURL(url);
              resolve();
            };
            img.onerror = reject;
            img.src = url;
          });
          return; // Success, skip legacy rendering
        }
      } catch (err) {
        console.warn("Failed to load thumbnail for note", noteId, err);
      }
    }

    // Fallback: Live rendering (Strokes only)
    if (isFullSize) {
      renderNotePreview(canvas, note, {
        padding: 20,
        fullSize: true,
      });
    } else {
      // Legacy rendering for scaled canvas
      renderNotePreview(canvas, note, {
        padding: 10,
        showTextIndicator: false,
      });
    }
  });

  await Promise.all(promises);
}
