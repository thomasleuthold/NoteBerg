/**
 * Breadcrumb Module
 * Manages breadcrumb navigation in the header
 */

import { t } from "../i18n/index.js";
import { getIcon } from "../utils/icons.js";
import { navigateTo } from "./router.js";
import { getNote, getNotebook } from "./storage.js";

/**
 * Update breadcrumb based on current navigation state
 * @param {string} mode - Current mode
 * @param {string|null} notebookId - Current notebook ID
 * @param {string|null} noteId - Current note ID
 */
export async function updateBreadcrumb(_mode, notebookId = null, noteId = null) {
  const breadcrumb = document.getElementById("breadcrumb");
  if (!breadcrumb) return;

  const homeIcon = getIcon("home", 24);

  // Clear existing content
  breadcrumb.innerHTML = "";

  // Create Home Button
  const homeBtn = document.createElement("button");
  homeBtn.id = "nav-overview";
  homeBtn.className = "breadcrumb-item";
  homeBtn.ariaLabel = t("breadcrumb.home");
  homeBtn.title = t("breadcrumb.home");
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
        notebookItem.textContent = notebook.title;

        if (!isLast) {
          notebookItem.dataset.notebookId = actualNotebookId;
          notebookItem.onclick = () => navigateTo("overview", { notebookId: actualNotebookId });
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
    noteItem.textContent = note.title || t("common.untitled");

    breadcrumb.appendChild(noteItem);
  }
}

function addSeparator(container) {
  const sep = document.createElement("span");
  sep.className = "breadcrumb-separator";
  sep.textContent = "→";
  container.appendChild(sep);
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
