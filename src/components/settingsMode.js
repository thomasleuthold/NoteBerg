/**
 * Settings Mode Component
 * Renders the settings panel with theme selection and other preferences
 */

import { APP_FULL_VERSION, APP_NAME } from "../config.js";
import {
  clearCredentials,
  fullSync,
  getStoredCredentials,
  isAuthenticated,
  startLoginFlow,
  testConnection,
} from "../modules/nextcloudSync.js";
import {
  getAllNotebooksForSync,
  getAllNotesForSync,
  getSetting,
  purgeLocalData,
  saveNote,
  saveNotebook,
  setSetting,
} from "../modules/storage.js";
import { getTheme, setTheme } from "../modules/theme.js";
import { showLicensesDialog } from "./licensesDialog.js";
import { showAlertDialog, showConfirmDialog, showConflictResolutionDialog } from "./modals.js";

/**
 * Render settings UI
 * @param {HTMLElement} container - Container element to render into
 */
export async function renderSettings(container) {
  const currentTheme = getTheme();
  const authenticated = await isAuthenticated();
  const credentials = await getStoredCredentials();
  // Biometric authentication removed for performance
  const biometricCapability = { available: false };
  const biometricEnabled = false;

  // Get encryption settings
  const encryptLocalData = (await getSetting("encrypt_local_data")) ?? true; // Default: enabled
  const encryptNextcloudData = (await getSetting("encrypt_nextcloud_data")) ?? false; // Default: disabled
  const recognitionUrl = (await getSetting("recognition_url")) || "http://localhost:5000";
  const recognitionLanguage = (await getSetting("recognition_language")) || "en-US";

  container.innerHTML = `
    <div class="settings-panel">
      <div class="settings-header">
        <h2>Settings</h2>
      </div>

      <div class="settings-section">
        <h3>Appearance</h3>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">Theme</span>
            <span class="setting-description">Choose your preferred color scheme</span>
          </div>
          <div class="theme-toggle-group">
            <button class="theme-toggle ${currentTheme === "light" ? "active" : ""}" data-theme="light">
              <div class="theme-toggle-swatch light"></div>
              <span class="theme-toggle-label">Light</span>
            </button>
            <button class="theme-toggle ${currentTheme === "dark" ? "active" : ""}" data-theme="dark">
              <div class="theme-toggle-swatch dark"></div>
              <span class="theme-toggle-label">Dark</span>
            </button>
            <button class="theme-toggle ${currentTheme === "epaper" ? "active" : ""}" data-theme="epaper">
              <div class="theme-toggle-swatch epaper"></div>
              <span class="theme-toggle-label">E-Paper</span>
            </button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>Security</h3>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">Encrypt Local Data</span>
            <span class="setting-description">Encrypt notes stored locally on this device</span>
          </div>
          <label class="toggle-switch">
            <input
              type="checkbox"
              id="encrypt-local-toggle"
              ${encryptLocalData ? "checked" : ""}
            />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">Encrypt Data on Nextcloud</span>
            <span class="setting-description">
              ${authenticated ? "Encrypt notes before uploading to Nextcloud (end-to-end encryption)" : "Nextcloud sync not configured"}
            </span>
          </div>
          <label class="toggle-switch" ${!authenticated ? 'style="opacity: 0.5;"' : ""}>
            <input
              type="checkbox"
              id="encrypt-nextcloud-toggle"
              ${encryptNextcloudData ? "checked" : ""}
              ${!authenticated ? "disabled" : ""}
            />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <!-- Biometric Authentication UI - Hidden for now, keeping code for future use
        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">Biometric Authentication</span>
            <span class="setting-description">
              ${
                biometricCapability.available
                  ? (
                      () => {
                        const type = biometricCapability.biometricType;
                        if (type === "windows_hello")
                          return "Protect credentials with Windows Hello";
                        if (type === "touch_id") return "Protect credentials with Touch ID";
                        if (type === "ios_biometric")
                          return "Protect credentials with Face ID or Touch ID";
                        if (type === "android_biometric")
                          return "Protect credentials with Fingerprint or Face Unlock";
                        if (type === "fingerprint") return "Protect credentials with Fingerprint";
                        return "Protect credentials with biometric authentication";
                      }
                    )()
                  : "Biometric authentication not available on this device"
              }
            </span>
          </div>
          <label class="toggle-switch" ${!biometricCapability.available ? 'style="opacity: 0.5;"' : ""}>
            <input
              type="checkbox"
              id="biometric-toggle"
              ${biometricEnabled ? "checked" : ""}
              ${!biometricCapability.available ? "disabled" : ""}
            />
            <span class="toggle-slider"></span>
          </label>
        </div>

        ${
          biometricCapability.available
            ? `
        <div class="setting-item">
          <button id="test-biometric-btn" class="btn-secondary">Test Biometric Authentication</button>
          <span id="biometric-test-status" class="setting-note"></span>
        </div>
        `
            : ""
        }
        -->
      </div>

      <div class="settings-section">
        <h3>Nextcloud Sync</h3>

        ${
          !authenticated
            ? `
        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">Connect to Nextcloud</span>
            <span class="setting-description">Use Nextcloud Login Flow to securely connect your account</span>
          </div>
        </div>

        <div class="setting-item">
          <label for="nextcloud-url" class="setting-label">
            <span class="setting-name">Nextcloud Server URL</span>
            <span class="setting-description">Enter your Nextcloud server address</span>
          </label>
          <input
            type="url"
            id="nextcloud-url"
            class="setting-control"
            placeholder="https://cloud.example.com"
          />
        </div>

        <div class="setting-item">
          <button id="test-connection-btn" class="btn-secondary">Test Connection</button>
          <button id="connect-nextcloud-btn" class="btn-primary">Connect to Nextcloud</button>
          <span id="connection-status" class="setting-note"></span>
        </div>

        <div class="setting-item" id="login-url-container" style="display: none;">
          <label for="login-url" class="setting-label">
            <span class="setting-name">Login URL</span>
            <span class="setting-description">Copy and open this URL in your browser to complete login</span>
          </label>
          <input
            type="text"
            id="login-url"
            class="setting-control"
            readonly
            style="user-select: all; -webkit-user-select: all;"
          />
          <button id="copy-login-url-btn" class="btn-secondary" style="margin-top: 8px;">Copy URL</button>
        </div>
        `
            : `
        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">Connected</span>
            <span class="setting-description">Logged in as ${credentials?.loginName || "Unknown"}</span>
          </div>
          <div class="setting-label">
            <span class="setting-description">Server: ${credentials?.serverUrl || "Unknown"}</span>
          </div>
        </div>

        <div class="setting-item">
          <button id="sync-now-btn" class="btn-primary">Sync Now</button>
          <button id="disconnect-btn" class="btn-secondary">Disconnect</button>
          <span id="sync-status" class="setting-note"></span>
        </div>
        `
        }
      </div>

      <div class="settings-section">
        <h3>Handwriting Recognition</h3>

        <div class="setting-item">
          <label for="recognition-url" class="setting-label">
            <span class="setting-name">Backend URL</span>
            <span class="setting-description">URL of the recognition service</span>
          </label>
          <input
            type="url"
            id="recognition-url"
            class="setting-control"
            value="${recognitionUrl}"
            placeholder="http://localhost:5000"
          />
        </div>

        <div class="setting-item">
          <label for="recognition-language" class="setting-label">
            <span class="setting-name">Language</span>
            <span class="setting-description">Target language (requires installed Windows language pack)</span>
          </label>
          <select id="recognition-language" class="setting-control">
            <option value="en-US" ${recognitionLanguage === "en-US" ? "selected" : ""}>English (US)</option>
            <option value="de-DE" ${recognitionLanguage === "de-DE" ? "selected" : ""}>German</option>
            <option value="fr-FR" ${recognitionLanguage === "fr-FR" ? "selected" : ""}>French</option>
            <option value="es-ES" ${recognitionLanguage === "es-ES" ? "selected" : ""}>Spanish</option>
            <option value="it-IT" ${recognitionLanguage === "it-IT" ? "selected" : ""}>Italian</option>
            <option value="ja-JP" ${recognitionLanguage === "ja-JP" ? "selected" : ""}>Japanese</option>
            <option value="zh-CN" ${recognitionLanguage === "zh-CN" ? "selected" : ""}>Chinese (Simplified)</option>
          </select>
        </div>

        <div class="setting-item">
          <button id="test-recognition-btn" class="btn-secondary">Test Connection</button>
          <span id="recognition-status" class="setting-note"></span>
        </div>
      </div>

      <div class="settings-section">
        <h3>Logging</h3>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">Log Level</span>
            <span class="setting-description">Set minimum severity level for logging</span>
          </div>
          <select id="log-level-select" class="setting-control">
            <option value="debug">Debug (Verbose)</option>
            <option value="info">Info</option>
            <option value="warning" selected>Warning (Default)</option>
            <option value="error">Error (Minimal)</option>
          </select>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">Session Logs</span>
            <span class="setting-description">View in-memory logs for this session</span>
          </div>
          <button id="view-logs-btn" class="btn-secondary">View Logs</button>
        </div>
      </div>

      <div class="settings-section">
        <h3 style="color: var(--color-danger);">Danger Zone</h3>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">Reset Master Password</span>
            <span class="setting-description">Clear master password and encryption keys. You'll need to set a new password.</span>
          </div>
          <button id="reset-master-password-btn" class="btn-secondary" style="background-color: var(--color-warning); color: white;">Reset Master Password</button>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">Purge Local Data</span>
            <span class="setting-description">Clears ALL local notebooks and notes from this device.</span>
          </div>
          <button id="purge-local-btn" class="btn-secondary" style="background-color: var(--color-danger); color: white;">Purge Local Data</button>
          <span id="purge-status" class="setting-note"></span>
        </div>

        <div class="setting-item">
          <div class="setting-description" style="color: var(--text-secondary); font-size: 0.875rem;">
            ⚠️ <strong>Warning:</strong> This action will delete all local data including notebooks, notes, and sync history. ${authenticated ? "If you are connected to Nextcloud, you can restore your data by syncing again. Unsynced changes will be permanently lost." : "This action is permanent and cannot be undone."}
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>About</h3>

        <div class="setting-item">
          <div class="about-info">
            <p><strong>${APP_NAME}</strong></p>
            <p>Version: ${APP_FULL_VERSION}</p>
            <p>A note-taking app supporting handwritten notes, text, and drawings.</p>
          </div>
        </div>

        <div class="setting-item">
          <button id="show-licenses-btn" class="btn-secondary">License Information</button>
        </div>
      </div>
    </div>
  `;

  // Attach event listeners to theme toggle buttons
  const themeToggles = container.querySelectorAll(".theme-toggle");
  themeToggles.forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const theme = toggle.dataset.theme;
      setTheme(theme);

      // Update active state
      for (const t of themeToggles) {
        t.classList.remove("active");
      }
      toggle.classList.add("active");
    });
  });

  // Encryption toggles event listeners
  const encryptLocalToggle = container.querySelector("#encrypt-local-toggle");
  const encryptNextcloudToggle = container.querySelector("#encrypt-nextcloud-toggle");

  encryptLocalToggle?.addEventListener("change", async () => {
    const enabled = encryptLocalToggle.checked;

    if (enabled) {
      // Check if master password is configured AND actually stored in keyring
      const { isMasterPasswordSet } = await import("../modules/masterPassword.js");
      const { getSecureCredential } = await import("../modules/secureStorage.js");

      const masterPasswordSet = await isMasterPasswordSet();
      const masterPasswordInKeyring = await getSecureCredential("master_password");

      console.log(
        "[Settings] Local encryption toggle enabled, master password set:",
        masterPasswordSet,
        "in keyring:",
        !!masterPasswordInKeyring,
        "keyring value:",
        masterPasswordInKeyring,
      );

      if (!masterPasswordSet || !masterPasswordInKeyring) {
        // Need to set up master password first
        console.log("[Settings] Showing master password setup modal...");
        const { showMasterPasswordSetup } = await import("./masterPasswordModals.js");

        const result = await new Promise((resolve) => {
          showMasterPasswordSetup({
            isMigration: false,
            onSuccess: async () => {
              console.log("[Settings] Master password setup complete for local encryption");
              await setSetting("encrypt_local_data", true);
              await showAlertDialog(
                "Encryption Enabled",
                "✓ Master password created and local data encryption enabled. New notes will be encrypted.",
              );
              resolve(true);
            },
            onCancel: () => {
              console.log("[Settings] Master password setup canceled, reverting toggle");
              encryptLocalToggle.checked = false;
              resolve(false);
            },
          });
        });

        console.log("[Settings] Master password setup result:", result);
        return;
      } else {
        console.log("[Settings] Master password already configured, enabling encryption directly");
      }
    }

    await setSetting("encrypt_local_data", enabled);

    // Show confirmation message
    const statusMsg = enabled
      ? "✓ Local data encryption enabled. New notes will be encrypted."
      : "Local data encryption disabled. Existing encrypted notes remain encrypted.";

    await showAlertDialog("Encryption Setting Updated", statusMsg);
  });

  encryptNextcloudToggle?.addEventListener("change", async () => {
    const enabled = encryptNextcloudToggle.checked;

    if (enabled) {
      // Check if master password is configured AND actually stored in keyring
      const { isMasterPasswordSet } = await import("../modules/masterPassword.js");
      const { getSecureCredential } = await import("../modules/secureStorage.js");

      const masterPasswordSet = await isMasterPasswordSet();
      const masterPasswordInKeyring = await getSecureCredential("master_password");

      console.log(
        "[Settings] Nextcloud encryption toggle enabled, master password set:",
        masterPasswordSet,
        "in keyring:",
        !!masterPasswordInKeyring,
      );

      if (!masterPasswordSet || !masterPasswordInKeyring) {
        // Need to set up master password first
        console.log("[Settings] Showing master password setup modal...");
        const { showMasterPasswordSetup } = await import("./masterPasswordModals.js");

        showMasterPasswordSetup({
          isMigration: false,
          onSuccess: async () => {
            console.log("[Settings] Master password setup complete for Nextcloud encryption");
            await setSetting("encrypt_nextcloud_data", true);
            await showAlertDialog(
              "Encryption Enabled",
              "✓ Master password created and Nextcloud encryption enabled. Notes will be encrypted before uploading.<br><br><strong>Important:</strong> Encrypted notes cannot be read in Nextcloud's web interface or other clients.",
            );
          },
          onCancel: () => {
            console.log("[Settings] Master password setup canceled, reverting toggle");
            encryptNextcloudToggle.checked = false;
          },
        });

        return;
      }
    }

    await setSetting("encrypt_nextcloud_data", enabled);

    // Show confirmation message
    const statusMsg = enabled
      ? "✓ Nextcloud encryption enabled. Notes will be encrypted before uploading.<br><br><strong>Important:</strong> Encrypted notes cannot be read in Nextcloud's web interface or other clients."
      : "Nextcloud encryption disabled. Notes will be synced as plain text.";

    await showAlertDialog("Encryption Setting Updated", statusMsg);
  });

  // Biometric authentication removed for performance - event listeners removed

  // Recognition settings listeners
  const recognitionUrlInput = container.querySelector("#recognition-url");
  const recognitionLanguageSelect = container.querySelector("#recognition-language");
  const testRecognitionBtn = container.querySelector("#test-recognition-btn");
  const recognitionStatus = container.querySelector("#recognition-status");

  recognitionUrlInput?.addEventListener("change", async () => {
    let url = recognitionUrlInput.value.trim();
    if (url.endsWith("/")) url = url.slice(0, -1);
    await setSetting("recognition_url", url);
    if (recognitionStatus) recognitionStatus.textContent = "";
  });

  recognitionLanguageSelect?.addEventListener("change", async () => {
    await setSetting("recognition_language", recognitionLanguageSelect.value);
  });

  testRecognitionBtn?.addEventListener("click", async () => {
    const url = recognitionUrlInput.value.trim().replace(/\/$/, "");
    const apiUrl = `${url}/recognize`;

    testRecognitionBtn.disabled = true;
    testRecognitionBtn.textContent = "Testing...";
    recognitionStatus.textContent = "Connecting...";
    recognitionStatus.style.color = "var(--color-text)";

    try {
      const { fetch } = await import("@tauri-apps/plugin-http");
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([]),
      });

      if (response.ok) {
        recognitionStatus.textContent = "✓ Connection successful!";
        recognitionStatus.style.color = "var(--color-success)";
      } else {
        recognitionStatus.textContent = `✗ Server returned ${response.status}`;
        recognitionStatus.style.color = "var(--color-error)";
      }
    } catch (error) {
      console.error("Recognition test failed:", error);
      const errorMessage = error.message || String(error);
      recognitionStatus.textContent = `✗ Connection failed: ${errorMessage}`;
      recognitionStatus.style.color = "var(--color-error)";
    } finally {
      testRecognitionBtn.disabled = false;
      testRecognitionBtn.textContent = "Test Connection";
    }
  });

  // Log level select - change minimum log level
  const logLevelSelect = container.querySelector("#log-level-select");
  if (logLevelSelect) {
    // Load saved log level
    const savedLogLevel = await getSetting("log_level");
    if (savedLogLevel) {
      logLevelSelect.value = savedLogLevel;
    }

    logLevelSelect.addEventListener("change", async () => {
      const { setLogLevel } = await import("../utils/logger.js");
      const newLevel = logLevelSelect.value;
      setLogLevel(newLevel);
      await setSetting("log_level", newLevel);
      console.log(`[Settings] Log level changed to: ${newLevel}`);
    });
  }

  // View logs button - show in-memory logs in a modal
  const viewLogsBtn = container.querySelector("#view-logs-btn");
  viewLogsBtn?.addEventListener("click", async () => {
    const { getLogsAsText, getLogCount, clearLogs } = await import("../utils/logger.js");
    const logCount = getLogCount();
    const logsText = getLogsAsText();

    if (logCount === 0) {
      await showAlertDialog("Debug Logs", "No logs available in this session.");
      return;
    }

    // Create a custom modal with copy and clear buttons
    const modalHtml = `
      <div id="logs-modal" class="modal-overlay">
        <div class="modal-dialog" style="max-width: 800px; max-height: 80vh;">
          <div class="modal-header">
            <h3 class="modal-title">Debug Logs (${logCount} entries)</h3>
            <button class="modal-close" aria-label="Close">&times;</button>
          </div>
          <div class="modal-body">
            <p style="margin-bottom: 10px;">Session logs from this app run:</p>
            <textarea
              id="logs-content"
              readonly
              style="width: 100%; height: 400px; font-family: monospace; font-size: 12px; padding: 10px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-secondary);"
            >${logsText}</textarea>
          </div>
          <div class="modal-footer" style="gap: 10px;">
            <button class="btn-secondary" id="copy-logs-btn">Copy to Clipboard</button>
            <button class="btn-danger" id="clear-logs-btn">Clear Logs</button>
            <button class="btn-primary modal-close-btn">Close</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", modalHtml);

    const modal = document.getElementById("logs-modal");
    const closeBtn = modal.querySelector(".modal-close");
    const closeBtnFooter = modal.querySelector(".modal-close-btn");
    const copyBtn = modal.querySelector("#copy-logs-btn");
    const clearBtn = modal.querySelector("#clear-logs-btn");
    const logsContent = modal.querySelector("#logs-content");

    const closeModal = () => {
      modal.classList.add("modal-closing");
      setTimeout(() => modal.remove(), 200);
    };

    closeBtn.addEventListener("click", closeModal);
    closeBtnFooter.addEventListener("click", closeModal);

    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(logsText);
        copyBtn.textContent = "✓ Copied!";
        setTimeout(() => {
          copyBtn.textContent = "Copy to Clipboard";
        }, 2000);
      } catch (error) {
        console.error("Failed to copy logs:", error);
        alert("Failed to copy logs to clipboard");
      }
    });

    clearBtn.addEventListener("click", () => {
      if (confirm("Are you sure you want to clear all debug logs?")) {
        clearLogs();
        logsContent.value = "";
        closeModal();
      }
    });

    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });

    document.addEventListener("keydown", function handleEsc(e) {
      if (e.key === "Escape") {
        closeModal();
        document.removeEventListener("keydown", handleEsc);
      }
    });
  });

  // Nextcloud sync event listeners
  if (!authenticated) {
    const testBtn = container.querySelector("#test-connection-btn");
    const connectBtn = container.querySelector("#connect-nextcloud-btn");
    const urlInput = container.querySelector("#nextcloud-url");
    const statusSpan = container.querySelector("#connection-status");

    testBtn?.addEventListener("click", async () => {
      const serverUrl = urlInput.value.trim();

      if (!serverUrl) {
        statusSpan.textContent = "Please enter a server URL";
        statusSpan.style.color = "var(--color-error)";
        return;
      }

      testBtn.disabled = true;
      testBtn.textContent = "Testing...";
      statusSpan.textContent = "";

      try {
        const result = await testConnection(serverUrl);
        if (result.success) {
          statusSpan.textContent = `✓ Connected to Nextcloud ${result.versionstring}`;
          statusSpan.style.color = "var(--color-success)";
        } else {
          statusSpan.textContent = `✗ ${result.error}`;
          statusSpan.style.color = "var(--color-error)";
        }
      } catch (error) {
        statusSpan.textContent = `✗ ${error.message}`;
        statusSpan.style.color = "var(--color-error)";
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = "Test Connection";
      }
    });

    connectBtn?.addEventListener("click", async () => {
      const serverUrl = urlInput.value.trim();

      if (!serverUrl) {
        statusSpan.textContent = "Please enter a server URL";
        statusSpan.style.color = "var(--color-error)";
        return;
      }

      connectBtn.disabled = true;
      connectBtn.textContent = "Initializing...";
      statusSpan.textContent = "Starting Nextcloud Login Flow...";
      statusSpan.style.color = "var(--color-text)";

      const loginUrlContainer = container.querySelector("#login-url-container");
      const loginUrlInput = container.querySelector("#login-url");
      const copyLoginUrlBtn = container.querySelector("#copy-login-url-btn");

      try {
        await startLoginFlow(serverUrl, (loginUrl) => {
          // Show the login URL field
          loginUrlContainer.style.display = "block";
          loginUrlInput.value = loginUrl;

          statusSpan.textContent = "Waiting for login... Open the URL above in your browser";
          statusSpan.style.color = "var(--color-text)";

          // Add copy button handler
          copyLoginUrlBtn.onclick = async () => {
            try {
              loginUrlInput.select();
              await navigator.clipboard.writeText(loginUrl);
              copyLoginUrlBtn.textContent = "✓ Copied!";
              setTimeout(() => {
                copyLoginUrlBtn.textContent = "Copy URL";
              }, 2000);
            } catch (_err) {
              // Fallback: select the text
              loginUrlInput.select();
              copyLoginUrlBtn.textContent = "Selected - use Ctrl+C";
              setTimeout(() => {
                copyLoginUrlBtn.textContent = "Copy URL";
              }, 2000);
            }
          };
        });

        // Login successful
        loginUrlContainer.style.display = "none";
        statusSpan.textContent = "✓ Connected successfully!";
        statusSpan.style.color = "var(--color-success)";

        // Notify footer about auth change
        window.dispatchEvent(new CustomEvent("nextcloud-auth-changed"));

        // Reload settings to show authenticated state
        setTimeout(() => renderSettings(container), 1000);
      } catch (error) {
        console.error("Login flow error caught in settings:", error);
        const errorMessage = error?.message || error?.toString() || "Unknown error occurred";
        loginUrlContainer.style.display = "none";
        statusSpan.textContent = `✗ ${errorMessage}`;
        statusSpan.style.color = "var(--color-error)";
        connectBtn.disabled = false;
        connectBtn.textContent = "Connect to Nextcloud";
      }
    });
  } else {
    const syncBtn = container.querySelector("#sync-now-btn");
    const disconnectBtn = container.querySelector("#disconnect-btn");
    const syncStatus = container.querySelector("#sync-status");

    syncBtn?.addEventListener("click", async () => {
      const runSync = async () => {
        syncBtn.disabled = true;
        syncBtn.textContent = "Syncing...";
        syncStatus.textContent = "Syncing with Nextcloud...";
        syncStatus.style.color = "var(--color-text)";

        const notebooks = await getAllNotebooksForSync();
        const notes = await getAllNotesForSync();

        const result = await fullSync(notebooks, notes);

        // Handle manual conflict resolution for notes
        if (result.conflicts?.notes?.length > 0) {
          for (const conflict of result.conflicts.notes) {
            const choice = await showConflictResolutionDialog(conflict.local, conflict.remote);
            if (choice === "local") {
              // Keep local: Accept remote ETag as base, but increment version and mark unsynced
              await saveNote({
                ...conflict.local,
                lastSyncedEtag: conflict.remote.lastSyncedEtag,
                synced: false,
                version: Math.max(conflict.local.version || 0, conflict.remote.version || 0) + 1,
                modified: Date.now(),
              });
            } else {
              // Keep remote: Overwrite local with remote data
              await saveNote({ ...conflict.remote, synced: true });
            }
          }
          // Re-run sync logic to process the resolutions
          return await runSync();
        }

        // Mark uploaded items as synced in local storage
        for (const id of result.uploaded.notebooks.uploadedIds || []) {
          const uploadedNotebook = result.notebooksToUpload.find((n) => n.id === id);
          const notebook = uploadedNotebook || notebooks.find((n) => n.id === id);
          if (notebook) {
            const etag = result.uploaded.notebooks.metadata?.[id]?.etag;
            await saveNotebook({
              ...notebook,
              synced: true,
              lastSyncedEtag: etag || notebook.lastSyncedEtag,
            });
          }
        }

        for (const id of result.uploaded.notes.uploadedIds || []) {
          const uploadedNote = result.notesToUpload.find((n) => n.id === id);
          const note = uploadedNote || notes.find((n) => n.id === id);
          if (note) {
            const etag = result.uploaded.notes.metadata?.[id]?.etag;
            await saveNote({ ...note, synced: true, lastSyncedEtag: etag || note.lastSyncedEtag });
          }
        }

        // Save downloaded notebooks to local storage
        let downloadedNotebooks = 0;
        let downloadedNotes = 0;

        for (const notebook of result.downloaded.notebooks) {
          await saveNotebook(notebook);
          downloadedNotebooks++;
        }

        // Save downloaded notes to local storage
        // Use skipEncryption because decryptNoteFromNextcloud already handled encryption format conversion
        for (const note of result.downloaded.notes) {
          // Remove internal _currentFileEtag and update lastSyncedEtag for tracking
          const { _currentFileEtag, ...noteToSave } = note;
          noteToSave.lastSyncedEtag = _currentFileEtag || note.lastSyncedEtag;
          await saveNote(noteToSave, { skipEncryption: true });
          downloadedNotes++;
        }

        const conflictCount =
          (result.conflicts?.notebooks?.length || 0) + (result.conflicts?.notes?.length || 0);
        let statusMsg = `✓ Sync complete! Uploaded ${result.uploaded.notebooks.uploaded} notebooks, ${result.uploaded.notes.uploaded} notes. Downloaded ${downloadedNotebooks} notebooks, ${downloadedNotes} notes.`;

        if (conflictCount > 0) {
          statusMsg += ` ⚠️ Detected ${conflictCount} conflicts.`;
          syncStatus.style.color = "var(--color-warning)";
        } else {
          syncStatus.style.color = "var(--color-success)";
        }

        syncStatus.textContent = statusMsg;

        // Dispatch a global event to notify all components that data has changed.
        // This is safer than conditional dispatching, as sync can have many side effects.
        window.dispatchEvent(new CustomEvent("datachange"));
      };

      try {
        await runSync();
      } catch (error) {
        syncStatus.textContent = `✗ Sync failed: ${error.message}`;
        syncStatus.style.color = "var(--color-error)";
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = "Sync Now";
      }
    });

    disconnectBtn?.addEventListener("click", async () => {
      if (confirm("Are you sure you want to disconnect from Nextcloud?")) {
        await clearCredentials();

        // Notify footer about auth change
        window.dispatchEvent(new CustomEvent("nextcloud-auth-changed"));

        renderSettings(container);
      }
    });
  }

  // Reset master password listener
  const resetMasterPasswordBtn = container.querySelector("#reset-master-password-btn");
  resetMasterPasswordBtn?.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog(
      "Reset Master Password",
      "⚠️ This will clear your master password and encryption keys.<br><br>" +
        "After reset, you'll need to set a new master password to use encryption.<br><br>" +
        "<strong>Note:</strong> Encrypted notes will remain encrypted and cannot be decrypted without the original password.",
      "Reset Password",
      "btn-warning",
    );

    if (!confirmed) return;

    try {
      // Clear master password from storage
      const { deleteSecureCredential } = await import("../modules/secureStorage.js");
      const { clearMasterPassword } = await import("../modules/masterPassword.js");

      await deleteSecureCredential("master_password");
      await clearMasterPassword();

      await showAlertDialog(
        "Master Password Reset",
        "✓ Master password has been cleared. You can now set a new password by enabling encryption.",
      );

      // Re-render settings to update UI
      await renderSettings(container);
    } catch (error) {
      console.error("[Settings] Failed to reset master password:", error);
      await showAlertDialog("Error", `Failed to reset master password: ${error.message}`);
    }
  });

  // Purge local data listener (available regardless of auth status)
  const purgeLocalBtn = container.querySelector("#purge-local-btn");
  const purgeStatus = container.querySelector("#purge-status");

  purgeLocalBtn?.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog(
      "Purge Local Data",
      "⚠️ DANGER: This will DELETE ALL local notebooks and notes from this device!<br><br>" +
        "This includes:<ul>" +
        "<li>All notebooks and notes</li>" +
        "<li>All deleted items (recycle bin)</li>" +
        "<li>Local sync history</li></ul>" +
        "This action cannot be undone. Are you absolutely sure you want to continue?",
      "Purge Everything",
      "btn-danger",
    );

    if (!confirmed) return;

    purgeLocalBtn.disabled = true;
    purgeLocalBtn.textContent = "Purging...";
    if (purgeStatus) {
      purgeStatus.textContent = "Purging local data...";
      purgeStatus.style.color = "var(--color-danger)";
    }

    try {
      await purgeLocalData();

      const isAuth = await isAuthenticated();
      if (purgeStatus) {
        purgeStatus.textContent = isAuth
          ? `✓ Local data purged successfully! Click "Sync Now" to download from server.`
          : `✓ Local data purged successfully!`;
        purgeStatus.style.color = "var(--color-success)";
      }

      // Refresh UI to show empty state
      window.dispatchEvent(new CustomEvent("notes-updated"));

      if (isAuth) {
        await showAlertDialog(
          "Purge Successful",
          "Local data purged successfully!<br><br>" +
            "Next steps:<ol>" +
            "<li>Click 'Sync Now' to download all data from Nextcloud</li>" +
            "<li>Wait for sync to complete</li>" +
            "<li>Your notes will be restored from the server</li></ol>",
        );
      } else {
        await showAlertDialog("Purge Successful", "Local data purged successfully!");
      }
    } catch (error) {
      if (purgeStatus) {
        purgeStatus.textContent = `✗ Purge failed: ${error.message}`;
        purgeStatus.style.color = "var(--color-error)";
      }
      await showAlertDialog("Purge Failed", `Purge failed: ${error.message}`);
    } finally {
      purgeLocalBtn.disabled = false;
      purgeLocalBtn.textContent = "Purge Local Data";
    }
  });

  // License information button (available to all users)
  const showLicensesBtn = container.querySelector("#show-licenses-btn");
  showLicensesBtn?.addEventListener("click", () => {
    showLicensesDialog();
  });
}

/**
 * Initialize settings component
 */
export function initSettings() {
  // Listen for render settings event from router
  window.addEventListener("rendersettings", async () => {
    const container = document.getElementById("settings-content");
    if (container) {
      await renderSettings(container);
    }
  });

  console.log("Settings component initialized");
}
