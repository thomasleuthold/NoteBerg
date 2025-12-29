/**
 * Master Password Modals
 * UI components for master password setup and unlock
 */

import {
  setupMasterPassword,
  unlockApp,
  unlockWithBiometric,
  getPasswordHint,
  isBiometricUnlockEnabled
} from '../modules/masterPassword.js';
import {
  calculatePasswordStrength,
  getPasswordStrengthLabel,
  getPasswordStrengthColor
} from '../modules/encryption.js';
import { checkBiometricAvailability } from '../modules/secureStorage.js';

/**
 * Show master password setup modal (first time)
 * @param {Object} options - Setup options
 * @param {boolean} options.isMigration - Whether this is migrating existing data
 * @param {Function} options.onSuccess - Callback when setup succeeds
 * @returns {Promise<void>}
 */
export async function showMasterPasswordSetup({ isMigration = false, onSuccess } = {}) {
  console.log('[MasterPasswordModals] Showing password setup modal');

  // Check if biometric is available
  const biometricInfo = await checkBiometricAvailability();
  const biometricAvailable = biometricInfo.available;

  const modalHtml = `
    <div id="master-password-modal" class="modal-overlay">
      <div class="modal-dialog modal-password-setup">
        <div class="modal-header">
          <h3 class="modal-title">
            ${isMigration ? '🔒 Secure Your Data' : '🔒 Create Master Password'}
          </h3>
        </div>
        <div class="modal-body">
          ${isMigration ? `
            <div class="info-box">
              <p><strong>We're upgrading your security!</strong></p>
              <p>To protect your data with encryption, please create a master password. Your existing data will be encrypted automatically.</p>
            </div>
          ` : `
            <p class="modal-description">
              Your master password encrypts all your data. Choose a strong password you'll remember.
            </p>
          `}

          <div class="form-group">
            <label for="setup-password">Master Password</label>
            <input
              type="password"
              id="setup-password"
              class="form-control"
              placeholder="Enter master password"
              autocomplete="new-password"
            />
            <div class="password-strength">
              <div class="strength-bar">
                <div class="strength-fill" id="strength-fill"></div>
              </div>
              <span class="strength-label" id="strength-label">Enter password</span>
            </div>
          </div>

          <div class="form-group">
            <label for="setup-password-confirm">Confirm Password</label>
            <input
              type="password"
              id="setup-password-confirm"
              class="form-control"
              placeholder="Re-enter password"
              autocomplete="new-password"
            />
          </div>

          <div class="form-group">
            <label for="setup-password-hint">Password Hint (Optional)</label>
            <input
              type="text"
              id="setup-password-hint"
              class="form-control"
              placeholder="e.g., First pet + birth year"
              autocomplete="off"
            />
            <small class="form-text">A hint to help you remember your password. Don't make it obvious!</small>
          </div>

          ${biometricAvailable ? `
            <div class="form-group form-checkbox">
              <label>
                <input type="checkbox" id="setup-enable-biometric" />
                <span>Enable biometric unlock (${biometricInfo.biometricType === 'windows_hello' ? 'Windows Hello' : 'Biometric'})</span>
              </label>
              <small class="form-text">Use fingerprint or face recognition to unlock the app quickly</small>
            </div>
          ` : ''}

          <div class="warning-box">
            <strong>⚠️ Important:</strong> Your master password cannot be recovered if forgotten. Make sure you remember it or store it securely.
          </div>

          <div class="modal-error" style="display: none;"></div>
        </div>
        <div class="modal-footer">
          <button class="btn-primary modal-setup-confirm" id="setup-confirm-btn">
            ${isMigration ? 'Encrypt & Continue' : 'Create Master Password'}
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  const overlay = document.getElementById('master-password-modal');
  const passwordInput = document.getElementById('setup-password');
  const confirmInput = document.getElementById('setup-password-confirm');
  const hintInput = document.getElementById('setup-password-hint');
  const biometricCheckbox = document.getElementById('setup-enable-biometric');
  const confirmBtn = document.getElementById('setup-confirm-btn');
  const strengthFill = document.getElementById('strength-fill');
  const strengthLabel = document.getElementById('strength-label');

  // Password strength indicator
  passwordInput.addEventListener('input', () => {
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
    const errorEl = overlay.querySelector('.modal-error');
    errorEl.textContent = message;
    errorEl.style.display = 'block';
  };

  // Hide error
  const hideError = () => {
    const errorEl = overlay.querySelector('.modal-error');
    errorEl.style.display = 'none';
  };

  // Confirm handler
  confirmBtn.addEventListener('click', async () => {
    hideError();

    const password = passwordInput.value;
    const confirm = confirmInput.value;
    const hint = hintInput.value.trim();
    const enableBiometric = biometricCheckbox ? biometricCheckbox.checked : false;

    // Validation
    if (!password) {
      showError('Please enter a master password');
      passwordInput.focus();
      return;
    }

    if (password.length < 8) {
      showError('Password must be at least 8 characters long');
      passwordInput.focus();
      return;
    }

    if (password !== confirm) {
      showError('Passwords do not match');
      confirmInput.focus();
      return;
    }

    const strength = calculatePasswordStrength(password);
    if (strength < 30) {
      showError('Password is too weak. Please choose a stronger password.');
      passwordInput.focus();
      return;
    }

    // Disable button during setup
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Setting up...';

    try {
      await setupMasterPassword(password, hint, enableBiometric);
      console.log('[MasterPasswordModals] Master password setup successful');

      // Close modal
      overlay.remove();

      // Call success callback
      if (onSuccess) {
        onSuccess();
      }
    } catch (error) {
      console.error('[MasterPasswordModals] Setup failed:', error);
      showError(error.message || 'Failed to set up master password');
      confirmBtn.disabled = false;
      confirmBtn.textContent = isMigration ? 'Encrypt & Continue' : 'Create Master Password';
    }
  });

  // Enter key to confirm
  const handleEnter = (e) => {
    if (e.key === 'Enter') {
      confirmBtn.click();
    }
  };
  passwordInput.addEventListener('keydown', handleEnter);
  confirmInput.addEventListener('keydown', handleEnter);

  // Focus first input
  setTimeout(() => passwordInput.focus(), 100);
}

/**
 * Show app unlock modal
 * @param {Function} onSuccess - Callback when unlock succeeds
 * @returns {Promise<void>}
 */
export async function showAppUnlock({ onSuccess } = {}) {
  console.log('[MasterPasswordModals] Showing unlock modal');

  // Check if biometric unlock is available
  const biometricUnlockEnabled = await isBiometricUnlockEnabled();
  const biometricInfo = biometricUnlockEnabled ? await checkBiometricAvailability() : { available: false };

  // Get password hint
  const hint = await getPasswordHint();

  const modalHtml = `
    <div id="unlock-modal" class="modal-overlay modal-no-close">
      <div class="modal-dialog modal-unlock">
        <div class="modal-header">
          <h3 class="modal-title">🔒 Unlock oneJournal</h3>
        </div>
        <div class="modal-body">
          <p class="modal-description">
            Enter your master password to unlock the app
          </p>

          <div class="form-group">
            <label for="unlock-password">Master Password</label>
            <input
              type="password"
              id="unlock-password"
              class="form-control"
              placeholder="Enter password"
              autocomplete="current-password"
            />
            ${hint ? `<small class="form-text">Hint: ${hint}</small>` : ''}
          </div>

          ${biometricUnlockEnabled && biometricInfo.available ? `
            <div class="unlock-divider">
              <span>OR</span>
            </div>
            <button class="btn-biometric" id="unlock-biometric-btn">
              <span class="biometric-icon">👆</span>
              Unlock with ${biometricInfo.biometricType === 'windows_hello' ? 'Windows Hello' : 'Biometric'}
            </button>
          ` : ''}

          <div class="modal-error" style="display: none;"></div>
        </div>
        <div class="modal-footer">
          <button class="btn-primary modal-unlock-confirm" id="unlock-confirm-btn">
            Unlock
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  const overlay = document.getElementById('unlock-modal');
  const passwordInput = document.getElementById('unlock-password');
  const confirmBtn = document.getElementById('unlock-confirm-btn');
  const biometricBtn = document.getElementById('unlock-biometric-btn');

  // Show error in modal
  const showError = (message) => {
    const errorEl = overlay.querySelector('.modal-error');
    errorEl.textContent = message;
    errorEl.style.display = 'block';
  };

  // Hide error
  const hideError = () => {
    const errorEl = overlay.querySelector('.modal-error');
    errorEl.style.display = 'none';
  };

  // Unlock with password
  const unlockWithPassword = async () => {
    hideError();

    const password = passwordInput.value;

    if (!password) {
      showError('Please enter your password');
      passwordInput.focus();
      return;
    }

    // Disable button during unlock
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Unlocking...';

    try {
      const success = await unlockApp(password);

      if (success) {
        console.log('[MasterPasswordModals] Unlock successful');
        overlay.remove();

        // Call success callback
        if (onSuccess) {
          onSuccess();
        }
      } else {
        showError('Incorrect password. Please try again.');
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Unlock';
        passwordInput.value = '';
        passwordInput.focus();
      }
    } catch (error) {
      console.error('[MasterPasswordModals] Unlock failed:', error);
      showError(error.message || 'Failed to unlock app');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Unlock';
    }
  };

  // Confirm handler
  confirmBtn.addEventListener('click', unlockWithPassword);

  // Biometric unlock handler
  if (biometricBtn) {
    biometricBtn.addEventListener('click', async () => {
      hideError();
      biometricBtn.disabled = true;
      biometricBtn.textContent = 'Authenticating...';

      try {
        const success = await unlockWithBiometric();

        if (success) {
          console.log('[MasterPasswordModals] Biometric unlock successful');
          overlay.remove();

          if (onSuccess) {
            onSuccess();
          }
        } else {
          showError('Biometric authentication failed. Please use your password.');
          biometricBtn.disabled = false;
          biometricBtn.innerHTML = '<span class="biometric-icon">👆</span> Unlock with Biometric';
          passwordInput.focus();
        }
      } catch (error) {
        console.error('[MasterPasswordModals] Biometric unlock failed:', error);
        showError('Biometric unlock not available. Please use your password.');
        biometricBtn.disabled = false;
        biometricBtn.innerHTML = '<span class="biometric-icon">👆</span> Unlock with Biometric';
        passwordInput.focus();
      }
    });
  }

  // Enter key to unlock
  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
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
  title = 'Confirm',
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm
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

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const overlay = document.getElementById('confirm-modal');
    const confirmBtn = overlay.querySelector('.modal-confirm');
    const cancelBtn = overlay.querySelector('.modal-cancel');

    const closeModal = () => {
      overlay.remove();
    };

    confirmBtn.addEventListener('click', async () => {
      if (onConfirm) {
        await onConfirm();
      }
      closeModal();
      resolve(true);
    });

    cancelBtn.addEventListener('click', () => {
      closeModal();
      resolve(false);
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        closeModal();
        resolve(false);
      }
    });
  });
}
