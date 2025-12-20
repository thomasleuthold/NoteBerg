/**
 * Modal Components
 * Reusable modal dialogs for creating notebooks and notes
 */

import { createNote, createNotebook } from "../modules/storage.js";

/**
 * Show modal
 * @param {string} title - Modal title
 * @param {string} content - Modal content HTML
 * @param {Function} onConfirm - Callback when confirmed
 */
function showModal(title, content, onConfirm) {
  const existingModal = document.getElementById("modal-overlay");
  if (existingModal) {
    existingModal.remove();
  }

  const modalHtml = `
    <div id="modal-overlay" class="modal-overlay">
      <div class="modal-dialog">
        <div class="modal-header">
          <h3 class="modal-title">${title}</h3>
          <button class="modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">
          ${content}
        </div>
        <div class="modal-footer">
          <button class="btn-secondary modal-cancel">Cancel</button>
          <button class="btn-primary modal-confirm">Create</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);

  const overlay = document.getElementById("modal-overlay");
  const confirmBtn = overlay.querySelector(".modal-confirm");
  const cancelBtn = overlay.querySelector(".modal-cancel");
  const closeBtn = overlay.querySelector(".modal-close");

  // Close modal function
  const closeModal = () => {
    overlay.classList.add("modal-closing");
    setTimeout(() => overlay.remove(), 200);
  };

  // Confirm handler
  confirmBtn.addEventListener("click", async () => {
    try {
      await onConfirm();
      closeModal();
    } catch (error) {
      showError(overlay, error.message);
    }
  });

  // Cancel handlers
  cancelBtn.addEventListener("click", closeModal);
  closeBtn.addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  // ESC key handler
  const handleEsc = (e) => {
    if (e.key === "Escape") {
      closeModal();
      document.removeEventListener("keydown", handleEsc);
    }
  };
  document.addEventListener("keydown", handleEsc);

  // Focus first input
  setTimeout(() => {
    const firstInput = overlay.querySelector("input");
    if (firstInput) firstInput.focus();
  }, 100);
}

/**
 * Show error in modal
 * @param {HTMLElement} modal - Modal element
 * @param {string} message - Error message
 */
function showError(modal, message) {
  let errorEl = modal.querySelector(".modal-error");
  if (!errorEl) {
    errorEl = document.createElement("div");
    errorEl.className = "modal-error";
    modal.querySelector(".modal-body").prepend(errorEl);
  }
  errorEl.textContent = message;
  errorEl.style.display = "block";
}

/**
 * Show confirmation dialog
 * @param {string} title - Dialog title
 * @param {string} message - Confirmation message
 * @param {string} confirmText - Text for confirm button (default: "Confirm")
 * @param {string} confirmClass - CSS class for confirm button (default: "btn-danger")
 * @returns {Promise<boolean>} True if confirmed, false if cancelled
 */
export function showConfirmDialog(
  title,
  message,
  confirmText = "Confirm",
  confirmClass = "btn-danger",
) {
  return new Promise((resolve) => {
    const existingModal = document.getElementById("modal-overlay");
    if (existingModal) {
      existingModal.remove();
    }

    const modalHtml = `
      <div id="modal-overlay" class="modal-overlay">
        <div class="modal-dialog">
          <div class="modal-header">
            <h3 class="modal-title">${title}</h3>
            <button class="modal-close" aria-label="Close">&times;</button>
          </div>
          <div class="modal-body">
            <p class="confirm-message">${message}</p>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary modal-cancel">Cancel</button>
            <button class="${confirmClass} modal-confirm">${confirmText}</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", modalHtml);

    const overlay = document.getElementById("modal-overlay");
    const confirmBtn = overlay.querySelector(".modal-confirm");
    const cancelBtn = overlay.querySelector(".modal-cancel");
    const closeBtn = overlay.querySelector(".modal-close");

    // Close modal function
    const closeModal = (confirmed) => {
      overlay.classList.add("modal-closing");
      setTimeout(() => {
        overlay.remove();
        resolve(confirmed);
      }, 200);
    };

    // Confirm handler
    confirmBtn.addEventListener("click", () => closeModal(true));

    // Cancel handlers
    cancelBtn.addEventListener("click", () => closeModal(false));
    closeBtn.addEventListener("click", () => closeModal(false));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal(false);
    });

    // ESC key handler
    const handleEsc = (e) => {
      if (e.key === "Escape") {
        closeModal(false);
        document.removeEventListener("keydown", handleEsc);
      }
    };
    document.addEventListener("keydown", handleEsc);
  });
}

/**
 * Show create notebook modal
 */
export function showCreateNotebookModal() {
  const colors = [
    { name: "Blue", value: "#3b82f6" },
    { name: "Green", value: "#10b981" },
    { name: "Purple", value: "#8b5cf6" },
    { name: "Red", value: "#ef4444" },
    { name: "Orange", value: "#f59e0b" },
    { name: "Pink", value: "#ec4899" },
  ];

  const colorOptions = colors
    .map(
      (color, index) => `
    <label class="color-option">
      <input type="radio" name="color" value="${color.value}" ${index === 0 ? "checked" : ""} />
      <span class="color-swatch" style="background-color: ${color.value}"></span>
      <span class="color-name">${color.name}</span>
    </label>
  `,
    )
    .join("");

  const content = `
    <div class="form-field">
      <label for="notebook-title" class="form-label">Title *</label>
      <input
        type="text"
        id="notebook-title"
        class="form-input"
        placeholder="Enter notebook title"
        required
      />
    </div>
    <div class="form-field">
      <label for="notebook-description" class="form-label">Description</label>
      <textarea
        id="notebook-description"
        class="form-input"
        placeholder="Optional description"
        rows="3"
      ></textarea>
    </div>
    <div class="form-field">
      <label class="form-label">Color</label>
      <div class="color-options">
        ${colorOptions}
      </div>
    </div>
  `;

  showModal("Create Notebook", content, async () => {
    const titleInput = document.getElementById("notebook-title");
    const descriptionInput = document.getElementById("notebook-description");
    const colorInput = document.querySelector('input[name="color"]:checked');

    const title = titleInput.value.trim();
    if (!title) {
      throw new Error("Title is required");
    }

    const notebook = await createNotebook({
      title,
      description: descriptionInput.value.trim(),
      color: colorInput.value,
    });

    console.log("Notebook created:", notebook.id);
    window.dispatchEvent(
      new CustomEvent("datachange", {
        detail: { type: "notebook", action: "create", data: notebook },
      }),
    );
  });
}

/**
 * Show create note modal
 * @param {string|null} notebookId - Optional notebook ID to create note in
 */
export async function showCreateNoteModal(notebookId = null) {
  let notebookName = null;

  // Fetch notebook name if creating in a notebook
  if (notebookId) {
    const { getNotebook } = await import("../modules/storage.js");
    const notebook = await getNotebook(notebookId);
    notebookName = notebook ? notebook.title : null;
  }

  const content = `
    <div class="form-field">
      <label for="note-title" class="form-label">Title *</label>
      <input
        type="text"
        id="note-title"
        class="form-input"
        placeholder="Enter note title"
        required
      />
    </div>
    ${
      notebookId === null
        ? '<p class="form-hint">This will be created as a quick note (not in any notebook).</p>'
        : `<p class="form-hint">This note will be created in <strong>${notebookName || "notebook"}</strong>.</p>`
    }
  `;

  showModal("Create Note", content, async () => {
    const titleInput = document.getElementById("note-title");

    const title = titleInput.value.trim();
    if (!title) {
      throw new Error("Title is required");
    }

    const note = await createNote({
      title,
      notebookId,
    });

    console.log("Note created:", note.id);
    window.dispatchEvent(
      new CustomEvent("datachange", { detail: { type: "note", action: "create", data: note } }),
    );

    // Navigate to the note editor
    const { navigateTo } = await import("../modules/router.js");
    navigateTo("notebook", { noteId: note.id, notebookId });
  });
}

/**
 * Initialize modal event listeners
 */
export function initModals() {
  // Listen for create notebook event
  window.addEventListener("createnotebook", () => {
    showCreateNotebookModal();
  });

  // Listen for create quick note event
  window.addEventListener("createquicknote", () => {
    showCreateNoteModal(null);
  });

  // Listen for create note event (with optional notebookId)
  window.addEventListener("createnote", (e) => {
    const notebookId = e.detail?.notebookId || null;
    showCreateNoteModal(notebookId);
  });

  console.log("Modals initialized");
}
