/**
 * Breadcrumb Module
 * Manages breadcrumb navigation in the header
 */

import { getIcon } from "../utils/icons.js";
import { navigateTo } from "./router.js";
import { getNote, getNotebook } from "./storage.js";

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

  let breadcrumbHtml = `
    <button id="nav-overview" class="breadcrumb-item" aria-label="Home" title="Home">
      ${homeIcon}
    </button>
  `;

  // Add notebook if we're in a notebook
  if (mode === "notebook" && notebookId) {
    try {
      const notebook = await getNotebook(notebookId);
      if (notebook) {
        breadcrumbHtml += `
          <span class="breadcrumb-separator">→</span>
          <button class="breadcrumb-item breadcrumb-notebook" data-notebook-id="${notebookId}">
            ${escapeHtml(notebook.title)}
          </button>
        `;
      }
    } catch (error) {
      console.error("Error loading notebook for breadcrumb:", error);
    }
  }

  // Add note if we have one open
  if (mode === "notebook" && noteId) {
    try {
      const note = await getNote(noteId);
      if (note) {
        breadcrumbHtml += `
          <span class="breadcrumb-separator">→</span>
          <span class="breadcrumb-item breadcrumb-current">
            ${escapeHtml(note.title || "Untitled")}
          </span>
        `;
      }
    } catch (error) {
      console.error("Error loading note for breadcrumb:", error);
    }
  }

  breadcrumb.innerHTML = breadcrumbHtml;

  // Attach event handlers
  const overviewBtn = breadcrumb.querySelector("#nav-overview");
  if (overviewBtn) {
    overviewBtn.addEventListener("click", () => navigateTo("overview"));
  }

  const notebookBtn = breadcrumb.querySelector(".breadcrumb-notebook");
  if (notebookBtn) {
    notebookBtn.addEventListener("click", () => {
      const nbId = notebookBtn.dataset.notebookId;
      navigateTo("notebook", { notebookId: nbId });
    });
  }
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
