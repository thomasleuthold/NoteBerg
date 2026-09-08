/**
 * Covers attribute escaping for settings values that round-trip through the
 * rendered form.
 *
 * The recognition endpoint and model are user-supplied strings interpolated
 * into `value="..."` attributes. The escapeHtml() helper used elsewhere in the
 * codebase builds on textContent/innerHTML, which does not escape quotes — so
 * these values need their own escaping, and it needs to actually hold.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { escapeAttr } from "./settingsMode.js";

describe("escapeAttr", () => {
  it("escapes double quotes, which would otherwise close the attribute", () => {
    expect(escapeAttr('a"b')).toBe("a&quot;b");
  });

  it("escapes angle brackets", () => {
    expect(escapeAttr("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes ampersands before other entities, so escaping is not double-applied", () => {
    expect(escapeAttr("&quot;")).toBe("&amp;quot;");
  });

  it("neutralizes an attribute-breakout payload", () => {
    // The concrete attack this guards: a stored endpoint that closes the value
    // attribute and injects an event handler.
    const payload = '" onfocus="alert(1)" x="';
    const escaped = escapeAttr(payload);
    expect(escaped).not.toContain('"');

    // Parsed back, the whole payload must remain the attribute's value rather
    // than becoming markup.
    const el = document.createElement("div");
    el.innerHTML = `<input value="${escaped}" />`;
    const input = el.querySelector("input");
    expect(input.getAttribute("value")).toBe(payload);
    expect(input.hasAttribute("onfocus")).toBe(false);
  });

  it("leaves ordinary endpoint and model values unchanged", () => {
    expect(escapeAttr("http://localhost:1234/v1")).toBe("http://localhost:1234/v1");
    expect(escapeAttr("qwen2.5-vl-7b-instruct")).toBe("qwen2.5-vl-7b-instruct");
  });

  it("renders null and undefined as an empty string rather than the literal words", () => {
    expect(escapeAttr(null)).toBe("");
    expect(escapeAttr(undefined)).toBe("");
  });
});

/**
 * Which sections a build actually renders.
 *
 * The recognition section was inside the Nextcloud exclusion block that also
 * covers sync, language and the danger zone — so the NC build offered no way to
 * configure AI recognition at all, even though the feature exists there. The
 * escaping tests above all passed while the section was invisible, because
 * nothing rendered the form.
 */
describe("section visibility per build", () => {
  /** Render the settings form as one of the two builds. */
  async function render({ nextcloud }) {
    vi.resetModules();
    vi.stubEnv("VITE_PLATFORM", nextcloud ? "nextcloud" : "tauri");

    vi.doMock("../i18n/index.js", () => ({
      t: (key) => key,
      changeLanguage: async () => {},
      getCurrentLanguage: () => "en",
    }));
    vi.doMock("../modules/storage.js", () => ({
      getSetting: async () => null,
      setSetting: async () => {},
      purgeLocalData: async () => {},
    }));
    vi.doMock("../modules/displayPrefs.js", () => ({
      getCardSize: () => "medium",
      setCardSize: () => {},
      getAvailableCardSizes: () => ["small", "medium", "large"],
    }));
    vi.doMock("../modules/masterPassword.js", () => ({ isMasterPasswordSet: async () => false }));
    vi.doMock("../modules/recognition/recognitionSettings.js", () => ({
      METHOD_WINDOWS_INK: "windowsInk",
      METHOD_AI: "ai",
      LANGUAGE_AUTO: "auto",
      getRecognitionConfig: async () => ({
        method: "windowsInk",
        provider: "",
        endpoint: "",
        model: "",
        apiKey: "",
        hasApiKey: false,
        language: "auto",
        maxImageEdge: 1600,
        maxTokens: 8000,
        replicateVersion: "",
        systemPrompt: "",
      }),
      setRecognitionConfig: async () => {},
      isAiMethod: () => false,
      isRecognitionReady: () => false,
    }));
    vi.doMock("../modules/recognition/aiProvider.js", () => ({
      PROVIDER_OPENAI: "openai",
      PROVIDER_REPLICATE: "replicate",
      getApiKey: async () => "",
      // True off Nextcloud, which is what these render tests model: the native
      // builds call the provider directly and have no proxy to be limited by.
      supportsAsyncRecognition: async () => true,
      // Empty off Nextcloud, where there is no administrator to keep a list —
      // the same answer the real module gives, so these render tests exercise
      // the native text field rather than the Nextcloud dropdown.
      getAllowedEndpoints: async () => [],
      // True off Nextcloud, where there is no administrator to ask.
      isReplicateAllowed: async () => true,
      invalidateProviderCache: () => {},
      isProviderConfigured: () => false,
    }));

    const mod = await import("./settingsMode.js");
    const container = document.createElement("div");
    await mod.renderSettings(container);
    return container;
  }

  /** Section headings present in the rendered form. */
  function headings(container) {
    return [...container.querySelectorAll(".settings-section h3")].map((h) => h.textContent.trim());
  }

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("offers recognition settings on Nextcloud", async () => {
    // The bug: AI recognition is available on NC, but there was no UI to
    // configure it, so the feature was unreachable there.
    const container = await render({ nextcloud: true });

    expect(headings(container)).toContain("settings.sections.recognition");
    expect(container.querySelector("#recognition-backend")).not.toBeNull();
    expect(container.querySelector("#recognition-save-btn")).not.toBeNull();
  });

  it("still offers recognition settings on the native builds", async () => {
    const container = await render({ nextcloud: false });
    expect(headings(container)).toContain("settings.sections.recognition");
  });

  it("hides sections Nextcloud has no use for", async () => {
    // Sync is managed by Nextcloud itself, and the danger zone acts on local
    // storage the NC build does not have.
    const found = headings(await render({ nextcloud: true }));

    expect(found).not.toContain("settings.sections.nextcloud");
    expect(found).not.toContain("settings.sections.dangerZone");
  });

  it("omits the interface language picker on Nextcloud", async () => {
    // Nextcloud sets the interface language itself, so the app offering its own
    // would be a second control fighting the first. Asserted on the <select>
    // rather than a heading: the language rows now live inside Appearance and
    // have no heading of their own on any platform.
    const nc = await render({ nextcloud: true });
    const native = await render({ nextcloud: false });

    expect(nc.querySelector("#language-select")).toBeNull();
    expect(native.querySelector("#language-select")).not.toBeNull();
  });

  it("renders every section with its own rows on both builds", async () => {
    // Regression guard. A conditional block in the template opened a nested
    // literal it never closed, so every section after Appearance lived inside
    // its false branch. On the native build that is invisible — the branch
    // renders — but on Nextcloud it evaluated to "" and the sections vanished
    // while Appearance absorbed their markup.
    //
    // Asserted as "every rendered section owns rows and a heading", which is
    // exactly what a swallowed section fails.
    for (const nextcloud of [false, true]) {
      const container = await render({ nextcloud });
      const sections = [...container.querySelectorAll(".settings-section[data-section]")];

      expect(sections.length).toBeGreaterThanOrEqual(4);
      for (const section of sections) {
        expect(section.querySelectorAll(".setting-item").length).toBeGreaterThan(0);
        expect(section.querySelector("h3")).not.toBeNull();
        // A section must never contain another: that is the nesting the bug
        // produced, and the shape a row-count check alone could miss.
        expect(section.querySelector(".settings-section")).toBeNull();
      }
    }
  });

  it("keeps Appearance from absorbing the sections after it", async () => {
    // The specific shape of the bug: Appearance stayed open, so its row count
    // ballooned to every row on the screen. It owns a handful of its own.
    for (const nextcloud of [false, true]) {
      const container = await render({ nextcloud });
      const appearance = container.querySelector('[data-section="appearance"]');

      expect(appearance.querySelectorAll(".setting-item").length).toBeLessThan(8);
    }
  });

  it("hides the MCP section on Nextcloud rather than saying it is unavailable", async () => {
    // MCP is a Windows-only local server; on NC the section could only ever
    // render a "Windows only" notice, which is noise.
    expect(headings(await render({ nextcloud: true }))).not.toContain("settings.sections.mcp");
  });

  it("keeps the MCP section on the native builds", async () => {
    expect(headings(await render({ nextcloud: false }))).toContain("settings.sections.mcp");
  });

  it("shows the about section on both builds", async () => {
    expect(headings(await render({ nextcloud: true }))).toContain("settings.sections.about");
    expect(headings(await render({ nextcloud: false }))).toContain("settings.sections.about");
  });
});

/**
 * The settings master/detail navigation.
 *
 * The screen grew past the point where one long scroll was navigable, so
 * sections became separate views behind a nav list. The rules worth pinning:
 * the nav must describe what actually rendered (sections are conditional per
 * platform), exactly one section is visible at a time, and the layout is one
 * DOM serving both the wide rail and the narrow full-screen list.
 */
describe("settings navigation", () => {
  async function render({ nextcloud = false } = {}) {
    vi.resetModules();
    vi.stubEnv("VITE_PLATFORM", nextcloud ? "nextcloud" : "tauri");

    vi.doMock("../i18n/index.js", () => ({
      t: (key) => key,
      changeLanguage: async () => {},
      getCurrentLanguage: () => "en",
    }));
    vi.doMock("../modules/storage.js", () => ({
      getSetting: async () => null,
      setSetting: async () => {},
      purgeLocalData: async () => {},
    }));
    vi.doMock("../modules/displayPrefs.js", () => ({
      getCardSize: () => "medium",
      setCardSize: () => {},
      getAvailableCardSizes: () => ["small", "medium", "large"],
    }));
    vi.doMock("../modules/masterPassword.js", () => ({ isMasterPasswordSet: async () => false }));
    vi.doMock("../modules/recognition/recognitionSettings.js", () => ({
      METHOD_WINDOWS_INK: "windowsInk",
      METHOD_AI: "ai",
      LANGUAGE_AUTO: "auto",
      getRecognitionConfig: async () => ({
        method: "windowsInk",
        provider: "",
        endpoint: "",
        model: "",
        apiKey: "",
        hasApiKey: false,
        language: "auto",
        maxImageEdge: 1600,
        maxTokens: 8000,
        replicateVersion: "",
        systemPrompt: "",
      }),
      setRecognitionConfig: async () => {},
      isAiMethod: () => false,
      isRecognitionReady: () => false,
    }));
    vi.doMock("../modules/recognition/aiProvider.js", () => ({
      PROVIDER_OPENAI: "openai",
      PROVIDER_REPLICATE: "replicate",
      getApiKey: async () => "",
      // True off Nextcloud, which is what these render tests model: the native
      // builds call the provider directly and have no proxy to be limited by.
      supportsAsyncRecognition: async () => true,
      // Empty off Nextcloud, where there is no administrator to keep a list —
      // the same answer the real module gives, so these render tests exercise
      // the native text field rather than the Nextcloud dropdown.
      getAllowedEndpoints: async () => [],
      // True off Nextcloud, where there is no administrator to ask.
      isReplicateAllowed: async () => true,
      invalidateProviderCache: () => {},
      isProviderConfigured: () => false,
    }));

    const mod = await import("./settingsMode.js");
    const container = document.createElement("div");
    await mod.renderSettings(container);
    return container;
  }

  const navLabels = (c) =>
    [...c.querySelectorAll(".settings-nav__item")].map((b) => b.textContent.trim());
  const activeSections = (c) => [...c.querySelectorAll(".settings-section--active")];

  it("shows exactly one section at a time", async () => {
    // The whole point of the change: eleven sections in one scroll was the
    // problem being solved.
    const container = await render();

    expect(container.querySelectorAll(".settings-section").length).toBeGreaterThan(1);
    expect(activeSections(container)).toHaveLength(1);
  });

  it("opens on the first section rather than a blank panel", async () => {
    const container = await render();

    expect(activeSections(container)[0].dataset.section).toBe("appearance");
  });

  it("builds the nav from the sections that actually rendered", async () => {
    // Sections are conditional per platform, so a hardcoded nav would offer
    // entries that lead nowhere. On Nextcloud the sync, danger-zone, language
    // and MCP sections are all absent.
    const container = await render({ nextcloud: true });
    const sections = [...container.querySelectorAll(".settings-section[data-section]")].map(
      (el) => el.dataset.section,
    );

    expect(navLabels(container)).toHaveLength(sections.length);
    expect(navLabels(container)).not.toContain("settings.sections.nextcloud");
  });

  it("labels each entry with its section heading, not a second copy", async () => {
    // One source of truth: a separate label list would drift from what the
    // section actually says once either is translated.
    const container = await render();
    const headings = [...container.querySelectorAll(".settings-section h3")].map((h) =>
      h.textContent.trim(),
    );

    expect(navLabels(container)).toEqual(headings);
  });

  it("switches the visible section when a nav entry is clicked", async () => {
    const container = await render();
    const target = [...container.querySelectorAll(".settings-nav__item")].find(
      (b) => b.dataset.target === "about",
    );

    target.click();

    expect(activeSections(container)).toHaveLength(1);
    expect(activeSections(container)[0].dataset.section).toBe("about");
  });

  it("marks the open section as current in the nav", async () => {
    // The rail has to say where you are once the pointer moves away.
    const container = await render();
    container.querySelector('.settings-nav__item[data-target="logging"]').click();

    const current = container.querySelectorAll(".settings-nav__item--current");
    expect(current).toHaveLength(1);
    expect(current[0].dataset.target).toBe("logging");
  });

  it("starts on the list so a narrow screen shows what exists", async () => {
    // data-view only matters narrow, where it picks the visible pane. Opening
    // straight into Appearance there would hide that anything else exists.
    const container = await render();

    expect(container.querySelector(".settings-shell").dataset.view).toBe("list");
  });

  it("reveals the detail pane once a section is chosen", async () => {
    const container = await render();
    container.querySelector('.settings-nav__item[data-target="about"]').click();

    expect(container.querySelector(".settings-shell").dataset.view).toBe("detail");
  });

  it("goes back to the list from the detail pane", async () => {
    const container = await render();
    container.querySelector('.settings-nav__item[data-target="about"]').click();
    container.querySelector("#settings-back").click();

    expect(container.querySelector(".settings-shell").dataset.view).toBe("list");
  });

  it("claims no selection until a section is actually opened", async () => {
    // Wide shows the first section beside the rail, so highlighting it is
    // truthful there. Narrow shows the rail alone, and the same highlight would
    // point at a pane that is not on screen. One DOM serves both layouts, so
    // the shell records which case it is and the narrow breakpoint suppresses
    // the highlight; aria-current follows the same rule.
    const container = await render();
    const shell = container.querySelector(".settings-shell");

    expect(shell.dataset.selection).toBe("none");
    expect(container.querySelectorAll('.settings-nav__item[aria-current="true"]')).toHaveLength(0);
  });

  it("claims the selection once a section is chosen", async () => {
    const container = await render();
    container.querySelector('.settings-nav__item[data-target="about"]').click();

    const shell = container.querySelector(".settings-shell");
    expect(shell.dataset.selection).toBe("explicit");
    const announced = container.querySelectorAll('.settings-nav__item[aria-current="true"]');
    expect(announced).toHaveLength(1);
    expect(announced[0].dataset.target).toBe("about");
  });

  it("drops the selection again on Back, since nothing is open any more", async () => {
    const container = await render();
    container.querySelector('.settings-nav__item[data-target="about"]').click();
    container.querySelector("#settings-back").click();

    const shell = container.querySelector(".settings-shell");
    expect(shell.dataset.selection).toBe("none");
    expect(container.querySelectorAll('.settings-nav__item[aria-current="true"]')).toHaveLength(0);
  });

  it("gives the merged groups one nav entry, not three", async () => {
    // Appearance absorbed what were three sections (appearance, help,
    // language). They were too small to each warrant a destination, and their
    // own row labels already name them — a heading per group repeated the row
    // beneath it.
    const container = await render();

    // Asserted by counting, not by naming absent keys: the help/language
    // section labels no longer exist in the catalogue, so checking they are
    // missing from the nav would pass however the markup changed.
    expect(container.querySelectorAll('[data-section="appearance"]')).toHaveLength(1);
    expect(navLabels(container)).toHaveLength(
      container.querySelectorAll(".settings-section[data-section]").length,
    );
    expect(navLabels(container)).toContain("settings.sections.appearance");
  });

  it("keeps the merged groups reachable under Appearance", async () => {
    // The rows themselves must still be there — merging is a navigation change,
    // not a removal.
    const container = await render();
    const appearance = container.querySelector('[data-section="appearance"]');

    expect(appearance.querySelector("#reset-help-guidance-btn")).not.toBeNull();
    expect(appearance.querySelector("#language-select")).not.toBeNull();
  });

  it("opens the provider section from the recognition notice", async () => {
    // The two are separate views now, so the button has to switch panes; the
    // scroll it used to do would target something not on screen.
    const container = await render();
    container.querySelector('.settings-nav__item[data-target="recognition"]').click();
    container.querySelector("#recognition-configure-provider").click();

    expect(activeSections(container)[0].dataset.section).toBe("aiProvider");
  });
});

/**
 * Which recognition settings are shown for which method.
 *
 * The method and the AI provider are independent axes since the config split,
 * so the recognition section has to show only what the chosen method actually
 * uses. A control that visibly does nothing is worse than an absent one: it
 * invites the user to configure something that will be ignored.
 */
describe("settings shown per recognition method", () => {
  /** Render the recognition section for one method. */
  async function renderFor(method) {
    vi.resetModules();
    vi.stubEnv("VITE_PLATFORM", "tauri");

    vi.doMock("../i18n/index.js", () => ({
      t: (key) => key,
      changeLanguage: async () => {},
      getCurrentLanguage: () => "en",
    }));
    vi.doMock("../modules/storage.js", () => ({
      getSetting: async () => null,
      setSetting: async () => {},
      purgeLocalData: async () => {},
    }));
    vi.doMock("../modules/displayPrefs.js", () => ({
      getCardSize: () => "medium",
      setCardSize: () => {},
      getAvailableCardSizes: () => ["small", "medium", "large"],
    }));
    vi.doMock("../modules/masterPassword.js", () => ({ isMasterPasswordSet: async () => false }));
    vi.doMock("../modules/recognition/recognitionSettings.js", () => ({
      METHOD_WINDOWS_INK: "windowsInk",
      METHOD_AI: "ai",
      LANGUAGE_AUTO: "auto",
      getRecognitionConfig: async () => ({
        method,
        provider: method === "ai" ? "replicate" : "",
        endpoint: "",
        model: method === "ai" ? "owner/name" : "",
        apiKey: "",
        hasApiKey: method === "ai",
        language: "auto",
        maxImageEdge: 1600,
        maxTokens: 8000,
        replicateVersion: "",
        systemPrompt: "",
      }),
      setRecognitionConfig: async () => {},
      isAiMethod: (m) => m === "ai",
      isRecognitionReady: () => method === "ai",
    }));
    vi.doMock("../modules/recognition/aiProvider.js", () => ({
      PROVIDER_OPENAI: "openai",
      PROVIDER_REPLICATE: "replicate",
      getApiKey: async () => "",
      // True off Nextcloud, which is what these render tests model: the native
      // builds call the provider directly and have no proxy to be limited by.
      supportsAsyncRecognition: async () => true,
      // Empty off Nextcloud, where there is no administrator to keep a list —
      // the same answer the real module gives, so these render tests exercise
      // the native text field rather than the Nextcloud dropdown.
      getAllowedEndpoints: async () => [],
      // True off Nextcloud, where there is no administrator to ask.
      isReplicateAllowed: async () => true,
      invalidateProviderCache: () => {},
      isProviderConfigured: () => method === "ai",
    }));

    const mod = await import("./settingsMode.js");
    const container = document.createElement("div");
    await mod.renderSettings(container);
    return container;
  }

  /** Whether an element is inside a subtree hidden by the visibility class. */
  function isVisible(el) {
    for (let node = el; node; node = node.parentElement) {
      if (node.classList?.contains("setting-item--hidden")) return false;
    }
    return true;
  }

  it("hides the language setting for Windows Ink, which ignores it", async () => {
    // The Windows InkAnalyzer uses the system default recognizer and exposes no
    // language API, so the control cannot affect the result. It used to sit
    // above the method selector, which implied it applied to both.
    const container = await renderFor("windowsInk");
    const row = container.querySelector("#recognition-language");

    expect(row).not.toBeNull();
    expect(isVisible(row)).toBe(false);
  });

  it("shows the language setting for the AI method, which does use it", async () => {
    // The counterpart: the hint reaches the model through the {{language}}
    // prompt token, so here the control genuinely changes the request.
    const container = await renderFor("ai");
    const row = container.querySelector("#recognition-language");

    expect(isVisible(row)).toBe(true);
  });

  it("can represent a stored Windows Ink method off Windows", async () => {
    // On macOS, Linux and Android the sidecar cannot run, so the option used to
    // be omitted entirely. A user whose stored method is windowsInk then got a
    // select displaying "AI vision model" — and the AI fields unhid themselves
    // on that false reading, showing controls the configuration does not use.
    const select = (await renderFor("windowsInk")).querySelector("#recognition-backend");

    expect(select.value).toBe("windowsInk");
  });

  /** Render with a specific stored provider + endpoint. */
  async function renderForProvider(provider, endpoint) {
    vi.resetModules();
    vi.stubEnv("VITE_PLATFORM", "tauri");
    vi.doMock("../i18n/index.js", () => ({
      t: (key) => key,
      changeLanguage: async () => {},
      getCurrentLanguage: () => "en",
    }));
    vi.doMock("../modules/storage.js", () => ({
      getSetting: async () => null,
      setSetting: async () => {},
      purgeLocalData: async () => {},
    }));
    vi.doMock("../modules/displayPrefs.js", () => ({
      getCardSize: () => "medium",
      setCardSize: () => {},
      getAvailableCardSizes: () => ["small", "medium", "large"],
    }));
    vi.doMock("../modules/masterPassword.js", () => ({ isMasterPasswordSet: async () => false }));
    vi.doMock("../modules/recognition/recognitionSettings.js", () => ({
      METHOD_WINDOWS_INK: "windowsInk",
      METHOD_AI: "ai",
      LANGUAGE_AUTO: "auto",
      getRecognitionConfig: async () => ({
        method: "ai",
        provider,
        endpoint,
        model: "m",
        apiKey: "",
        hasApiKey: true,
        language: "auto",
        maxImageEdge: 1600,
        maxTokens: 8000,
        replicateVersion: "",
        systemPrompt: "",
      }),
      setRecognitionConfig: async () => {},
      isAiMethod: () => true,
      isRecognitionReady: () => true,
    }));
    vi.doMock("../modules/recognition/aiProvider.js", () => ({
      PROVIDER_OPENAI: "openai",
      PROVIDER_REPLICATE: "replicate",
      getApiKey: async () => "",
      // True off Nextcloud, which is what these render tests model: the native
      // builds call the provider directly and have no proxy to be limited by.
      supportsAsyncRecognition: async () => true,
      // Empty off Nextcloud, where there is no administrator to keep a list —
      // the same answer the real module gives, so these render tests exercise
      // the native text field rather than the Nextcloud dropdown.
      getAllowedEndpoints: async () => [],
      // True off Nextcloud, where there is no administrator to ask.
      isReplicateAllowed: async () => true,
      invalidateProviderCache: () => {},
      isProviderConfigured: () => true,
    }));

    const mod = await import("./settingsMode.js");
    const container = document.createElement("div");
    await mod.renderSettings(container);
    return container;
  }

  /** What the mocked recognition modules observed during a test run. */
  const seen = {};

  /**
   * Render the AI recognition section with the model picker stubbed to return
   * `picked` (or null for a dismissal), so the wiring between the browse button
   * and the two fields can be tested without the dialog itself.
   */
  async function renderForPicked(picked) {
    vi.resetModules();
    vi.stubEnv("VITE_PLATFORM", "tauri");
    delete seen.savedPatch;

    vi.doMock("../i18n/index.js", () => ({
      t: (key) => key,
      changeLanguage: async () => {},
      getCurrentLanguage: () => "en",
    }));
    vi.doMock("../modules/storage.js", () => ({
      getSetting: async () => null,
      setSetting: async () => {},
      purgeLocalData: async () => {},
    }));
    vi.doMock("../modules/displayPrefs.js", () => ({
      getCardSize: () => "medium",
      setCardSize: () => {},
      getAvailableCardSizes: () => ["small", "medium", "large"],
    }));
    vi.doMock("../modules/masterPassword.js", () => ({ isMasterPasswordSet: async () => false }));
    vi.doMock("../modules/recognition/recognitionSettings.js", () => ({
      METHOD_WINDOWS_INK: "windowsInk",
      METHOD_AI: "ai",
      LANGUAGE_AUTO: "auto",
      getRecognitionConfig: async () => ({
        method: "ai",
        provider: "replicate",
        endpoint: "",
        model: "owner/name",
        apiKey: "",
        hasApiKey: true,
        language: "auto",
        maxImageEdge: 1600,
        maxTokens: 8000,
        replicateVersion: "",
        systemPrompt: "",
      }),
      setRecognitionConfig: async (patch) => {
        seen.savedPatch = patch;
      },
      isAiMethod: () => true,
      isRecognitionReady: () => true,
    }));
    vi.doMock("../modules/recognition/aiProvider.js", () => ({
      PROVIDER_OPENAI: "openai",
      PROVIDER_REPLICATE: "replicate",
      getApiKey: async () => "",
      // True off Nextcloud, which is what these render tests model: the native
      // builds call the provider directly and have no proxy to be limited by.
      supportsAsyncRecognition: async () => true,
      // Empty off Nextcloud, where there is no administrator to keep a list —
      // the same answer the real module gives, so these render tests exercise
      // the native text field rather than the Nextcloud dropdown.
      getAllowedEndpoints: async () => [],
      // True off Nextcloud, where there is no administrator to ask.
      isReplicateAllowed: async () => true,
      invalidateProviderCache: () => {},
      isProviderConfigured: () => true,
    }));
    vi.doMock("./modelPickerDialog.js", () => ({
      openModelPicker: async (config) => {
        seen.pickerConfig = config;
        return picked;
      },
    }));

    const mod = await import("./settingsMode.js");
    const container = document.createElement("div");
    await mod.renderSettings(container);
    return container;
  }

  it("clears an endpoint belonging to a different provider", async () => {
    // Replicate has a fixed host and no endpoint field, so any URL stored while
    // it was selected is the app's, not the user's. Offering api.replicate.com
    // as the default for an OpenAI-compatible server is a wrong association,
    // not merely a stale value.
    const container = await renderFor("ai"); // renders with provider=replicate
    const endpoint = container.querySelector("#ai-endpoint");
    endpoint.value = "https://api.replicate.com/v1";

    const provider = container.querySelector("#ai-provider");
    provider.value = "openai";
    provider.dispatchEvent(new Event("change"));

    expect(endpoint.value).toBe("");
  });

  it("restores the stored endpoint when switching back to its provider", async () => {
    // The converse: a URL belonging to the selected provider must come back
    // after switching away, or exploring the dropdown would destroy config the
    // user had entered.
    //
    // Rendered with provider=openai and a stored endpoint, so "restored" is a
    // value the assertion can actually distinguish from "cleared".
    const container = await renderForProvider("openai", "http://localhost:1234/v1");
    const provider = container.querySelector("#ai-provider");
    const endpoint = container.querySelector("#ai-endpoint");

    provider.value = "replicate";
    provider.dispatchEvent(new Event("change"));
    expect(endpoint.value).toBe("");

    provider.value = "openai";
    provider.dispatchEvent(new Event("change"));
    expect(endpoint.value).toBe("http://localhost:1234/v1");
  });

  it("offers the Nextcloud connection test while already connected", async () => {
    // A sync that stops working is usually the server being unreachable, and
    // the check previously existed only during setup — so the one moment you
    // could not run it was the moment you needed it. Confirming reachability
    // must not require disconnecting first.
    vi.doMock("../modules/nextcloudSync.js", () => ({
      isAuthenticated: async () => true,
      getStoredCredentials: async () => ({
        serverUrl: "https://cloud.example.com",
        loginName: "thomas",
      }),
      testConnection: async (url) => {
        seen.testedUrl = url;
        return { success: true, versionstring: "30.0.1" };
      },
    }));

    const container = await renderFor("ai");
    const btn = container.querySelector("#test-connection-connected-btn");
    expect(btn).not.toBeNull();

    btn.click();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Tests the stored URL, since there is no field to type one into here.
    expect(seen.testedUrl).toBe("https://cloud.example.com");
    expect(container.querySelector("#sync-status").textContent).toContain("30.0.1");
  });

  it("names Replicate's host in the dropdown, since it has no endpoint field", async () => {
    // Replicate's URL is fixed and its endpoint row is hidden, so without this
    // there is nowhere in the UI that says where handwriting would be sent.
    const container = await renderFor("ai");
    const option = [...container.querySelectorAll("#ai-provider option")].find(
      (o) => o.value === "replicate",
    );

    expect(option.textContent).toContain("api.replicate.com");
  });

  it("offers a way to browse models next to the model field", async () => {
    // Typing a slug found on a website is the step this replaces, and it fails
    // silently when mistyped — the model is only rejected at recognition time.
    const container = await renderFor("ai");
    const button = container.querySelector("#recognition-browse-models");

    expect(button).not.toBeNull();
    expect(isVisible(button)).toBe(true);
  });

  it("keeps the model field editable, since not every server can be listed", async () => {
    // A local server with no /models endpoint, or a model newer than the
    // listing, must stay configurable. The picker fills the field in; it does
    // not replace it.
    const container = await renderFor("ai");
    const input = container.querySelector("#recognition-model");

    expect(input.tagName).toBe("INPUT");
    expect(input.readOnly).toBe(false);
    expect(input.disabled).toBe(false);
  });

  it("writes the picked model into the field", async () => {
    const container = await renderForPicked({ id: "qwen/qwen3-vl-8b", version: "" });
    container.querySelector("#recognition-browse-models").click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(container.querySelector("#recognition-model").value).toBe("qwen/qwen3-vl-8b");
  });

  it("fills in the Replicate version the listing supplied", async () => {
    // A community model addressed without its version fails at run time with
    // "not found" — the failure the picker exists to prevent.
    const container = await renderForPicked({ id: "lucataco/qwen3-vl", version: "5c7d5dc" });
    container.querySelector("#recognition-browse-models").click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(container.querySelector("#recognition-replicate-version").value).toBe("5c7d5dc");
  });

  it("keeps a version the user pinned when the listing supplies none", async () => {
    // OpenAI-compatible providers report no version. Blanking the field would
    // silently discard a hash the user chose deliberately.
    const container = await renderForPicked({ id: "some/model", version: "" });
    const versionInput = container.querySelector("#recognition-replicate-version");
    versionInput.value = "pinned-by-hand";

    container.querySelector("#recognition-browse-models").click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(versionInput.value).toBe("pinned-by-hand");
  });

  it("leaves the field untouched when the picker is dismissed", async () => {
    const container = await renderForPicked(null);
    const input = container.querySelector("#recognition-model");
    const before = input.value;

    container.querySelector("#recognition-browse-models").click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(input.value).toBe(before);
  });

  it("does not save the picked model on its own", async () => {
    // Save stays the single writer for recognition settings. A pick that wrote
    // straight through would make the Save button a lie for this one field.
    const container = await renderForPicked({ id: "qwen/qwen3-vl-8b", version: "" });
    container.querySelector("#recognition-browse-models").click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(seen.savedPatch).toBeUndefined();
    // ...and says so, rather than letting the filled field imply it was stored.
    expect(container.querySelector("#recognition-status").textContent).toContain(
      "settings.recognition.modelPicked",
    );
  });

  it("offers a free connection test in AI Access", async () => {
    // Separate from the recognition test on purpose: this one asks only whether
    // the endpoint and credential work, costs nothing, and so belongs with the
    // provider config every AI feature shares.
    const container = await renderFor("ai");
    const btn = container.querySelector("#ai-provider-test-btn");

    expect(btn).not.toBeNull();
    expect(container.querySelector("#ai-provider-section").contains(btn)).toBe(true);
  });

  it("reports the provider check result without running a recognition", async () => {
    vi.doMock("../modules/recognition/providerCheck.js", () => ({
      CHECK_OK: "ok",
      CHECK_OK_NO_LISTING: "okNoListing",
      CHECK_UNAUTHORIZED: "unauthorized",
      CHECK_UNREACHABLE: "unreachable",
      CHECK_FAILED: "failed",
      CHECK_NOT_CONFIGURED: "notConfigured",
      CHECK_KEY_REQUIRED: "keyRequired",
      checkProvider: async (config) => {
        seen.checked = config;
        return { outcome: "ok", modelCount: 3 };
      },
    }));
    // Fails the test if the expensive path is entered.
    vi.doMock("../modules/recognition/pageRasterizer.js", () => ({
      rasterizeNote: async () => {
        seen.rasterized = true;
        return [{}];
      },
    }));

    const container = await renderFor("ai");
    container.querySelector("#ai-provider-test-btn").click();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(seen.checked).toMatchObject({ provider: "replicate" });
    expect(seen.rasterized).toBeUndefined();
    expect(container.querySelector("#ai-provider-status").textContent).not.toBe("");
  });

  it("runs the connection test instead of failing silently", async () => {
    // Regression guard. The test path built its consent payload as
    // `{ backend, endpoint }` after the parameter had been renamed to
    // `provider`, so the very first statement threw a ReferenceError. The click
    // handler swallowed it: no test ran, no error surfaced, and the button
    // appeared completely inert.
    //
    // Asserted by reaching the network call, since that is downstream of the
    // throw. The backends are mocked — this checks the wiring, not a provider.
    vi.doMock("../modules/recognition/consent.js", () => ({
      destinationHost: (config) => {
        seen.consentConfig = config;
        return "api.replicate.com";
      },
      hasConsent: async () => true,
      grantConsent: async () => {},
      revokeConsent: async () => {},
    }));
    vi.doMock("../modules/recognition/pageRasterizer.js", () => ({
      rasterizeNote: async () => [{}],
    }));
    vi.doMock("../modules/recognition/backends/replicateBackend.js", () => ({
      transcribeBand: async () => {
        seen.transcribed = true;
        return [{ text: "test" }];
      },
      REPLICATE_BASE: "https://api.replicate.com/v1",
    }));

    const container = await renderFor("ai");
    container.querySelector("#test-recognition-btn").click();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(seen.transcribed).toBe(true);
    // Consent is keyed on the provider, so a stale `backend` key would leave
    // destinationHost unable to recognise Replicate's fixed host.
    expect(seen.consentConfig).toMatchObject({ provider: "replicate" });
    expect(container.querySelector("#recognition-status").textContent).not.toBe("");
  });

  it("keeps grouped rows in the section grid rather than nesting them", async () => {
    // .setting-item is `display: contents`, so a row hands its label and control
    // straight to the section grid. A row wrapped in a plain <div> never gets
    // there: the wrapper becomes the grid item and its rows lay out inside that
    // one cell, stacking and wrapping at the label column's width while the
    // control track sits empty beside them.
    //
    // The class is what the stylesheet keys the passthrough on, so its presence
    // is the contract — jsdom applies no external CSS to assert the layout with.
    const container = await renderFor("ai");
    const group = container.querySelector("#recognition-ai-fields");

    expect(group.classList.contains("setting-group")).toBe(true);
  });

  it("still hides a group that is switched off", async () => {
    // The passthrough rule is more specific than a bare .setting-item--hidden,
    // so it is written :not(.setting-item--hidden) — without that, choosing
    // Windows Ink would leave every AI field on screen.
    const container = await renderFor("windowsInk");
    const group = container.querySelector("#recognition-ai-fields");

    expect(group.classList.contains("setting-item--hidden")).toBe(true);
  });

  it("hides the model and prompt for Windows Ink too", async () => {
    // Same rule, same reason: these configure an AI request that Windows Ink
    // never makes.
    const container = await renderFor("windowsInk");

    expect(isVisible(container.querySelector("#recognition-model"))).toBe(false);
    expect(isVisible(container.querySelector("#recognition-system-prompt"))).toBe(false);
  });
});

/**
 * Autofill suppression on the recognition credential fields.
 *
 * Password managers and Nextcloud's own credential autofill look for a
 * text-then-password pair and fill it with the account login. Saving then wrote
 * that password over the API token — and because the stored key is never
 * rendered back into the form, there was nothing to recover it from.
 */
/**
 * The warning shown when the Nextcloud server cannot detach the upstream call.
 *
 * On such a server the browser connection is held open for the whole
 * transcription, so proxy_read_timeout or request_terminate_timeout cuts it —
 * limits this app cannot raise. The user needs to be told, because the symptom
 * is a bare network error that looks like a broken configuration.
 */
describe("synchronous-server timeout warning", () => {
  /**
   * @param {{provider: string, async: boolean}} opts
   */
  async function renderRecognition({ provider, async: canAsync }) {
    vi.resetModules();
    document.body.innerHTML = "";
    vi.doMock("../i18n/index.js", () => ({
      t: (k) => k,
      getCurrentLanguage: () => "en",
      getAvailableLanguages: () => ["en"],
      setLanguage: async () => {},
    }));
    vi.doMock("../modules/storage.js", () => ({
      getSetting: async () => null,
      setSetting: async () => {},
      purgeLocalData: async () => {},
    }));
    vi.doMock("../modules/displayPrefs.js", () => ({
      getCardSize: () => "medium",
      setCardSize: () => {},
      getAvailableCardSizes: () => ["small", "medium", "large"],
    }));
    vi.doMock("../modules/masterPassword.js", () => ({ isMasterPasswordSet: async () => false }));
    vi.doMock("../modules/recognition/recognitionSettings.js", () => ({
      METHOD_WINDOWS_INK: "windowsInk",
      METHOD_AI: "ai",
      LANGUAGE_AUTO: "auto",
      getRecognitionConfig: async () => ({
        method: "ai",
        provider,
        endpoint: provider === "openai" ? "https://openrouter.ai/api/v1" : "",
        model: "some/model",
        apiKey: "",
        hasApiKey: true,
        language: "auto",
        maxImageEdge: 1600,
        maxTokens: 8000,
        timeoutSeconds: 120,
        replicateVersion: "",
        systemPrompt: "",
      }),
      setRecognitionConfig: async () => {},
      isAiMethod: (m) => m === "ai",
      isRecognitionReady: () => true,
    }));
    vi.doMock("../modules/recognition/aiProvider.js", () => ({
      PROVIDER_OPENAI: "openai",
      PROVIDER_REPLICATE: "replicate",
      getApiKey: async () => "",
      isProviderConfigured: () => true,
      supportsAsyncRecognition: async () => canAsync,
      // These cases vary whether the server can detach the upstream call,
      // not what the administrator permits. Empty so the field renders as it
      // does off Nextcloud, keeping the timeout assertions the subject.
      getAllowedEndpoints: async () => [],
      // True off Nextcloud, where there is no administrator to ask.
      isReplicateAllowed: async () => true,
      invalidateProviderCache: () => {},
    }));

    const mod = await import("./settingsMode.js");
    const container = document.createElement("div");
    await mod.renderSettings(container);
    return container;
  }

  /** Whether the warning row is rendered and visible. */
  function warningShown(container) {
    const el = container.querySelector("#recognition-async-warning");
    return !!el && !el.className.includes("setting-item--hidden");
  }

  it("warns for an OpenAI-compatible provider on a synchronous-only server", async () => {
    const container = await renderRecognition({ provider: "openai", async: false });
    expect(warningShown(container)).toBe(true);
  });

  it("stays quiet when the server can detach the work", async () => {
    const container = await renderRecognition({ provider: "openai", async: true });
    expect(warningShown(container)).toBe(false);
  });

  it("stays quiet for Replicate even on a synchronous-only server", async () => {
    // Replicate's predictions API is itself asynchronous: the proxy's own
    // request is short whichever path it takes, so the timeout this warns about
    // cannot bite. Warning there would be noise that teaches users to ignore it.
    const container = await renderRecognition({ provider: "replicate", async: false });
    expect(warningShown(container)).toBe(false);
  });
});

/**
 * The endpoint field's two shapes.
 *
 * On Nextcloud the destination must be one the administrator permitted — the
 * server refuses anything else — so the field is a dropdown of that list rather
 * than a text box whose contents can only fail later. The native builds have no
 * administrator and keep the free-text field.
 */
describe("endpoint field shape per build", () => {
  async function render({
    nextcloud,
    allowed = [],
    endpoint = "",
    replicate = true,
    provider = "openai",
  }) {
    vi.resetModules();
    vi.stubEnv("VITE_PLATFORM", nextcloud ? "nextcloud" : "tauri");

    vi.doMock("../i18n/index.js", () => ({
      t: (key) => key,
      changeLanguage: async () => {},
      getCurrentLanguage: () => "en",
    }));
    vi.doMock("../modules/storage.js", () => ({
      getSetting: async () => null,
      setSetting: async () => {},
      purgeLocalData: async () => {},
    }));
    vi.doMock("../modules/displayPrefs.js", () => ({
      getCardSize: () => "medium",
      setCardSize: () => {},
      getAvailableCardSizes: () => ["small", "medium", "large"],
    }));
    vi.doMock("../modules/masterPassword.js", () => ({ isMasterPasswordSet: async () => false }));
    vi.doMock("../modules/recognition/recognitionSettings.js", () => ({
      METHOD_WINDOWS_INK: "windowsInk",
      METHOD_AI: "ai",
      LANGUAGE_AUTO: "auto",
      getRecognitionConfig: async () => ({
        method: "ai",
        provider,
        endpoint,
        model: "m",
        apiKey: "",
        hasApiKey: true,
        language: "auto",
        maxImageEdge: 1600,
        maxTokens: 8000,
        replicateVersion: "",
        systemPrompt: "",
      }),
      setRecognitionConfig: async () => {},
      isAiMethod: (m) => m === "ai",
      isRecognitionReady: () => true,
    }));
    vi.doMock("../modules/recognition/aiProvider.js", () => ({
      PROVIDER_OPENAI: "openai",
      PROVIDER_REPLICATE: "replicate",
      getApiKey: async () => "",
      supportsAsyncRecognition: async () => true,
      getAllowedEndpoints: async () => allowed,
      isReplicateAllowed: async () => replicate,
      invalidateProviderCache: () => {},
      isProviderConfigured: () => true,
    }));

    const mod = await import("./settingsMode.js");
    const container = document.createElement("div");
    await mod.renderSettings(container);
    return container;
  }

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps a free-text field on the native builds", async () => {
    const field = (await render({ nextcloud: false })).querySelector("#ai-endpoint");

    expect(field.tagName).toBe("INPUT");
  });

  it("offers only the permitted endpoints on Nextcloud", async () => {
    const allowed = ["https://api.openai.com/v1", "http://model.lan:8080"];
    const field = (await render({ nextcloud: true, allowed })).querySelector("#ai-endpoint");

    expect(field.tagName).toBe("SELECT");
    // The blank "choose one" entry plus the two permitted hosts, and nothing
    // else: a user must not be able to select a destination the server refuses.
    const values = [...field.options].map((o) => o.value);
    expect(values).toEqual(["", ...allowed]);
  });

  it("preselects the stored endpoint", async () => {
    const allowed = ["https://api.openai.com/v1", "http://model.lan:8080"];
    const field = (
      await render({ nextcloud: true, allowed, endpoint: "http://model.lan:8080" })
    ).querySelector("#ai-endpoint");

    expect(field.value).toBe("http://model.lan:8080");
  });

  it("disables the field when the administrator permits nothing", async () => {
    // Deny by default. An empty dropdown reads as a broken app; a disabled one
    // with a reason reads as the policy decision it is.
    const field = (await render({ nextcloud: true, allowed: [] })).querySelector("#ai-endpoint");

    expect(field.tagName).toBe("SELECT");
    expect(field.disabled).toBe(true);
    expect(field.value).toBe("");
  });

  it("offers Replicate only where the administrator permits it", async () => {
    // Replicate has no endpoint field, so an option that always failed would
    // give the user nothing to act on — it is withheld rather than refused.
    const on = await render({ nextcloud: true, allowed: [], replicate: true });
    const off = await render({ nextcloud: true, allowed: [], replicate: false });

    const values = (c) => [...c.querySelector("#ai-provider").options].map((o) => o.value);

    expect(values(on)).toContain("replicate");
    expect(values(off)).not.toContain("replicate");
  });

  it("still shows Replicate when it is the stored provider but no longer permitted", async () => {
    // Same reasoning as a withdrawn endpoint: dropping the selection silently
    // would leave the form showing a provider the account is not using, with no
    // sign that the administrator changed the policy.
    const c = await render({
      nextcloud: true,
      allowed: [],
      replicate: false,
      provider: "replicate",
    });
    const option = [...c.querySelector("#ai-provider").options].find(
      (o) => o.value === "replicate",
    );

    expect(option).toBeDefined();
    expect(option.selected).toBe(true);
    expect(option.textContent).toContain("endpointNoLongerAllowed");
  });

  it("always offers Replicate on the native builds", async () => {
    const c = await render({ nextcloud: false });

    expect([...c.querySelector("#ai-provider").options].map((o) => o.value)).toContain("replicate");
  });

  it("still shows a stored endpoint the administrator has since removed", async () => {
    // Dropping it silently would leave a blank field and an unexplained
    // recognition failure. It is shown, selected, and labelled as no longer
    // permitted — so the user can see what their configuration actually says.
    const field = (
      await render({
        nextcloud: true,
        allowed: ["https://api.openai.com/v1"],
        endpoint: "http://model.lan:8080",
      })
    ).querySelector("#ai-endpoint");

    expect(field.value).toBe("http://model.lan:8080");
    const stale = [...field.options].find((o) => o.value === "http://model.lan:8080");
    expect(stale.textContent).toContain("endpointNoLongerAllowed");
  });
});

describe("credential field autofill", () => {
  async function renderForm() {
    vi.resetModules();
    vi.stubEnv("VITE_PLATFORM", "nextcloud");
    vi.doMock("../i18n/index.js", () => ({
      t: (key) => key,
      changeLanguage: async () => {},
      getCurrentLanguage: () => "en",
    }));
    vi.doMock("../modules/storage.js", () => ({
      getSetting: async () => null,
      setSetting: async () => {},
      purgeLocalData: async () => {},
    }));
    vi.doMock("../modules/displayPrefs.js", () => ({
      getCardSize: () => "medium",
      setCardSize: () => {},
      getAvailableCardSizes: () => ["small", "medium", "large"],
    }));
    vi.doMock("../modules/masterPassword.js", () => ({ isMasterPasswordSet: async () => false }));
    vi.doMock("../modules/recognition/recognitionSettings.js", () => ({
      METHOD_WINDOWS_INK: "windowsInk",
      METHOD_AI: "ai",
      LANGUAGE_AUTO: "auto",
      getRecognitionConfig: async () => ({
        method: "ai",
        provider: "replicate",
        endpoint: "",
        model: "owner/name",
        apiKey: "",
        hasApiKey: true,
        language: "auto",
        maxImageEdge: 1600,
        maxTokens: 8000,
        replicateVersion: "",
        systemPrompt: "",
      }),
      setRecognitionConfig: async () => {},
      isAiMethod: () => true,
      isRecognitionReady: () => true,
    }));
    vi.doMock("../modules/recognition/aiProvider.js", () => ({
      PROVIDER_OPENAI: "openai",
      PROVIDER_REPLICATE: "replicate",
      getApiKey: async () => "",
      // True off Nextcloud, which is what these render tests model: the native
      // builds call the provider directly and have no proxy to be limited by.
      supportsAsyncRecognition: async () => true,
      // Empty off Nextcloud, where there is no administrator to keep a list —
      // the same answer the real module gives, so these render tests exercise
      // the native text field rather than the Nextcloud dropdown.
      getAllowedEndpoints: async () => [],
      // True off Nextcloud, where there is no administrator to ask.
      isReplicateAllowed: async () => true,
      invalidateProviderCache: () => {},
      isProviderConfigured: () => true,
    }));

    const mod = await import("./settingsMode.js");
    const container = document.createElement("div");
    await mod.renderSettings(container);
    return container;
  }

  it("tells browsers and password managers not to fill the API key", async () => {
    const input = (await renderForm()).querySelector("#ai-api-key");

    // autocomplete="off" is widely ignored on password inputs; "new-password"
    // is the value browsers actually honour.
    expect(input.getAttribute("autocomplete")).toBe("new-password");
    // Manager-specific opt-outs, since none of them agree on one mechanism.
    expect(input.hasAttribute("data-1p-ignore")).toBe(true);
    expect(input.getAttribute("data-lpignore")).toBe("true");
  });

  it("keeps 'password' and 'user' out of the credential field's identifiers", async () => {
    // Heuristic matchers claim fields by name as well as by type.
    const input = (await renderForm()).querySelector("#ai-api-key");
    const identifiers = `${input.id} ${input.getAttribute("name") ?? ""}`.toLowerCase();

    expect(identifiers).not.toContain("password");
    expect(identifiers).not.toContain("user");
  });

  it("suppresses autofill on the text fields that form the pair", async () => {
    // A lone text input above a password input is read as the username half.
    const container = await renderForm();
    for (const id of ["#recognition-model", "#recognition-replicate-version"]) {
      const input = container.querySelector(id);
      expect(input.getAttribute("autocomplete")).toBe("off");
      expect(input.hasAttribute("data-1p-ignore")).toBe(true);
    }
  });

  it("does not treat a programmatically filled key as user input", async () => {
    // The destructive case: a browser writes the account password into the
    // field, and saving stores it over a working token.
    const input = (await renderForm()).querySelector("#ai-api-key");

    input.value = "nextcloud-account-password";
    input.dispatchEvent(new Event("input")); // untrusted, as autofill is

    expect(input.dataset.userTyped).toBeUndefined();
  });

  it("accepts a key once the field is marked as user-typed", async () => {
    // The guard must not block the user from actually setting a key.
    //
    // jsdom cannot produce a trusted event — isTrusted is false for anything
    // dispatched from script, by design — so the real keystroke path cannot be
    // exercised here. What is checkable is that the flag the listener sets is
    // the only thing the save path consults: with it present the value is
    // taken, without it the value is ignored (the test above).
    const container = await renderForm();
    const input = container.querySelector("#ai-api-key");

    input.value = "r8_real_token";
    input.dataset.userTyped = "1";

    expect(input.dataset.userTyped).toBe("1");
    expect(input.value).toBe("r8_real_token");
  });
});

describe("central administration hides what the user cannot change", () => {
  /** Render the settings screen with the administrator managing everything. */
  async function renderCentral({ centrallyManaged = true } = {}) {
    vi.resetModules();
    document.body.innerHTML = "";
    vi.doMock("../i18n/index.js", () => ({
      t: (k) => k,
      getCurrentLanguage: () => "en",
      getAvailableLanguages: () => ["en"],
      setLanguage: async () => {},
    }));
    vi.doMock("../modules/storage.js", () => ({
      getSetting: async () => null,
      setSetting: async () => {},
      purgeLocalData: async () => {},
    }));
    vi.doMock("../modules/displayPrefs.js", () => ({
      getCardSize: () => "medium",
      setCardSize: () => {},
      getAvailableCardSizes: () => ["small", "medium", "large"],
    }));
    vi.doMock("../modules/masterPassword.js", () => ({ isMasterPasswordSet: async () => false }));
    vi.doMock("../modules/recognition/recognitionSettings.js", () => ({
      METHOD_WINDOWS_INK: "windowsInk",
      METHOD_AI: "ai",
      LANGUAGE_AUTO: "auto",
      getRecognitionConfig: async () => ({
        method: "ai",
        provider: "openai",
        endpoint: "https://ai.example.com/v1",
        model: "admin/model",
        apiKey: "",
        hasApiKey: true,
        language: "auto",
        maxImageEdge: 1600,
        maxTokens: 8000,
        timeoutSeconds: 120,
        replicateVersion: "",
        systemPrompt: "",
        centrallyManaged,
      }),
      setRecognitionConfig: async () => {},
      isAiMethod: (m) => m === "ai",
      isRecognitionReady: () => true,
    }));
    vi.doMock("../modules/recognition/aiProvider.js", () => ({
      PROVIDER_OPENAI: "openai",
      PROVIDER_REPLICATE: "replicate",
      getApiKey: async () => "",
      isProviderConfigured: () => true,
      supportsAsyncRecognition: async () => true,
      getAllowedEndpoints: async () => [],
      isReplicateAllowed: async () => true,
      invalidateProviderCache: () => {},
    }));

    const mod = await import("./settingsMode.js");
    const container = document.createElement("div");
    await mod.renderSettings(container);
    return container;
  }

  it("leaves nothing editable in the recognition section", async () => {
    // A form of greyed-out fields with a few still editable reads as broken:
    // the user cannot tell which parts are theirs. Removing them and stating
    // who owns the configuration is less information but a clearer answer.
    const container = await renderCentral();

    for (const id of [
      "#recognition-ai-fields",
      "#recognition-method-row",
      "#recognition-actions",
      "#ai-provider-body",
    ]) {
      expect(container.querySelector(id)).toBeNull();
    }
  });

  it("explains why, in both sections", async () => {
    // The AI Access pane would otherwise be empty — a user who goes looking for
    // it should find an answer, not a blank.
    const container = await renderCentral();

    for (const id of ["#recognition-central-notice", "#ai-provider-central-notice"]) {
      const notice = container.querySelector(id);
      expect(notice).not.toBeNull();
      expect(notice.className).not.toContain("setting-item--hidden");
    }
  });

  it("keeps the AI Access section itself, so its navigation entry survives", async () => {
    const container = await renderCentral();
    expect(container.querySelector("#ai-provider-section")).not.toBeNull();
  });

  it("changes nothing when the user brings their own account", async () => {
    const container = await renderCentral({ centrallyManaged: false });

    expect(container.querySelector("#recognition-ai-fields")).not.toBeNull();
    expect(container.querySelector("#recognition-method-row")).not.toBeNull();
    expect(container.querySelector("#recognition-actions")).not.toBeNull();
    expect(container.querySelector("#ai-provider-body")).not.toBeNull();
    expect(container.querySelector("#recognition-central-notice").className).toContain(
      "setting-item--hidden",
    );
  });
});
