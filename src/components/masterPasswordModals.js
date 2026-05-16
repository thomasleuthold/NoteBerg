/**
 * Master Password Modals
 * UI components for master password setup and unlock
 */

import { t } from "../i18n/index.js";
import {
  calculatePasswordStrength,
  getPasswordStrengthColor,
  getPasswordStrengthLabel,
} from "../modules/encryption.js";
import {
  getPasswordHint,
  setupMasterPassword,
  unlockApp,
  unlockWithBiometric,
} from "../modules/masterPassword.js";

/**
 * Show master password setup modal (first time)
 * @param {Object} options - Setup options
 * @param {boolean} options.isMigration - Whether this is migrating existing data
 * @param {Function} options.onSuccess - Callback when setup succeeds
 * @param {Function} options.onCancel - Callback when setup is canceled
 * @returns {Promise<void>}
 */
export async function showMasterPasswordSetup({ isMigration = false, onSuccess, onCancel } = {}) {
  console.log("[MasterPasswordModals] Showing password setup modal");

  const modalHtml = `
    <div id="master-password-modal" class="modal-overlay">
      <div class="modal-dialog modal-password-setup">
        <div class="modal-header">
          <h3 class="modal-title">
            ${isMigration ? t("auth.setup.titleMigration") : t("auth.setup.titleNew")}
          </h3>
        </div>
        <div class="modal-body">
          ${
            isMigration
              ? `
            <div class="info-box">
              <p><strong>${t("auth.setup.migrationHeading")}</strong></p>
              <p>${t("auth.setup.migrationDesc")}</p>
            </div>
          `
              : `
            <p class="modal-description">
              ${t("auth.setup.description")}
            </p>
          `
          }

          <div class="form-group">
            <label for="setup-password">${t("auth.setup.passwordLabel")}</label>
            <input
              type="password"
              id="setup-password"
              class="form-control"
              placeholder="${t("auth.setup.passwordPlaceholder")}"
              autocomplete="new-password"
            />
            <div class="password-strength">
              <div class="strength-bar">
                <div class="strength-fill" id="strength-fill"></div>
              </div>
              <span class="strength-label" id="strength-label">${t("auth.strength.enterPassword")}</span>
            </div>
          </div>

          <div class="form-group">
            <label for="setup-password-confirm">${t("auth.setup.confirmLabel")}</label>
            <input
              type="password"
              id="setup-password-confirm"
              class="form-control"
              placeholder="${t("auth.setup.confirmPlaceholder")}"
              autocomplete="new-password"
            />
          </div>

          <div class="form-group">
            <label for="setup-password-hint">${t("auth.setup.hintLabel")}</label>
            <input
              type="text"
              id="setup-password-hint"
              class="form-control"
              placeholder="${t("auth.setup.hintPlaceholder")}"
              autocomplete="off"
            />
            <small class="form-text">${t("auth.setup.hintDesc")}</small>
          </div>

          <div class="warning-box">
            ${t("auth.setup.warning")}
          </div>

          <div class="modal-error" style="display: none;"></div>
        </div>
        <div class="modal-footer">
          ${
            !isMigration
              ? `<button class="btn-secondary" id="setup-cancel-btn">${t("auth.setup.cancelBtn")}</button>`
              : ""
          }
          <button class="btn-primary modal-setup-confirm" id="setup-confirm-btn">
            ${isMigration ? t("auth.setup.confirmBtnMigration") : t("auth.setup.confirmBtnNew")}
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);

  const overlay = document.getElementById("master-password-modal");
  const passwordInput = document.getElementById("setup-password");
  const confirmInput = document.getElementById("setup-password-confirm");
  const hintInput = document.getElementById("setup-password-hint");
  const confirmBtn = document.getElementById("setup-confirm-btn");
  const cancelBtn = document.getElementById("setup-cancel-btn");
  const strengthFill = document.getElementById("strength-fill");
  const strengthLabel = document.getElementById("strength-label");

  // Password strength indicator
  passwordInput.addEventListener("input", () => {
    const password = passwordInput.value;
    const strength = calculatePasswordStrength(password);
    const label = getPasswordStrengthLabel(strength);
    const color = getPasswordStrengthColor(strength);

    strengthFill.style.width = `${strength}%`;
    strengthFill.style.backgroundColor = color;
    strengthLabel.textContent = label;
    strengthLabel.style.color = color;
  });

  // Show error in modal
  const showError = (message) => {
    const errorEl = overlay.querySelector(".modal-error");
    errorEl.textContent = message;
    errorEl.style.display = "block";
  };

  // Hide error
  const hideError = () => {
    const errorEl = overlay.querySelector(".modal-error");
    errorEl.style.display = "none";
  };

  // Confirm handler
  confirmBtn.addEventListener("click", async () => {
    hideError();

    const password = passwordInput.value;
    const confirm = confirmInput.value;
    const hint = hintInput.value.trim();

    // Validation
    if (!password) {
      showError(t("auth.errors.enterPassword"));
      passwordInput.focus();
      return;
    }

    if (password.length < 8) {
      showError(t("auth.errors.tooShort"));
      passwordInput.focus();
      return;
    }

    if (password !== confirm) {
      showError(t("auth.errors.mismatch"));
      confirmInput.focus();
      return;
    }

    const strength = calculatePasswordStrength(password);
    if (strength < 30) {
      showError(t("auth.errors.tooWeak"));
      passwordInput.focus();
      return;
    }

    // Disable button during setup
    confirmBtn.disabled = true;
    confirmBtn.textContent = t("auth.setup.settingUp");

    try {
      // Biometric unlock is never enabled during setup - password is always stored in keyring
      await setupMasterPassword(password, hint, false);
      console.log("[MasterPasswordModals] Master password setup successful");

      // Close modal
      overlay.remove();

      // Call success callback
      if (onSuccess) {
        onSuccess();
      }
    } catch (error) {
      console.error("[MasterPasswordModals] Setup failed:", error);
      showError(error.message || t("auth.errors.setupFailed"));
      confirmBtn.disabled = false;
      confirmBtn.textContent = isMigration
        ? t("auth.setup.confirmBtnMigration")
        : t("auth.setup.confirmBtnNew");
    }
  });

  // Cancel handler
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      console.log("[MasterPasswordModals] Master password setup canceled");
      overlay.remove();
      if (onCancel) {
        onCancel();
      }
    });
  }

  // Allow clicking outside to cancel (only if not a migration)
  if (!isMigration) {
    let mousedownOnOverlay = false;
    overlay.addEventListener("mousedown", (e) => {
      mousedownOnOverlay = e.target === overlay;
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay && mousedownOnOverlay) {
        console.log("[MasterPasswordModals] Master password setup canceled (clicked outside)");
        overlay.remove();
        if (onCancel) {
          onCancel();
        }
      }
    });
  }

  // Enter key to confirm
  const handleEnter = (e) => {
    if (e.key === "Enter") {
      confirmBtn.click();
    }
  };
  passwordInput.addEventListener("keydown", handleEnter);
  confirmInput.addEventListener("keydown", handleEnter);

  // Focus first input
  setTimeout(() => passwordInput.focus(), 100);
}

/**
 * Show app unlock modal
 * @param {Function} onSuccess - Callback when unlock succeeds
 * @returns {Promise<void>}
 */
export async function showAppUnlock({ onSuccess } = {}) {
  console.log("[MasterPasswordModals] Showing unlock modal");

  // Biometric unlock removed for performance
  const biometricUnlockEnabled = false;
  const biometricInfo = { available: false };

  // Get password hint
  const hint = await getPasswordHint();

  const modalHtml = `
    <div id="unlock-modal" class="modal-overlay modal-no-close">
      <div class="modal-dialog modal-unlock">
        <div class="modal-header">
          <h3 class="modal-title">${t("auth.unlock.title")}</h3>
        </div>
        <div class="modal-body">
          <p class="modal-description">
            ${t("auth.unlock.description")}
          </p>

          <div class="form-group">
            <label for="unlock-password">${t("auth.unlock.passwordLabel")}</label>
            <input
              type="password"
              id="unlock-password"
              class="form-control"
              placeholder="${t("auth.unlock.passwordPlaceholder")}"
              autocomplete="current-password"
            />
            ${hint ? `<small class="form-text">${t("auth.unlock.hint", { hint })}</small>` : ""}
          </div>

          ${
            biometricUnlockEnabled && biometricInfo.available
              ? `
            <div class="unlock-divider">
              <span>OR</span>
            </div>
            <button class="btn-biometric" id="unlock-biometric-btn">
              <span class="biometric-icon">👆</span>
              Unlock with ${biometricInfo.biometricType === "windows_hello" ? "Windows Hello" : "Biometric"}
            </button>
          `
              : ""
          }

          <div class="modal-error" style="display: none;"></div>
        </div>
        <div class="modal-footer">
          <button class="btn-primary modal-unlock-confirm" id="unlock-confirm-btn">
            ${t("auth.unlock.unlockBtn")}
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);

  const overlay = document.getElementById("unlock-modal");
  const passwordInput = document.getElementById("unlock-password");
  const confirmBtn = document.getElementById("unlock-confirm-btn");
  const biometricBtn = document.getElementById("unlock-biometric-btn");

  // Show error in modal
  const showError = (message) => {
    const errorEl = overlay.querySelector(".modal-error");
    errorEl.textContent = message;
    errorEl.style.display = "block";
  };

  // Hide error
  const hideError = () => {
    const errorEl = overlay.querySelector(".modal-error");
    errorEl.style.display = "none";
  };

  // Unlock with password
  const unlockWithPassword = async () => {
    hideError();

    const password = passwordInput.value;

    if (!password) {
      showError(t("auth.errors.enterPassword"));
      passwordInput.focus();
      return;
    }

    // Disable button during unlock
    confirmBtn.disabled = true;
    confirmBtn.textContent = t("auth.unlock.unlocking");

    try {
      const success = await unlockApp(password);

      if (success) {
        console.log("[MasterPasswordModals] Unlock successful");
        overlay.remove();

        // Re-save the verified password to the keyring so future auto-unlocks work
        // (handles the case where keyring had a stale/wrong password)
        try {
          const { saveSecureCredential } = await import("../modules/secureStorage.js");
          await saveSecureCredential("master_password", password);
          console.log("[MasterPasswordModals] Keyring password refreshed after manual unlock");
        } catch (e) {
          console.warn("[MasterPasswordModals] Could not refresh keyring password:", e);
        }

        // Call success callback
        if (onSuccess) {
          onSuccess();
        }
      } else {
        showError(t("auth.errors.wrongPassword"));
        confirmBtn.disabled = false;
        confirmBtn.textContent = t("auth.unlock.unlockBtn");
        passwordInput.value = "";
        passwordInput.focus();
      }
    } catch (error) {
      console.error("[MasterPasswordModals] Unlock failed:", error);
      showError(error.message || t("auth.errors.setupFailed"));
      confirmBtn.disabled = false;
      confirmBtn.textContent = t("auth.unlock.unlockBtn");
    }
  };

  // Confirm handler
  confirmBtn.addEventListener("click", unlockWithPassword);

  // Biometric unlock handler
  if (biometricBtn) {
    biometricBtn.addEventListener("click", async () => {
      hideError();
      biometricBtn.disabled = true;
      biometricBtn.textContent = "Authenticating...";

      try {
        const success = await unlockWithBiometric();

        if (success) {
          console.log("[MasterPasswordModals] Biometric unlock successful");
          overlay.remove();

          if (onSuccess) {
            onSuccess();
          }
        } else {
          showError(t("auth.errors.biometricFailed"));
          biometricBtn.disabled = false;
          biometricBtn.innerHTML = `<span class="biometric-icon">👆</span> ${t("auth.unlock.unlockBtn")}`;
          passwordInput.focus();
        }
      } catch (error) {
        console.error("[MasterPasswordModals] Biometric unlock failed:", error);
        showError(t("auth.errors.biometricUnavailable"));
        biometricBtn.disabled = false;
        biometricBtn.innerHTML = `<span class="biometric-icon">👆</span> ${t("auth.unlock.unlockBtn")}`;
        passwordInput.focus();
      }
    });
  }

  // Enter key to unlock
  passwordInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      unlockWithPassword();
    }
  });

  // Focus password input
  setTimeout(() => passwordInput.focus(), 100);
}

/**
 * Show confirmation dialog (generic)
 * @param {Object} options - Dialog options
 * @param {string} options.title - Dialog title
 * @param {string} options.message - Dialog message
 * @param {string} options.confirmText - Confirm button text
 * @param {string} options.cancelText - Cancel button text
 * @param {Function} options.onConfirm - Callback when confirmed
 * @returns {Promise<boolean>}
 */
export function showConfirmDialog({
  title = "Confirm",
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  onConfirm,
} = {}) {
  return new Promise((resolve) => {
    const modalHtml = `
      <div id="confirm-modal" class="modal-overlay">
        <div class="modal-dialog modal-confirm">
          <div class="modal-header">
            <h3 class="modal-title">${title}</h3>
          </div>
          <div class="modal-body">
            <p>${message}</p>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary modal-cancel">${cancelText}</button>
            <button class="btn-primary modal-confirm">${confirmText}</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", modalHtml);

    const overlay = document.getElementById("confirm-modal");
    const confirmBtn = overlay.querySelector(".modal-confirm");
    const cancelBtn = overlay.querySelector(".modal-cancel");

    const closeModal = () => {
      overlay.remove();
    };

    confirmBtn.addEventListener("click", async () => {
      if (onConfirm) {
        await onConfirm();
      }
      closeModal();
      resolve(true);
    });

    cancelBtn.addEventListener("click", () => {
      closeModal();
      resolve(false);
    });

    let mousedownOnOverlay = false;
    overlay.addEventListener("mousedown", (e) => {
      mousedownOnOverlay = e.target === overlay;
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay && mousedownOnOverlay) {
        closeModal();
        resolve(false);
      }
    });
  });
}
