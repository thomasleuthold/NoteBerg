/**
 * i18n Module
 * Internationalization support using i18next
 */

import i18next from "i18next";
import { getSetting, setSetting } from "../modules/storage.js";
import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import it from "./locales/it.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import pt from "./locales/pt.json";
import zh from "./locales/zh.json";

const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

const resources = {
  en: { translation: en },
  de: { translation: de },
  fr: { translation: fr },
  es: { translation: es },
  it: { translation: it },
  zh: { translation: zh },
  pt: { translation: pt },
  ja: { translation: ja },
  ko: { translation: ko },
};

/**
 * Initialize the i18n system. Must be called after initStorage().
 * In Nextcloud: reads locale from OC.getLocale() instead of stored setting.
 */
export async function initI18n() {
  // In Nextcloud the user's locale comes from the server via OC.getLocale()
  const detectedLang = IS_NEXTCLOUD
    ? (window.OC?.getLocale?.() || "en").substring(0, 2) // e.g. "de_DE" → "de"
    : (await getSetting("ui_language")) || "en";
  // Guard against locales we don't have translations for (e.g. OC.getLocale()
  // returning "nl" or "pl") — fall back to English rather than reporting an
  // unregistered language as active.
  const savedLang = detectedLang in resources ? detectedLang : "en";

  await i18next.init({
    lng: savedLang,
    fallbackLng: "en",
    resources,
    interpolation: {
      escapeValue: false, // HTML is escaped at the call site where needed
    },
  });

  console.log(`i18n initialized: ${savedLang}`);
}

/**
 * Translate a key with optional interpolation values.
 * @param {string} key - Translation key (dot-notation)
 * @param {object} [options] - Interpolation variables
 * @returns {string}
 */
export function t(key, options) {
  return i18next.t(key, options);
}

/**
 * Get the currently active language code.
 * @returns {string}
 */
export function getCurrentLanguage() {
  return i18next.language;
}

/**
 * Change the UI language, persist the choice, and re-render the current view.
 * @param {string} lang - Language code (e.g. "en", "de")
 */
export async function changeLanguage(lang) {
  await i18next.changeLanguage(lang);
  await setSetting("ui_language", lang);

  // Re-render current view via router
  const { getCurrentMode, getCurrentNoteId, getCurrentNotebookId, navigateTo } = await import(
    "../modules/router.js"
  );
  navigateTo(getCurrentMode(), {
    noteId: getCurrentNoteId(),
    notebookId: getCurrentNotebookId(),
  });

  // Re-render persistent UI elements that the router doesn't touch
  const { updateSyncStatus } = await import("../modules/footer.js");
  updateSyncStatus();

  const { updateBreadcrumb } = await import("../modules/breadcrumb.js");
  const {
    getCurrentMode: mode,
    getCurrentNotebookId: nbId,
    getCurrentNoteId: nId,
  } = await import("../modules/router.js");
  updateBreadcrumb(mode(), nbId(), nId());

  // Overlays live outside the router's view tree, so the re-render above never
  // reaches them — the settings dialog (which is where the language is actually
  // changed) would otherwise keep its old strings until reopened.
  window.dispatchEvent(new CustomEvent("languagechange", { detail: { lang } }));
}
