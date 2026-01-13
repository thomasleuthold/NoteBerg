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
            <div class="confirm-message">${message}</div>
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
 * Show alert dialog (styled modal with only an OK button)
 * @param {string} title - Dialog title
 * @param {string} message - Alert message
 * @param {string} buttonText - Text for the button (default: "OK")
 * @returns {Promise<void>} Resolves when button is clicked
 */
export function showAlertDialog(title, message, buttonText = "OK") {
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
            <div class="confirm-message">${message}</div>
          </div>
          <div class="modal-footer">
            <button class="btn-primary modal-confirm">${buttonText}</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", modalHtml);

    const overlay = document.getElementById("modal-overlay");
    const confirmBtn = overlay.querySelector(".modal-confirm");
    const closeBtn = overlay.querySelector(".modal-close");

    const closeModal = () => {
      overlay.classList.add("modal-closing");
      setTimeout(() => {
        overlay.remove();
        resolve();
      }, 200);
    };

    confirmBtn.addEventListener("click", closeModal);
    closeBtn.addEventListener("click", closeModal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });

    const handleEsc = (e) => {
      if (e.key === "Escape") {
        closeModal();
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
 * Show note info modal with properties
 * @param {Object} note - Note object
 */
export function showNoteInfoModal(note) {
  const existingModal = document.getElementById("modal-overlay");
  if (existingModal) {
    existingModal.remove();
  }

  const formatDate = (ts) => (ts ? new Date(ts).toLocaleString() : "N/A");

  const modalHtml = `
    <div id="modal-overlay" class="modal-overlay">
      <div class="modal-dialog">
        <div class="modal-header">
          <h3 class="modal-title">Note Properties</h3>
          <button class="modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="note-info-list" style="line-height: 1.6;">
            <p><strong>Note ID:</strong> ${note.id}</p>
            <p><strong>Notebook ID:</strong> ${note.notebookId || "None"}</p>
            <p><strong>Note Version:</strong> ${note.version || "1"}</p>
            <p><strong>Note Modified:</strong> ${formatDate(note.modified)}</p>
            <p><strong>Note Created:</strong> ${formatDate(note.created)}</p>
            <p><strong>Synced State:</strong> ${note.synced ? "Synced" : "Local Only"}</p>
            <p><strong>Last Sync ETag:</strong> <code style="font-size: 0.9em;">${note.lastSyncedEtag || "None"}</code></p>
            <p><strong>Deleted State:</strong> ${note.deleted ? "In Recycle Bin" : "Active"}</p>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-primary modal-close-btn">Close</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);

  const overlay = document.getElementById("modal-overlay");
  const closeBtn = overlay.querySelector(".modal-close");
  const closeBtnFooter = overlay.querySelector(".modal-close-btn");

  const closeModal = () => {
    overlay.classList.add("modal-closing");
    setTimeout(() => overlay.remove(), 200);
  };

  closeBtn.addEventListener("click", closeModal);
  closeBtnFooter.addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  document.addEventListener("keydown", function handleEsc(e) {
    if (e.key === "Escape") {
      closeModal();
      document.removeEventListener("keydown", handleEsc);
    }
  });
}

/**
 * Show password prompt dialog
 * @param {string} title - Dialog title
 * @param {string} message - Prompt message
 * @returns {Promise<string|null>} Password string, or null if cancelled
 */
export function showPasswordPrompt(title, message) {
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
            <p>${message}</p>
            <div class="form-field" style="margin-top: 15px;">
              <input
                type="password"
                id="password-input"
                class="form-input"
                placeholder="Enter password"
                autocomplete="current-password"
              />
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary modal-cancel">Cancel</button>
            <button class="btn-primary modal-confirm">OK</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", modalHtml);

    const overlay = document.getElementById("modal-overlay");
    const confirmBtn = overlay.querySelector(".modal-confirm");
    const cancelBtn = overlay.querySelector(".modal-cancel");
    const closeBtn = overlay.querySelector(".modal-close");
    const passwordInput = document.getElementById("password-input");

    const closeModal = (password = null) => {
      overlay.classList.add("modal-closing");
      setTimeout(() => {
        overlay.remove();
        resolve(password);
      }, 200);
    };

    // Confirm handler
    confirmBtn.addEventListener("click", () => {
      const password = passwordInput.value;
      if (password) {
        closeModal(password);
      }
    });

    // Cancel handlers
    cancelBtn.addEventListener("click", () => closeModal(null));
    closeBtn.addEventListener("click", () => closeModal(null));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal(null);
    });

    // ESC key handler
    const handleEsc = (e) => {
      if (e.key === "Escape") {
        closeModal(null);
        document.removeEventListener("keydown", handleEsc);
      }
    };
    document.addEventListener("keydown", handleEsc);

    // Enter key handler
    const handleEnter = (e) => {
      if (e.key === "Enter") {
        const password = passwordInput.value;
        if (password) {
          closeModal(password);
          document.removeEventListener("keydown", handleEnter);
        }
      }
    };
    passwordInput.addEventListener("keydown", handleEnter);

    // Focus password input
    setTimeout(() => passwordInput.focus(), 100);
  });
}

/**
 * Show conflict resolution dialog
 * @param {Object} local - Local version
 * @param {Object} remote - Remote version
 * @returns {Promise<string>} 'local' or 'remote'
 */
export function showConflictResolutionDialog(local, remote) {
  return new Promise((resolve) => {
    const existingModal = document.getElementById("modal-overlay");
    if (existingModal) existingModal.remove();

    const formatDate = (ts) => (ts ? new Date(ts).toLocaleString() : "N/A");

    const modalHtml = `
      <div id="modal-overlay" class="modal-overlay">
        <div class="modal-dialog modal-lg" style="max-width: 800px;">
          <div class="modal-header">
            <h3 class="modal-title">Sync Conflict: ${local.title}</h3>
          </div>
          <div class="modal-body">
            <p>This note has been modified on both this device and the server. Please choose which version to keep.</p>
            <div class="conflict-comparison" style="display: flex; gap: 20px; margin-top: 20px;">
              <div class="conflict-option" style="flex: 1; padding: 15px; border: 1px solid var(--border-color); border-radius: 8px;">
                <h4>Local Version</h4>
                <p><small>Modified: ${formatDate(local.modified)}</small></p>
                <div class="content-preview" style="margin-top: 10px; font-size: 0.9em; max-height: 150px; overflow: auto; background: var(--bg-secondary); padding: 10px; border-radius: 4px; white-space: pre-wrap;">${local.content || "<i>No text content</i>"}</div>
                <p style="margin-top: 10px;">Strokes: ${local.strokes?.length || 0}</p>
                <button class="btn-primary use-local" style="width: 100%; margin-top: 15px;">Keep Local</button>
              </div>
              <div class="conflict-option" style="flex: 1; padding: 15px; border: 1px solid var(--border-color); border-radius: 8px;">
                <h4>Remote Version</h4>
                <p><small>Modified: ${formatDate(remote.modified)}</small></p>
                <div class="content-preview" style="margin-top: 10px; font-size: 0.9em; max-height: 150px; overflow: auto; background: var(--bg-secondary); padding: 10px; border-radius: 4px; white-space: pre-wrap;">${remote.content || "<i>No text content</i>"}</div>
                <p style="margin-top: 10px;">Strokes: ${remote.strokes?.length || 0}</p>
                <button class="btn-primary use-remote" style="width: 100%; margin-top: 15px;">Keep Remote</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", modalHtml);
    const overlay = document.getElementById("modal-overlay");

    const closeModal = (choice) => {
      overlay.classList.add("modal-closing");
      setTimeout(() => {
        overlay.remove();
        resolve(choice);
      }, 200);
    };

    overlay.querySelector(".use-local").addEventListener("click", () => closeModal("local"));
    overlay.querySelector(".use-remote").addEventListener("click", () => closeModal("remote"));
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
