/**
 * Breadcrumb Module
 * Manages breadcrumb navigation in the header
 */

import { getIcon } from "../utils/icons.js";
import { navigateTo } from "./router.js";
import { getNote, getNotebook, updateNote, updateNotebook } from "./storage.js";

/**
 * Update breadcrumb based on current navigation state
 * @param {string} mode - Current mode
 * @param {string|null} notebookId - Current notebook ID
 * @param {string|null} noteId - Current note ID
 */
export async function updateBreadcrumb(mode, notebookId = null, noteId = null) {
  const breadcrumb = document.getElementById("breadcrumb");
  if (!breadcrumb) return;

  const homeIcon = getIcon("home", 24);
  const editIcon = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
  const checkIcon = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

  // Clear existing content
  breadcrumb.innerHTML = "";

  // Create Home Button
  const homeBtn = document.createElement("button");
  homeBtn.id = "nav-overview";
  homeBtn.className = "breadcrumb-item";
  homeBtn.ariaLabel = "Home";
  homeBtn.title = "Home";
  homeBtn.innerHTML = homeIcon;
  homeBtn.onclick = () => navigateTo("overview");
  breadcrumb.appendChild(homeBtn);

  // If we have a noteId, get the notebookId from the note
  let actualNotebookId = notebookId;
  let note = null;
  let notebook = null;

  if (noteId) {
    try {
      note = await getNote(noteId);
      if (note?.notebookId) {
        actualNotebookId = note.notebookId;
      }
    } catch (error) {
      console.error("Error loading note for breadcrumb:", error);
    }
  }

  // Add notebook if we're in a notebook
  if (actualNotebookId) {
    try {
      notebook = await getNotebook(actualNotebookId);
      if (notebook) {
        addSeparator(breadcrumb);

        const isLast = !note; // If no note, notebook is the active item
        const notebookItem = document.createElement(isLast ? "div" : "button");
        notebookItem.className = isLast
          ? "breadcrumb-item breadcrumb-current"
          : "breadcrumb-item breadcrumb-notebook";

        if (!isLast) {
          // It's a link to the notebook
          notebookItem.textContent = notebook.title;
          notebookItem.dataset.notebookId = actualNotebookId;
          notebookItem.onclick = () => navigateTo("overview", { notebookId: actualNotebookId });
        } else {
          // It's the current view (Notebook Overview) - Allow rename
          setupEditableItem(
            notebookItem,
            notebook.title,
            editIcon,
            checkIcon,
            async (newName) => {
              if (newName && newName !== notebook.title) {
                await updateNotebook(notebook.id, { title: newName });
                window.dispatchEvent(new CustomEvent("datachange"));
                return true;
              }
              return false;
            },
          );
        }

        breadcrumb.appendChild(notebookItem);
      }
    } catch (error) {
      console.error("Error loading notebook for breadcrumb:", error);
    }
  }

  // Add note if we have one open
  if (note) {
    addSeparator(breadcrumb);

    const noteItem = document.createElement("div");
    noteItem.className = "breadcrumb-item breadcrumb-current";

    setupEditableItem(
      noteItem,
      note.title || "Untitled",
      editIcon,
      checkIcon,
      async (newName) => {
        if (newName && newName !== note.title) {
          await updateNote(note.id, { title: newName });
          window.dispatchEvent(new CustomEvent("datachange"));
          return true;
        }
        return false;
      },
    );

    breadcrumb.appendChild(noteItem);
  }
}

function addSeparator(container) {
  const sep = document.createElement("span");
  sep.className = "breadcrumb-separator";
  sep.textContent = "→";
  container.appendChild(sep);
}

function setupEditableItem(container, text, editIcon, checkIcon, onSave) {
  container.style.display = "flex";
  container.style.alignItems = "center";
  container.style.gap = "8px";

  const label = document.createElement("span");
  label.className = "breadcrumb-label";
  label.textContent = text;
  container.appendChild(label);

  const btn = document.createElement("button");
  btn.className = "breadcrumb-edit-btn";
  btn.innerHTML = editIcon;
  btn.title = "Rename";
  btn.style.background = "none";
  btn.style.border = "none";
  btn.style.cursor = "pointer";
  btn.style.color = "var(--text-secondary)";
  btn.style.display = "flex";
  btn.style.alignItems = "center";
  btn.style.padding = "4px";

  const startEdit = () => {
    const input = document.createElement("input");
    input.type = "text";
    input.value = label.textContent;
    input.className = "breadcrumb-edit-input";
    input.style.font = "inherit";
    input.style.minWidth = "100px";
    input.style.width = Math.max(100, input.value.length * 10) + "px";

    const save = async () => {
      const newName = input.value.trim();
      const success = await onSave(newName);
      if (success) label.textContent = newName;
      container.replaceChild(label, input);
      btn.innerHTML = editIcon;
      btn.title = "Rename";
      btn.onclick = startEdit;
    };

    container.replaceChild(input, label);
    btn.innerHTML = checkIcon;
    btn.title = "Save";
    btn.onclick = save;

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
      if (e.key === "Escape") {
        container.replaceChild(label, input);
        btn.innerHTML = editIcon;
        btn.title = "Rename";
        btn.onclick = startEdit;
      }
    });

    input.focus();
    input.select();
  };

  btn.onclick = startEdit;
  container.appendChild(btn);
}

/**
 * Initialize breadcrumb component
 */
export function initBreadcrumb() {
  // Initialize the home icon on page load
  const navOverview = document.getElementById("nav-overview");
  if (navOverview) {
    navOverview.innerHTML = getIcon("home", 24);
  }

  // Update breadcrumb on navigation
  window.addEventListener("navigate", async (e) => {
    const { mode } = e.detail;
    const { notebookId, noteId } = e.detail.params || {};
    await updateBreadcrumb(mode, notebookId, noteId);
  });

  console.log("Breadcrumb component initialized");
}
