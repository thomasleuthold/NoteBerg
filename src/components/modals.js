/**
 * Modal Components
 * Reusable modal dialogs for creating notebooks and notes
 */

import { t } from "../i18n/index.js";
import { engineDisplayName } from "../modules/recognition/recognitionService.js";
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

  // Busy state: disable the button and swap its label, so a slow create reads as
  // "in progress" rather than as a keypress that did not register — the latter is
  // exactly what prompts a user to press ENTER again.
  const confirmIdleLabel = confirmBtn.textContent;
  const setConfirmBusy = (busy) => {
    confirmBtn.disabled = busy;
    confirmBtn.textContent = busy ? t("common.working") : confirmIdleLabel;
    confirmBtn.classList.toggle("btn-busy", busy);
    // Dismissing mid-write would hide a create that still lands, so the exits are
    // closed for the duration too.
    cancelBtn.disabled = busy;
    closeBtn.disabled = busy;
    overlay.classList.toggle("modal-busy", busy);
  };

  // True from the moment a confirm starts until the modal is gone. Every dismissal
  // path checks it, so an in-flight create cannot be abandoned half-done.
  let confirming = false;

  // Close modal function
  const closeModal = () => {
    document.removeEventListener("keydown", handleEsc);
    overlay.classList.add("modal-closing");
    setTimeout(() => overlay.remove(), 200);
  };

  // Dismissals requested by the user (cancel button, X, backdrop, ESC) — ignored
  // while a confirm is in flight.
  const dismiss = () => {
    if (confirming) return;
    closeModal();
  };

  // Confirm handler.
  //
  // onConfirm is async and may take a long time (the Nextcloud build writes over
  // WebDAV rather than to IndexedDB). Without a guard the button stays live for
  // the whole write plus the 200ms close animation, so a second ENTER starts a
  // second, independent onConfirm — creating a duplicate note and firing a
  // second navigateTo. Mark in-flight *before* the first await.
  const runConfirm = async () => {
    if (confirming) return;
    confirming = true;
    setConfirmBusy(true);
    try {
      await onConfirm();
      // Deliberately not resetting `confirming` here: the modal is on its way
      // out, and re-enabling during the close animation would reopen the very
      // window this guard exists to close.
      closeModal();
    } catch (error) {
      showError(overlay, error.message);
      confirming = false;
      setConfirmBusy(false);
    }
  };

  confirmBtn.addEventListener("click", runConfirm);

  // Cancel handlers
  cancelBtn.addEventListener("click", dismiss);
  closeBtn.addEventListener("click", dismiss);
  let mousedownOnOverlay = false;
  overlay.addEventListener("mousedown", (e) => {
    mousedownOnOverlay = e.target === overlay;
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && mousedownOnOverlay) dismiss();
  });

  // ESC key handler. Removed in closeModal rather than only here, so the listener
  // does not outlive a modal dismissed by any other route.
  const handleEsc = (e) => {
    if (e.key === "Escape") {
      dismiss();
    }
  };
  document.addEventListener("keydown", handleEsc);

  // ENTER confirms (harmless create/edit action). Bound to text inputs only so
  // ENTER inside a <textarea> still inserts a newline.
  //
  // e.repeat filters held keys, and the disabled check stops a second press
  // landing while a confirm is still in flight. Both are belt-and-braces on top
  // of the `confirming` guard, but they also keep the key from re-triggering the
  // busy button at all.
  overlay.querySelectorAll('input[type="text"]').forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.repeat || confirmBtn.disabled) return;
        runConfirm();
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
 * Confirm a recognition run, and collect its per-run options.
 *
 * Recognition is the one action in the note menu that spends money on a remote
 * service, and until this dialog existed a single mis-tap started it. The
 * confirmation is the point; the options are what make the extra tap worth
 * taking rather than pure friction.
 *
 * The scope line is the substance of the confirmation. "Are you sure?" is a
 * speed bump — a dialog naming the page count and the model the pages go to is
 * enough to decide with, and it is also the only place the user sees which
 * model a note is about to be charged against.
 *
 * Options reset to their defaults on every open rather than persisting: this is
 * a per-run choice about one note, and a preference silently remembered from a
 * run months ago is the kind of surprise this dialog exists to prevent. The
 * recognition settings screen remains the single writer for anything durable.
 *
 * `punctuation` starts on, because that is what the prompt does by default and
 * what every previous run did. The toggle is an opt-out for the pages where
 * bare words read better — keywords, labels, figures — not a feature to enable.
 *
 * `breaks` starts off, for the opposite reason: models place line-break markers
 * unreliably, so asking for the layout costs accuracy on the text itself. It is
 * opt-in for the notes whose shape matters.
 *
 * `quota` is the administrator's allowance under central management (null off
 * Nextcloud, or in BYO mode where the account is the user's own). A limit of 0
 * means unlimited and is not shown — there is nothing to decide about. Showing
 * the count here, before the pages are sent, is what lets the user choose to
 * spend a handful of remaining pages on this note rather than discovering the
 * allowance was gone only after the run failed. When nothing remains, Start is
 * disabled outright: offering a button that always fails is worse than not
 * offering it.
 *
 * @param {{pageCount?: number, model?: string, quota?: {used: number, limit: number}|null}} [info]
 * @returns {Promise<{punctuation: boolean, breaks: boolean}|null>} the chosen
 *   options, or null when the user cancelled
 */
export function showRecognitionOptionsDialog(info = {}) {
  return new Promise((resolve) => {
    const existingModal = document.getElementById("modal-overlay");
    if (existingModal) existingModal.remove();

    // A page count is only known once the note has been measured; callers that
    // cannot say omit it rather than guessing, and the line degrades to naming
    // the model alone.
    const scope =
      typeof info.pageCount === "number" && info.model
        ? t("canvas.recognition.confirmScope", { count: info.pageCount, model: info.model })
        : info.model
          ? t("canvas.recognition.confirmScopeModelOnly", { model: info.model })
          : "";

    const quota = info.quota;
    const hasLimit = quota && typeof quota.limit === "number" && quota.limit > 0;
    const remaining = hasLimit ? Math.max(0, quota.limit - quota.used) : null;
    const quotaExhausted = hasLimit && remaining <= 0;
    const quotaLine = hasLimit
      ? quotaExhausted
        ? t("canvas.recognition.quotaExhausted")
        : t("canvas.recognition.quotaRemaining", { remaining, limit: quota.limit })
      : "";

    const modalHtml = `
      <div id="modal-overlay" class="modal-overlay">
        <div class="modal-dialog">
          <div class="modal-header">
            <h3 class="modal-title">${t("canvas.recognition.confirmTitle")}</h3>
            <button class="modal-close" aria-label="${t("modals.close")}">&times;</button>
          </div>
          <div class="modal-body">
            ${scope ? `<div class="confirm-message">${scope}</div>` : ""}
            ${quotaLine ? `<div class="confirm-message${quotaExhausted ? " confirm-message-warning" : ""}">${quotaLine}</div>` : ""}
            <div class="setting-item recognition-option">
              <div class="setting-label">
                <span class="setting-name">${t("canvas.recognition.optionPunctuation")}</span>
                <span class="setting-description">${t("canvas.recognition.optionPunctuationDesc")}</span>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="recognition-punctuation" checked />
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div class="setting-item recognition-option">
              <div class="setting-label">
                <span class="setting-name">${t("canvas.recognition.optionBreaks")}</span>
                <span class="setting-description">${t("canvas.recognition.optionBreaksDesc")}</span>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="recognition-breaks" />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary modal-cancel">${t("common.cancel")}</button>
            <button class="btn-primary modal-confirm" ${quotaExhausted ? "disabled" : ""}>${t("canvas.recognition.confirmStart")}</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", modalHtml);

    const overlay = document.getElementById("modal-overlay");
    const confirmBtn = overlay.querySelector(".modal-confirm");
    const cancelBtn = overlay.querySelector(".modal-cancel");
    const closeBtn = overlay.querySelector(".modal-close");
    const punctuation = overlay.querySelector("#recognition-punctuation");
    const breaks = overlay.querySelector("#recognition-breaks");

    const closeModal = (result) => {
      document.removeEventListener("keydown", handleKey);
      overlay.classList.add("modal-closing");
      setTimeout(() => {
        overlay.remove();
        resolve(result);
      }, 200);
    };

    const start = () => closeModal({ punctuation: punctuation.checked, breaks: breaks.checked });

    confirmBtn.addEventListener("click", start);
    cancelBtn.addEventListener("click", () => closeModal(null));
    closeBtn.addEventListener("click", () => closeModal(null));

    let mousedownOnOverlay = false;
    overlay.addEventListener("mousedown", (e) => {
      mousedownOnOverlay = e.target === overlay;
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay && mousedownOnOverlay) closeModal(null);
    });

    const handleKey = (e) => {
      if (e.key === "Escape") {
        closeModal(null);
        return;
      }
      // ENTER starts the run, but never while a toggle has focus: there SPACE
      // and ENTER are both reaching for the switch, and starting a paid run on a
      // keystroke aimed at an option is the mis-trigger this dialog is meant to
      // remove.
      const onToggle = document.activeElement === punctuation || document.activeElement === breaks;
      if (e.key === "Enter" && !onToggle && !quotaExhausted) {
        e.preventDefault();
        start();
      }
    };
    document.addEventListener("keydown", handleKey);

    // Focus Start: unlike a delete confirmation this action is not destructive,
    // and the user arrived here by asking for it. Unless the allowance is
    // already gone, in which case Start is disabled and Cancel is the only
    // live action.
    setTimeout(() => (quotaExhausted ? cancelBtn : confirmBtn).focus(), 100);
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
 * Show a progress dialog.
 * Returns a controller object to update or close the dialog.
 *
 * Not dismissable by default. Pass `onCancel` for operations that can take long
 * enough that the user needs a way out — a modal with no exit during a
 * multi-minute wait is indistinguishable from a hang.
 *
 * @param {string} title - Dialog title
 * @param {{ onCancel?: () => void, cancelLabel?: string }} [options]
 * @returns {{ update: (current: number, total: number, text?: string) => void, close: () => void }}
 */
export function showProgressDialog(title, options = {}) {
  const existingModal = document.getElementById("modal-overlay");
  if (existingModal) existingModal.remove();

  // `dismissLabel` turns this into a dialog the user may close while the work
  // continues elsewhere — the recognition queue keeps running after its dialog
  // is gone. `note` states that, so closing does not read as cancelling.
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
          <p class="modal-progress-note">${options.note || ""}</p>
        </div>
        ${
          options.onCancel || options.dismissLabel
            ? `<div class="modal-footer">
          ${
            options.onCancel
              ? `<button id="modal-progress-cancel" class="btn-secondary">${options.cancelLabel || "Cancel"}</button>`
              : ""
          }
          ${
            options.dismissLabel
              ? `<button id="modal-progress-dismiss" class="btn-primary">${options.dismissLabel}</button>`
              : ""
          }
        </div>`
            : ""
        }
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);
  const overlay = document.getElementById("modal-overlay");
  const label = overlay.querySelector(".modal-progress-label");
  const fill = overlay.querySelector(".modal-progress-fill");
  const noteEl = overlay.querySelector(".modal-progress-note");
  const bar = overlay.querySelector(".modal-progress-bar");

  const api = {
    update(current, total, text) {
      const pct = total > 0 ? Math.round((current / total) * 100) : 0;
      label.textContent = text || `${current} / ${total}`;
      bar.classList.remove("modal-progress-bar--indeterminate");
      fill.style.width = `${pct}%`;
    },
    /**
     * Show activity without a percentage, for work whose size is not yet known
     * — a job waiting behind another has made no progress of its own, and a bar
     * pinned at 0% reads as a hang.
     */
    indeterminate(text) {
      label.textContent = text;
      bar.classList.add("modal-progress-bar--indeterminate");
      fill.style.width = "100%";
    },
    setNote(text) {
      if (noteEl) noteEl.textContent = text || "";
    },
    close() {
      overlay.classList.add("modal-closing");
      setTimeout(() => overlay.remove(), 200);
    },
  };

  if (options.onCancel) {
    const cancelBtn = overlay.querySelector("#modal-progress-cancel");
    cancelBtn?.addEventListener("click", () => {
      cancelBtn.disabled = true;
      options.onCancel();
    });
  }

  if (options.dismissLabel) {
    overlay.querySelector("#modal-progress-dismiss")?.addEventListener("click", () => {
      options.onDismiss?.();
      api.close();
    });
  }

  return api;
}

/**
 * Show the recognized handwriting text for a note, read-only.
 *
 * Recognition already runs for search; this simply surfaces what it produced so
 * the text is usable by hand — read, selected, copied elsewhere.
 *
 * Deliberately read-only: `fullText` and `words` describe the same handwriting,
 * and `words` carries the geometry search highlighting depends on. An edit to
 * the text alone would leave the two disagreeing with no way to reconcile them.
 *
 * @param {{fullText?: string, engine?: string}|null} recognition - stored result
 */
export function showRecognizedTextModal(recognition) {
  const existingModal = document.getElementById("modal-overlay");
  if (existingModal) {
    existingModal.remove();
  }

  const text = recognition?.fullText ?? "";
  const engine = engineDisplayName(recognition?.engine);

  const modalHtml = `
    <div id="modal-overlay" class="modal-overlay">
      <div class="modal-dialog">
        <div class="modal-header">
          <h3 class="modal-title">${t("modals.recognizedText.title")}</h3>
          <button class="modal-close" aria-label="${t("modals.close")}">&times;</button>
        </div>
        <div class="modal-body">
          <div class="recognized-text">
            ${
              engine
                ? `<p class="recognized-text__engine">${t("modals.recognizedText.engineLabel", { engine: escapeHtml(engine) })}</p>`
                : ""
            }
            <textarea class="recognized-text__field" readonly rows="12"
              aria-label="${t("modals.recognizedText.title")}"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary modal-copy">${t("modals.recognizedText.copy")}</button>
          <button class="btn-primary modal-close-btn">${t("common.close")}</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);

  const overlay = document.getElementById("modal-overlay");
  const field = overlay.querySelector(".recognized-text__field");
  const copyBtn = overlay.querySelector(".modal-copy");
  const closeBtn = overlay.querySelector(".modal-close");
  const closeBtnFooter = overlay.querySelector(".modal-close-btn");

  // Assigned rather than interpolated into the template: the text is arbitrary
  // recognized content, and a value never rendered as HTML cannot be malformed
  // by it.
  field.value = text;

  let copyResetTimer = null;

  const closeModal = () => {
    document.removeEventListener("keydown", handleKey);
    if (copyResetTimer) clearTimeout(copyResetTimer);
    overlay.classList.add("modal-closing");
    setTimeout(() => overlay.remove(), 200);
  };

  closeBtn.addEventListener("click", closeModal);
  closeBtnFooter.addEventListener("click", closeModal);
  copyBtn.addEventListener("click", () => copyText(field, copyBtn));

  let mousedownOnOverlay = false;
  overlay.addEventListener("mousedown", (e) => {
    mousedownOnOverlay = e.target === overlay;
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && mousedownOnOverlay) closeModal();
  });

  // ESC only. The other read-only dialogs also close on ENTER, but here the
  // focused element is a multi-line field where ENTER is an ordinary key —
  // closing on it would fight the text selection the dialog exists to allow.
  const handleKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeModal();
    }
  };
  document.addEventListener("keydown", handleKey);

  // Focus the text, not a button: reading and selecting is the point of this
  // dialog, and it makes the field immediately scrollable by keyboard.
  setTimeout(() => field.focus(), 100);

  /**
   * Copy the field's contents to the system clipboard, confirming visibly.
   *
   * Two paths because `navigator.clipboard` is absent on insecure origins —
   * the Nextcloud app served over plain HTTP is exactly that case, so the
   * async API alone would leave the button silently dead there.
   *
   * @param {HTMLTextAreaElement} source
   * @param {HTMLButtonElement} button
   */
  async function copyText(source, button) {
    let copied = false;
    try {
      await navigator.clipboard.writeText(source.value);
      copied = true;
    } catch (_e) {
      // Insecure origin, or permission refused. Selecting the field and asking
      // the document to copy works without the async API, and leaves the text
      // selected either way — so a user whose browser blocks both can still
      // copy by hand.
      try {
        source.select();
        copied = document.execCommand("copy");
      } catch (_fallbackError) {
        copied = false;
      }
    }

    // Silent success reads as a dead button, which matters most on touch where
    // there is no other feedback that anything happened.
    if (copyResetTimer) clearTimeout(copyResetTimer);
    const idleLabel = t("modals.recognizedText.copy");
    button.textContent = copied
      ? t("modals.recognizedText.copied")
      : t("modals.recognizedText.copyFailed");
    copyResetTimer = setTimeout(() => {
      copyResetTimer = null;
      // The dialog may be gone by now; the node is detached but still safe to
      // write to, and the timer is cleared on close anyway.
      button.textContent = idleLabel;
    }, 1500);
  }
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
