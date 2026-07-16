/**
 * src/i18n/locales.test.js
 * Structural consistency checks across all locale files. These catch drift
 * that a normal diff review easily misses: a key added to en.json but
 * forgotten elsewhere, a {{placeholder}} dropped or renamed during
 * translation, or a translation so much longer than English that it will
 * overflow fixed-width UI chrome (buttons, tabs, toolbar labels).
 */

import { describe, expect, it } from "vitest";
import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import itLocale from "./locales/it.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import pt from "./locales/pt.json";
import zh from "./locales/zh.json";

const LOCALES = { en, de, fr, es, it: itLocale, zh, pt, ja, ko };
const BASE_LANG = "en";

/** Flatten a nested translation object into dot-notation key -> string value pairs. */
function flatten(obj, prefix = "") {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") {
      Object.assign(out, flatten(value, path));
    } else {
      out[path] = value;
    }
  }
  return out;
}

/** Extract the set of {{placeholder}} names referenced in a string. */
function placeholders(str) {
  const matches = str.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g);
  return new Set(Array.from(matches, (m) => m[1]));
}

const flatByLang = Object.fromEntries(
  Object.entries(LOCALES).map(([lang, resource]) => [lang, flatten(resource)]),
);
const baseKeys = Object.keys(flatByLang[BASE_LANG]).sort();

// Scripts where character count isn't comparable to Latin-alphabet English
// (CJK glyphs are information-dense; a "short" translation is expected).
const LENGTH_EXEMPT_LANGS = new Set(["zh", "ja", "ko"]);

// Individual keys where the base English string is so short (often a single
// morpheme) that no ratio ceiling is meaningful — the translation is correct
// idiomatic usage, just structurally longer in that language (e.g. German
// compounds, Italian gerund progressive forms). Keyed by "lang:key".
const LENGTH_RATIO_EXCEPTIONS = new Set([
  "de:canvas.textSelection.cut",
  "it:settings.dangerZone.purging",
  "de:recycleBin.purge",
  "fr:footer.syncing",
  "it:footer.syncing",
]);

// Long-form strings (descriptions, warnings, confirmation dialogs) are allowed
// to expand more than tight UI chrome. Only keys under these sections are
// held to the tighter overflow-risk ratio.
const COMPACT_UI_SECTIONS = [
  "common.",
  "overview.tabs.",
  "toolbar.modes.",
  "toolbar.actions.",
  "toolbar.insert.",
  "toolbar.background.",
  "settings.sections.",
  "breadcrumb.",
  "footer.",
  "recycleBin.",
  "canvas.selection.",
  "canvas.media.",
];

function isCompactUiKey(key) {
  return COMPACT_UI_SECTIONS.some((prefix) => key.startsWith(prefix)) || key.endsWith(".title");
}

describe("locale key parity", () => {
  for (const lang of Object.keys(LOCALES)) {
    if (lang === BASE_LANG) continue;

    it(`${lang}.json has exactly the same keys as en.json`, () => {
      const keys = Object.keys(flatByLang[lang]).sort();
      const missing = baseKeys.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !baseKeys.includes(k));
      expect(missing, `${lang}.json is missing keys present in en.json`).toEqual([]);
      expect(extra, `${lang}.json has keys not present in en.json`).toEqual([]);
    });
  }
});

describe("locale placeholder parity", () => {
  for (const lang of Object.keys(LOCALES)) {
    if (lang === BASE_LANG) continue;

    it(`${lang}.json uses the same {{placeholders}} as en.json for every key`, () => {
      const mismatches = [];
      for (const key of baseKeys) {
        const baseValue = flatByLang[BASE_LANG][key];
        const translated = flatByLang[lang][key];
        if (typeof baseValue !== "string" || typeof translated !== "string") continue;

        const basePlaceholders = placeholders(baseValue);
        const translatedPlaceholders = placeholders(translated);
        const same =
          basePlaceholders.size === translatedPlaceholders.size &&
          [...basePlaceholders].every((p) => translatedPlaceholders.has(p));

        if (!same) {
          mismatches.push(
            `${key}: en=[${[...basePlaceholders]}] ${lang}=[${[...translatedPlaceholders]}]`,
          );
        }
      }
      expect(mismatches).toEqual([]);
    });
  }
});

describe("locale string length sanity", () => {
  // Short English words (e.g. "None", "Save") routinely become 2-3x longer in
  // Romance languages (Nenhum, Salvar) with zero translation-quality issue —
  // the ratio is only meaningful once there's enough length to amortize
  // per-word overhead. Below MIN_BASE_LENGTH we only check for absurd blowups.
  const MIN_BASE_LENGTH = 10;
  const MAX_RATIO = 2.3; // generous ceiling for full sentences/descriptions
  const MAX_COMPACT_RATIO = 2.1; // tighter ceiling for buttons/tabs/labels
  const MAX_RATIO_SHORT_STRING = 3; // absurd-blowup guard for very short base strings

  for (const lang of Object.keys(LOCALES)) {
    if (lang === BASE_LANG || LENGTH_EXEMPT_LANGS.has(lang)) continue;

    it(`${lang}.json strings aren't drastically longer than en.json`, () => {
      const offenders = [];
      for (const key of baseKeys) {
        const baseValue = flatByLang[BASE_LANG][key];
        const translated = flatByLang[lang][key];
        if (typeof baseValue !== "string" || typeof translated !== "string") continue;
        if (baseValue.length < 2) continue; // too short for ratio to mean anything
        if (LENGTH_RATIO_EXCEPTIONS.has(`${lang}:${key}`)) continue;

        const ratio = translated.length / baseValue.length;
        const ceiling =
          baseValue.length < MIN_BASE_LENGTH
            ? MAX_RATIO_SHORT_STRING
            : isCompactUiKey(key)
              ? MAX_COMPACT_RATIO
              : MAX_RATIO;
        if (ratio > ceiling) {
          offenders.push(
            `${key}: en="${baseValue}" (${baseValue.length}) ${lang}="${translated}" (${translated.length}, ${ratio.toFixed(2)}x)`,
          );
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});

describe("locale value sanity", () => {
  for (const lang of Object.keys(LOCALES)) {
    it(`${lang}.json has no empty or placeholder-only string values`, () => {
      const blanks = Object.entries(flatByLang[lang])
        .filter(([, value]) => typeof value === "string" && value.trim() === "")
        .map(([key]) => key);
      expect(blanks).toEqual([]);
    });
  }

  it("settings.language lists the same set of language codes in every locale", () => {
    const codeSetsByLang = Object.fromEntries(
      Object.entries(LOCALES).map(([lang, resource]) => [
        lang,
        Object.keys(resource.settings.language)
          .filter((k) => k !== "label" && k !== "desc")
          .sort(),
      ]),
    );
    const reference = codeSetsByLang[BASE_LANG];
    for (const [lang, codes] of Object.entries(codeSetsByLang)) {
      expect(codes, `${lang}.json settings.language codes`).toEqual(reference);
    }
  });
});
