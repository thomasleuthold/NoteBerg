/**
 * Overview Mode Component
 * Displays notebooks and quick notes in grid/list layout
 */

import { t } from "../i18n/index.js";
import { getCardSize } from "../modules/displayPrefs.js";
import { extractPdfText } from "../modules/pdfManager.js";
import { navigateTo } from "../modules/router.js";
import {
  copyNote,
  deleteNote,
  deleteNotebook,
  getAllNotebooks,
  getAllNotes,
  getDeletedNotebooks,
  getDeletedNotes,
  getNote,
  getNotebook,
  getNotesByNotebook,
  getQuickNotes,
  moveNote,
  purgeNote,
  purgeNotebook,
  restoreNote,
  restoreNotebook,
} from "../modules/storage.js";
// getAllNotes / getNotesByNotebook / getQuickNotes now return lightweight index entries
// (no strokes, no content, no recognition). Use getNote(id) when full content is needed.
import { getIcon } from "../utils/icons.js";
import {
  drawStroke,
  getStrokeBounds,
  getThemePalette,
  renderNotePreview,
  renderNoteSnapshot,
} from "../utils/noteRenderer.js";
import {
  showConfirmDialog,
  showEditNotebookModal,
  showEditNoteModal,
  showMoveCopyDialog,
} from "./modals.js";
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

// Incremented on every renderActiveTab (and direct re-render) call. Sub-renderers capture
// their own token and check it against the current value before writing to the DOM, so a
// slow render for a tab the user has since navigated away from can't clobber the active tab.
let renderToken = 0;

// Render concurrency guard: prevents two renderOverview calls from racing on the same container.
// If a render is in progress when datachange fires, we note that a refresh is pending and
// let the active render trigger it when done, rather than starting a second concurrent render.
let isRendering = false;
let pendingRender = false;

/**
 * Render overview UI
 * @param {HTMLElement} container - Container element to render into
 * @param {string|null} notebookId - Optional notebook ID to show contents of
 */
export async function renderOverview(
  container,
  notebookId = null,
  { preserveScroll = false } = {},
) {
  // Save scroll position before wiping the DOM, restore it after if requested.
  const tabContent = container.querySelector("#overview-tab-content");
  const savedScrollTop = preserveScroll && tabContent ? tabContent.scrollTop : 0;

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
            ${notebookIcon} <span class="tab-label">${t("overview.tabs.notes")}</span>
          </button>
          <button class="tab-btn ${currentActiveTab === "search" ? "active" : ""}" data-tab="search">
            ${searchIcon} <span class="tab-label">${t("overview.tabs.search")}</span>
          </button>
          <button class="tab-btn ${currentActiveTab === "markers" ? "active" : ""}" data-tab="markers">
            ${markersIcon} <span class="tab-label">${t("overview.tabs.markers")}</span>
          </button>

          <button class="tab-btn recycle-bin-tab ${currentActiveTab === "recyclebin" ? "active" : ""}" data-tab="recyclebin">
            ${trashIcon}
            <span class="tab-label">${t("overview.tabs.recycleBin")}</span>
          </button>
        </div>

        <div id="overview-tab-content" class="overview-tab-content"></div>
      </div>
    `;

    // Apply card size class from settings
    const cardSize = getCardSize();
    const overviewContainer = container.querySelector(".overview-container");
    if (overviewContainer) {
      overviewContainer.classList.add(`card-size-${cardSize}`);
    }

    // Attach Shell Listeners
    attachShellListeners(container, notebookId);

    // Render Initial Tab
    await renderActiveTab(container.querySelector("#overview-tab-content"), notebookId);

    // Restore scroll position after content is in the DOM
    if (preserveScroll && savedScrollTop > 0) {
      const newTabContent = container.querySelector("#overview-tab-content");
      if (newTabContent) newTabContent.scrollTop = savedScrollTop;
    }
  } catch (error) {
    console.error("Error rendering overview:", error);
    renderError(container, error);
  }
}

async function renderNotesList(container, myToken) {
  // Fetch data (notebooks and quick notes are independent — fetch concurrently)
  const [notebooks, quickNotes] = await Promise.all([getAllNotebooks(), getQuickNotes()]);

  // Get note counts for each notebook
  const notebookData = await Promise.all(
    notebooks.map(async (notebook) => {
      const notes = await getNotesByNotebook(notebook.id);
      const lastNoteModified = notes.length > 0 ? Math.max(...notes.map((n) => n.modified)) : 0;
      const effectiveUpdatedAt = Math.max(notebook.modified || 0, lastNoteModified);
      return { notebook, count: notes.length, effectiveUpdatedAt };
    }),
  );

  if (myToken !== renderToken) return;

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
    if (myToken !== renderToken) return;
    renderNotePreviews(container, quickNotes);
  });
}

async function renderNotebookContents(container, notebookId, myToken) {
  const notebook = await getNotebook(notebookId);
  if (!notebook) throw new Error("Notebook not found");

  const notes = await getNotesByNotebook(notebookId);

  if (myToken !== renderToken) return;

  const notesHtml =
    notes.length > 0
      ? notes.map((note) => renderPreviewNoteCard(note)).join("")
      : `<p class="empty-state">${t("overview.empty.noNotesInNotebook")}</p>`;

  container.innerHTML = `
    <div class="section-header">
      <div class="notebook-back-group">
        <button class="notebook-back-btn" id="notebook-back-btn" title="${t("overview.tabs.backToNotebooks")}" aria-label="${t("overview.tabs.backToNotebooks")}">
          ${getIcon("arrowLeft", 20)}
        </button>
        <h3 class="notebook-back-title">${notebook.title}</h3>
      </div>
      <button class="btn-primary" id="new-note-btn">${t("overview.actions.newNote")}</button>
    </div>
    <div class="notes-grid">
      ${notesHtml}
    </div>
  `;

  // Attach listeners
  const backBtn = container.querySelector("#notebook-back-btn");
  if (backBtn) {
    backBtn.addEventListener("click", () => navigateTo("overview"));
  }

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
    if (myToken !== renderToken) return;
    renderNotePreviews(container, notes);
  });
}

async function renderSearchTab(container, myToken) {
  if (myToken !== renderToken) return;
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

/** Number of notes fetched/decoded per batch while progressively building the markers tab. */
const MARKERS_BATCH_SIZE = 8;

export function extractTasksFromNote(note) {
  const tasks = [];
  try {
    const noteTasks = Array.isArray(note.tasks) ? note.tasks : [];

    let recognition = note.recognition;
    if (typeof recognition === "string") {
      try {
        recognition = JSON.parse(recognition);
      } catch (_e) {
        recognition = null;
      }
    }
    if (recognition !== null && !Array.isArray(recognition?.words)) {
      recognition = null;
    }

    const rawDeletedTasks = Array.isArray(note.deletedTasks) ? note.deletedTasks : [];
    const deletedTaskIds = new Set(rawDeletedTasks);
    const noteStrokes = Array.isArray(note.strokes) ? note.strokes : [];
    for (const task of noteTasks) {
      // Skip explicitly deleted tasks and ghost stroke tasks (all strokes gone)
      if (deletedTaskIds.has(task.id)) continue;
      const taskStrokeIds = new Set(task.strokeIds || []);
      const taskStrokes = noteStrokes.filter(
        (s) => taskStrokeIds.has(s.id) && !s._deleted && !s.isDeleted,
      );
      if (task.type === "stroke" && taskStrokes.length === 0) continue;
      tasks.push({
        ...task,
        noteId: note.id,
        noteTitle: note.title || t("common.untitled"),
        noteContent: note.content || "",
        recognition,
        strokes: taskStrokes,
      });
    }
  } catch (noteError) {
    console.warn(`[markers] Skipping note ${note.id} due to error:`, noteError);
  }
  return tasks;
}

// Note: renderTaskItem() (called from within the returned HTML template) populates
// taskStrokesMap as a side effect, so callers must reset the map before invoking this.
function buildTasksHtml(allTasks) {
  const openTasks = allTasks.filter((t) => !t.checked);
  const doneTasks = allTasks.filter((t) => t.checked);

  return allTasks.length > 0
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
}

async function renderMarkersTab(container, myToken) {
  // Collect tasks from all notes — need full content (tasks, strokes, recognition)
  const noteIndexes = await getAllNotes();
  if (myToken !== renderToken) return;

  // In Tauri build, getAllNotes() returns index entries with hasStrokes/hasContent flags.
  // In NC build, it returns full notes directly — those flags are never set, so fall back
  // to checking tasks/strokes/content directly.
  const notesWithTasks = noteIndexes.filter(
    (n) =>
      n.hasStrokes ||
      n.hasContent ||
      (n.tasks && n.tasks.length > 0) ||
      (n.strokes && n.strokes.length > 0) ||
      n.content,
  );

  const allTasks = [];

  const renderProgress = (isFinal) => {
    if (myToken !== renderToken) return;
    taskStrokesMap = new Map();
    container.innerHTML = buildTasksHtml(allTasks);
    drawTaskStrokeCanvases(container);
    attachTaskListeners(container);
    if (isFinal) {
      const toggleBtn = container.querySelector("#toggle-task-display");
      if (toggleBtn) {
        toggleBtn.addEventListener("click", () => {
          forceStrokeRender = !forceStrokeRender;
          // Mint a fresh token so any still-running batch loop from the previous
          // render is invalidated and can't clobber this re-render.
          renderMarkersTab(container, ++renderToken);
        });
      }
    }
  };

  if (notesWithTasks.length === 0) {
    renderProgress(true);
    return;
  }

  // Fetch+decode notes in small batches and paint after each one, so the user sees tasks
  // appear progressively instead of waiting for every note to finish loading.
  for (let i = 0; i < notesWithTasks.length; i += MARKERS_BATCH_SIZE) {
    const batch = notesWithTasks.slice(i, i + MARKERS_BATCH_SIZE);
    const fullNotes = await Promise.all(batch.map((n) => getNote(n.id)));
    if (myToken !== renderToken) return;

    for (const note of fullNotes) {
      if (!note) continue;
      allTasks.push(...extractTasksFromNote(note));
    }

    renderProgress(i + MARKERS_BATCH_SIZE >= notesWithTasks.length);
  }
}

async function renderRecycleBinTab(container, myToken) {
  const [deletedNotebooks, deletedNotes] = await Promise.all([
    getDeletedNotebooks(),
    getDeletedNotes(),
  ]);
  if (myToken !== renderToken) return;
  const totalItems = deletedNotebooks.length + deletedNotes.length;

  const notebookIcon = getIcon("notebook", 24);
  const noteIcon = getIcon("note", 24);
  const restoreIcon = getIcon("restore", 16);
  const trashIcon = getIcon("trash", 16);

  const escHtml = (text) => {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  };

  const fmtDate = (ts) => {
    const date = new Date(ts);
    const now = new Date();
    const diffMins = Math.floor((now - date) / 60000);
    const diffHours = Math.floor((now - date) / 3600000);
    const diffDays = Math.floor((now - date) / 86400000);
    if (diffMins < 1) return t("common.justNow");
    if (diffMins < 60) return t("common.minutesAgo", { count: diffMins });
    if (diffHours < 24) return t("common.hoursAgo", { count: diffHours });
    if (diffDays < 7) return t("common.daysAgo", { count: diffDays });
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const renderItem = (item, type, icon) => `
    <div class="recycle-item" data-type="${type}" data-id="${item.id}">
      <div class="recycle-item-icon">${icon}</div>
      <div class="recycle-item-content">
        <div class="recycle-item-title">${escHtml(item.title || t("common.untitled"))}</div>
        <div class="recycle-item-meta">
          <span class="recycle-item-type">${type === "notebook" ? t("recycleBin.notebook") : t("recycleBin.note")}</span>
          <span class="recycle-item-date">${t("recycleBin.deletedOn", { date: fmtDate(item.modified) })}</span>
        </div>
      </div>
      <div class="recycle-item-actions">
        <button class="btn-restore" data-type="${type}" data-id="${item.id}" title="${t("recycleBin.restoreTitle")}">
          ${restoreIcon} ${t("recycleBin.restore")}
        </button>
        <button class="btn-purge" data-type="${type}" data-id="${item.id}" title="${t("recycleBin.purgeTitle")}">
          ${trashIcon} ${t("recycleBin.purge")}
        </button>
      </div>
    </div>
  `;

  if (totalItems === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon" style="margin-bottom: 1rem; color: var(--text-secondary);">
          ${getIcon("trash", 64)}
        </div>
        <h3>${t("recycleBin.emptyTitle")}</h3>
        <p>${t("recycleBin.emptyDesc")}</p>
      </div>
    `;
  } else {
    const notebooksHtml =
      deletedNotebooks.length > 0
        ? deletedNotebooks.map((nb) => renderItem(nb, "notebook", notebookIcon)).join("")
        : `<p class="empty-state">${t("recycleBin.emptyNotebooks")}</p>`;
    const notesHtml =
      deletedNotes.length > 0
        ? deletedNotes.map((n) => renderItem(n, "note", noteIcon)).join("")
        : `<p class="empty-state">${t("recycleBin.emptyNotes")}</p>`;

    container.innerHTML = `
      <div class="recycle-bin-container">
        <div class="recycle-bin-section">
          <h3>${t("recycleBin.notebooksCount", { count: deletedNotebooks.length })}</h3>
          <div class="recycle-items-list">${notebooksHtml}</div>
        </div>
        <div class="recycle-bin-section">
          <h3>${t("recycleBin.notesCount", { count: deletedNotes.length })}</h3>
          <div class="recycle-items-list">${notesHtml}</div>
        </div>
      </div>
    `;
  }

  // Restore buttons
  container.querySelectorAll(".btn-restore").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        if (btn.dataset.type === "notebook") {
          await restoreNotebook(btn.dataset.id);
        } else {
          await restoreNote(btn.dataset.id);
        }
        window.dispatchEvent(new CustomEvent("datachange"));
      } catch (error) {
        console.error("Error restoring item:", error);
      }
    });
  });

  // Purge buttons
  container.querySelectorAll(".btn-purge").forEach((btn) => {
    btn.addEventListener("click", async () => {
      let message =
        "Are you sure you want to permanently delete this item? This will remove it from all synced devices and cannot be undone.";
      if (btn.dataset.type === "notebook") {
        const notes = await getDeletedNotes();
        const count = notes.filter((n) => n.notebookId === btn.dataset.id).length;
        if (count > 0) {
          message = `Are you sure you want to permanently delete this notebook? This will also permanently delete ${count} note(s) inside it. This will remove it from all synced devices and cannot be undone.`;
        }
      }
      const confirmed = await showConfirmDialog(
        "Delete Permanently",
        message,
        "Delete",
        "btn-danger",
      );
      if (confirmed) {
        try {
          if (btn.dataset.type === "note") {
            await purgeNote(btn.dataset.id);
          } else {
            await purgeNotebook(btn.dataset.id);
          }
          window.dispatchEvent(new CustomEvent("datachange"));
        } catch (error) {
          console.error("Error purging item:", error);
        }
      }
    });
  });
}

async function renderActiveTab(container, notebookId) {
  const myToken = ++renderToken;
  container.innerHTML = `<div class="loading-state">${t("overview.loading")}</div>`;

  try {
    if (currentActiveTab === "notes") {
      if (notebookId) {
        await renderNotebookContents(container, notebookId, myToken);
      } else {
        await renderNotesList(container, myToken);
      }
    } else if (currentActiveTab === "search") {
      await renderSearchTab(container, myToken);
    } else if (currentActiveTab === "markers") {
      await renderMarkersTab(container, myToken);
    } else if (currentActiveTab === "recyclebin") {
      await renderRecycleBinTab(container, myToken);
    }
  } catch (error) {
    if (myToken !== renderToken) return;
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

  // Notebook options button clicks
  const notebookOptionsBtns = container.querySelectorAll(".notebook-card .card-options-btn");
  notebookOptionsBtns.forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const notebookId = btn.dataset.notebookId;
      const notebook = await getNotebook(notebookId);
      showNotebookOptionsMenu(btn, notebook);
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

/**
 * Search all notes' typed content, recognized handwriting, and extracted PDF
 * text for a query (supports `*`/`?` wildcards). Extracted from the overview
 * search UI's inline handler so both the UI and the MCP bridge (mcpBridge.js's
 * search_notes tool) share one implementation instead of duplicating it.
 * @param {string} rawQuery
 * @returns {Promise<Array<{note: object, contentMatch: boolean, recognitionMatch: boolean, pdfMatch: boolean}>>}
 */
export async function searchAllNotes(rawQuery) {
  // Title search uses index only (fast). Content/recognition/PDF search needs full notes.
  const notebooks = await getAllNotebooks();
  const quickNoteIndexes = await getQuickNotes();
  const notebookNoteIndexes = await Promise.all(notebooks.map((nb) => getNotesByNotebook(nb.id)));
  const allIndexes = [...quickNoteIndexes, ...notebookNoteIndexes.flat()];

  // Load full notes for content/recognition/PDF search
  const fullNotes = await Promise.all(allIndexes.map((idx) => getNote(idx.id)));
  const allNotes = fullNotes.filter(Boolean);

  // Extract PDF text for notes that have PDF pages
  const pdfTextByNote = new Map();
  const notesWithPdfs = allNotes.filter((note) => {
    return note.media?.some((m) => m.type === "pdf-page");
  });
  await Promise.all(
    notesWithPdfs.map(async (note) => {
      const fileIds = [
        ...new Set(note.media.filter((m) => m.type === "pdf-page").map((m) => m.fileId)),
      ];
      const texts = await Promise.all(fileIds.map((fid) => extractPdfText(fid)));
      pdfTextByNote.set(note.id, texts.join("\n"));
    }),
  );

  const results = [];
  for (const note of allNotes) {
    const contentMatch = globQueryMatches(rawQuery, note.content || "");
    const recognitionMatch = globQueryMatches(rawQuery, note.recognition?.fullText || "");
    const pdfMatch = globQueryMatches(rawQuery, pdfTextByNote.get(note.id) || "");
    if (contentMatch || recognitionMatch || pdfMatch) {
      results.push({ note, contentMatch, recognitionMatch, pdfMatch });
    }
  }
  return results;
}

/**
 * Case-insensitive glob match ("*" = any run of characters incl. none, "?" =
 * exactly one character, anything else literal), unanchored — true if the
 * pattern matches anywhere in `text`, mirroring the previous implementation
 * (a regex .test() with no ^/$ anchors and "*"/"?" mapped to ".*"/".").
 *
 * Implemented as a linear two-pointer scan (the standard non-recursive
 * wildcard-matching algorithm), NOT a regex — a regex built by translating
 * "*" to ".*" is catastrophic-backtracking: measured empirically, a 3-
 * wildcard query against 800 characters of non-matching content took 41
 * SECONDS (single-threaded JS, so this froze the whole app, not just
 * search), and 2 wildcards were already badly non-linear (2000 chars: 3.2s;
 * 4000 chars: 24s). A wildcard-count cap doesn't fix this — 2 adjacent
 * wildcards are already enough for exponential blowup, so a cap tight enough
 * to be safe (1 wildcard) still isn't linear and defeats normal glob usage.
 * This scan is provably O(pattern length * text length) with no
 * backtracking regardless of wildcard count or position — confirmed
 * empirically: 50 wildcards against 500,000 characters resolves in ~11ms.
 *
 * Reachable with an attacker/LLM-controlled query via MCP's search_notes
 * tool (mcpBridge.js), not just a person typing into the search box, so
 * safety can't depend on "no one would type that".
 */
function globQueryMatches(rawQuery, text) {
  const query = rawQuery.toLowerCase();
  const haystack = text.toLowerCase();

  // Old regex had no ^/$ anchors, so it matched the pattern anywhere as a
  // substring. Pad with "*" on whichever side doesn't already have one, so
  // the anchored scan below becomes an unanchored "find anywhere" match
  // without changing its (already-linear) algorithm.
  const withLeadingStar = query.startsWith("*") ? query : `*${query}`;
  const pattern = withLeadingStar.endsWith("*") ? withLeadingStar : `${withLeadingStar}*`;

  return wildcardMatch(pattern, haystack);
}

/** Anchored glob match: pattern must account for the entire `text`. `pattern` is assumed lowercase and to already contain any "*"/"?" wildcards. */
function wildcardMatch(pattern, text) {
  let patternIndex = 0;
  let textIndex = 0;
  let starIndex = -1; // last "*" seen in pattern, or -1 if none yet
  let starMatchIndex = 0; // how much of text the last "*" has tentatively consumed

  while (textIndex < text.length) {
    if (
      patternIndex < pattern.length &&
      (pattern[patternIndex] === "?" || pattern[patternIndex] === text[textIndex])
    ) {
      patternIndex++;
      textIndex++;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      starIndex = patternIndex;
      starMatchIndex = textIndex;
      patternIndex++;
    } else if (starIndex !== -1) {
      // Mismatch after a "*": let the "*" absorb one more character and retry.
      patternIndex = starIndex + 1;
      starMatchIndex++;
      textIndex = starMatchIndex;
    } else {
      return false;
    }
  }

  // Any trailing "*"s in the pattern match the empty remainder.
  while (patternIndex < pattern.length && pattern[patternIndex] === "*") patternIndex++;
  return patternIndex === pattern.length;
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
        const results = await searchAllNotes(rawQuery);
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

    // Focus the search field when the tab activates so the user can type
    // immediately; ENTER then runs the search (harmless action).
    setTimeout(() => searchInput.focus(), 100);
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
    <button class="note-options-menu__item" data-action="edit">${t("overview.noteOptions.edit")}</button>
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

  menu.querySelector("[data-action='edit']").addEventListener("click", () => {
    closeMenu();
    showEditNoteModal(note);
  });

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

function showNotebookOptionsMenu(anchor, notebook) {
  const existing = document.getElementById("note-options-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.id = "note-options-menu";
  menu.className = "note-options-menu";
  menu.innerHTML = `
    <button class="note-options-menu__item" data-action="edit">${t("overview.notebookOptions.edit")}</button>
    <hr class="note-options-menu__separator">
    <button class="note-options-menu__item note-options-menu__item--danger" data-action="delete">${t("overview.notebookOptions.delete")}</button>
  `;

  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 4;
  let left = rect.right - menuRect.width;
  if (left < 4) left = 4;
  if (top + menuRect.height > window.innerHeight - 4) top = rect.top - menuRect.height - 4;
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;

  const closeMenu = () => menu.remove();

  menu.querySelector("[data-action='edit']").addEventListener("click", () => {
    closeMenu();
    showEditNotebookModal(notebook);
  });

  menu.querySelector("[data-action='delete']").addEventListener("click", async () => {
    closeMenu();
    const confirmed = await showConfirmDialog(
      t("overview.delete.notebookTitle"),
      t("overview.delete.notebookMessage", { title: notebook.title }),
      t("common.delete"),
      "btn-danger",
    );
    if (confirmed) {
      await deleteNotebook(notebook.id);
      window.dispatchEvent(new CustomEvent("datachange"));
    }
  });

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
  // Index entries carry hasStrokes/hasContent flags — no need to load content for layout.
  const hasDrawings = note.hasStrokes ?? (note.strokes && note.strokes.length > 0);
  const hasText =
    note.hasContent ?? (typeof note.content === "string" && note.content.trim().length > 0);
  const hasBackground = note.background && note.background !== "none";
  const hasMedia = Array.isArray(note.media) ? note.media.some((m) => !m.deleted) : false;

  let previewContent = "";

  if (hasDrawings || hasBackground || hasText || hasMedia) {
    previewContent = `
      <div class="preview-scaler">
        <div class="note-preview-spinner"></div>
        <canvas class="note-preview-canvas" data-note-id="${note.id}" data-full-size="true"></canvas>
      </div>
    `;
  } else {
    previewContent = `<div class="preview-no-content">${t("overview.search.noContent")}</div>`;
  }

  return `
    <div class="note-card preview-card" data-note-id="${note.id}">
      <button class="card-options-btn btn-icon" data-note-id="${note.id}" title="${t("overview.noteOptions.title")}">
        ${getIcon("moreVertical", 16)}
      </button>
      <div class="note-card-header">
        <div class="note-card-title">${escapeHtml(note.title || t("common.untitled"))}</div>
        <div class="note-card-date">${formatDate(note.modified)}</div>
      </div>
      <div class="note-card-preview">
        ${previewContent}
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
/**
 * Derive a human-readable label for a task (from extractTasksFromNote's output):
 * for a "text" task, the plain text of the matching <span data-task-id> in the
 * note's HTML content; for a "stroke" task, the recognized words whose
 * strokeIds overlap the task's strokeIds, joined. Returns "" if no label could
 * be derived (caller decides the fallback — see renderTaskItem below).
 * Exported so the MCP bridge (get_task_markers) can reuse the same derivation
 * instead of duplicating it.
 * @param {object} task
 * @returns {string}
 */
export function deriveTaskLabel(task) {
  if (task.type === "text" && task.noteContent) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(task.noteContent, "text/html");
    const span = doc.querySelector(`[data-task-id="${task.id}"]`);
    return span?.textContent || "";
  }
  if (task.type === "stroke" && task.recognition?.words && task.strokeIds?.length > 0) {
    const taskStrokeIds = new Set(task.strokeIds);
    const matchedWords = task.recognition.words.filter((word) =>
      word.strokeIds?.some((id) => taskStrokeIds.has(id)),
    );
    if (matchedWords.length > 0) {
      return matchedWords.map((w) => w.text).join(" ");
    }
  }
  return "";
}

function renderTaskItem(task) {
  const isDone = task.checked;
  const checkIcon = isDone ? getIcon("checkSquare", 16) : getIcon("square", 16);

  let label = deriveTaskLabel(task);
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
    if (!container) return;

    // Navigation always does a fresh render (no scroll preserve). Cancel any pending
    // datachange render — the fresh render supersedes it.
    pendingRender = false;
    isRendering = true;
    try {
      await renderOverview(container, notebookId);
    } finally {
      isRendering = false;
    }
  });

  // Listen for data changes to refresh overview (skip search tab to avoid clearing input).
  // The guard prevents a second concurrent renderOverview from starting while one is already
  // running (e.g. the initial renderoverview and a sync-triggered datachange overlapping).
  // If a render is in progress we set a flag; the active render will re-run when it finishes.
  window.addEventListener("datachange", async () => {
    if (currentActiveTab === "search") return;
    const container = document.getElementById("overview-content");
    if (!container || container.offsetParent === null) return;

    if (isRendering) {
      pendingRender = true;
      return;
    }

    isRendering = true;
    try {
      await renderOverview(container, currentNotebookId, { preserveScroll: true });
      // If another datachange arrived while we were rendering, do one more pass now.
      while (pendingRender) {
        pendingRender = false;
        await renderOverview(container, currentNotebookId, { preserveScroll: true });
      }
    } finally {
      isRendering = false;
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

    // Check if this is a full-size canvas that needs to be rendered at 360x500
    const isFullSize = canvas.dataset.fullSize === "true";

    // Setup layout scaling (must happen for both thumbnails and live rendering)
    if (isFullSize) {
      // Set bitmap size accounting for device pixel ratio for sharp rendering
      const dpr = window.devicePixelRatio || 1;
      canvas.width = 360 * dpr;
      canvas.height = 500 * dpr;

      // Calculate and apply the scale transform to the parent scaler div
      // The scaler CSS size is 360x500, so we scale down by dpr to compensate
      // for the larger bitmap, then scale to fit the container.
      const scaler = canvas.closest(".preview-scaler");
      const previewContainer = canvas.closest(".note-card-preview");
      if (scaler && previewContainer) {
        const containerRect = previewContainer.getBoundingClientRect();
        // Use a default if rect is zero (e.g. hidden) to avoid divide by zero
        const containerWidth = containerRect.width || 300;
        const scale = containerWidth / 360;
        scaler.style.transform = `scale(${scale})`;
      }
    }

    const fullNote = await getNote(noteId).catch(() => null);
    if (!fullNote) return;

    if (isFullSize) {
      await renderNoteSnapshot(canvas, fullNote);
    } else {
      renderNotePreview(canvas, fullNote, { padding: 10 });
    }

    // Hide spinner once rendering completes
    const spinner = canvas.closest(".preview-scaler")?.querySelector(".note-preview-spinner");
    if (spinner) spinner.remove();
  });

  await Promise.all(promises);
}
