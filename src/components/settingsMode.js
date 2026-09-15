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
import { getIcon } from "../utils/icons.js";
import { showLicensesDialog } from "./licensesDialog.js";
import { createLoadingIndicator } from "./loadingIndicator.js";
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
 * Placeholder shown in the API key field when a key is stored.
 *
 * The stored secret is never rendered back — on Nextcloud it is not even
 * knowable to the browser — so this stands in for it purely to say "a key is
 * set". A fixed length, deliberately: sizing it to the real key would leak the
 * key's length, and it is not the key in any case.
 *
 * Nothing may ever save this value. typedApiKey() is what guarantees that: the
 * mask is assigned without a trusted input event, so it can never be read back
 * as a user-entered key.
 */
const STORED_KEY_MASK = "•".repeat(36);

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
    setStatus(t("settings.recognition.notConfiguredError"), "var(--nb-status-error)");
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
        "var(--nb-status-success)",
      );
    } else {
      setStatus(
        t("settings.recognition.errorStatus", { status: response.status }),
        "var(--nb-status-error)",
      );
    }
  } catch (error) {
    console.error("Recognition test failed:", error);
    setStatus(
      t("settings.recognition.errorFailed", { message: error.message || String(error) }),
      "var(--nb-status-error)",
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
 * @param {{provider: string, endpoint: string, model: string, typedKey: string,
 *          imageEdge: number, maxTokens: number, timeoutSeconds: number,
 *          language: string,
 *          setStatus: (text: string, color: string) => void}} params
 */
async function testAiRecognitionBackend({
  provider,
  endpoint,
  model,
  replicateVersion,
  typedKey,
  imageEdge,
  maxTokens,
  timeoutSeconds,
  language,
  setStatus,
}) {
  const isReplicate = provider === "replicate";

  let normalized = "";

  if (isReplicate) {
    // Fixed API host: only the model (and a token) are required.
    if (!model) {
      setStatus(t("settings.recognition.missingModel"), "var(--nb-status-error)");
      return;
    }
  } else {
    if (!endpoint || !model) {
      setStatus(t("settings.recognition.missingEndpoint"), "var(--nb-status-error)");
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
        "var(--nb-status-error)",
      );
      return;
    }
  }

  // The test sends a real rendered image, so it needs the same consent as a
  // recognition run — testing must not be a way to bypass the dialog.
  const { destinationHost, grantConsent, hasConsent } = await import(
    "../modules/recognition/consent.js"
  );
  // `provider`, not `backend`: consent.js keys destinationHost() on the provider
  // since the config split, and the parameter was renamed with it. The stale
  // name here was a ReferenceError that the click handler swallowed, so the
  // button did nothing at all — no test, no error, no status.
  const pending = { provider, endpoint: normalized };
  const host = destinationHost(pending);
  if (host && !(await hasConsent(pending))) {
    const agreed = await showConfirmDialog(
      t("settings.aiProvider.consentTitle", { host }),
      t("settings.aiProvider.consentBody", { host }),
      t("settings.aiProvider.consentConfirm"),
      "btn-primary",
    );
    if (!agreed) {
      setStatus(t("settings.aiProvider.consentDeclined", { host }), "var(--nb-status-warning)");
      return;
    }
    await grantConsent(pending);
  }

  setStatus(t("settings.recognition.testingModel"), "var(--color-text)");

  try {
    const { getApiKey } = await import("../modules/recognition/aiProvider.js");
    const { rasterizeNote } = await import("../modules/recognition/pageRasterizer.js");
    const { transcribeBand } = isReplicate
      ? await import("../modules/recognition/backends/replicateBackend.js")
      : await import("../modules/recognition/backends/openAiBackend.js");

    const bands = await rasterizeNote(buildTestStrokes(), { maxImageEdge: imageEdge });
    if (bands.length === 0) {
      setStatus(t("settings.recognition.aiNoVision"), "var(--nb-status-warning)");
      return;
    }

    const words = await transcribeBand(bands[0], {
      provider,
      endpoint: normalized,
      model,
      replicateVersion,
      // Prefer a freshly typed key; fall back to the stored one so testing an
      // existing configuration does not require retyping the secret.
      // On Nextcloud the key lives on the server and is never sent to the
      // browser, so there is nothing to fall back to: an untouched field means
      // "leave the stored key alone", which setRecognitionConfig honours by
      // omitting it from the patch.
      // Read for the provider being tested, so testing after a provider switch
      // uses that provider's credential rather than the one left behind.
      apiKey: typedKey || (IS_NEXTCLOUD ? undefined : await getApiKey(provider)),
      language,
      maxTokens,
      timeoutSeconds,
    });

    // Real words only. `words` also carries the line-break entries that describe
    // layout, and a model that answered with nothing but a break passed the old
    // length check — reporting "vision works" for a run that transcribed not one
    // character. countWords is what the rest of the pipeline already uses to
    // tell content from layout.
    const { countWords } = await import("../modules/recognition/breaks.js");
    const transcribed = countWords(words);

    if (transcribed > 0) {
      setStatus(t("settings.recognition.aiSuccess", { model }), "var(--nb-status-success)");
    } else {
      setStatus(t("settings.recognition.aiNoVision"), "var(--nb-status-warning)");
    }
  } catch (error) {
    console.error("AI recognition test failed:", error);
    setStatus(
      t("settings.recognition.errorFailed", { message: error.message || String(error) }),
      "var(--nb-status-error)",
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
 * Wire up the settings master/detail navigation.
 *
 * One component, two layouts, chosen by CSS alone:
 *
 *   - Wide: the nav list sits beside the panel and both are always visible.
 *   - Narrow: the nav fills the screen, and choosing an entry slides the
 *     section in as a full-screen page with a back button — the platform
 *     Settings pattern on both iOS and Android, so it reads as familiar rather
 *     than invented.
 *
 * The shell's `data-view` attribute is the only thing this function changes for
 * the narrow case; the wide layout ignores it entirely. That keeps one DOM and
 * one set of handlers for both, rather than two renderers to keep in step.
 *
 * The nav is built from the sections that actually rendered, not a fixed list:
 * sections are conditional per platform (no Nextcloud section in the NC build,
 * no MCP off Windows), and a hardcoded list would offer entries leading
 * nowhere.
 *
 * @param {HTMLElement} container
 */
/**
 * The section the user last opened.
 *
 * renderSettings() rebuilds the whole screen from scratch in about a dozen
 * places — after toggling MCP, connecting Nextcloud, changing the interface
 * language — and each of those would otherwise throw the user back to the first
 * section, having just acted somewhere else entirely.
 *
 * Module scope rather than storage: it should survive a re-render, not a
 * restart. Reopening Settings later is a fresh visit and starts at the top.
 */
let lastOpenSection = null;

function initSettingsNav(container) {
  const shell = container.querySelector(".settings-shell");
  const list = container.querySelector("#settings-nav-list");
  const back = container.querySelector("#settings-back");
  if (!shell || !list) return;

  const sections = [...container.querySelectorAll(".settings-section[data-section]")];
  if (sections.length === 0) return;

  /** Nav entries, in the order the sections appear. */
  const entries = sections.map((section) => {
    const key = section.dataset.section;
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-nav__item";
    button.dataset.target = key;
    // The heading is the label: one source of truth, already translated, and
    // it cannot drift from what the section actually says.
    button.textContent = section.querySelector("h3")?.textContent.trim() || key;
    item.appendChild(button);
    list.appendChild(item);
    return { key, section, button };
  });

  // Restore what was open before a re-render, falling back to the first section
  // — the remembered one may not exist any more, since sections come and go
  // with platform and auth state.
  const restored = entries.some((e) => e.key === lastOpenSection) ? lastOpenSection : null;
  let activeKey = restored ?? entries[0].key;

  /**
   * Show one section and mark its nav entry current.
   *
   * `reveal` also records *why* the section is open, which the two layouts
   * need to answer differently. Wide shows the nav and the section side by
   * side, so the first section being open is a fact the user can see and the
   * rail should say which one it is. Narrow shows the nav alone until an entry
   * is chosen, so highlighting one there would claim a section is open when
   * nothing is on screen but the list.
   *
   * The two layouts share one DOM and are chosen by CSS alone, so this cannot
   * be decided here — the class is set either way and `data-selection` on the
   * shell lets the narrow breakpoint suppress it.
   */
  function select(key, { reveal = true } = {}) {
    const match = entries.find((e) => e.key === key);
    if (!match) return;
    activeKey = key;
    lastOpenSection = key;

    for (const entry of entries) {
      const current = entry.key === key;
      entry.section.classList.toggle("settings-section--active", current);
      entry.button.classList.toggle("settings-nav__item--current", current);
      // aria-current follows the same rule as the highlight, and for the same
      // reason: narrow, an unrevealed section is not the current one — the
      // list is all there is. Announcing otherwise would tell a screen reader
      // user they are inside a section they have not opened.
      const announced = current && (reveal || shell.dataset.selection === "explicit");
      entry.button.setAttribute("aria-current", announced ? "true" : "false");
    }

    // Only meaningful narrow, where it swaps which pane is on screen. Wide
    // ignores it, so the same call serves both.
    if (reveal) shell.dataset.view = "detail";
    if (reveal) shell.dataset.selection = "explicit";

    // A section taller than the pane would otherwise open part-scrolled, at
    // whatever offset the previous section left behind. The detail pane is the
    // scroller now — the dialog body no longer scrolls, so that the nav rail
    // stays put while a section moves beside it.
    const scroller = shell.querySelector(".settings-detail") || shell;
    scroller.scrollTop = 0;
  }

  list.addEventListener("click", (e) => {
    const button = e.target.closest(".settings-nav__item");
    if (button) select(button.dataset.target);
  });

  // Narrow only: return to the list. Wide never shows this button, so the
  // attribute it resets is inert there.
  back?.addEventListener("click", () => {
    shell.dataset.view = "list";
    // Back to the list means nothing is open again, so the rail drops its
    // highlight along with the pane it referred to.
    shell.dataset.selection = "none";
    for (const entry of entries) entry.button.setAttribute("aria-current", "false");
  });

  /**
   * Open a section from elsewhere in the settings screen.
   *
   * The recognition section's "Configure AI access" button needs to reach the
   * provider section, which in this layout means switching panes rather than
   * scrolling. Exposed on the shell so the existing handler can call it without
   * this function having to know about that button.
   */
  shell.showSettingsSection = (key) => select(key);

  // A restored section was already open, so narrow stays in the detail pane —
  // returning to the list after an action taken inside a section would be its
  // own kind of lost place. A first visit opens on the list instead, since
  // landing straight inside Appearance would hide that anything else exists.
  shell.dataset.selection = restored !== null ? "explicit" : "none";
  select(activeKey, { reveal: restored !== null });
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
  // Recognition and provider configuration, read here so the sections can render
  // the stored values.
  //
  // Two sections, two modules, deliberately: the provider is one account-level
  // fact shared by every AI feature, while the method and model belong to
  // handwriting recognition alone. getRecognitionConfig() returns both halves
  // flattened, which is what the recognition section needs to decide what to
  // show.
  const { getRecognitionConfig, isAiMethod, METHOD_AI, METHOD_WINDOWS_INK, LANGUAGE_AUTO } =
    await import("../modules/recognition/recognitionSettings.js");
  const { isProviderConfigured, PROVIDER_OPENAI, PROVIDER_REPLICATE } = await import(
    "../modules/recognition/aiProvider.js"
  );
  // Named in the provider dropdown, since Replicate has no endpoint field of
  // its own. Imported rather than written out so the label always matches the
  // host the request code actually uses.
  const { REPLICATE_BASE } = await import("../modules/recognition/backends/replicateBackend.js");
  // Drop the cached server config *before* reading it, not after.
  //
  // The provider config — which now carries the administrator's mode, policy and
  // central settings — is cached for the session so a recognition run does not
  // refetch it per page. That cache is what makes an admin change invisible to
  // an already-open tab: the settings screen re-read a copy taken at some
  // earlier point, so closing and reopening settings changed nothing and only a
  // full page reload helped.
  //
  // The invalidation used to sit further down, after this read, which meant the
  // form always rendered from the previous generation and dropped the cache for
  // whoever asked next. Opening settings is the one moment a user is acting on
  // the policy, so it is the right place to pay for one fetch.
  //
  // No-op off Nextcloud, where there is no server config to cache.
  if (IS_NEXTCLOUD) {
    const { invalidateProviderCache } = await import("../modules/recognition/aiProvider.js");
    invalidateProviderCache();
  }
  const recognitionConfig = await getRecognitionConfig();
  const isAiBackend = isAiMethod(recognitionConfig.method);
  const isReplicate = recognitionConfig.provider === PROVIDER_REPLICATE;
  const providerReady = isProviderConfigured(recognitionConfig);
  // Only Replicate survives a server that cannot detach the upstream call: its
  // predictions API is asynchronous, so the proxy's own request is short even on
  // the synchronous path. An OpenAI-compatible endpoint is one long call by
  // construction, so on such a server it races a timeout this app cannot raise.
  const { supportsAsyncRecognition } = await import("../modules/recognition/aiProvider.js");
  const timeoutRisk = isAiBackend && !isReplicate && !(await supportsAsyncRecognition());
  // On Nextcloud the endpoint is chosen from what the administrator permits,
  // never typed: the server refuses anything else, so a text box could only
  // produce a value that fails later. Empty means the admin has permitted
  // nothing — the field says so rather than offering an empty dropdown.
  // Already re-read above, before recognitionConfig: these read the same cached
  // server config, so invalidating again here would cost a second fetch for
  // values that are current.
  const { getAllowedEndpoints, isReplicateAllowed } = await import(
    "../modules/recognition/aiProvider.js"
  );
  const allowedEndpoints = await getAllowedEndpoints();
  // Replicate is offered only where the administrator permits it. Hidden rather
  // than shown-and-refused: it has no endpoint field to explain a rejection, so
  // an option that always fails would give the user nothing to act on.
  const replicateAllowed = await isReplicateAllowed();
  const recognitionLanguage = recognitionConfig.language || LANGUAGE_AUTO;
  const currentLanguage = getCurrentLanguage();

  // The bundled local recognizer sidecar is Windows-only; the AI method works everywhere
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

  // Auto-detect first, and the default: a wrong language assertion makes models
  // rewrite foreign words into the named language, so naming one is opt-in.
  const recognitionLangOptions = [
    LANGUAGE_AUTO,
    "en-US",
    "de-DE",
    "fr-FR",
    "es-ES",
    "it-IT",
    "ja-JP",
    "zh-CN",
  ];
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
    <div class="settings-shell" data-view="list">
      <div class="settings-header">
        <h2>${t("settings.title")}</h2>
      </div>

      <nav class="settings-nav" aria-label="${t("settings.title")}">
        <ul class="settings-nav__list" id="settings-nav-list"></ul>
      </nav>

      <div class="settings-detail">
        <button type="button" class="settings-detail__back" id="settings-back">
          ${t("settings.nav.back")}
        </button>
        <div class="settings-panel" id="settings-panel">

      <div class="settings-section" data-section="appearance">
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

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">${t("settings.help.reset")}</span>
            <span class="setting-description">${t("settings.help.resetDesc")}</span>
          </div>
          <button id="reset-help-guidance-btn" class="btn-secondary">${t("settings.help.resetBtn")}</button>
        </div>

        ${
          // The interface language is the browser's business on Nextcloud,
          // so the app does not offer a picker of its own there.
          IS_NEXTCLOUD
            ? ""
            : `
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
        `
        }
      </div>

      ${
        // Neither section applies to the Nextcloud build: local
        // encryption has no local store to protect, and syncing is
        // Nextcloud's own job rather than something this app arranges.
        IS_NEXTCLOUD
          ? ""
          : `
      <div class="settings-section" data-section="security">
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

      <div class="settings-section" data-section="nextcloud">
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
          <button id="test-connection-connected-btn" class="btn-secondary">${t("settings.nextcloud.testBtn")}</button>
          <button id="disconnect-btn" class="btn-secondary">${t("settings.nextcloud.disconnect")}</button>
          <span id="sync-status" class="setting-note"></span>
        </div>
        `
        }
      </div>
      `
      }

      <div class="settings-section" id="ai-provider-section" data-section="aiProvider">
        <h3>${t("settings.sections.aiProvider")}</h3>

        <!-- Central mode (Nextcloud): the connection and credential are the
             administrator's, so the body below is removed and this stands in its
             place. The section itself is kept rather than dropped from the
             navigation — a user who goes looking for "AI Access" should find an
             answer there, not an entry that silently disappeared. -->
        <div
          class="setting-item setting-item--full settings-notice setting-item--hidden"
          id="ai-provider-central-notice"
        >
          <div class="setting-label">
            <span class="setting-name">${t("settings.recognition.centralTitle")}</span>
            <span class="setting-description">${t("settings.recognition.centralBody")}</span>
          </div>
        </div>

        <div id="ai-provider-body">
        <p class="setting-note">${t("settings.aiProvider.intro")}</p>

        <div class="setting-item">
          <label for="ai-provider" class="setting-label">
            <span class="setting-name">${t("settings.aiProvider.providerLabel")}</span>
            <span class="setting-description">${t("settings.aiProvider.providerDesc")}</span>
          </label>
          <select id="ai-provider" class="setting-control">
            <option value="" ${!recognitionConfig.provider ? "selected" : ""}>
              ${t("settings.aiProvider.providerNone")}
            </option>
            <option value="${PROVIDER_OPENAI}" ${recognitionConfig.provider === PROVIDER_OPENAI ? "selected" : ""}>
              ${t("settings.aiProvider.providerOpenAi")}
            </option>
            ${
              // The host is named in the label because Replicate has no endpoint
              // field: without this there is nowhere in the UI that says where
              // handwriting would actually be sent. Interpolated from the
              // constant the request code uses, so the label cannot drift from
              // the real destination.
              //
              // Omitted entirely where the administrator has not permitted it.
              // A stored selection still renders, so a configuration made before
              // the policy changed is visible rather than silently blank — the
              // label says it is no longer permitted.
              replicateAllowed
                ? `<option value="${PROVIDER_REPLICATE}" ${isReplicate ? "selected" : ""}>
                     ${t("settings.aiProvider.providerReplicate")} (${REPLICATE_BASE})
                   </option>`
                : isReplicate
                  ? `<option value="${PROVIDER_REPLICATE}" selected>
                       ${t("settings.aiProvider.providerReplicate")} — ${t("settings.recognition.endpointNoLongerAllowed")}
                     </option>`
                  : ""
            }
          </select>
        </div>

        <div id="ai-provider-fields" class="setting-group ${recognitionConfig.provider ? "" : "setting-item--hidden"}">
          <div class="setting-item ${isReplicate ? "setting-item--hidden" : ""}" id="ai-endpoint-row">
            <label for="ai-endpoint" class="setting-label">
              <span class="setting-name">${t("settings.recognition.endpointLabel")}</span>
              <span class="setting-description">${
                // On Nextcloud the request is issued by the server through the
                // proxy, so the URL must resolve from there. "localhost" in this
                // field means the Nextcloud server, not this device — worth
                // stating, because the field otherwise reads as device-local.
                IS_NEXTCLOUD
                  ? allowedEndpoints.length === 0
                    ? t("settings.recognition.endpointDescNoneAllowed")
                    : t("settings.recognition.endpointDescNextcloud")
                  : t("settings.recognition.endpointDesc")
              }</span>
            </label>
            ${
              // Two shapes for one field. On Nextcloud the destination is
              // whatever the administrator permitted, so offering anything else
              // would only produce a save the server refuses; a <select> makes
              // the invalid state unreachable instead of reporting it after the
              // fact. The native builds have no administrator and keep the text
              // box, checked client-side by endpointValidation.js.
              //
              // Both render #ai-endpoint and are read through .value, so every
              // call site below is indifferent to which one is on screen.
              IS_NEXTCLOUD
                ? allowedEndpoints.length === 0
                  ? `<select id="ai-endpoint" class="setting-control" disabled>
                       <option value="">${t("settings.recognition.endpointNoneAllowed")}</option>
                     </select>`
                  : `<select id="ai-endpoint" class="setting-control">
                       <!-- A blank first entry so an unconfigured account does not
                            silently adopt whichever endpoint happens to sort first. -->
                       <option value="" ${recognitionConfig.endpoint ? "" : "selected"}>
                         ${t("settings.recognition.endpointChoose")}
                       </option>
                       ${allowedEndpoints
                         .map(
                           (url) =>
                             `<option value="${escapeAttr(url)}" ${
                               url === recognitionConfig.endpoint ? "selected" : ""
                             }>${escapeAttr(url)}</option>`,
                         )
                         .join("")}
                       ${
                         // A stored endpoint the admin has since removed. Kept
                         // visible and selected so the user can see what their
                         // configuration actually says — dropping it silently
                         // would show a blank field and leave the recognition
                         // failure unexplained. It no longer works, and the
                         // label says so.
                         recognitionConfig.endpoint &&
                         !allowedEndpoints.includes(recognitionConfig.endpoint)
                           ? `<option value="${escapeAttr(recognitionConfig.endpoint)}" selected>
                                ${escapeAttr(recognitionConfig.endpoint)} — ${t("settings.recognition.endpointNoLongerAllowed")}
                              </option>`
                           : ""
                       }
                     </select>`
                : `<input
                     type="url"
                     id="ai-endpoint"
                     name="noteberg-ai-endpoint"
                     autocomplete="off"
                     autocorrect="off"
                     autocapitalize="off"
                     spellcheck="false"
                     data-1p-ignore
                     data-lpignore="true"
                     data-bwignore
                     class="setting-control"
                     placeholder="${t("settings.recognition.endpointPlaceholder")}"
                     value="${escapeAttr(recognitionConfig.endpoint)}"
                   />`
            }
          </div>

          <div class="setting-item">
            <label for="ai-api-key" class="setting-label">
              <span class="setting-name">${t("settings.recognition.apiKeyLabel")}</span>
              <span class="setting-description">${t("settings.recognition.apiKeyDesc")}</span>
            </label>
            <!-- Password managers and Nextcloud's own credential autofill look
                 for a text-then-password pair and fill it with the account
                 login, silently overwriting the API token. autocomplete="off"
                 is widely ignored; "new-password" is the value browsers do
                 honour, and the name/id are kept clear of "password"/"user"
                 so heuristic matchers do not claim the field either. -->
            <!-- A stored key shows as a run of dots so the field says at a
                 glance that one is set. The dots are decoration, never the
                 value: they are written straight to .value without a trusted
                 input event, so typedApiKey() ignores them and no save can ever
                 store them as a token. Typing replaces them (see the focus
                 handler), which is also what makes an untouched field mean
                 "keep the stored key". -->
            <input
              type="password"
              id="ai-api-key"
              name="noteberg-ai-token"
              class="setting-control"
              autocomplete="new-password"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              value="${recognitionConfig.apiKey || recognitionConfig.hasApiKey ? STORED_KEY_MASK : ""}"
              placeholder="${t("settings.recognition.apiKeyPlaceholder")}"
            />
          </div>

          <div class="setting-item setting-item--full">
            <div class="setting-label">
              <span class="setting-description" id="ai-privacy-hint"></span>
            </div>
          </div>
        </div>

        <div class="setting-item setting-item--actions">
          <button id="ai-provider-save-btn" class="btn-primary">${t("settings.aiProvider.saveBtn")}</button>
          <button id="ai-provider-test-btn" class="btn-secondary">${t("settings.aiProvider.testBtn")}</button>
          <span id="ai-provider-status" class="setting-note"></span>
        </div>
        </div>
      </div>

      <div class="settings-section" data-section="recognition">
        <h3>${t("settings.sections.recognition")}</h3>

        <div class="setting-item" id="recognition-method-row">
          <label for="recognition-backend" class="setting-label">
            <span class="setting-name">${t("settings.recognition.methodLabel")}</span>
            <span class="setting-description">${t("settings.recognition.methodDesc")}</span>
          </label>
          <select id="recognition-backend" class="setting-control">
            ${
              // Offered where the sidecar can run, and also wherever it is the
              // stored method: omitting it there would leave the select showing
              // "AI vision model" for a user configured for Windows Ink, and the
              // AI fields would unhide on that false reading. The select must
              // always be able to represent the configuration it was rendered
              // from.
              isWindows || !isAiBackend
                ? `<option value="${METHOD_WINDOWS_INK}" ${!isAiBackend ? "selected" : ""}>
                     ${hasLocalRecognition ? t("settings.recognition.backendSidecar") : t("settings.recognition.backendSidecarUnavailable")}
                   </option>`
                : ""
            }
            <option value="${METHOD_AI}" ${isAiBackend ? "selected" : ""}>
              ${t("settings.recognition.backendAi")}
            </option>
          </select>
        </div>

        <!-- Central mode (Nextcloud): every setting below belongs to the
             administrator, so the whole group is removed rather than shown
             disabled. A form of greyed-out fields with two or three still
             editable reads as broken — the user cannot tell which parts are
             theirs — whereas one sentence explaining who owns the configuration
             is complete information.
             Hidden by default and revealed after render, since the mode is only
             known once the server config has been read. -->
        <div
          class="setting-item setting-item--full settings-notice setting-item--hidden"
          id="recognition-central-notice"
        >
          <div class="setting-label">
            <span class="setting-name">${t("settings.recognition.centralTitle")}</span>
            <span class="setting-description">${t("settings.recognition.centralBody")}</span>
          </div>
        </div>

        <div id="recognition-ai-fields" class="setting-group ${isAiBackend ? "" : "setting-item--hidden"}">
          <!-- Selecting AI with no provider set up is allowed: the intent is
               recorded and recognition no-ops, exactly as it does when the
               Windows sidecar is not running. What must not happen is a silent
               no-op with nothing in the UI explaining it, which is what this
               notice is for. -->
          <div
            class="setting-item setting-item--full settings-notice ${providerReady ? "setting-item--hidden" : ""}"
            id="recognition-provider-missing"
          >
            <div class="setting-label">
              <span class="setting-name">${t("settings.recognition.providerMissingTitle")}</span>
              <span class="setting-description">${t("settings.recognition.providerMissingBody")}</span>
            </div>
            <button id="recognition-configure-provider" class="btn-secondary">
              ${t("settings.recognition.configureProvider")}
            </button>
          </div>

          <!-- Shown only where it is actually true: a server with no php-fpm or
               no distributed cache cannot detach the transcription, so a slow
               model is cut off by proxy_read_timeout or
               request_terminate_timeout — limits this app has no way to raise,
               and whose failure reaches the browser as a bare network error. -->
          <div
            class="setting-item setting-item--full settings-notice ${timeoutRisk ? "" : "setting-item--hidden"}"
            id="recognition-async-warning"
          >
            <div class="setting-label">
              <span class="setting-name">${t("settings.recognition.syncOnlyTitle")}</span>
              <span class="setting-description">${t("settings.recognition.syncOnlyBody")}</span>
            </div>
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
            <label for="recognition-model" class="setting-label">
              <span class="setting-name">${t("settings.recognition.modelLabel")}</span>
              <span class="setting-description">${t("settings.recognition.modelDesc")}</span>
            </label>
            <!-- The field stays free text and the button only fills it in: not
                 every server offers a model listing, and Replicate's is a
                 sample rather than the whole catalog (see modelCatalog.js), so
                 a picker that replaced the field would make an unlistable
                 server unconfigurable. -->
            <div class="setting-control-row">
              <input
                type="text"
                id="recognition-model"
                name="noteberg-recognition-model"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                class="setting-control"
                placeholder="${t("settings.recognition.modelPlaceholder")}"
                value="${escapeAttr(recognitionConfig.model)}"
              />
              <button
                type="button"
                id="recognition-browse-models"
                class="btn-icon"
                title="${t("settings.recognition.browseModels")}"
                aria-label="${t("settings.recognition.browseModels")}"
              >
                ${getIcon("list", 20)}
              </button>
            </div>
          </div>

          <div class="setting-item ${isReplicate ? "" : "setting-item--hidden"}" id="recognition-version-row">
            <label for="recognition-replicate-version" class="setting-label">
              <span class="setting-name">${t("settings.recognition.versionLabel")}</span>
              <span class="setting-description">${t("settings.recognition.versionDesc")}</span>
            </label>
            <input
              type="text"
              id="recognition-replicate-version"
              name="noteberg-recognition-version"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              class="setting-control"
              placeholder="${t("settings.recognition.versionPlaceholder")}"
              value="${escapeAttr(recognitionConfig.replicateVersion)}"
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

          <div class="setting-item">
            <label for="recognition-timeout" class="setting-label">
              <span class="setting-name">${t("settings.recognition.timeoutLabel")}</span>
              <span class="setting-description">${
                // The server-side cap and the web-server timeout only exist on
                // Nextcloud, where the proxy makes the request. On the native
                // builds the app calls the endpoint directly, so naming them
                // there describes a limit that does not apply — and reads as a
                // warning about a Nextcloud the user may not even have.
                IS_NEXTCLOUD
                  ? t("settings.recognition.timeoutDescNextcloud")
                  : t("settings.recognition.timeoutDesc")
              }</span>
            </label>
            <input
              type="number"
              id="recognition-timeout"
              class="setting-control"
              min="10"
              max="600"
              step="10"
              value="${Number(recognitionConfig.timeoutSeconds) || 120}"
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
            </div>
          </div>
        </div>

        <div class="setting-item setting-item--actions" id="recognition-actions">
          <button id="recognition-save-btn" class="btn-primary">${t("settings.recognition.saveBtn")}</button>
          <button id="test-recognition-btn" class="btn-secondary">${t("settings.recognition.testBtn")}</button>
          <span id="recognition-status" class="setting-note"></span>
        </div>
      </div>

      ${
        // MCP is a Windows-only local server. On Nextcloud the section could
        // only ever say "unavailable", so it is not rendered at all.
        IS_NEXTCLOUD
          ? ""
          : `
      <div class="settings-section" data-section="mcp">
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
      `
      }

      ${
        IS_NEXTCLOUD
          ? ""
          : `
      <div class="settings-section" data-section="logging">
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

      <div class="settings-section" data-section="dangerZone">
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

      <div class="settings-section" data-section="about">
        <h3>${t("settings.sections.about")}</h3>

        <div class="setting-item setting-item--full">
          <div class="about-info">
            <p class="about-title">
              <span id="about-easter-egg" class="about-easter-egg"></span>
              <strong>${APP_NAME}</strong>
            </p>
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
        </div>
      </div>
  `;

  initSettingsNav(container);

  // Open the project link through the Tauri opener on native builds: in the
  // Android webview target="_blank" does nothing (same reason licensesDialog.js
  // routes its links this way). In the NC build the anchor is a plain browser
  // link and needs no interception.
  const easterEggContainer = container.querySelector("#about-easter-egg");
  if (easterEggContainer) {
    const indicator = createLoadingIndicator({ size: "48px" });
    indicator.style.setProperty("--nb-loader-duration", "60000ms");
    easterEggContainer.appendChild(indicator);
  }

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
  // Which provider the stored endpoint was entered for. Used to decide whether
  // it is still meaningful after the provider dropdown changes.
  const storedEndpointProvider = recognitionConfig.provider || "";

  const aiProviderSelect = container.querySelector("#ai-provider");
  const aiProviderFields = container.querySelector("#ai-provider-fields");
  const aiProviderSaveBtn = container.querySelector("#ai-provider-save-btn");
  const aiProviderTestBtn = container.querySelector("#ai-provider-test-btn");
  const aiProviderStatus = container.querySelector("#ai-provider-status");
  const providerMissingNotice = container.querySelector("#recognition-provider-missing");
  const configureProviderBtn = container.querySelector("#recognition-configure-provider");
  const recognitionEndpointInput = container.querySelector("#ai-endpoint");
  const recognitionEndpointRow = container.querySelector("#ai-endpoint-row");
  const recognitionVersionRow = container.querySelector("#recognition-version-row");
  const recognitionVersionInput = container.querySelector("#recognition-replicate-version");
  const recognitionModelInput = container.querySelector("#recognition-model");
  const recognitionBrowseModelsBtn = container.querySelector("#recognition-browse-models");
  const recognitionApiKeyInput = container.querySelector("#ai-api-key");
  const recognitionImageEdgeInput = container.querySelector("#recognition-image-edge");
  const recognitionMaxTokensInput = container.querySelector("#recognition-max-tokens");
  const recognitionTimeoutInput = container.querySelector("#recognition-timeout");
  const recognitionPromptInput = container.querySelector("#recognition-system-prompt");
  const recognitionPromptReset = container.querySelector("#recognition-prompt-reset");
  const recognitionPromptStatus = container.querySelector("#recognition-prompt-status");
  const recognitionPrivacyHint = container.querySelector("#ai-privacy-hint");
  const recognitionSaveBtn = container.querySelector("#recognition-save-btn");
  const testRecognitionBtn = container.querySelector("#test-recognition-btn");
  const recognitionStatus = container.querySelector("#recognition-status");

  const setRecognitionStatus = (text, color) => {
    if (!recognitionStatus) return;
    recognitionStatus.textContent = text;
    recognitionStatus.style.color = color;
  };

  // Central mode (Nextcloud): every AI setting belongs to the administrator, so
  // the whole group goes and only the notice remains.
  //
  // An earlier version disabled the fields instead, on the reasoning that a user
  // whose transcriptions are poor should still see which model produced them.
  // In practice that read as broken: most controls greyed out, a few still
  // editable, and nothing on screen saying which were which. Removing them and
  // stating who owns the configuration is less information but a clearer answer
  // — and the settings that genuinely are per-device moved to the admin panel
  // with the rest, so nothing editable is left behind.
  //
  // The provider section goes too. It holds only the endpoint and credential,
  // both the administrator's here, so leaving an empty pane in the navigation
  // would invite a user to look for something that is not there. The nav is
  // built from the sections present in the DOM (see `sections` above), so
  // removing the element removes its entry.
  //
  // `centrallyManaged` is always false on the native builds, so this is inert
  // on Windows and Android.
  if (recognitionConfig.centrallyManaged) {
    for (const selector of [
      "#recognition-ai-fields",
      // The method too: choosing Windows Ink over the AI model is a choice about
      // a service the administrator configured, and the sidecar does not exist
      // on Nextcloud anyway — so the select had one real option and no save
      // button left to apply it with.
      "#recognition-method-row",
      // Save and Test act on fields that are no longer there. A Test button in
      // particular would spend the administrator's quota to check a
      // configuration the user cannot change.
      "#recognition-actions",
      // The provider body, but not its section: the heading and the notice stay
      // so "AI Access" still answers the question when a user opens it, rather
      // than being an empty pane or a navigation entry that vanished.
      "#ai-provider-body",
    ]) {
      container.querySelector(selector)?.remove();
    }
    for (const selector of ["#recognition-central-notice", "#ai-provider-central-notice"]) {
      container.querySelector(selector)?.classList.remove("setting-item--hidden");
    }
  }

  /**
   * Say plainly where handwriting will be sent.
   *
   * Privacy is a product commitment, so the destination is stated whenever an
   * AI backend is selected — not only at first setup — and it distinguishes a
   * loopback endpoint (nothing leaves the device) from a remote one.
   */
  const updatePrivacyHint = () => {
    if (!recognitionPrivacyHint) return;
    if (aiProviderSelect?.value === "replicate") {
      // Always a remote third-party service; there is no local variant to detect.
      recognitionPrivacyHint.textContent =
        `${t("settings.aiProvider.privacyHint")} ${t("settings.aiProvider.privacyHintRemote")}`.trim();
      return;
    }
    const raw = recognitionEndpointInput?.value.trim() || "";
    let scope = "";
    try {
      const host = new URL(raw).hostname;
      scope =
        host === "localhost" || host === "127.0.0.1" || host === "[::1]"
          ? t("settings.aiProvider.privacyHintLocal")
          : t("settings.aiProvider.privacyHintRemote");
    } catch (_e) {
      scope = "";
    }
    recognitionPrivacyHint.textContent = `${t("settings.aiProvider.privacyHint")} ${scope}`.trim();
  };

  /**
   * The API key the user actually typed, or "" when the field was autofilled.
   *
   * Password managers and Nextcloud's own credential autofill target this
   * field despite the suppression attributes, and a browser-supplied account
   * password saved over a working token destroys it — the stored key is never
   * rendered back, so there is nothing to restore it from.
   *
   * A value the user did not type is therefore discarded. `_userTyped` is set
   * by the input listener below; anything that appears without one is not the
   * user's doing.
   */
  const typedApiKey = () => {
    if (!recognitionApiKeyInput) return "";
    if (recognitionApiKeyInput.dataset.userTyped !== "1") return "";

    const value = recognitionApiKeyInput.value || "";
    // Belt and braces: the mask is never marked as user-typed, so this should be
    // unreachable. It is checked anyway because the cost of being wrong is
    // storing a row of dots as the API key and locking the user out of their own
    // provider — a failure that would look exactly like the one this fixes.
    return value === STORED_KEY_MASK ? "" : value;
  };

  // Two independent axes since the config split: *how* handwriting is
  // recognized, and *which* AI service the account can reach. Neither implies
  // the other — Windows Ink with a configured provider is a valid state, and so
  // is a provider configured for some other feature while handwriting stays
  // local.
  const isAiSelected = () => recognitionBackendSelect?.value === "ai";
  const selectedProvider = () => aiProviderSelect?.value || "";
  const isReplicateSelected = () => selectedProvider() === "replicate";

  /**
   * Whether the selected provider has enough typed in to be reachable.
   *
   * Reads the live form rather than the stored config so the notice clears the
   * moment the missing field is filled, instead of waiting for a save.
   */
  const providerLooksConfigured = () => {
    if (isReplicateSelected()) {
      // The stored key is never rendered back, so an untouched field on a
      // configuration that already has one still counts as configured.
      return !!(typedApiKey() || recognitionConfig.apiKey || recognitionConfig.hasApiKey);
    }
    if (selectedProvider() === "openai") {
      const endpoint = recognitionEndpointInput?.value.trim() || "";
      if (!endpoint) return false;
      // A remote endpoint without a credential is not a runnable configuration,
      // and the notice saying so is the only thing on screen that says a key is
      // missing — the field itself looks the same either way. Local servers are
      // exempt: LM Studio and Ollama need no key. Same rule as checkProvider().
      if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(endpoint)) return true;
      return !!(typedApiKey() || recognitionConfig.apiKey || recognitionConfig.hasApiKey);
    }
    return false;
  };

  const syncAiFieldVisibility = () => {
    recognitionAiFields?.classList.toggle("setting-item--hidden", !isAiSelected());
    aiProviderFields?.classList.toggle("setting-item--hidden", !selectedProvider());
    // Replicate has a fixed API host and is addressed by model + version, so an
    // endpoint URL would be meaningless there.
    recognitionEndpointRow?.classList.toggle("setting-item--hidden", isReplicateSelected());
    recognitionVersionRow?.classList.toggle("setting-item--hidden", !isReplicateSelected());
    // Choosing AI without a provider is allowed and saves; it simply cannot run
    // yet. Saying so is the whole point — the pre-split UI let a user select an
    // AI backend, leave it unconfigured, and get silent no-ops with no
    // explanation anywhere.
    providerMissingNotice?.classList.toggle(
      "setting-item--hidden",
      !isAiSelected() || providerLooksConfigured(),
    );
    updatePrivacyHint();
  };

  syncAiFieldVisibility();

  recognitionBackendSelect?.addEventListener("change", async () => {
    const { setRecognitionConfig } = await import("../modules/recognition/recognitionSettings.js");
    await setRecognitionConfig({ method: recognitionBackendSelect.value });
    const { invalidateRecognitionUrl } = await import("../modules/autoRecognition.js");
    invalidateRecognitionUrl();
    syncAiFieldVisibility();
    setRecognitionStatus("", "var(--color-text)");
  });

  aiProviderSelect?.addEventListener("change", () => {
    // An endpoint belongs to the provider it was entered for. Replicate has a
    // fixed host and no endpoint field, so a URL stored while it was selected
    // is the app's own, not the user's — leaving it in the box would offer
    // api.replicate.com as the default for an OpenAI-compatible server, which
    // is not merely unhelpful but wrong.
    //
    // Only clears a URL that belongs to a *different* provider: the value the
    // user typed for this one survives switching away and back.
    if (recognitionEndpointInput && selectedProvider() !== storedEndpointProvider) {
      recognitionEndpointInput.value = "";
    } else if (recognitionEndpointInput) {
      // Assigning a value a <select> has no <option> for silently leaves it on
      // whatever was selected, so the field would disagree with the stored
      // config. Only restore what the element can actually represent; on the
      // native text box every value qualifies.
      const restored = recognitionConfig.endpoint || "";
      const isSelect = recognitionEndpointInput.tagName === "SELECT";
      const representable =
        !isSelect ||
        Array.prototype.some.call(
          recognitionEndpointInput.options,
          (opt) => opt.value === restored,
        );
      recognitionEndpointInput.value = representable ? restored : "";
    }
    syncAiFieldVisibility();
    refreshKeyMask();
  });

  /**
   * Show the mask only when the *selected* provider actually has a key stored.
   *
   * Keys are per provider, so switching changes the answer. Without this the
   * dots would persist across a switch and assert that the new provider is
   * configured when it is not — reintroducing, as a display bug, exactly the
   * confusion that per-provider storage removes.
   *
   * A key the user typed but has not saved is left alone: it is the more recent
   * intent, and overwriting it with dots would discard their input.
   */
  async function refreshKeyMask() {
    if (!recognitionApiKeyInput || typedApiKey()) return;

    const provider = selectedProvider();
    let stored = false;
    if (provider) {
      if (IS_NEXTCLOUD) {
        // The browser never holds the key here; only the server knows, and it
        // reports presence for the provider it has stored — which is the one
        // being switched away from until the save lands. Trust it only when the
        // selection still matches, and show nothing otherwise rather than
        // guessing wrong in either direction.
        stored = provider === recognitionConfig.provider && !!recognitionConfig.hasApiKey;
      } else {
        const { getApiKey } = await import("../modules/recognition/aiProvider.js");
        stored = !!(await getApiKey(provider));
      }
    }

    // Re-checked after the await: the user may have started typing while it was
    // in flight, and their input must win.
    if (typedApiKey()) return;
    recognitionApiKeyInput.value = stored ? STORED_KEY_MASK : "";
  }

  configureProviderBtn?.addEventListener("click", () => {
    // Take the user to the provider section rather than blocking the save.
    // Switching panes rather than scrolling: the sections are separate views
    // now, so the target is not on screen to scroll to.
    const shell = container.querySelector(".settings-shell");
    shell?.showSettingsSection?.("aiProvider");
    aiProviderSelect?.focus();
  });

  // "change" as well as "input": on Nextcloud this element is a <select>,
  // which never fires "input". Both are harmless on the text box.
  recognitionEndpointInput?.addEventListener("input", syncAiFieldVisibility);
  recognitionEndpointInput?.addEventListener("change", syncAiFieldVisibility);

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
    const warnings = checkPrompt(value);
    if (warnings.length === 0) {
      recognitionPromptStatus.textContent = "";
      return;
    }
    recognitionPromptStatus.textContent = t("settings.recognition.promptWarning", {
      items: warnings.map((w) => t(`settings.recognition.promptWarn.${w}`)).join(", "),
    });
    recognitionPromptStatus.style.color = "var(--nb-status-warning)";
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

  // Clear the mask the moment the user means to replace it, so a typed key is
  // never appended to a run of dots. Guarded on the mask itself rather than on
  // "has focus": a real key typed earlier in the same session must survive the
  // user clicking away and back.
  recognitionApiKeyInput?.addEventListener("focus", () => {
    if (recognitionApiKeyInput.value === STORED_KEY_MASK) {
      recognitionApiKeyInput.value = "";
    }
  });

  // Restore the mask if the field is left untouched, so the display goes back to
  // saying what is true: a key is stored, and this save will keep it.
  recognitionApiKeyInput?.addEventListener("blur", () => {
    const stored = recognitionConfig.apiKey || recognitionConfig.hasApiKey;
    if (stored && !typedApiKey() && recognitionApiKeyInput.value === "") {
      recognitionApiKeyInput.value = STORED_KEY_MASK;
    }
  });

  recognitionApiKeyInput?.addEventListener("input", (e) => {
    // isTrusted distinguishes a real keystroke or paste from a programmatic
    // fill. Autofill dispatches an untrusted event, or none at all.
    if (e.isTrusted) recognitionApiKeyInput.dataset.userTyped = "1";
  });

  const setProviderStatus = (text, color) => {
    if (!aiProviderStatus) return;
    aiProviderStatus.textContent = text;
    aiProviderStatus.style.color = color;
  };

  aiProviderSaveBtn?.addEventListener("click", async () => {
    const { setProviderConfig, invalidateProviderCache } = await import(
      "../modules/recognition/aiProvider.js"
    );
    const { normalizeEndpoint, validateEndpoint } = await import(
      "../modules/recognition/endpointValidation.js"
    );

    const provider = selectedProvider();
    const patch = { provider };

    if (provider === "openai") {
      // Accept the server root, the /v1 base, or a full route — see
      // normalizeEndpoint(). Storing the raw value made a missing /v1 fail as
      // "unparseable content" instead of as a wrong URL.
      // Normalization exists for a field users type into: it forgives a
      // missing "/v1" and a pasted route. On Nextcloud the value came from a
      // dropdown of what the administrator permitted, so it is already exactly
      // what the policy will be checked against — rewriting it there could turn
      // a permitted entry into a rejected one, which is the opposite of helping.
      const rawEndpoint = recognitionEndpointInput?.value.trim() || "";
      const endpoint = IS_NEXTCLOUD ? rawEndpoint : normalizeEndpoint(rawEndpoint);
      // The administrator's list is the authority on Nextcloud, and it may
      // permit plain http to a host on their own network. validateEndpoint()
      // refusing that is the right default where there is no administrator;
      // here it would override a decision that is legitimately theirs.
      const check = IS_NEXTCLOUD ? { valid: true } : validateEndpoint(endpoint);
      if (!check.valid) {
        // Reject at save time rather than at request time: an endpoint that
        // would send ink in clear text to a remote host must never be stored.
        const messages = {
          "not-a-url": t("settings.recognition.endpointInvalidUrl"),
          "insecure-remote": t("settings.recognition.endpointInsecure"),
          "unsupported-protocol": t("settings.recognition.endpointUnsupported"),
        };
        setProviderStatus(
          messages[check.reason] || t("settings.recognition.endpointInvalidUrl"),
          "var(--nb-status-error)",
        );
        return;
      }
      patch.endpoint = endpoint;
    }

    // An empty field means "keep the stored key", not "clear it" — the input is
    // never populated with the existing secret, so treating blank as a deletion
    // would silently drop a working key on any unrelated save.
    const typedKey = typedApiKey();
    if (typedKey) patch.apiKey = typedKey;

    // Ask before this configuration can send anything. Consent is recorded per
    // destination host, so switching endpoints asks again; a local endpoint
    // needs no dialog because nothing leaves the device (DESIGN §6).
    //
    // Consent lives with the provider rather than with recognition: the host is
    // a property of where requests go, and agreeing to send data there is the
    // same agreement whichever feature makes the request.
    const { destinationHost, grantConsent, hasConsent } = await import(
      "../modules/recognition/consent.js"
    );
    const pending = { ...recognitionConfig, ...patch };
    const host = destinationHost(pending);
    if (host && !(await hasConsent(pending))) {
      const agreed = await showConfirmDialog(
        t("settings.aiProvider.consentTitle", { host }),
        t("settings.aiProvider.consentBody", { host }),
        t("settings.aiProvider.consentConfirm"),
        "btn-primary",
      );
      if (!agreed) {
        // Store the configuration but not the consent: the fields the user
        // typed are kept, and nothing is sent until they agree.
        await setProviderConfig(patch);
        invalidateProviderCache();
        setProviderStatus(
          t("settings.aiProvider.consentDeclined", { host }),
          "var(--nb-status-warning)",
        );
        return;
      }
      await grantConsent(pending);
    }

    try {
      await setProviderConfig(patch);
    } catch (err) {
      // The administrator narrowed the allowlist while this form was open, so
      // the dropdown is offering an endpoint the server no longer accepts.
      // Naming that is the whole point: the same rejection reported as a status
      // code reads as a bug in the app rather than as a policy decision.
      if (err?.code === "endpoint-not-permitted") {
        setProviderStatus(t("settings.recognition.endpointNotPermitted"), "var(--nb-status-error)");
        return;
      }
      throw err;
    }
    invalidateProviderCache();
    if (patch.endpoint && recognitionEndpointInput) {
      // Show what was actually stored, so a normalized URL is not a surprise.
      // Skipped for the Nextcloud <select>: its value was not normalized, so it
      // already shows what was stored, and assigning a value it has no option
      // for would silently leave the field on the wrong entry.
      if (recognitionEndpointInput.tagName !== "SELECT")
        recognitionEndpointInput.value = patch.endpoint;
    }
    // The recognition section's "not configured" notice reads this state, so it
    // has to re-evaluate now rather than on the next settings open.
    syncAiFieldVisibility();
    const { invalidateRecognitionUrl } = await import("../modules/autoRecognition.js");
    invalidateRecognitionUrl();
    setProviderStatus(t("settings.aiProvider.saved"), "var(--nb-status-success)");
  });

  aiProviderTestBtn?.addEventListener("click", async () => {
    aiProviderTestBtn.disabled = true;
    const originalLabel = aiProviderTestBtn.textContent;
    aiProviderTestBtn.textContent = t("settings.aiProvider.testing");
    setProviderStatus(t("settings.aiProvider.testing"), "var(--color-text)");

    try {
      const {
        checkProvider,
        CHECK_OK,
        CHECK_OK_NO_LISTING,
        CHECK_UNAUTHORIZED,
        CHECK_UNREACHABLE,
        CHECK_NOT_CONFIGURED,
        CHECK_KEY_REQUIRED,
      } = await import("../modules/recognition/providerCheck.js");

      // Reads the form rather than the stored config, so the button tests what
      // is on screen — including a key just typed but not yet saved, which is
      // exactly when someone wants to check it.
      const result = await checkProvider({
        provider: selectedProvider(),
        endpoint: recognitionEndpointInput?.value.trim() || "",
        apiKey: typedApiKey(),
        hasApiKey: !!(recognitionConfig.apiKey || recognitionConfig.hasApiKey),
      });

      if (result.outcome === CHECK_OK) {
        setProviderStatus(
          result.modelCount === null
            ? t("settings.aiProvider.testOk")
            : t("settings.aiProvider.testOkModels", { count: result.modelCount }),
          "var(--nb-status-success)",
        );
      } else if (result.outcome === CHECK_OK_NO_LISTING) {
        // The endpoint answered but does not implement /models. That is a
        // working configuration, not a broken one — say so rather than sending
        // the user hunting for a fault that is not there.
        setProviderStatus(t("settings.aiProvider.testOkNoListing"), "var(--nb-status-success)");
      } else if (result.outcome === CHECK_UNAUTHORIZED) {
        setProviderStatus(t("settings.aiProvider.testUnauthorized"), "var(--nb-status-error)");
      } else if (result.outcome === CHECK_KEY_REQUIRED) {
        // Distinct from "fill in the details": the endpoint is there, the key is
        // not, and saying which one is missing is the whole value of the message.
        setProviderStatus(t("settings.aiProvider.testKeyRequired"), "var(--nb-status-warning)");
      } else if (result.outcome === CHECK_NOT_CONFIGURED) {
        setProviderStatus(t("settings.aiProvider.testNotConfigured"), "var(--nb-status-warning)");
      } else if (result.outcome === CHECK_UNREACHABLE) {
        setProviderStatus(
          t("settings.aiProvider.testUnreachable", { message: result.message || "" }),
          "var(--nb-status-error)",
        );
      } else {
        setProviderStatus(
          t("settings.aiProvider.testFailed", { status: result.status ?? "?" }),
          "var(--nb-status-error)",
        );
      }
    } catch (error) {
      console.error("AI provider connection test failed:", error);
      setProviderStatus(
        t("settings.aiProvider.testUnreachable", { message: error.message || String(error) }),
        "var(--nb-status-error)",
      );
    } finally {
      aiProviderTestBtn.disabled = false;
      aiProviderTestBtn.textContent = originalLabel;
    }
  });

  recognitionBrowseModelsBtn?.addEventListener("click", async () => {
    // Reads the live form rather than the stored config, so a user can type an
    // endpoint or paste a token and browse before saving — the same allowance
    // the test button makes. Without it, first-time setup would demand a save
    // of settings the user cannot yet fill in.
    const config = {
      provider: selectedProvider(),
      endpoint: recognitionEndpointInput?.value.trim() || "",
      apiKey: typedApiKey() || recognitionConfig.apiKey || "",
      hasApiKey: !!recognitionConfig.hasApiKey,
    };

    if (!config.provider) {
      setRecognitionStatus(
        t("settings.recognition.providerMissingTitle"),
        "var(--nb-status-error)",
      );
      return;
    }

    recognitionBrowseModelsBtn.disabled = true;
    try {
      const { openModelPicker } = await import("./modelPickerDialog.js");
      const picked = await openModelPicker(config, {
        currentModel: recognitionModelInput?.value.trim() || "",
      });
      if (!picked) return;

      if (recognitionModelInput) recognitionModelInput.value = picked.id;
      // Replicate addresses community models by version hash, and the listing
      // already carries the latest one — filling it in here is the difference
      // between a picked model that runs and one that fails with "not found".
      // Only overwritten when the listing supplied a version: a blank would
      // silently discard a hash the user pinned deliberately.
      if (recognitionVersionInput && picked.version) {
        recognitionVersionInput.value = picked.version;
      }
      // Chosen, not yet stored — the Save button is still the single writer, so
      // say so rather than letting the filled-in field imply it was saved.
      setRecognitionStatus(
        t("settings.recognition.modelPicked", { model: picked.id }),
        "var(--nb-status-warning)",
      );
    } finally {
      recognitionBrowseModelsBtn.disabled = false;
    }
  });

  recognitionSaveBtn?.addEventListener("click", async () => {
    const { setRecognitionConfig } = await import("../modules/recognition/recognitionSettings.js");

    // Only task-scoped fields. The endpoint and credential belong to the AI
    // Provider section, which is their single writer — two writers for one
    // setting is how the pre-split config drifted.
    const patch = { method: recognitionBackendSelect?.value };

    if (isAiSelected()) {
      patch.model = recognitionModelInput?.value.trim() || "";
      patch.replicateVersion = recognitionVersionInput?.value.trim() || "";
      patch.maxImageEdge = Number(recognitionImageEdgeInput?.value) || 1600;
      patch.maxTokens = Number(recognitionMaxTokensInput?.value) || 8000;
      patch.timeoutSeconds = Number(recognitionTimeoutInput?.value) || 120;
      // Saved here rather than written straight through on "change", which is
      // what it used to do. That made this the one recognition setting with a
      // second writer, bypassing setRecognitionConfig() — the single-writer rule
      // the config split exists to keep (recognitionSettings.js). It also meant
      // a language change was committed even when the user then abandoned the
      // form, unlike every other field in this section.
      patch.language = recognitionLanguageSelect?.value || "auto";
      // Empty means "use the built-in default", so a user who never edits it
      // keeps receiving improvements to the default.
      patch.systemPrompt = recognitionPromptInput?.value.trim() || "";

      if (!patch.model) {
        setRecognitionStatus(t("settings.recognition.missingModel"), "var(--nb-status-error)");
        return;
      }
    }

    await setRecognitionConfig(patch);
    const { invalidateRecognitionUrl } = await import("../modules/autoRecognition.js");
    invalidateRecognitionUrl();

    // Saving a method the provider cannot yet serve is allowed — the intent is
    // recorded and recognition no-ops until the provider is set up — but it must
    // say so, or the user is left with a silent no-op and no explanation.
    if (isAiSelected() && !providerLooksConfigured()) {
      setRecognitionStatus(
        t("settings.recognition.savedNeedsProvider"),
        "var(--nb-status-warning)",
      );
      return;
    }
    setRecognitionStatus(t("settings.recognition.saved"), "var(--nb-status-success)");
  });

  testRecognitionBtn?.addEventListener("click", async () => {
    testRecognitionBtn.disabled = true;
    const originalLabel = testRecognitionBtn.textContent;
    testRecognitionBtn.textContent = t("settings.recognition.testing");

    try {
      if (isAiSelected()) {
        await testAiRecognitionBackend({
          provider: selectedProvider(),
          endpoint: recognitionEndpointInput?.value.trim() || "",
          model: recognitionModelInput?.value.trim() || "",
          replicateVersion: recognitionVersionInput?.value.trim() || "",
          // Same guard as saving: an autofilled account password must not be
          // sent to the provider as a token, which would report a confusing
          // auth failure for a key the user never entered.
          typedKey: typedApiKey(),
          imageEdge: Number(recognitionImageEdgeInput?.value) || 1600,
          maxTokens: Number(recognitionMaxTokensInput?.value) || 8000,
          timeoutSeconds: Number(recognitionTimeoutInput?.value) || 120,
          language: recognitionLanguageSelect?.value || "auto",
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

  // Reachability check for an *already connected* server. Same call the setup
  // flow uses, against the stored URL rather than a typed one — a sync that
  // stops working is usually the server being unreachable, and being able to
  // confirm that without disconnecting first is the whole point.
  if (authenticated) {
    const testConnectedBtn = container.querySelector("#test-connection-connected-btn");
    const syncStatusSpan = container.querySelector("#sync-status");

    testConnectedBtn?.addEventListener("click", async () => {
      const serverUrl = credentials?.serverUrl || "";
      if (!serverUrl) {
        if (syncStatusSpan) {
          syncStatusSpan.textContent = t("settings.nextcloud.errorNoUrl");
          syncStatusSpan.style.color = "var(--nb-status-error)";
        }
        return;
      }

      testConnectedBtn.disabled = true;
      testConnectedBtn.textContent = t("settings.nextcloud.testing");
      if (syncStatusSpan) syncStatusSpan.textContent = "";

      try {
        const { testConnection } = await loadNextcloudSync();
        const result = await testConnection(serverUrl);
        if (syncStatusSpan) {
          syncStatusSpan.textContent = result.success
            ? `✓ Connected to Nextcloud ${result.versionstring}`
            : `✗ ${result.error}`;
          syncStatusSpan.style.color = result.success
            ? "var(--nb-status-success)"
            : "var(--nb-status-error)";
        }
      } catch (error) {
        if (syncStatusSpan) {
          syncStatusSpan.textContent = `✗ ${error.message}`;
          syncStatusSpan.style.color = "var(--nb-status-error)";
        }
      } finally {
        testConnectedBtn.disabled = false;
        testConnectedBtn.textContent = t("settings.nextcloud.testBtn");
      }
    });
  }

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
        statusSpan.style.color = "var(--nb-status-error)";
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
          statusSpan.style.color = "var(--nb-status-success)";
        } else {
          statusSpan.textContent = `✗ ${result.error}`;
          statusSpan.style.color = "var(--nb-status-error)";
        }
      } catch (error) {
        statusSpan.textContent = `✗ ${error.message}`;
        statusSpan.style.color = "var(--nb-status-error)";
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = t("settings.nextcloud.testBtn");
      }
    });

    connectBtn?.addEventListener("click", async () => {
      const serverUrl = urlInput.value.trim();

      if (!serverUrl) {
        statusSpan.textContent = t("settings.nextcloud.errorNoUrl");
        statusSpan.style.color = "var(--nb-status-error)";
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
        statusSpan.style.color = "var(--nb-status-success)";

        // Notify footer about auth change
        window.dispatchEvent(new CustomEvent("nextcloud-auth-changed"));

        // Reload settings to show authenticated state
        setTimeout(() => renderSettings(container), 1000);
      } catch (error) {
        console.error("Login flow error caught in settings:", error);
        const errorMessage = error?.message || error?.toString() || "Unknown error occurred";
        loginUrlContainer.classList.add("setting-item--hidden");
        statusSpan.textContent = `✗ ${errorMessage}`;
        statusSpan.style.color = "var(--nb-status-error)";
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
          syncStatus.style.color = "var(--nb-status-warning)";
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
          syncStatus.style.color = "var(--nb-status-warning)";
        } else {
          syncStatus.style.color = "var(--nb-status-success)";
        }

        syncStatus.textContent = statusMsg;
      } catch (error) {
        syncStatus.textContent = t("settings.nextcloud.syncFailed", { message: error.message });
        syncStatus.style.color = "var(--nb-status-error)";
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
        purgeStatus.style.color = "var(--nb-status-success)";
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
        purgeStatus.style.color = "var(--nb-status-error)";
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
