/**
 * Settings Mode Component
 * Renders the settings panel with theme selection and other preferences
 */

import { APP_NAME, APP_VERSION_WITH_BUILD, PROJECT_URL } from "../config.js";
import { changeLanguage, getCurrentLanguage, t } from "../i18n/index.js";
import { getCardSize, setCardSize } from "../modules/displayPrefs.js";
import { resetAllHelp } from "../modules/helpGuidance.js";
import { getSetting, purgeLocalData, setSetting } from "../modules/storage.js";
import {
  getPdfInvertDarkMode,
  getTheme,
  setPdfInvertDarkMode,
  setTheme,
} from "../modules/theme.js";
import { showLicensesDialog } from "./licensesDialog.js";
import { showAlertDialog, showConfirmDialog, showTextPrompt } from "./modals.js";

/**
 * The Nextcloud build shows only the settings that actually apply there.
 *
 * Omitted rather than shown-and-disabled, because Nextcloud already owns these
 * as platform preferences and a dead control would be worse than none:
 *  - Theme: theme.js follows NC's own light/dark via MutationObserver, so
 *    setTheme() would fight it.
 *  - UI language: i18n reads OC.getLocale(), so a picker would visibly switch
 *    the UI and then silently revert on the next load.
 *  - Nextcloud sync: the NC build talks WebDAV directly — it *is* the server,
 *    there is no connection to configure.
 *  - Recognition / MCP: Windows-only sidecar and Rust server.
 *  - Encryption / master password: appInit.js short-circuits in the NC build.
 *  - Purge local data: there is no local IndexedDB copy to purge.
 */
const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

/**
 * Escape a value for interpolation into a double-quoted HTML attribute.
 *
 * Deliberately not the textContent/innerHTML trick used elsewhere in the
 * codebase: that escapes `<` and `&` but leaves quotes intact, so a stored
 * value containing `"` would close the attribute and allow markup injection.
 * These values (endpoint, model) are user-supplied and round-trip through
 * settings, so they are escaped properly here.
 *
 * @param {string} value
 * @returns {string}
 */
/**
 * Escape a value for interpolation into element text content.
 *
 * Separate from escapeAttr(): inside a <textarea> the danger is a literal
 * "</textarea>" closing the element early, so only the markup-significant
 * characters need escaping — quotes are safe here and escaping them would show
 * entities to the user.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeHtmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Test the Windows sidecar by posting an empty stroke list.
 *
 * @param {string} localRecognitionUrl
 * @param {(text: string, color: string) => void} setStatus
 */
async function testSidecarRecognition(localRecognitionUrl, setStatus) {
  if (!localRecognitionUrl) {
    setStatus(t("settings.recognition.notConfiguredError"), "var(--color-error)");
    return;
  }

  setStatus(t("settings.recognition.connecting"), "var(--color-text)");

  try {
    const { fetch } = await import("@tauri-apps/plugin-http");
    const response = await fetch(`${localRecognitionUrl}/recognize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([]),
    });

    if (response.ok) {
      setStatus(
        t("settings.recognition.success", { source: t("settings.recognition.localSidecar") }),
        "var(--color-success)",
      );
    } else {
      setStatus(
        t("settings.recognition.errorStatus", { status: response.status }),
        "var(--color-error)",
      );
    }
  } catch (error) {
    console.error("Recognition test failed:", error);
    setStatus(
      t("settings.recognition.errorFailed", { message: error.message || String(error) }),
      "var(--color-error)",
    );
  }
}

/**
 * Test an AI backend by running a real recognition round-trip.
 *
 * Deliberately sends an actual rendered image rather than pinging the endpoint:
 * a model loaded without its vision projector answers a text request perfectly
 * while silently ignoring images, so a connectivity-only check would report
 * success for a configuration that cannot read handwriting at all.
 *
 * The word "test" is drawn as strokes, so a working setup transcribes something
 * and a vision-blind one returns nothing usable.
 *
 * @param {{endpoint: string, model: string, typedKey: string, imageEdge: number,
 *          setStatus: (text: string, color: string) => void}} params
 */
async function testAiRecognitionBackend({
  backend,
  endpoint,
  model,
  replicateVersion,
  typedKey,
  imageEdge,
  maxTokens,
  setStatus,
}) {
  const isReplicate = backend === "replicate";

  let normalized = "";

  if (isReplicate) {
    // Fixed API host: only the model (and a token) are required.
    if (!model) {
      setStatus(t("settings.recognition.missingModel"), "var(--color-error)");
      return;
    }
  } else {
    if (!endpoint || !model) {
      setStatus(t("settings.recognition.missingEndpoint"), "var(--color-error)");
      return;
    }

    const { normalizeEndpoint, validateEndpoint } = await import(
      "../modules/recognition/endpointValidation.js"
    );
    normalized = normalizeEndpoint(endpoint);
    const check = validateEndpoint(normalized);
    if (!check.valid) {
      const messages = {
        "not-a-url": t("settings.recognition.endpointInvalidUrl"),
        "insecure-remote": t("settings.recognition.endpointInsecure"),
        "unsupported-protocol": t("settings.recognition.endpointUnsupported"),
      };
      setStatus(
        messages[check.reason] || t("settings.recognition.endpointInvalidUrl"),
        "var(--color-error)",
      );
      return;
    }
  }

  setStatus(t("settings.recognition.testingModel"), "var(--color-text)");

  try {
    const { getApiKey } = await import("../modules/recognition/recognitionSettings.js");
    const { rasterizeNote } = await import("../modules/recognition/pageRasterizer.js");
    const { transcribeBand } = isReplicate
      ? await import("../modules/recognition/backends/replicateBackend.js")
      : await import("../modules/recognition/backends/openAiBackend.js");

    const bands = await rasterizeNote(buildTestStrokes(), { maxImageEdge: imageEdge });
    if (bands.length === 0) {
      setStatus(t("settings.recognition.aiNoVision"), "var(--color-warning)");
      return;
    }

    const words = await transcribeBand(bands[0], {
      backend,
      endpoint: normalized,
      model,
      replicateVersion,
      // Prefer a freshly typed key; fall back to the stored one so testing an
      // existing configuration does not require retyping the secret.
      apiKey: typedKey || (await getApiKey()),
      language: "en-US",
      maxTokens,
    });

    if (Array.isArray(words) && words.length > 0) {
      setStatus(t("settings.recognition.aiSuccess", { model }), "var(--color-success)");
    } else {
      setStatus(t("settings.recognition.aiNoVision"), "var(--color-warning)");
    }
  } catch (error) {
    console.error("AI recognition test failed:", error);
    setStatus(
      t("settings.recognition.errorFailed", { message: error.message || String(error) }),
      "var(--color-error)",
    );
  }
}

/**
 * Strokes spelling a short word, used as the connection test payload.
 * Coarse letterforms are enough: the test asks whether the model sees an image
 * and returns words at all, not whether it transcribes accurately.
 *
 * @returns {Array}
 */
function buildTestStrokes() {
  const stroke = (id, points) => ({
    id,
    x: points.map((p) => p[0]),
    y: points.map((p) => p[1]),
    pressure: points.map(() => 0.5),
    width: 3,
  });

  return [
    // t
    stroke("t1", [
      [20, 10],
      [20, 70],
    ]),
    stroke("t2", [
      [8, 30],
      [34, 30],
    ]),
    // e
    stroke("e1", [
      [50, 45],
      [78, 45],
      [78, 35],
      [58, 32],
      [48, 48],
      [52, 68],
      [76, 68],
    ]),
    // s
    stroke("s1", [
      [118, 36],
      [96, 32],
      [92, 46],
      [116, 54],
      [112, 70],
      [90, 66],
    ]),
    // t
    stroke("t3", [
      [140, 10],
      [140, 70],
    ]),
    stroke("t4", [
      [128, 30],
      [154, 30],
    ]),
  ];
}

/**
 * nextcloudSync.js is loaded on demand, never statically.
 *
 * It statically imports @tauri-apps/plugin-http and @tauri-apps/plugin-opener,
 * so a static import here would pull the Tauri runtime into the Nextcloud
 * browser bundle — which the storage.js → storage.webdav.js alias exists
 * precisely to avoid. The NC build never renders the sync section (see
 * IS_NEXTCLOUD above), so it must never load the module either.
 *
 * @returns {Promise<typeof import("../modules/nextcloudSync.js")>}
 */
function loadNextcloudSync() {
  return import("../modules/nextcloudSync.js");
}

/**
 * Render settings UI
 * @param {HTMLElement} container - Container element to render into
 */
export async function renderSettings(container) {
  const currentTheme = getTheme();

  // The NC build has no connection to configure, so it neither renders the
  // sync section nor loads the module that backs it.
  let authenticated = false;
  let credentials = null;
  if (!IS_NEXTCLOUD) {
    const { isAuthenticated, getStoredCredentials } = await loadNextcloudSync();
    authenticated = await isAuthenticated();
    credentials = await getStoredCredentials();
  }
  // Biometric authentication removed for performance
  const biometricCapability = { available: false };
  const biometricEnabled = false;

  const cardSize = getCardSize();
  const pdfInvertDarkMode = getPdfInvertDarkMode();

  // Get encryption settings
  const encryptLocalData = (await getSetting("encrypt_local_data")) ?? false; // Default: disabled
  const { isMasterPasswordSet } = await import("../modules/masterPassword.js");
  const masterPasswordSet = await isMasterPasswordSet();
  const recognitionLanguage = (await getSetting("recognition_language")) || "en-US";

  // Recognition backend configuration. Read here so the section can render the
  // stored values; the AI path is available on every platform, unlike the
  // Windows-only sidecar.
  const {
    getRecognitionConfig,
    isAiBackend: isAiBackendId,
    BACKEND_OPENAI,
    BACKEND_REPLICATE,
    BACKEND_SIDECAR,
  } = await import("../modules/recognition/recognitionSettings.js");
  const recognitionConfig = await getRecognitionConfig();
  const isAiBackend = isAiBackendId(recognitionConfig.backend);
  const isReplicate = recognitionConfig.backend === BACKEND_REPLICATE;
  const currentLanguage = getCurrentLanguage();

  // Handwriting recognition is only available on Windows, via a bundled sidecar
  const isWindows = /windows/i.test(navigator.userAgent);

  // Check if the local sidecar recognition service is running
  let localRecognitionUrl = "";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    localRecognitionUrl = await invoke("get_recognition_url");
  } catch (_e) {
    // Not in Tauri environment or command not available
  }
  const hasLocalRecognition = !!localRecognitionUrl;

  // MCP server status (Windows only — see documentation/mcp_design.md).
  // Dynamic import so the bridge module stays out of the Android bundle: this
  // whole file also runs on Android (only excluded from the NC build), and a
  // static import here would defeat the tree-shaking main.js relies on.
  let mcpEnabled = false;
  let mcpTokens = [];
  let mcpPort = null;
  let mcpAuditLogEnabled = true;
  let mcpAuditLogCount = 0;
  // True when the persisted "enabled" setting and Rust's actual live state
  // disagree — e.g. the startup config push to Rust failed (see
  // mcpBridge.js's syncMcpConfigToRust). Without this check the toggle below
  // would silently show "on" while the server is actually not listening,
  // with nothing telling the user why their AI client can't connect.
  let mcpStatusMismatch = false;
  // True when MCP is enabled but the server never bound its port at startup —
  // something else was already on it (see mcp.rs's McpState::listening). This
  // is deliberately separate from mcpStatusMismatch: that one is a failed
  // config push, which the Retry button can actually fix, whereas a taken port
  // needs the conflicting process closed and NoteBerg restarted. Offering
  // Retry here would be a button that cannot work.
  let mcpNotListening = false;
  if (isWindows) {
    const { isMcpEnabled, getMcpStatus, listMcpTokens } = await import("../modules/mcpBridge.js");
    mcpEnabled = await isMcpEnabled();
    mcpTokens = await listMcpTokens();
    try {
      const status = await getMcpStatus();
      mcpPort = status.port;
      mcpStatusMismatch = mcpEnabled && !status.enabled;
      mcpNotListening = mcpEnabled && !status.listening;
    } catch (_e) {
      // Bridge not initialized yet (e.g. rendered before app init completed).
    }

    const { isAuditLogEnabled, getAuditEntryCount } = await import("../modules/mcpAuditLog.js");
    mcpAuditLogEnabled = await isAuditLogEnabled();
    mcpAuditLogCount = await getAuditEntryCount();
  }

  const recognitionLangOptions = ["en-US", "de-DE", "fr-FR", "es-ES", "it-IT", "ja-JP", "zh-CN"];
  const uiLanguageOptions = [
    { code: "en", flag: "🇬🇧" },
    { code: "de", flag: "🇩🇪" },
    { code: "fr", flag: "🇫🇷" },
    { code: "es", flag: "🇪🇸" },
    { code: "it", flag: "🇮🇹" },
    { code: "zh", flag: "🇨🇳" },
    { code: "pt", flag: "🇵🇹" },
    { code: "ja", flag: "🇯🇵" },
    { code: "ko", flag: "🇰🇷" },
  ];

  container.innerHTML = `
    <div class="settings-panel">
      <div class="settings-header">
        <h2>${t("settings.title")}</h2>
      </div>

      <div class="settings-section">
        <h3>${t("settings.sections.appearance")}</h3>

        ${
          IS_NEXTCLOUD
            ? ""
            : `
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
        `
        }

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.appearance.pdfInvertDark")}</span>
            <span class="setting-description">${t("settings.appearance.pdfInvertDarkDesc")}</span>
          </div>
          <label class="toggle-switch">
            <input
              type="checkbox"
              id="pdf-invert-dark-toggle"
              ${pdfInvertDarkMode ? "checked" : ""}
            />
            <span class="toggle-slider"></span>
          </label>
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
        <h3>${t("settings.sections.help")}</h3>
        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.help.reset")}</span>
            <span class="setting-description">${t("settings.help.resetDesc")}</span>
          </div>
          <button id="reset-help-guidance-btn" class="btn-secondary">${t("settings.help.resetBtn")}</button>
        </div>
      </div>

      ${
        IS_NEXTCLOUD
          ? ""
          : `
      <div class="settings-section">
        <h3>${t("settings.sections.language")}</h3>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.language.label")}</span>
            <span class="setting-description">${t("settings.language.desc")}</span>
          </div>
          <select id="language-select" class="setting-control">
            ${uiLanguageOptions
              .map(
                ({ code, flag }) =>
                  `<option value="${code}" ${currentLanguage === code ? "selected" : ""}>${flag} ${t(`settings.language.${code}`)}</option>`,
              )
              .join("")}
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
        <div class="setting-item setting-item--full">
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

        <div class="setting-item setting-item--actions">
          <button id="test-connection-btn" class="btn-secondary">${t("settings.nextcloud.testBtn")}</button>
          <button id="connect-nextcloud-btn" class="btn-primary">${t("settings.nextcloud.connectBtn")}</button>
          <span id="connection-status" class="setting-note"></span>
        </div>

        <div class="setting-item setting-item--hidden" id="login-url-container">
          <label for="login-url" class="setting-label">
            <span class="setting-name">${t("settings.nextcloud.loginUrlLabel")}</span>
            <span class="setting-description">${t("settings.nextcloud.loginUrlDesc")}</span>
          </label>
          <div class="setting-item__actions">
            <input
              type="text"
              id="login-url"
              class="setting-control setting-control--selectable"
              readonly
            />
            <button id="copy-login-url-btn" class="btn-secondary">${t("settings.nextcloud.copyUrlBtn")}</button>
          </div>
        </div>
        `
            : `
        <div class="setting-item setting-item--full">
          <div class="setting-label">
            <span class="setting-name">${t("settings.nextcloud.connected")}</span>
            <span class="setting-description">${t("settings.nextcloud.connectedAs", { user: credentials?.loginName || "Unknown" })}</span>
          </div>
          <div class="setting-label">
            <span class="setting-description">${t("settings.nextcloud.server", { url: credentials?.serverUrl || "Unknown" })}</span>
          </div>
        </div>

        <div class="setting-item setting-item--actions">
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
          <label for="recognition-backend" class="setting-label">
            <span class="setting-name">${t("settings.recognition.backendLabel")}</span>
            <span class="setting-description">${t("settings.recognition.backendDesc")}</span>
          </label>
          <select id="recognition-backend" class="setting-control">
            ${
              isWindows
                ? `<option value="${BACKEND_SIDECAR}" ${!isAiBackend ? "selected" : ""}>
                     ${hasLocalRecognition ? t("settings.recognition.backendSidecar") : t("settings.recognition.backendSidecarUnavailable")}
                   </option>`
                : ""
            }
            <option value="${BACKEND_OPENAI}" ${recognitionConfig.backend === BACKEND_OPENAI ? "selected" : ""}>
              ${t("settings.recognition.backendAi")}
            </option>
            <option value="${BACKEND_REPLICATE}" ${isReplicate ? "selected" : ""}>
              ${t("settings.recognition.backendReplicate")}
            </option>
          </select>
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

        <div id="recognition-ai-fields" class="${isAiBackend ? "" : "setting-item--hidden"}">
          <div class="setting-item ${isReplicate ? "setting-item--hidden" : ""}" id="recognition-endpoint-row">
            <label for="recognition-endpoint" class="setting-label">
              <span class="setting-name">${t("settings.recognition.endpointLabel")}</span>
              <span class="setting-description">${t("settings.recognition.endpointDesc")}</span>
            </label>
            <input
              type="url"
              id="recognition-endpoint"
              class="setting-control"
              placeholder="${t("settings.recognition.endpointPlaceholder")}"
              value="${escapeAttr(recognitionConfig.endpoint)}"
            />
          </div>

          <div class="setting-item">
            <label for="recognition-model" class="setting-label">
              <span class="setting-name">${t("settings.recognition.modelLabel")}</span>
              <span class="setting-description">${t("settings.recognition.modelDesc")}</span>
            </label>
            <input
              type="text"
              id="recognition-model"
              class="setting-control"
              placeholder="${t("settings.recognition.modelPlaceholder")}"
              value="${escapeAttr(recognitionConfig.model)}"
            />
          </div>

          <div class="setting-item ${isReplicate ? "" : "setting-item--hidden"}" id="recognition-version-row">
            <label for="recognition-replicate-version" class="setting-label">
              <span class="setting-name">${t("settings.recognition.versionLabel")}</span>
              <span class="setting-description">${t("settings.recognition.versionDesc")}</span>
            </label>
            <input
              type="text"
              id="recognition-replicate-version"
              class="setting-control"
              placeholder="${t("settings.recognition.versionPlaceholder")}"
              value="${escapeAttr(recognitionConfig.replicateVersion)}"
            />
          </div>

          <div class="setting-item">
            <label for="recognition-api-key" class="setting-label">
              <span class="setting-name">${t("settings.recognition.apiKeyLabel")}</span>
              <span class="setting-description">
                ${recognitionConfig.apiKey ? t("settings.recognition.apiKeySet") : t("settings.recognition.apiKeyDesc")}
              </span>
            </label>
            <input
              type="password"
              id="recognition-api-key"
              class="setting-control"
              autocomplete="off"
              placeholder="${t("settings.recognition.apiKeyPlaceholder")}"
            />
          </div>

          <div class="setting-item">
            <label for="recognition-image-edge" class="setting-label">
              <span class="setting-name">${t("settings.recognition.imageEdgeLabel")}</span>
              <span class="setting-description">${t("settings.recognition.imageEdgeDesc")}</span>
            </label>
            <input
              type="number"
              id="recognition-image-edge"
              class="setting-control"
              min="512"
              max="4096"
              step="100"
              value="${Number(recognitionConfig.maxImageEdge) || 1600}"
            />
          </div>

          <div class="setting-item">
            <label for="recognition-max-tokens" class="setting-label">
              <span class="setting-name">${t("settings.recognition.maxTokensLabel")}</span>
              <span class="setting-description">${t("settings.recognition.maxTokensDesc")}</span>
            </label>
            <input
              type="number"
              id="recognition-max-tokens"
              class="setting-control"
              min="256"
              max="32000"
              step="500"
              value="${Number(recognitionConfig.maxTokens) || 8000}"
            />
          </div>

          <div class="setting-item setting-item--full">
            <label for="recognition-system-prompt" class="setting-label">
              <span class="setting-name">${t("settings.recognition.promptLabel")}</span>
              <span class="setting-description">${t("settings.recognition.promptDesc")}</span>
            </label>
            <textarea
              id="recognition-system-prompt"
              class="setting-control"
              rows="10"
              spellcheck="false"
              placeholder="${t("settings.recognition.promptPlaceholder")}"
            >${escapeHtmlText(recognitionConfig.systemPrompt)}</textarea>
            <div class="setting-item__actions">
              <button id="recognition-prompt-reset" class="btn-secondary">
                ${t("settings.recognition.promptReset")}
              </button>
              <span id="recognition-prompt-status" class="setting-note"></span>
            </div>
          </div>

          <div class="setting-item setting-item--full">
            <div class="setting-label">
              <span class="setting-description" id="recognition-privacy-hint"></span>
            </div>
          </div>
        </div>

        <div class="setting-item setting-item--actions">
          <button id="recognition-save-btn" class="btn-primary">${t("settings.recognition.saveBtn")}</button>
          <button id="test-recognition-btn" class="btn-secondary">${t("settings.recognition.testBtn")}</button>
          <span id="recognition-status" class="setting-note"></span>
        </div>
      </div>

      <div class="settings-section">
        <h3>${t("settings.sections.mcp")}</h3>

        ${
          isWindows
            ? `
        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.mcp.enableLabel")}</span>
            <span class="setting-description">${t("settings.mcp.enableDesc")}</span>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="mcp-enabled-toggle" ${mcpEnabled ? "checked" : ""}>
            <span class="toggle-slider"></span>
          </label>
        </div>

        ${
          mcpStatusMismatch
            ? `
        <div class="setting-item mcp-status-mismatch-warning">
          <div class="setting-label">
            <span class="setting-description">${t("settings.mcp.statusMismatchWarning")}</span>
          </div>
          <button id="mcp-retry-sync-btn" class="btn-secondary">${t("settings.mcp.retrySyncBtn")}</button>
        </div>
        `
            : ""
        }

        ${
          mcpNotListening
            ? `
        <div class="setting-item setting-item--full mcp-status-mismatch-warning">
          <div class="setting-label">
            <span class="setting-description">${t("settings.mcp.notListeningWarning", { port: mcpPort ?? "" })}</span>
          </div>
        </div>
        `
            : ""
        }

        <div class="setting-item setting-item--full">
          <div class="setting-label">
            <span class="setting-name">${t("settings.mcp.statusLabel")}</span>
            <span class="setting-description" id="mcp-status-info">
              ${
                mcpEnabled
                  ? // The "Listening on ..." suffix is only truthful when the
                    // server actually bound — suppressed otherwise, since the
                    // warning above already explains why it isn't.
                    `${mcpTokens.length > 0 ? t("settings.mcp.tokenConfigured") : t("settings.mcp.noToken")}${mcpPort && !mcpNotListening ? t("settings.mcp.portInfo", { port: mcpPort }) : ""}`
                  : t("settings.mcp.serverDisabled")
              }
            </span>
          </div>
        </div>

        <div class="setting-item setting-item--full mcp-token-list-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.mcp.tokensLabel")}</span>
            <span class="setting-description">${t("settings.mcp.tokensDesc")}</span>
          </div>
          <div class="mcp-token-list">
            ${
              mcpTokens.length === 0
                ? `<span class="setting-note">${t("settings.mcp.noTokensYet")}</span>`
                : mcpTokens
                    .map(
                      (token) => `
              <div class="mcp-token-row" data-token-id="${escapeHtml(token.id)}">
                <span class="mcp-token-row-name">${escapeHtml(token.name)}</span>
                <button class="btn-secondary btn-danger-filled mcp-revoke-token-btn" data-token-id="${escapeHtml(token.id)}">${t("settings.mcp.revokeTokenBtn")}</button>
              </div>`,
                    )
                    .join("")
            }
          </div>
          <button id="mcp-generate-token-btn" class="btn-secondary">${t("settings.mcp.generateTokenBtn")}</button>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.mcp.auditLogEnableLabel")}</span>
            <span class="setting-description">${t("settings.mcp.auditLogEnableDesc")}</span>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="mcp-audit-log-enabled-toggle" ${mcpAuditLogEnabled ? "checked" : ""}>
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.mcp.auditLogCountLabel")}</span>
            <span class="setting-description" id="mcp-audit-log-count">${t("settings.mcp.auditLogCountValue", { count: mcpAuditLogCount })}</span>
          </div>
          <div class="setting-item__actions">
            <button id="mcp-view-audit-log-btn" class="btn-secondary" ${mcpAuditLogCount === 0 ? "disabled" : ""}>${t("settings.mcp.viewAuditLogBtn")}</button>
            <button id="mcp-clear-audit-log-btn" class="btn-secondary btn-danger-filled" ${mcpAuditLogCount === 0 ? "disabled" : ""}>${t("settings.mcp.clearAuditLogBtn")}</button>
          </div>
        </div>
        `
            : `
        <div class="setting-item setting-item--full">
          <div class="setting-label">
            <span class="setting-description">${t("settings.mcp.windowsOnly")}</span>
          </div>
        </div>
        `
        }
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

        ${
          masterPasswordSet
            ? `<div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.dangerZone.resetPassword")}</span>
            <span class="setting-description">${t("settings.dangerZone.resetPasswordDesc")}</span>
          </div>
          <button id="reset-master-password-btn" class="btn-secondary btn-warning">${t("settings.dangerZone.resetPasswordBtn")}</button>
        </div>`
            : ""
        }

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.dangerZone.purgeLocal")}</span>
            <span class="setting-description">${t("settings.dangerZone.purgeLocalDesc")}</span>
          </div>
          <div class="setting-item__actions">
            <button id="purge-local-btn" class="btn-secondary btn-danger-filled">${t("settings.dangerZone.purgeLocalBtn")}</button>
            <span id="purge-status" class="setting-note"></span>
          </div>
        </div>

        <div class="setting-item setting-item--full">
          <div class="danger-zone-desc">
            ${authenticated ? t("settings.dangerZone.warningConnected") : t("settings.dangerZone.warningDisconnected")}
          </div>
        </div>
      </div>
      `
      }

      <div class="settings-section">
        <h3>${t("settings.sections.about")}</h3>

        <div class="setting-item setting-item--full">
          <div class="about-info">
            <p><strong>${APP_NAME}</strong></p>
            <p>${t("settings.about.version", { version: APP_VERSION_WITH_BUILD })}</p>
            <p>${t("settings.about.description")}</p>
            <p>
              ${t("settings.about.openSource")}
              <a
                href="${PROJECT_URL}"
                class="about-link"
                target="_blank"
                rel="noopener noreferrer"
              >${t("settings.about.projectLink")}</a>
            </p>
          </div>
        </div>

        <div class="setting-item setting-item--actions">
          <button id="show-licenses-btn" class="btn-secondary">${t("settings.about.licenses")}</button>
        </div>
      </div>
    </div>
  `;

  // Open the project link through the Tauri opener on native builds: in the
  // Android webview target="_blank" does nothing (same reason licensesDialog.js
  // routes its links this way). In the NC build the anchor is a plain browser
  // link and needs no interception.
  const projectLink = container.querySelector(".about-link");
  if (projectLink && !IS_NEXTCLOUD) {
    projectLink.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(projectLink.href);
      } catch (error) {
        console.error("Failed to open project URL:", error);
      }
    });
  }

  // Language selector
  const languageSelect = container.querySelector("#language-select");
  languageSelect?.addEventListener("change", async () => {
    await changeLanguage(languageSelect.value);
  });

  // Card size selector
  const cardSizeSelect = container.querySelector("#card-size-select");
  cardSizeSelect?.addEventListener("change", () => {
    setCardSize(cardSizeSelect.value);
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

  const pdfInvertDarkToggle = container.querySelector("#pdf-invert-dark-toggle");
  pdfInvertDarkToggle?.addEventListener("change", () => {
    // Dispatches themechange itself, so any open note re-renders its PDF
    // pages with the new inversion setting, same as an actual theme switch would.
    setPdfInvertDarkMode(pdfInvertDarkToggle.checked);
  });

  // Encryption toggles event listeners
  const encryptLocalToggle = container.querySelector("#encrypt-local-toggle");

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

  // Biometric authentication removed for performance - event listeners removed

  // Recognition settings listeners
  const recognitionBackendSelect = container.querySelector("#recognition-backend");
  const recognitionLanguageSelect = container.querySelector("#recognition-language");
  const recognitionAiFields = container.querySelector("#recognition-ai-fields");
  const recognitionEndpointInput = container.querySelector("#recognition-endpoint");
  const recognitionEndpointRow = container.querySelector("#recognition-endpoint-row");
  const recognitionVersionRow = container.querySelector("#recognition-version-row");
  const recognitionVersionInput = container.querySelector("#recognition-replicate-version");
  const recognitionModelInput = container.querySelector("#recognition-model");
  const recognitionApiKeyInput = container.querySelector("#recognition-api-key");
  const recognitionImageEdgeInput = container.querySelector("#recognition-image-edge");
  const recognitionMaxTokensInput = container.querySelector("#recognition-max-tokens");
  const recognitionPromptInput = container.querySelector("#recognition-system-prompt");
  const recognitionPromptReset = container.querySelector("#recognition-prompt-reset");
  const recognitionPromptStatus = container.querySelector("#recognition-prompt-status");
  const recognitionPrivacyHint = container.querySelector("#recognition-privacy-hint");
  const recognitionSaveBtn = container.querySelector("#recognition-save-btn");
  const testRecognitionBtn = container.querySelector("#test-recognition-btn");
  const recognitionStatus = container.querySelector("#recognition-status");

  const setRecognitionStatus = (text, color) => {
    if (!recognitionStatus) return;
    recognitionStatus.textContent = text;
    recognitionStatus.style.color = color;
  };

  /**
   * Say plainly where handwriting will be sent.
   *
   * Privacy is a product commitment, so the destination is stated whenever an
   * AI backend is selected — not only at first setup — and it distinguishes a
   * loopback endpoint (nothing leaves the device) from a remote one.
   */
  const updatePrivacyHint = () => {
    if (!recognitionPrivacyHint) return;
    if (recognitionBackendSelect?.value === "replicate") {
      // Always a remote third-party service; there is no local variant to detect.
      recognitionPrivacyHint.textContent =
        `${t("settings.recognition.aiHint")} ${t("settings.recognition.aiHintRemote")}`.trim();
      return;
    }
    const raw = recognitionEndpointInput?.value.trim() || "";
    let scope = "";
    try {
      const host = new URL(raw).hostname;
      scope =
        host === "localhost" || host === "127.0.0.1" || host === "[::1]"
          ? t("settings.recognition.aiHintLocal")
          : t("settings.recognition.aiHintRemote");
    } catch (_e) {
      scope = "";
    }
    recognitionPrivacyHint.textContent = `${t("settings.recognition.aiHint")} ${scope}`.trim();
  };

  const selectedBackend = () => recognitionBackendSelect?.value || "";
  const isAiSelected = () => selectedBackend() === "openai" || selectedBackend() === "replicate";
  const isReplicateSelected = () => selectedBackend() === "replicate";

  const syncAiFieldVisibility = () => {
    recognitionAiFields?.classList.toggle("setting-item--hidden", !isAiSelected());
    // Replicate has a fixed API host and is addressed by model + version, so an
    // endpoint URL would be meaningless there.
    recognitionEndpointRow?.classList.toggle("setting-item--hidden", isReplicateSelected());
    recognitionVersionRow?.classList.toggle("setting-item--hidden", !isReplicateSelected());
    updatePrivacyHint();
  };

  syncAiFieldVisibility();

  recognitionBackendSelect?.addEventListener("change", async () => {
    const { setRecognitionConfig } = await import("../modules/recognition/recognitionSettings.js");
    await setRecognitionConfig({ backend: recognitionBackendSelect.value });
    const { invalidateRecognitionUrl } = await import("../modules/autoRecognition.js");
    invalidateRecognitionUrl();
    syncAiFieldVisibility();
    setRecognitionStatus("", "var(--color-text)");
  });

  recognitionEndpointInput?.addEventListener("input", updatePrivacyHint);

  /**
   * Warn when a custom prompt has dropped something the parser depends on.
   * Advisory only — an unusual phrasing that still works must not be blocked.
   */
  const validatePrompt = async () => {
    if (!recognitionPromptStatus) return;
    const value = recognitionPromptInput?.value ?? "";
    if (!value.trim()) {
      recognitionPromptStatus.textContent = t("settings.recognition.promptUsingDefault");
      recognitionPromptStatus.style.color = "var(--color-text-secondary)";
      return;
    }
    const { checkPrompt } = await import("../modules/recognition/prompts.js");
    // Validate against the mode actually selected: a region prompt legitimately
    // has no "box" instruction, and vice versa.
    const warnings = checkPrompt(value, {});
    if (warnings.length === 0) {
      recognitionPromptStatus.textContent = "";
      return;
    }
    recognitionPromptStatus.textContent = t("settings.recognition.promptWarning", {
      items: warnings.map((w) => t(`settings.recognition.promptWarn.${w}`)).join(", "),
    });
    recognitionPromptStatus.style.color = "var(--color-warning)";
  };

  recognitionPromptInput?.addEventListener("input", validatePrompt);
  // Prompt validity depends on the active mode, so re-check when it changes.
  validatePrompt();

  recognitionPromptReset?.addEventListener("click", async () => {
    // Load the built-in default into the box so it can be edited rather than
    // written from scratch — the default encodes several hard-won rules.
    const { SYSTEM_PROMPT } = await import("../modules/recognition/prompts.js");
    if (recognitionPromptInput) {
      recognitionPromptInput.value = SYSTEM_PROMPT;
      validatePrompt();
    }
  });

  recognitionLanguageSelect?.addEventListener("change", async () => {
    await setSetting("recognition_language", recognitionLanguageSelect.value);
  });

  recognitionSaveBtn?.addEventListener("click", async () => {
    const { setRecognitionConfig } = await import("../modules/recognition/recognitionSettings.js");
    const { normalizeEndpoint, validateEndpoint } = await import(
      "../modules/recognition/endpointValidation.js"
    );

    const patch = { backend: recognitionBackendSelect?.value };

    if (isReplicateSelected()) {
      // Replicate has a fixed API host, so there is no endpoint to validate; it
      // is addressed by model name plus an optional version hash.
      patch.model = recognitionModelInput?.value.trim() || "";
      patch.replicateVersion = recognitionVersionInput?.value.trim() || "";
      patch.maxImageEdge = Number(recognitionImageEdgeInput?.value) || 1600;
      patch.maxTokens = Number(recognitionMaxTokensInput?.value) || 8000;
      // Empty means "use the built-in default", so a user who never edits it
      // keeps receiving improvements to the default.
      patch.systemPrompt = recognitionPromptInput?.value.trim() || "";

      const typedKey = recognitionApiKeyInput?.value || "";
      if (typedKey) patch.apiKey = typedKey;

      if (!patch.model) {
        setRecognitionStatus(t("settings.recognition.missingModel"), "var(--color-error)");
        return;
      }
    } else if (isAiSelected()) {
      // Accept the server root, the /v1 base, or a full route — see
      // normalizeEndpoint(). Storing the raw value made a missing /v1 fail as
      // "unparseable content" instead of as a wrong URL.
      const endpoint = normalizeEndpoint(recognitionEndpointInput?.value.trim() || "");
      const check = validateEndpoint(endpoint);
      if (!check.valid) {
        // Reject at save time rather than at request time: an endpoint that
        // would send ink in clear text to a remote host must never be stored.
        const messages = {
          "not-a-url": t("settings.recognition.endpointInvalidUrl"),
          "insecure-remote": t("settings.recognition.endpointInsecure"),
          "unsupported-protocol": t("settings.recognition.endpointUnsupported"),
        };
        setRecognitionStatus(
          messages[check.reason] || t("settings.recognition.endpointInvalidUrl"),
          "var(--color-error)",
        );
        return;
      }

      patch.endpoint = endpoint;
      patch.model = recognitionModelInput?.value.trim() || "";
      patch.maxImageEdge = Number(recognitionImageEdgeInput?.value) || 1600;
      patch.maxTokens = Number(recognitionMaxTokensInput?.value) || 8000;
      // Empty means "use the built-in default", so a user who never edits it
      // keeps receiving improvements to the default.
      patch.systemPrompt = recognitionPromptInput?.value.trim() || "";

      // An empty field means "keep the stored key", not "clear it" — the input
      // is never populated with the existing secret, so treating blank as a
      // deletion would silently drop a working key on any unrelated save.
      const typedKey = recognitionApiKeyInput?.value || "";
      if (typedKey) patch.apiKey = typedKey;
    }

    await setRecognitionConfig(patch);
    if (patch.endpoint && recognitionEndpointInput) {
      // Show what was actually stored, so a normalized URL is not a surprise.
      recognitionEndpointInput.value = patch.endpoint;
      updatePrivacyHint();
    }
    const { invalidateRecognitionUrl } = await import("../modules/autoRecognition.js");
    invalidateRecognitionUrl();
    setRecognitionStatus(t("settings.recognition.saved"), "var(--color-success)");
  });

  testRecognitionBtn?.addEventListener("click", async () => {
    testRecognitionBtn.disabled = true;
    const originalLabel = testRecognitionBtn.textContent;
    testRecognitionBtn.textContent = t("settings.recognition.testing");

    try {
      if (isAiSelected()) {
        await testAiRecognitionBackend({
          backend: selectedBackend(),
          endpoint: recognitionEndpointInput?.value.trim() || "",
          model: recognitionModelInput?.value.trim() || "",
          replicateVersion: recognitionVersionInput?.value.trim() || "",
          typedKey: recognitionApiKeyInput?.value || "",
          imageEdge: Number(recognitionImageEdgeInput?.value) || 1600,
          maxTokens: Number(recognitionMaxTokensInput?.value) || 8000,
          setStatus: setRecognitionStatus,
        });
      } else {
        await testSidecarRecognition(localRecognitionUrl, setRecognitionStatus);
      }
    } finally {
      testRecognitionBtn.disabled = false;
      testRecognitionBtn.textContent = originalLabel;
    }
  });

  // MCP server settings listeners (Windows only)
  const mcpEnabledToggle = container.querySelector("#mcp-enabled-toggle");
  const mcpGenerateTokenBtn = container.querySelector("#mcp-generate-token-btn");
  const mcpRetrySyncBtn = container.querySelector("#mcp-retry-sync-btn");

  mcpEnabledToggle?.addEventListener("change", async () => {
    const { setMcpEnabled } = await import("../modules/mcpBridge.js");
    await setMcpEnabled(mcpEnabledToggle.checked);
    // Re-render so the status line reflects the new state immediately —
    // it previously kept showing "Access token configured. Listening on
    // ..." even after disabling, since that text only depended on token
    // presence, never on the enabled flag itself.
    await renderSettings(container);
  });

  // Re-push the persisted enabled/token state to Rust — recovers from the
  // startup sync having failed (see mcpBridge.js's syncMcpConfigToRust),
  // without requiring a full app restart.
  mcpRetrySyncBtn?.addEventListener("click", async () => {
    const { setMcpEnabled, isMcpEnabled } = await import("../modules/mcpBridge.js");
    await setMcpEnabled(await isMcpEnabled());
    await renderSettings(container);
  });

  mcpGenerateTokenBtn?.addEventListener("click", async () => {
    const name = await showTextPrompt(
      t("settings.mcp.tokenNamePromptTitle"),
      t("settings.mcp.tokenNamePromptMsg"),
      t("settings.mcp.tokenNamePromptPlaceholder"),
    );
    if (name === null) return; // cancelled

    const { generateAndStoreMcpToken } = await import("../modules/mcpBridge.js");
    const token = await generateAndStoreMcpToken(name.trim() || t("settings.mcp.unnamedToken"));

    // Copy proactively, before the dialog is shown/dismissed — showAlertDialog
    // only resolves once the user clicks OK, so copying afterward would mean
    // "copied" only after the token is no longer visible.
    let copied = true;
    try {
      await navigator.clipboard.writeText(token);
    } catch (_e) {
      copied = false;
    }

    // Show the token once — it is not retrievable again after this dialog closes.
    // Built as a DOM fragment (not string interpolation), then passed as HTML
    // (consistent with showAlertDialog's existing message contract) — safe
    // here because the only dynamic content is the freshly generated token
    // itself, never user input.
    const messageEl = document.createElement("div");
    const warning = document.createElement("p");
    warning.textContent = copied
      ? t("settings.mcp.tokenShownOnceWarningCopied")
      : t("settings.mcp.tokenShownOnceWarning");
    const displayRow = document.createElement("div");
    displayRow.className = "mcp-token-display-row";
    const tokenBox = document.createElement("code");
    tokenBox.className = "mcp-token-display";
    tokenBox.textContent = token;
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn-secondary mcp-token-copy-btn";
    copyBtn.textContent = t("settings.mcp.copyTokenBtn");
    displayRow.appendChild(tokenBox);
    displayRow.appendChild(copyBtn);
    messageEl.appendChild(warning);
    messageEl.appendChild(displayRow);

    const alertPromise = showAlertDialog(
      t("settings.mcp.tokenGeneratedTitle"),
      messageEl.outerHTML,
    );

    // showAlertDialog inserts its HTML synchronously before the dialog is
    // dismissed (it only resolves on close), so the button is already a real
    // DOM node in #modal-overlay by the time this listener attaches.
    document
      .getElementById("modal-overlay")
      ?.querySelector(".mcp-token-copy-btn")
      ?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        try {
          await navigator.clipboard.writeText(token);
          btn.textContent = t("settings.logging.copied");
          setTimeout(() => {
            btn.textContent = t("settings.mcp.copyTokenBtn");
          }, 2000);
        } catch (error) {
          console.error("Failed to copy MCP token:", error);
        }
      });

    await alertPromise;

    // Structural change (new row in the token list) — re-render.
    await renderSettings(container);
  });

  container.querySelectorAll(".mcp-revoke-token-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const confirmed = await showConfirmDialog(
        t("settings.mcp.revokeConfirmTitle"),
        t("settings.mcp.revokeConfirmMsg"),
        t("settings.mcp.revokeConfirmBtn"),
      );
      if (!confirmed) return;

      const { revokeMcpToken } = await import("../modules/mcpBridge.js");
      await revokeMcpToken(btn.dataset.tokenId);
      await renderSettings(container);
    });
  });

  const mcpAuditLogEnabledToggle = container.querySelector("#mcp-audit-log-enabled-toggle");
  const mcpViewAuditLogBtn = container.querySelector("#mcp-view-audit-log-btn");
  const mcpClearAuditLogBtn = container.querySelector("#mcp-clear-audit-log-btn");

  mcpAuditLogEnabledToggle?.addEventListener("change", async () => {
    const { setAuditLogEnabled } = await import("../modules/mcpAuditLog.js");
    await setAuditLogEnabled(mcpAuditLogEnabledToggle.checked);
  });

  mcpViewAuditLogBtn?.addEventListener("click", () => openMcpAuditLogModal());

  mcpClearAuditLogBtn?.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog(
      t("settings.mcp.clearAuditLogConfirmTitle"),
      t("settings.mcp.clearAuditLogConfirmMsg"),
      t("settings.mcp.clearAuditLogConfirmBtn"),
    );
    if (!confirmed) return;

    const { clearAuditLog } = await import("../modules/mcpAuditLog.js");
    await clearAuditLog();
    document.getElementById("mcp-audit-log-modal")?.remove();
    await renderSettings(container);
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

    // Create a custom modal with copy and clear buttons. The log text itself is
    // set via .value below (not interpolated into this HTML string) since
    // log entries can contain arbitrary/untrusted text.
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
            ></textarea>
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
    logsContent.value = logsText;

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
        const { testConnection } = await loadNextcloudSync();
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
        const { startLoginFlow } = await loadNextcloudSync();
        await startLoginFlow(serverUrl, (loginUrl) => {
          // Show the login URL field. Toggled by class, not style.display:
          // the row is a `display: contents` grid participant, so setting an
          // inline display would collapse it back into a stacked box.
          loginUrlContainer.classList.remove("setting-item--hidden");
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

        // Login successful
        loginUrlContainer.classList.add("setting-item--hidden");
        statusSpan.textContent = "✓ Connected successfully!";
        statusSpan.style.color = "var(--color-success)";

        // Notify footer about auth change
        window.dispatchEvent(new CustomEvent("nextcloud-auth-changed"));

        // Reload settings to show authenticated state
        setTimeout(() => renderSettings(container), 1000);
      } catch (error) {
        console.error("Login flow error caught in settings:", error);
        const errorMessage = error?.message || error?.toString() || "Unknown error occurred";
        loginUrlContainer.classList.add("setting-item--hidden");
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
        // Use centralized sync logic. Loaded on demand: sync.js statically
        // imports nextcloudSync.js, so a static import would defeat the
        // lazy-loading above (see loadNextcloudSync).
        const { performSync } = await import("../modules/sync.js");
        const result = await performSync({ silent: false });

        if (!result) {
          syncStatus.textContent = t("settings.nextcloud.syncSkipped");
          syncStatus.style.color = "var(--color-warning)";
          return;
        }

        const downloadedNotebooks = result.downloaded.notebooks.length;
        const downloadedNotes = result.downloaded.notes.length;
        const conflictCount =
          (result.conflicts?.notebooks?.length || 0) + (result.conflicts?.notes?.length || 0);

        let statusMsg = t("settings.nextcloud.syncComplete", {
          uploadedNotebooks: result.uploaded.notebooks.uploaded,
          uploadedNotes: result.uploaded.notes.uploaded,
          downloadedNotebooks,
          downloadedNotes,
        });

        if (conflictCount > 0) {
          statusMsg += t("settings.nextcloud.syncConflictsDetected", { count: conflictCount });
          syncStatus.style.color = "var(--color-warning)";
        } else {
          syncStatus.style.color = "var(--color-success)";
        }

        syncStatus.textContent = statusMsg;
      } catch (error) {
        syncStatus.textContent = t("settings.nextcloud.syncFailed", { message: error.message });
        syncStatus.style.color = "var(--color-error)";
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = t("settings.nextcloud.syncNow");
      }
    });

    disconnectBtn?.addEventListener("click", async () => {
      if (confirm(t("settings.nextcloud.disconnectConfirm"))) {
        const { clearCredentials } = await loadNextcloudSync();
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

  // Reset help guidance listener
  const resetHelpBtn = container.querySelector("#reset-help-guidance-btn");
  resetHelpBtn?.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog(
      t("settings.help.resetConfirmTitle"),
      t("settings.help.resetConfirmMsg"),
      t("settings.help.resetBtn"),
      "btn-secondary",
    );
    if (!confirmed) return;
    resetAllHelp();
    await renderSettings(container);
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

      // MCP call history lives in its own dedicated database (NoteBergMcpLog,
      // see mcpAuditLog.js), separate from storage.js's — purgeLocalData()
      // has no reason to know about it (containment rule: MCP-owned data
      // stays in MCP-owned files). But it can still contain sensitive
      // content (note ids, search query text) from before this purge, so a
      // "wipe all local data" action needs to clear it too, not leave it
      // behind as the one thing purge doesn't actually purge.
      if (isWindows) {
        const { clearAuditLog } = await import("../modules/mcpAuditLog.js");
        await clearAuditLog();
      }

      const { isAuthenticated: isAuthNow } = await loadNextcloudSync();
      const isAuth = await isAuthNow();
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

/** Minimal HTML-escaping for interpolating audit log field values (tool names,
 * arguments, error messages) that may contain arbitrary/untrusted text. */
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

const MCP_AUDIT_LOG_PAGE_SIZE = 50;

/**
 * Show the MCP access log as a paginated table — a dedicated modal, not a
 * reuse of the debug-logs textarea modal, since that dumps its entire
 * (max 1000-entry) free-text log into one <textarea>, which doesn't scale to
 * this log's structured, up-to-15,000-entry content (see
 * documentation/roadmap/mcp/PLAN.md Phase 5 for why the two logs are kept
 * separate in the first place).
 */
async function openMcpAuditLogModal() {
  const { getRecentAuditEntries, getAuditEntryCount } = await import("../modules/mcpAuditLog.js");

  let offset = 0;
  const totalCount = await getAuditEntryCount();

  const modalHtml = `
    <div id="mcp-audit-log-modal" class="modal-overlay">
      <div class="modal-dialog modal--wide">
        <div class="modal-header">
          <h3 class="modal-title">${t("settings.mcp.auditLogModalTitle")}</h3>
          <button class="modal-close" aria-label="${t("modals.close")}">&times;</button>
        </div>
        <div class="modal-body">
          <div class="logs-table-wrapper">
            <table class="mcp-audit-log-table">
              <thead>
                <tr>
                  <th>${t("settings.mcp.auditLogColTime")}</th>
                  <th>${t("settings.mcp.auditLogColToken")}</th>
                  <th>${t("settings.mcp.auditLogColTool")}</th>
                  <th>${t("settings.mcp.auditLogColArgs")}</th>
                  <th>${t("settings.mcp.auditLogColOutcome")}</th>
                  <th>${t("settings.mcp.auditLogColDuration")}</th>
                </tr>
              </thead>
              <tbody id="mcp-audit-log-rows"></tbody>
            </table>
          </div>
        </div>
        <div class="modal-footer modal-footer--gap">
          <button class="btn-secondary" id="mcp-audit-log-prev-btn">${t("settings.mcp.auditLogPrevPage")}</button>
          <span id="mcp-audit-log-page-info" class="setting-note"></span>
          <button class="btn-secondary" id="mcp-audit-log-next-btn">${t("settings.mcp.auditLogNextPage")}</button>
          <button class="btn-secondary" id="mcp-audit-log-copy-page-btn">${t("settings.logging.copyLogs")}</button>
          <button class="btn-primary modal-close-btn">${t("modals.noteProperties.closeBtn")}</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);

  const modal = document.getElementById("mcp-audit-log-modal");
  const rowsBody = modal.querySelector("#mcp-audit-log-rows");
  const pageInfo = modal.querySelector("#mcp-audit-log-page-info");
  const prevBtn = modal.querySelector("#mcp-audit-log-prev-btn");
  const nextBtn = modal.querySelector("#mcp-audit-log-next-btn");
  const copyPageBtn = modal.querySelector("#mcp-audit-log-copy-page-btn");

  let currentPageEntries = [];

  async function renderPage() {
    const entries = await getRecentAuditEntries(MCP_AUDIT_LOG_PAGE_SIZE, offset);
    currentPageEntries = entries;

    rowsBody.innerHTML = entries
      .map((entry) => {
        const time = new Date(entry.timestamp).toLocaleString();
        const args = escapeHtml(JSON.stringify(entry.arguments ?? {}));
        const outcome = entry.ok
          ? `<span class="mcp-audit-log-outcome mcp-audit-log-outcome--ok">${t("settings.mcp.auditLogOutcomeOk")}</span>`
          : `<span class="mcp-audit-log-outcome mcp-audit-log-outcome--error" title="${escapeHtml(entry.errorMessage)}">${t("settings.mcp.auditLogOutcomeError")}</span>`;
        return `
          <tr>
            <td>${escapeHtml(time)}</td>
            <td>${escapeHtml(entry.tokenName ?? t("settings.mcp.auditLogTokenUnknown"))}</td>
            <td>${escapeHtml(entry.tool)}</td>
            <td class="mcp-audit-log-args">${args}</td>
            <td>${outcome}</td>
            <td>${escapeHtml(String(entry.durationMs))} ms</td>
          </tr>`;
      })
      .join("");

    const pageStart = totalCount === 0 ? 0 : offset + 1;
    const pageEnd = Math.min(offset + MCP_AUDIT_LOG_PAGE_SIZE, totalCount);
    pageInfo.textContent = t("settings.mcp.auditLogPageInfo", {
      start: pageStart,
      end: pageEnd,
      total: totalCount,
    });
    prevBtn.disabled = offset === 0;
    nextBtn.disabled = offset + MCP_AUDIT_LOG_PAGE_SIZE >= totalCount;
  }

  await renderPage();

  prevBtn.addEventListener("click", async () => {
    offset = Math.max(0, offset - MCP_AUDIT_LOG_PAGE_SIZE);
    await renderPage();
  });

  nextBtn.addEventListener("click", async () => {
    offset += MCP_AUDIT_LOG_PAGE_SIZE;
    await renderPage();
  });

  copyPageBtn.addEventListener("click", async () => {
    const text = currentPageEntries
      .map(
        (e) =>
          `[${new Date(e.timestamp).toISOString()}] (${e.tokenName ?? t("settings.mcp.auditLogTokenUnknown")}) ${e.tool} ${JSON.stringify(e.arguments ?? {})} -> ${e.ok ? "ok" : `error: ${e.errorMessage}`} (${e.durationMs}ms)`,
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      copyPageBtn.textContent = t("settings.logging.copied");
      setTimeout(() => {
        copyPageBtn.textContent = t("settings.logging.copyLogs");
      }, 2000);
    } catch (error) {
      console.error("Failed to copy audit log page:", error);
    }
  });

  const closeModal = () => {
    modal.classList.add("modal-closing");
    setTimeout(() => modal.remove(), 200);
  };

  modal.querySelector(".modal-close").addEventListener("click", closeModal);
  modal.querySelector(".modal-close-btn").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener("keydown", function handleEsc(e) {
    if (e.key === "Escape") {
      closeModal();
      document.removeEventListener("keydown", handleEsc);
    }
  });
}
