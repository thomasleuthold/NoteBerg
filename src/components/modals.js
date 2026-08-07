/**
 * Modal Components
 * Reusable modal dialogs for creating notebooks and notes
 */

import { t } from "../i18n/index.js";
import { createNote, createNotebook, updateNote, updateNotebook } from "../modules/storage.js";
import { sanitizeNoteHtml } from "../utils/sanitizeHtml.js";

/**
 * Show modal
 * @param {string} title - Modal title
 * @param {string} content - Modal content HTML
 * @param {Function} onConfirm - Callback when confirmed
 */
function showModal(title, content, onConfirm, confirmLabel) {
  const existingModal = document.getElementById("modal-overlay");
  if (existingModal) {
    existingModal.remove();
  }

  const modalHtml = `
    <div id="modal-overlay" class="modal-overlay">
      <div class="modal-dialog">
        <div class="modal-header">
          <h3 class="modal-title">${title}</h3>
          <button class="modal-close" aria-label="${t("modals.close")}">&times;</button>
        </div>
        <div class="modal-body">
          ${content}
        </div>
        <div class="modal-footer">
          <button class="btn-secondary modal-cancel">${t("common.cancel")}</button>
          <button class="btn-primary modal-confirm">${confirmLabel ?? t("common.create")}</button>
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
  let mousedownOnOverlay = false;
  overlay.addEventListener("mousedown", (e) => {
    mousedownOnOverlay = e.target === overlay;
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && mousedownOnOverlay) closeModal();
  });

  // ESC key handler
  const handleEsc = (e) => {
    if (e.key === "Escape") {
      closeModal();
      document.removeEventListener("keydown", handleEsc);
    }
  };
  document.addEventListener("keydown", handleEsc);

  // ENTER confirms (harmless create/edit action). Bound to text inputs only so
  // ENTER inside a <textarea> still inserts a newline.
  overlay.querySelectorAll('input[type="text"]').forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        confirmBtn.click();
      }
    });
  });

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
 * @param {string} confirmText - Text for confirm button
 * @param {string} confirmClass - CSS class for confirm button (default: "btn-danger")
 * @returns {Promise<boolean>} True if confirmed, false if cancelled
 */
export function showConfirmDialog(title, message, confirmText, confirmClass = "btn-danger") {
  const resolvedConfirmText = confirmText ?? t("common.confirm");
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
            <button class="modal-close" aria-label="${t("modals.close")}">&times;</button>
          </div>
          <div class="modal-body">
            <div class="confirm-message">${message}</div>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary modal-cancel">${t("common.cancel")}</button>
            <button class="${confirmClass} modal-confirm">${resolvedConfirmText}</button>
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
      document.removeEventListener("keydown", handleEsc);
      document.removeEventListener("keydown", handleEnter);
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
    let mousedownOnOverlay = false;
    overlay.addEventListener("mousedown", (e) => {
      mousedownOnOverlay = e.target === overlay;
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay && mousedownOnOverlay) closeModal(false);
    });

    // ESC key handler
    const handleEsc = (e) => {
      if (e.key === "Escape") {
        closeModal(false);
      }
    };
    document.addEventListener("keydown", handleEsc);

    // Determine whether the confirm action is harmful (destructive). For harmful
    // actions ENTER must default to the safe choice (Cancel); for harmless ones
    // ENTER triggers the confirm action.
    const isHarmful = confirmClass.includes("btn-danger");
    const handleEnter = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        closeModal(!isHarmful);
      }
    };
    document.addEventListener("keydown", handleEnter);

    // Focus the safe default button so ENTER/SPACE activate it and it is clearly
    // highlighted: Cancel for harmful actions, Confirm otherwise.
    setTimeout(() => {
      (isHarmful ? cancelBtn : confirmBtn).focus();
    }, 100);
  });
}

/**
 * Show alert dialog (styled modal with only an OK button)
 * @param {string} title - Dialog title
 * @param {string} message - Alert message
 * @param {string} [buttonText] - Text for the button
 * @returns {Promise<void>} Resolves when button is clicked
 */
export function showAlertDialog(title, message, buttonText) {
  const resolvedButtonText = buttonText ?? t("common.ok");
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
            <button class="modal-close" aria-label="${t("modals.close")}">&times;</button>
          </div>
          <div class="modal-body">
            <div class="confirm-message">${message}</div>
          </div>
          <div class="modal-footer">
            <button class="btn-primary modal-confirm">${resolvedButtonText}</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", modalHtml);

    const overlay = document.getElementById("modal-overlay");
    const confirmBtn = overlay.querySelector(".modal-confirm");
    const closeBtn = overlay.querySelector(".modal-close");

    const closeModal = () => {
      document.removeEventListener("keydown", handleKey);
      overlay.classList.add("modal-closing");
      setTimeout(() => {
        overlay.remove();
        resolve();
      }, 200);
    };

    confirmBtn.addEventListener("click", closeModal);
    closeBtn.addEventListener("click", closeModal);
    let mousedownOnOverlay = false;
    overlay.addEventListener("mousedown", (e) => {
      mousedownOnOverlay = e.target === overlay;
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay && mousedownOnOverlay) closeModal();
    });

    // ESC and ENTER both dismiss this harmless info dialog (only OK is offered).
    const handleKey = (e) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        closeModal();
      }
    };
    document.addEventListener("keydown", handleKey);

    // Focus the OK button so ENTER/SPACE dismiss it.
    setTimeout(() => confirmBtn.focus(), 100);
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
      <span class="color-name">${t(`modals.createNotebook.colors.${color.name}`)}</span>
    </label>
  `,
    )
    .join("");

  const content = `
    <div class="form-field">
      <label for="notebook-title" class="form-label">${t("modals.createNotebook.titleLabel")}</label>
      <input
        type="text"
        id="notebook-title"
        class="form-input"
        placeholder="${t("modals.createNotebook.titlePlaceholder")}"
        required
      />
    </div>
    <div class="form-field">
      <label for="notebook-description" class="form-label">${t("modals.createNotebook.descLabel")}</label>
      <textarea
        id="notebook-description"
        class="form-input"
        placeholder="${t("modals.createNotebook.descPlaceholder")}"
        rows="3"
      ></textarea>
    </div>
    <div class="form-field">
      <label class="form-label">${t("modals.createNotebook.colorLabel")}</label>
      <div class="color-options">
        ${colorOptions}
      </div>
    </div>
  `;

  showModal(t("modals.createNotebook.title"), content, async () => {
    const titleInput = document.getElementById("notebook-title");
    const descriptionInput = document.getElementById("notebook-description");
    const colorInput = document.querySelector('input[name="color"]:checked');

    const title = titleInput.value.trim();
    if (!title) {
      throw new Error(t("modals.errors.titleRequired"));
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
 * Show edit notebook modal (pre-filled with existing values)
 * @param {Object} notebook - Notebook object to edit
 */
export function showEditNotebookModal(notebook) {
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
      (color) => `
    <label class="color-option">
      <input type="radio" name="color" value="${color.value}" ${notebook.color === color.value ? "checked" : ""} />
      <span class="color-swatch" style="background-color: ${color.value}"></span>
      <span class="color-name">${t(`modals.createNotebook.colors.${color.name}`)}</span>
    </label>
  `,
    )
    .join("");

  const escapedTitle = notebook.title.replace(/"/g, "&quot;");
  const escapedDesc = (notebook.description || "").replace(/"/g, "&quot;");

  const content = `
    <div class="form-field">
      <label for="notebook-title" class="form-label">${t("modals.createNotebook.titleLabel")}</label>
      <input
        type="text"
        id="notebook-title"
        class="form-input"
        value="${escapedTitle}"
        placeholder="${t("modals.createNotebook.titlePlaceholder")}"
        required
      />
    </div>
    <div class="form-field">
      <label for="notebook-description" class="form-label">${t("modals.createNotebook.descLabel")}</label>
      <textarea
        id="notebook-description"
        class="form-input"
        placeholder="${t("modals.createNotebook.descPlaceholder")}"
        rows="3"
      >${escapedDesc}</textarea>
    </div>
    <div class="form-field">
      <label class="form-label">${t("modals.createNotebook.colorLabel")}</label>
      <div class="color-options">
        ${colorOptions}
      </div>
    </div>
  `;

  showModal(
    t("modals.editNotebook.title"),
    content,
    async () => {
      const titleInput = document.getElementById("notebook-title");
      const descriptionInput = document.getElementById("notebook-description");
      const colorInput = document.querySelector('input[name="color"]:checked');

      const title = titleInput.value.trim();
      if (!title) {
        throw new Error(t("modals.errors.titleRequired"));
      }

      await updateNotebook(notebook.id, {
        title,
        description: descriptionInput.value.trim(),
        color: colorInput.value,
      });

      window.dispatchEvent(
        new CustomEvent("datachange", {
          detail: { type: "notebook", action: "update", data: { id: notebook.id } },
        }),
      );
    },
    t("common.save"),
  );
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
      <label for="note-title" class="form-label">${t("modals.createNote.titleLabel")}</label>
      <input
        type="text"
        id="note-title"
        class="form-input"
        placeholder="${t("modals.createNote.titlePlaceholder")}"
        required
      />
    </div>
    ${
      notebookId === null
        ? `<p class="form-hint">${t("modals.createNote.hintQuick")}</p>`
        : `<p class="form-hint">${t("modals.createNote.hintNotebook", { notebook: notebookName || "notebook" })}</p>`
    }
  `;

  showModal(t("modals.createNote.title"), content, async () => {
    const titleInput = document.getElementById("note-title");

    const title = titleInput.value.trim();
    if (!title) {
      throw new Error(t("modals.errors.titleRequired"));
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
 * Show edit note modal (pre-filled with existing title)
 * @param {Object} note - Note object to edit
 */
export function showEditNoteModal(note) {
  const escapedTitle = (note.title || "").replace(/"/g, "&quot;");

  const content = `
    <div class="form-field">
      <label for="note-title" class="form-label">${t("modals.createNote.titleLabel")}</label>
      <input
        type="text"
        id="note-title"
        class="form-input"
        value="${escapedTitle}"
        placeholder="${t("modals.createNote.titlePlaceholder")}"
        required
      />
    </div>
  `;

  showModal(
    t("modals.editNote.title"),
    content,
    async () => {
      const titleInput = document.getElementById("note-title");

      const title = titleInput.value.trim();
      if (!title) {
        throw new Error(t("modals.errors.titleRequired"));
      }

      await updateNote(note.id, { title });

      window.dispatchEvent(
        new CustomEvent("datachange", {
          detail: { type: "note", action: "update", data: { id: note.id } },
        }),
      );
    },
    t("common.save"),
  );
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
          <h3 class="modal-title">${t("modals.noteProperties.title")}</h3>
          <button class="modal-close" aria-label="${t("modals.close")}">&times;</button>
        </div>
        <div class="modal-body">
          <div class="note-info-list">
            <p><strong>${t("modals.noteProperties.noteId")}:</strong> ${note.id}</p>
            <p><strong>${t("modals.noteProperties.notebookId")}:</strong> ${note.notebookId || t("modals.noteProperties.noValue")}</p>
            <p><strong>${t("modals.noteProperties.version")}:</strong> ${note.version || "1"}</p>
            <p><strong>${t("modals.noteProperties.modified")}:</strong> ${formatDate(note.modified)}</p>
            <p><strong>${t("modals.noteProperties.created")}:</strong> ${formatDate(note.created)}</p>
            <p><strong>${t("modals.noteProperties.synced")}:</strong> ${note.synced ? t("modals.noteProperties.syncedYes") : t("modals.noteProperties.syncedNo")}</p>
            <p><strong>${t("modals.noteProperties.lastEtag")}:</strong> <code>${note.lastSyncedEtag || t("modals.noteProperties.noValue")}</code></p>
            <p><strong>${t("modals.noteProperties.deleted")}:</strong> ${note.deleted ? t("modals.noteProperties.deletedYes") : t("modals.noteProperties.deletedNo")}</p>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-primary modal-close-btn">${t("modals.noteProperties.closeBtn")}</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);

  const overlay = document.getElementById("modal-overlay");
  const closeBtn = overlay.querySelector(".modal-close");
  const closeBtnFooter = overlay.querySelector(".modal-close-btn");

  const closeModal = () => {
    document.removeEventListener("keydown", handleKey);
    overlay.classList.add("modal-closing");
    setTimeout(() => overlay.remove(), 200);
  };

  closeBtn.addEventListener("click", closeModal);
  closeBtnFooter.addEventListener("click", closeModal);
  let mousedownOnOverlay = false;
  overlay.addEventListener("mousedown", (e) => {
    mousedownOnOverlay = e.target === overlay;
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && mousedownOnOverlay) closeModal();
  });

  // ESC and ENTER both dismiss this read-only properties dialog.
  const handleKey = (e) => {
    if (e.key === "Escape" || e.key === "Enter") {
      e.preventDefault();
      closeModal();
    }
  };
  document.addEventListener("keydown", handleKey);

  // Focus the footer close button so ENTER/SPACE dismiss it.
  setTimeout(() => closeBtnFooter.focus(), 100);
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
            <button class="modal-close" aria-label="${t("modals.close")}">&times;</button>
          </div>
          <div class="modal-body">
            <p>${message}</p>
            <div class="form-field modal-password-field">
              <input
                type="password"
                id="password-input"
                class="form-input"
                placeholder="${t("auth.unlock.passwordPlaceholder")}"
                autocomplete="current-password"
              />
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary modal-cancel">${t("common.cancel")}</button>
            <button class="btn-primary modal-confirm">${t("common.ok")}</button>
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
    let mousedownOnOverlay = false;
    overlay.addEventListener("mousedown", (e) => {
      mousedownOnOverlay = e.target === overlay;
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay && mousedownOnOverlay) closeModal(null);
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
 * Show a plain single-line text prompt (title/message/placeholder in, entered
 * string or null on cancel out). Mirrors showPasswordPrompt's structure with
 * a text input instead of password, and without the non-empty-to-confirm
 * gate (callers that need a required field should validate the result).
 * @param {string} title
 * @param {string} message
 * @param {string} [placeholder]
 * @param {string} [defaultValue]
 * @returns {Promise<string|null>}
 */
export function showTextPrompt(title, message, placeholder = "", defaultValue = "") {
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
            <button class="modal-close" aria-label="${t("modals.close")}">&times;</button>
          </div>
          <div class="modal-body">
            <p class="modal-text-prompt-message">${message}</p>
            <div class="form-field">
              <input
                type="text"
                id="text-prompt-input"
                class="form-input"
                placeholder="${placeholder}"
              />
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary modal-cancel">${t("common.cancel")}</button>
            <button class="btn-primary modal-confirm">${t("common.next")}</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", modalHtml);

    const overlay = document.getElementById("modal-overlay");
    const confirmBtn = overlay.querySelector(".modal-confirm");
    const cancelBtn = overlay.querySelector(".modal-cancel");
    const closeBtn = overlay.querySelector(".modal-close");
    const textInput = document.getElementById("text-prompt-input");
    textInput.value = defaultValue;

    const closeModal = (value = null) => {
      overlay.classList.add("modal-closing");
      setTimeout(() => {
        overlay.remove();
        resolve(value);
      }, 200);
    };

    confirmBtn.addEventListener("click", () => closeModal(textInput.value));
    cancelBtn.addEventListener("click", () => closeModal(null));
    closeBtn.addEventListener("click", () => closeModal(null));
    let mousedownOnOverlay = false;
    overlay.addEventListener("mousedown", (e) => {
      mousedownOnOverlay = e.target === overlay;
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay && mousedownOnOverlay) closeModal(null);
    });

    const handleEsc = (e) => {
      if (e.key === "Escape") {
        closeModal(null);
        document.removeEventListener("keydown", handleEsc);
      }
    };
    document.addEventListener("keydown", handleEsc);

    const handleEnter = (e) => {
      if (e.key === "Enter") {
        closeModal(textInput.value);
        document.removeEventListener("keydown", handleEnter);
      }
    };
    textInput.addEventListener("keydown", handleEnter);

    setTimeout(() => {
      textInput.focus();
      textInput.select();
    }, 100);
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
        <div class="modal-dialog modal--wide">
          <div class="modal-header">
            <h3 class="modal-title">${t("modals.conflict.title", { title: escapeHtml(local.title) })}</h3>
          </div>
          <div class="modal-body">
            <p>${t("modals.conflict.message")}</p>
            <div class="conflict-comparison">
              <div class="conflict-option">
                <h4>${t("modals.conflict.local")}</h4>
                <p><small>${t("modals.conflict.modified", { date: formatDate(local.modified) })}</small></p>
                <div class="conflict-option__preview">${sanitizeNoteHtml(local.content) || t("modals.conflict.noContent")}</div>
                <p>${t("modals.conflict.strokes", { count: local.strokes?.length || 0 })}</p>
                <button class="btn-primary use-local conflict-option__keep-btn">${t("modals.conflict.keepLocal")}</button>
              </div>
              <div class="conflict-option">
                <h4>${t("modals.conflict.remote")}</h4>
                <p><small>${t("modals.conflict.modified", { date: formatDate(remote.modified) })}</small></p>
                <div class="conflict-option__preview">${sanitizeNoteHtml(remote.content) || t("modals.conflict.noContent")}</div>
                <p>${t("modals.conflict.strokes", { count: remote.strokes?.length || 0 })}</p>
                <button class="btn-primary use-remote conflict-option__keep-btn">${t("modals.conflict.keepRemote")}</button>
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
 * Show move/copy note dialog.
 * @param {Object} note - The note to move/copy
 * @param {Array} notebooks - All notebooks from storage
 * @returns {Promise<{action: string, targetNotebookId: string|null}|null>} Result or null if cancelled
 */
export function showMoveCopyDialog(note, notebooks) {
  return new Promise((resolve) => {
    const existingModal = document.getElementById("modal-overlay");
    if (existingModal) existingModal.remove();

    const currentNotebookId = note.notebookId ?? null;

    // Build notebook picker items
    const quickNotesItem = `
      <div class="notebook-picker-item${currentNotebookId === null ? " current" : ""}" data-notebook-id="__quicknotes__">
        <div class="notebook-picker-item__color" style="background-color: var(--text-secondary)"></div>
        <span class="notebook-picker-item__title">${t("overview.moveCopy.quickNotes")}</span>
        ${currentNotebookId === null ? `<span class="notebook-picker-item__badge">${t("overview.moveCopy.current")}</span>` : ""}
      </div>
    `;

    const notebookItems = notebooks
      .map((nb) => {
        const isCurrent = nb.id === currentNotebookId;
        return `
          <div class="notebook-picker-item${isCurrent ? " current" : ""}" data-notebook-id="${nb.id}">
            <div class="notebook-picker-item__color" style="background-color: ${nb.color}"></div>
            <span class="notebook-picker-item__title">${escapeHtml(nb.title)}</span>
            ${isCurrent ? `<span class="notebook-picker-item__badge">${t("overview.moveCopy.current")}</span>` : ""}
          </div>
        `;
      })
      .join("");

    const modalHtml = `
      <div id="modal-overlay" class="modal-overlay">
        <div class="modal-dialog">
          <div class="modal-header">
            <h3 class="modal-title">${t("overview.moveCopy.title")}</h3>
            <button class="modal-close" aria-label="${t("modals.close")}">&times;</button>
          </div>
          <div class="modal-body">
            <div class="action-toggle">
              <input type="radio" name="movecopy-action" id="action-move" value="move" checked>
              <label for="action-move">${t("overview.moveCopy.move")}</label>
              <input type="radio" name="movecopy-action" id="action-copy" value="copy">
              <label for="action-copy">${t("overview.moveCopy.copy")}</label>
            </div>
            <p class="form-label">${t("overview.moveCopy.targetLabel")}</p>
            <div class="notebook-picker">
              ${quickNotesItem}
              ${notebookItems}
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary modal-cancel">${t("common.cancel")}</button>
            <button class="btn-primary modal-confirm" disabled>${t("overview.moveCopy.apply")}</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", modalHtml);

    const overlay = document.getElementById("modal-overlay");
    const confirmBtn = overlay.querySelector(".modal-confirm");
    const cancelBtn = overlay.querySelector(".modal-cancel");
    const closeBtn = overlay.querySelector(".modal-close");
    const pickerItems = overlay.querySelectorAll(".notebook-picker-item:not(.current)");

    let selectedNotebookId; // undefined = nothing selected yet

    pickerItems.forEach((item) => {
      item.addEventListener("click", () => {
        pickerItems.forEach((i) => {
          i.classList.remove("selected");
        });
        item.classList.add("selected");
        selectedNotebookId =
          item.dataset.notebookId === "__quicknotes__" ? null : item.dataset.notebookId;
        confirmBtn.disabled = false;
      });
    });

    const closeModal = (result) => {
      document.removeEventListener("keydown", handleEsc);
      document.removeEventListener("keydown", handleEnter);
      overlay.classList.add("modal-closing");
      setTimeout(() => {
        overlay.remove();
        resolve(result);
      }, 200);
    };

    confirmBtn.addEventListener("click", () => {
      if (selectedNotebookId === undefined) return;
      const action = overlay.querySelector("input[name='movecopy-action']:checked").value;
      closeModal({ action, targetNotebookId: selectedNotebookId });
    });

    cancelBtn.addEventListener("click", () => closeModal(null));
    closeBtn.addEventListener("click", () => closeModal(null));
    let mousedownOnOverlay = false;
    overlay.addEventListener("mousedown", (e) => {
      mousedownOnOverlay = e.target === overlay;
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay && mousedownOnOverlay) closeModal(null);
    });

    const handleEsc = (e) => {
      if (e.key === "Escape") {
        closeModal(null);
      }
    };
    document.addEventListener("keydown", handleEsc);

    // ENTER applies the (harmless) move/copy once a target is selected; until
    // then it does nothing so the user must consciously pick a notebook.
    const handleEnter = (e) => {
      if (e.key === "Enter" && !confirmBtn.disabled) {
        e.preventDefault();
        confirmBtn.click();
      }
    };
    document.addEventListener("keydown", handleEnter);
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Show a progress dialog that cannot be dismissed by the user.
 * Returns a controller object to update or close the dialog.
 *
 * @param {string} title - Dialog title
 * @returns {{ update: (current: number, total: number) => void, close: () => void }}
 */
export function showProgressDialog(title) {
  const existingModal = document.getElementById("modal-overlay");
  if (existingModal) existingModal.remove();

  const modalHtml = `
    <div id="modal-overlay" class="modal-overlay modal-no-close">
      <div class="modal-dialog">
        <div class="modal-header">
          <h3 class="modal-title">${title}</h3>
        </div>
        <div class="modal-body modal-progress-body">
          <div class="modal-progress-spinner"></div>
          <p class="modal-progress-label">&nbsp;</p>
          <div class="modal-progress-bar">
            <div class="modal-progress-fill" style="width: 0%"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);
  const overlay = document.getElementById("modal-overlay");
  const label = overlay.querySelector(".modal-progress-label");
  const fill = overlay.querySelector(".modal-progress-fill");

  return {
    update(current, total, text) {
      const pct = total > 0 ? Math.round((current / total) * 100) : 0;
      label.textContent = text || `${current} / ${total}`;
      fill.style.width = `${pct}%`;
    },
    close() {
      overlay.classList.add("modal-closing");
      setTimeout(() => overlay.remove(), 200);
    },
  };
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
