/**
 * Settings Mode Component
 * Renders the settings panel with theme selection and other preferences
 */

import { APP_FULL_VERSION, APP_NAME } from "../config.js";
import { changeLanguage, getCurrentLanguage, t } from "../i18n/index.js";
import {
  clearCredentials,
  getStoredCredentials,
  isAuthenticated,
  startLoginFlow,
  testConnection,
} from "../modules/nextcloudSync.js";
import { getSetting, purgeLocalData, setSetting } from "../modules/storage.js";
import { performSync, resetSyncWorker } from "../modules/sync.js";
import { getTheme, setTheme } from "../modules/theme.js";
import { showLicensesDialog } from "./licensesDialog.js";
import { showAlertDialog, showConfirmDialog } from "./modals.js";

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

  const cardSize = (await getSetting("card_size")) || "medium";

  // Get encryption settings
  const encryptLocalData = (await getSetting("encrypt_local_data")) ?? false; // Default: disabled
  const encryptNextcloudData = (await getSetting("encrypt_nextcloud_data")) ?? false; // Default: disabled
  // Migrate old recognition_url setting to recognition_fallback_url
  const legacyRecognitionUrl = await getSetting("recognition_url");
  if (legacyRecognitionUrl) {
    await setSetting("recognition_fallback_url", legacyRecognitionUrl);
    await setSetting("recognition_url", null);
  }
  const recognitionFallbackUrl = (await getSetting("recognition_fallback_url")) || "";
  const recognitionLanguage = (await getSetting("recognition_language")) || "en-US";
  const currentLanguage = getCurrentLanguage();

  // Check if local sidecar recognition is available
  let localRecognitionUrl = "";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    localRecognitionUrl = await invoke("get_recognition_url");
  } catch (_e) {
    // Not in Tauri environment or command not available
  }
  const hasLocalRecognition = !!localRecognitionUrl;

  const recognitionLangOptions = ["en-US", "de-DE", "fr-FR", "es-ES", "it-IT", "ja-JP", "zh-CN"];

  container.innerHTML = `
    <div class="settings-panel">
      <div class="settings-header">
        <h2>${t("settings.title")}</h2>
      </div>

      <div class="settings-section">
        <h3>${t("settings.sections.appearance")}</h3>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.appearance.theme")}</span>
            <span class="setting-description">${t("settings.appearance.themeDesc")}</span>
          </div>
          <div class="theme-toggle-group">
            <button class="theme-toggle ${currentTheme === "light" ? "active" : ""}" data-theme="light">
              <div class="theme-toggle-swatch light"></div>
              <span class="theme-toggle-label">${t("settings.appearance.light")}</span>
            </button>
            <button class="theme-toggle ${currentTheme === "dark" ? "active" : ""}" data-theme="dark">
              <div class="theme-toggle-swatch dark"></div>
              <span class="theme-toggle-label">${t("settings.appearance.dark")}</span>
            </button>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.appearance.cardSize")}</span>
            <span class="setting-description">${t("settings.appearance.cardSizeDesc")}</span>
          </div>
          <select id="card-size-select" class="setting-control">
            <option value="small" ${cardSize === "small" ? "selected" : ""}>${t("settings.appearance.cardSizeSmall")}</option>
            <option value="medium" ${cardSize === "medium" ? "selected" : ""}>${t("settings.appearance.cardSizeMedium")}</option>
            <option value="large" ${cardSize === "large" ? "selected" : ""}>${t("settings.appearance.cardSizeLarge")}</option>
          </select>
        </div>
      </div>

      <div class="settings-section">
        <h3>${t("settings.sections.language")}</h3>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.language.label")}</span>
            <span class="setting-description">${t("settings.language.desc")}</span>
          </div>
          <select id="language-select" class="setting-control">
            <option value="en" ${currentLanguage === "en" ? "selected" : ""}>🇬🇧 ${t("settings.language.en")}</option>
            <option value="de" ${currentLanguage === "de" ? "selected" : ""}>🇩🇪 ${t("settings.language.de")}</option>
          </select>
        </div>
      </div>

      <div class="settings-section">
        <h3>${t("settings.sections.security")}</h3>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.security.encryptLocal")}</span>
            <span class="setting-description">${t("settings.security.encryptLocalDesc")}</span>
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
            <span class="setting-name">${t("settings.security.encryptNextcloud")}</span>
            <span class="setting-description">
              ${authenticated ? t("settings.security.encryptNextcloudDesc_connected") : t("settings.security.encryptNextcloudDesc_disconnected")}
            </span>
          </div>
          <label class="toggle-switch${!authenticated ? " toggle-switch--disabled" : ""}">
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
        <h3>${t("settings.sections.nextcloud")}</h3>

        ${
          !authenticated
            ? `
        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.nextcloud.connectLabel")}</span>
            <span class="setting-description">${t("settings.nextcloud.connectDesc")}</span>
          </div>
        </div>

        <div class="setting-item">
          <label for="nextcloud-url" class="setting-label">
            <span class="setting-name">${t("settings.nextcloud.urlLabel")}</span>
            <span class="setting-description">${t("settings.nextcloud.urlDesc")}</span>
          </label>
          <input
            type="url"
            id="nextcloud-url"
            class="setting-control"
            placeholder="${t("settings.nextcloud.urlPlaceholder")}"
          />
        </div>

        <div class="setting-item">
          <button id="test-connection-btn" class="btn-secondary">${t("settings.nextcloud.testBtn")}</button>
          <button id="connect-nextcloud-btn" class="btn-primary">${t("settings.nextcloud.connectBtn")}</button>
          <span id="connection-status" class="setting-note"></span>
        </div>

        <div class="setting-item" id="login-url-container" style="display: none;">
          <label for="login-url" class="setting-label">
            <span class="setting-name">${t("settings.nextcloud.loginUrlLabel")}</span>
            <span class="setting-description">${t("settings.nextcloud.loginUrlDesc")}</span>
          </label>
          <input
            type="text"
            id="login-url"
            class="setting-control setting-control--selectable"
            readonly
          />
          <button id="copy-login-url-btn" class="btn-secondary btn--margin-top">${t("settings.nextcloud.copyUrlBtn")}</button>
        </div>
        `
            : `
        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.nextcloud.connected")}</span>
            <span class="setting-description">${t("settings.nextcloud.connectedAs", { user: credentials?.loginName || "Unknown" })}</span>
          </div>
          <div class="setting-label">
            <span class="setting-description">${t("settings.nextcloud.server", { url: credentials?.serverUrl || "Unknown" })}</span>
          </div>
        </div>

        <div class="setting-item">
          <button id="sync-now-btn" class="btn-primary">${t("settings.nextcloud.syncNow")}</button>
          <button id="disconnect-btn" class="btn-secondary">${t("settings.nextcloud.disconnect")}</button>
          <span id="sync-status" class="setting-note"></span>
        </div>
        `
        }
      </div>

      <div class="settings-section">
        <h3>${t("settings.sections.recognition")}</h3>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.recognition.statusLabel")}</span>
            <span class="setting-description" id="recognition-mode-info">
              ${hasLocalRecognition ? t("settings.recognition.localActive") : recognitionFallbackUrl ? t("settings.recognition.externalService") : t("settings.recognition.notConfigured")}
            </span>
          </div>
        </div>

        <div class="setting-item">
          <label for="recognition-fallback-url" class="setting-label">
            <span class="setting-name">${t("settings.recognition.fallbackUrlLabel")}</span>
            <span class="setting-description">${t("settings.recognition.fallbackUrlDesc")}</span>
          </label>
          <input
            type="url"
            id="recognition-fallback-url"
            class="setting-control"
            value="${recognitionFallbackUrl}"
            placeholder="${t("settings.recognition.fallbackUrlPlaceholder")}"
          />
        </div>

        <div class="setting-item">
          <label for="recognition-language" class="setting-label">
            <span class="setting-name">${t("settings.recognition.languageLabel")}</span>
            <span class="setting-description">${t("settings.recognition.languageDesc")}</span>
          </label>
          <select id="recognition-language" class="setting-control">
            ${recognitionLangOptions.map((code) => `<option value="${code}" ${recognitionLanguage === code ? "selected" : ""}>${t(`settings.recognition.languages.${code}`)}</option>`).join("")}
          </select>
        </div>

        <div class="setting-item">
          <button id="test-recognition-btn" class="btn-secondary">${t("settings.recognition.testBtn")}</button>
          <span id="recognition-status" class="setting-note"></span>
        </div>
      </div>

      <div class="settings-section">
        <h3>${t("settings.sections.logging")}</h3>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.logging.logLevel")}</span>
            <span class="setting-description">${t("settings.logging.logLevelDesc")}</span>
          </div>
          <select id="log-level-select" class="setting-control">
            <option value="debug">${t("settings.logging.debug")}</option>
            <option value="info">${t("settings.logging.info")}</option>
            <option value="warning" selected>${t("settings.logging.warning")}</option>
            <option value="error">${t("settings.logging.error")}</option>
          </select>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.logging.sessionLogs")}</span>
            <span class="setting-description">${t("settings.logging.sessionLogsDesc")}</span>
          </div>
          <button id="view-logs-btn" class="btn-secondary">${t("settings.logging.viewLogs")}</button>
        </div>
      </div>

      <div class="settings-section">
        <h3 class="settings-section-heading--danger">${t("settings.sections.dangerZone")}</h3>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.dangerZone.resetPassword")}</span>
            <span class="setting-description">${t("settings.dangerZone.resetPasswordDesc")}</span>
          </div>
          <button id="reset-master-password-btn" class="btn-secondary btn-warning">${t("settings.dangerZone.resetPasswordBtn")}</button>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.dangerZone.purgeLocal")}</span>
            <span class="setting-description">${t("settings.dangerZone.purgeLocalDesc")}</span>
          </div>
          <button id="purge-local-btn" class="btn-secondary btn-danger-filled">${t("settings.dangerZone.purgeLocalBtn")}</button>
          <span id="purge-status" class="setting-note"></span>
        </div>

        <div class="setting-item">
          <div class="danger-zone-desc">
            ${authenticated ? t("settings.dangerZone.warningConnected") : t("settings.dangerZone.warningDisconnected")}
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>${t("settings.sections.about")}</h3>

        <div class="setting-item">
          <div class="about-info">
            <p><strong>${APP_NAME}</strong></p>
            <p>${t("settings.about.version", { version: APP_FULL_VERSION })}</p>
            <p>${t("settings.about.description")}</p>
          </div>
        </div>

        <div class="setting-item">
          <button id="show-licenses-btn" class="btn-secondary">${t("settings.about.licenses")}</button>
        </div>
      </div>
    </div>
  `;

  // Language selector
  const languageSelect = container.querySelector("#language-select");
  languageSelect?.addEventListener("change", async () => {
    await changeLanguage(languageSelect.value);
  });

  // Card size selector
  const cardSizeSelect = container.querySelector("#card-size-select");
  cardSizeSelect?.addEventListener("change", async () => {
    await setSetting("card_size", cardSizeSelect.value);
    // Re-render overview if currently visible so the change takes effect immediately
    const overviewContent = document.getElementById("overview-content");
    if (overviewContent?.offsetParent !== null) {
      window.dispatchEvent(new CustomEvent("renderoverview"));
    }
  });

  // Attach event listeners to theme toggle buttons
  const themeToggles = container.querySelectorAll(".theme-toggle");
  themeToggles.forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const theme = toggle.dataset.theme;
      setTheme(theme);

      // Update active state
      for (const btn of themeToggles) {
        btn.classList.remove("active");
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
      const { isMasterPasswordSet } = await import("../modules/masterPassword.js");
      const masterPasswordSet = await isMasterPasswordSet();

      if (!masterPasswordSet) {
        // No master password at all — set up fresh
        console.log("[Settings] Showing master password setup modal...");
        const { showMasterPasswordSetup } = await import("./masterPasswordModals.js");

        const result = await new Promise((resolve) => {
          showMasterPasswordSetup({
            isMigration: false,
            onSuccess: async () => {
              console.log("[Settings] Master password setup complete for local encryption");
              await setSetting("encrypt_local_data", true);
              await showAlertDialog(
                t("settings.encryption.enabledLocalTitle"),
                t("settings.encryption.enabledLocalMsg"),
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
      ? t("settings.encryption.enabledLocalMsg")
      : t("settings.encryption.disabledLocalMsg");

    await showAlertDialog(t("settings.encryption.updatedTitle"), statusMsg);
  });

  encryptNextcloudToggle?.addEventListener("change", async () => {
    const enabled = encryptNextcloudToggle.checked;

    if (enabled) {
      // Check if master password is configured AND actually stored in keyring
      const { isMasterPasswordSet } = await import("../modules/masterPassword.js");
      const masterPasswordSet = await isMasterPasswordSet();

      if (!masterPasswordSet) {
        // No master password at all — set up fresh
        console.log("[Settings] Showing master password setup modal...");
        const { showMasterPasswordSetup } = await import("./masterPasswordModals.js");

        showMasterPasswordSetup({
          isMigration: false,
          onSuccess: async () => {
            console.log("[Settings] Master password setup complete for Nextcloud encryption");
            await setSetting("encrypt_nextcloud_data", true);
            await showAlertDialog(
              t("settings.encryption.enabledNextcloudTitle"),
              t("settings.encryption.enabledNextcloudMsg"),
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
      ? t("settings.encryption.enabledNextcloudMsg")
      : t("settings.encryption.disabledNextcloudMsg");

    await showAlertDialog(t("settings.encryption.updatedTitle"), statusMsg);
  });

  // Biometric authentication removed for performance - event listeners removed

  // Recognition settings listeners
  const recognitionFallbackUrlInput = container.querySelector("#recognition-fallback-url");
  const recognitionLanguageSelect = container.querySelector("#recognition-language");
  const testRecognitionBtn = container.querySelector("#test-recognition-btn");
  const recognitionStatus = container.querySelector("#recognition-status");

  recognitionFallbackUrlInput?.addEventListener("change", async () => {
    let url = recognitionFallbackUrlInput.value.trim();
    if (url.endsWith("/")) url = url.slice(0, -1);
    await setSetting("recognition_fallback_url", url);
    // Invalidate cached URL so next recognition uses the new value
    const { invalidateRecognitionUrl } = await import("../modules/autoRecognition.js");
    invalidateRecognitionUrl();
    if (recognitionStatus) recognitionStatus.textContent = "";
  });

  recognitionLanguageSelect?.addEventListener("change", async () => {
    await setSetting("recognition_language", recognitionLanguageSelect.value);
  });

  testRecognitionBtn?.addEventListener("click", async () => {
    // Test whichever backend is active: sidecar first, then fallback URL
    const testUrl =
      localRecognitionUrl || recognitionFallbackUrlInput.value.trim().replace(/\/$/, "");
    if (!testUrl) {
      recognitionStatus.textContent = t("settings.recognition.notConfiguredError");
      recognitionStatus.style.color = "var(--color-error)";
      return;
    }
    const apiUrl = `${testUrl}/recognize`;

    testRecognitionBtn.disabled = true;
    testRecognitionBtn.textContent = t("settings.recognition.testing");
    recognitionStatus.textContent = t("settings.recognition.connecting");
    recognitionStatus.style.color = "var(--color-text)";

    try {
      const { fetch } = await import("@tauri-apps/plugin-http");
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([]),
      });

      if (response.ok) {
        const source = localRecognitionUrl
          ? t("settings.recognition.localSidecar")
          : t("settings.recognition.externalServiceLabel");
        recognitionStatus.textContent = t("settings.recognition.success", { source });
        recognitionStatus.style.color = "var(--color-success)";
      } else {
        recognitionStatus.textContent = t("settings.recognition.errorStatus", {
          status: response.status,
        });
        recognitionStatus.style.color = "var(--color-error)";
      }
    } catch (error) {
      console.error("Recognition test failed:", error);
      const errorMessage = error.message || String(error);
      recognitionStatus.textContent = t("settings.recognition.errorFailed", {
        message: errorMessage,
      });
      recognitionStatus.style.color = "var(--color-error)";
    } finally {
      testRecognitionBtn.disabled = false;
      testRecognitionBtn.textContent = t("settings.recognition.testBtn");
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
      await showAlertDialog(t("settings.sections.logging"), t("settings.logging.noLogs"));
      return;
    }

    // Create a custom modal with copy and clear buttons
    const modalHtml = `
      <div id="logs-modal" class="modal-overlay">
        <div class="modal-dialog modal--wide">
          <div class="modal-header">
            <h3 class="modal-title">${t("settings.logging.logsTitle", { count: logCount })}</h3>
            <button class="modal-close" aria-label="${t("modals.close")}">&times;</button>
          </div>
          <div class="modal-body">
            <p class="logs-intro">${t("settings.logging.logsIntro")}</p>
            <textarea
              id="logs-content"
              class="logs-textarea"
              readonly
            >${logsText}</textarea>
          </div>
          <div class="modal-footer modal-footer--gap">
            <button class="btn-secondary" id="copy-logs-btn">${t("settings.logging.copyLogs")}</button>
            <button class="btn-danger" id="clear-logs-btn">${t("settings.logging.clearLogs")}</button>
            <button class="btn-primary modal-close-btn">${t("modals.noteProperties.closeBtn")}</button>
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
        copyBtn.textContent = t("settings.logging.copied");
        setTimeout(() => {
          copyBtn.textContent = t("settings.logging.copyLogs");
        }, 2000);
      } catch (error) {
        console.error("Failed to copy logs:", error);
        alert("Failed to copy logs to clipboard");
      }
    });

    clearBtn.addEventListener("click", () => {
      if (confirm(t("settings.logging.clearConfirm"))) {
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
        statusSpan.textContent = t("settings.nextcloud.errorNoUrl");
        statusSpan.style.color = "var(--color-error)";
        return;
      }

      testBtn.disabled = true;
      testBtn.textContent = t("settings.nextcloud.testing");
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
        testBtn.textContent = t("settings.nextcloud.testBtn");
      }
    });

    connectBtn?.addEventListener("click", async () => {
      const serverUrl = urlInput.value.trim();

      if (!serverUrl) {
        statusSpan.textContent = t("settings.nextcloud.errorNoUrl");
        statusSpan.style.color = "var(--color-error)";
        return;
      }

      connectBtn.disabled = true;
      connectBtn.textContent = t("settings.nextcloud.initializing");
      statusSpan.textContent = t("settings.nextcloud.startingFlow");
      statusSpan.style.color = "var(--color-text)";

      const loginUrlContainer = container.querySelector("#login-url-container");
      const loginUrlInput = container.querySelector("#login-url");
      const copyLoginUrlBtn = container.querySelector("#copy-login-url-btn");

      try {
        await startLoginFlow(serverUrl, (loginUrl) => {
          // Show the login URL field
          loginUrlContainer.style.display = "block";
          loginUrlInput.value = loginUrl;

          statusSpan.textContent = t("settings.nextcloud.waitingLogin");
          statusSpan.style.color = "var(--color-text)";

          // Add copy button handler
          copyLoginUrlBtn.onclick = async () => {
            try {
              loginUrlInput.select();
              await navigator.clipboard.writeText(loginUrl);
              copyLoginUrlBtn.textContent = t("settings.logging.copied");
              setTimeout(() => {
                copyLoginUrlBtn.textContent = t("settings.nextcloud.copyUrlBtn");
              }, 2000);
            } catch (_err) {
              // Fallback: select the text
              loginUrlInput.select();
              copyLoginUrlBtn.textContent = t("settings.nextcloud.selectedCopyHint");
              setTimeout(() => {
                copyLoginUrlBtn.textContent = t("settings.nextcloud.copyUrlBtn");
              }, 2000);
            }
          };
        });

        // Login successful — reset worker so it picks up the new credentials
        resetSyncWorker();
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
        connectBtn.textContent = t("settings.nextcloud.connectBtn");
      }
    });
  } else {
    const syncBtn = container.querySelector("#sync-now-btn");
    const disconnectBtn = container.querySelector("#disconnect-btn");
    const syncStatus = container.querySelector("#sync-status");

    syncBtn?.addEventListener("click", async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = t("footer.syncing");
      syncStatus.textContent = t("settings.nextcloud.syncing");
      syncStatus.style.color = "var(--color-text)";

      try {
        // Use centralized sync logic
        const result = await performSync({ silent: false });

        if (!result) {
          syncStatus.textContent = "Sync skipped (already in progress)";
          syncStatus.style.color = "var(--color-warning)";
          return;
        }

        const downloadedNotebooks = result.downloaded.notebooks.length;
        const downloadedNotes = result.downloaded.notes.length;
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
      } catch (error) {
        syncStatus.textContent = `✗ Sync failed: ${error.message}`;
        syncStatus.style.color = "var(--color-error)";
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = t("settings.nextcloud.syncNow");
      }
    });

    disconnectBtn?.addEventListener("click", async () => {
      if (confirm(t("settings.nextcloud.disconnectConfirm"))) {
        await clearCredentials();
        resetSyncWorker();

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
      t("settings.dangerZone.resetPasswordConfirmTitle"),
      t("settings.dangerZone.resetPasswordConfirmMsg"),
      t("settings.dangerZone.resetPasswordConfirmBtn"),
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
        t("settings.dangerZone.resetPasswordSuccessTitle"),
        t("settings.dangerZone.resetPasswordSuccessMsg"),
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
      t("settings.dangerZone.purgeConfirmTitle"),
      t("settings.dangerZone.purgeConfirmMsg"),
      t("settings.dangerZone.purgeConfirmBtn"),
      "btn-danger",
    );

    if (!confirmed) return;

    purgeLocalBtn.disabled = true;
    purgeLocalBtn.textContent = t("settings.dangerZone.purging");
    if (purgeStatus) {
      purgeStatus.textContent = t("settings.dangerZone.purgingStatus");
      purgeStatus.style.color = "var(--color-danger)";
    }

    try {
      await purgeLocalData();

      const isAuth = await isAuthenticated();
      if (purgeStatus) {
        purgeStatus.textContent = isAuth
          ? t("settings.dangerZone.purgeSuccessStatus")
          : t("settings.dangerZone.purgeSuccessStatusOffline");
        purgeStatus.style.color = "var(--color-success)";
      }

      // Refresh UI to show empty state
      window.dispatchEvent(new CustomEvent("notes-updated"));

      if (isAuth) {
        await showAlertDialog(
          t("settings.dangerZone.purgeSuccessTitle"),
          t("settings.dangerZone.purgeSuccessMsgConnected"),
        );
      } else {
        await showAlertDialog(
          t("settings.dangerZone.purgeSuccessTitle"),
          t("settings.dangerZone.purgeSuccessMsgOffline"),
        );
      }
    } catch (error) {
      if (purgeStatus) {
        purgeStatus.textContent = t("settings.dangerZone.purgeFailedStatus", {
          message: error.message,
        });
        purgeStatus.style.color = "var(--color-error)";
      }
      await showAlertDialog(
        t("settings.dangerZone.purgeFailedTitle"),
        t("settings.dangerZone.purgeFailedMsg", { message: error.message }),
      );
    } finally {
      purgeLocalBtn.disabled = false;
      purgeLocalBtn.textContent = t("settings.dangerZone.purgeLocalBtn");
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
