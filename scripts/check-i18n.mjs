#!/usr/bin/env node
/**
 * Localization audit.
 *
 * Three checks, in order of how badly each fails the user:
 *
 *   1. Key parity      — a key missing from a locale renders as the raw key id.
 *   2. Placeholder     — a translation that drops {{count}} silently loses data.
 *   3. Untranslated    — a value still identical to English.
 *
 * Check 3 deliberately has NO length or word-count shortcut. An earlier version
 * of this audit skipped values under four characters or of two words or fewer,
 * on the theory that those were brand names and interface chrome. That hid real
 * gaps for a long time: "AI Access", "Provider", "Not configured" and "Status"
 * are all short, all translatable, and all shipped untranslated because the
 * heuristic filtered them out before a human ever saw them.
 *
 * The only automatic exclusion now is a value with no translatable letters at
 * all once placeholders are removed ("{{current}} / {{total}}"). Everything
 * else that is genuinely identical across languages goes in ALLOWED_IDENTICAL
 * below, where the decision is visible and reviewable.
 *
 * Usage: node scripts/check-i18n.mjs [--json]
 * Exits non-zero if checks 1 or 2 fail, or if an unlisted string is untranslated.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "src/i18n/locales";
const BASE = "en";

/**
 * Keys whose value is legitimately the same as English in the listed locales.
 *
 * Each entry needs a reason. "It looked short" is not one — that was the bug
 * this list replaced.
 */
const ALLOWED_IDENTICAL = {
  // Literal examples typed into a field; translating them would suggest the
  // user should type the translated text.
  "settings.nextcloud.urlPlaceholder": "*",
  "settings.recognition.endpointPlaceholder": "*",
  "settings.recognition.modelPlaceholder": "*",
  "settings.mcp.tokenNamePromptPlaceholder": "*",
  // Product and protocol names.
  "settings.aiProvider.providerReplicate": "*",
  "settings.aiProvider.providerOpenAi": "*",
  // Same word in these languages.
  "common.ok": ["de", "fr", "it", "ja", "pt"],
  // "Home" is the ordinary Italian word for this too.
  "common.home": ["it"],
  "breadcrumb.home": ["it"],
  "settings.mcp.auditLogColToken": ["de", "es", "it", "pt"],
  "settings.mcp.auditLogOutcomeOk": ["de", "es", "fr", "it", "pt"],
  "settings.mcp.statusLabel": ["de"],
  "settings.recognition.statusLabel": ["de"],
  "settings.logging.info": ["de", "fr", "it"],
  "settings.about.version": ["de"],
  "settings.nextcloud.server": ["de", "it"],
  "helpOverlay.text.title": ["de"],
  "noteNavigator.toggle": ["de"],
  "modals.createNotebook.colors.Orange": ["de", "fr"],
  "modals.createNotebook.descLabel": ["fr"],
  "modals.noteProperties.deletedNo": ["fr"],
  "canvas.crop.perspective": ["fr"],
  "overview.sections.notes": ["fr"],
  "overview.tabs.notes": ["fr"],
  "overview.notebook.noteCount_one": ["fr"],
  "overview.notebook.noteCount_other": ["fr"],
  "recycleBin.note": ["fr"],
  "recycleBin.notesCount": ["fr"],
  "overview.errorRender": ["es"],
  "common.error": ["es"],
  "settings.mcp.auditLogOutcomeError": ["es"],
  "modals.createNotebook.colorLabel": ["es"],
  "toolbar.penDialog.color": ["es"],
  "toolbar.penDialog.colorTitle": ["es"],
  "settings.mcp.auditLogColArgs": ["fr"],
  "soundDialog.pause": ["de", "fr"],
  // "Audio" is the ordinary word in these languages, not an English
  // borrowing left untranslated — each locale already uses it for the
  // audio-import and no-microphone strings.
  "settings.modelPicker.caps.audio": ["de", "es", "fr", "it"],
  // Likewise "Video" in German and Italian. Spanish and Portuguese
  // accent it ("Vídeo") and French takes an accent too, so those are
  // translated rather than listed here.
  "settings.modelPicker.caps.video": ["de", "it"],
};

const flatten = (obj, prefix = "") =>
  Object.entries(obj).reduce((acc, [k, v]) => {
    const key = prefix + k;
    if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(acc, flatten(v, `${key}.`));
    else acc[key] = v;
    return acc;
  }, {});

const load = (code) => flatten(JSON.parse(readFileSync(join(DIR, `${code}.json`), "utf8")));

const placeholders = (s) =>
  [...String(s).matchAll(/\{\{(\w+)\}\}/g)]
    .map((m) => m[1])
    .sort()
    .join(",");

/** A value with no letters left once placeholders are stripped cannot differ. */
const hasNoWords = (v) => !/\p{Letter}/u.test(String(v).replace(/\{\{\w+\}\}/g, ""));

const locales = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .filter((c) => c !== BASE)
  .sort();

const en = load(BASE);
const problems = { missing: [], extra: [], placeholder: [], untranslated: [] };

for (const code of locales) {
  const loc = load(code);
  for (const key of Object.keys(en)) {
    if (!(key in loc)) {
      problems.missing.push([code, key]);
      continue;
    }
    if (placeholders(en[key]) !== placeholders(loc[key])) {
      problems.placeholder.push([code, key, placeholders(en[key]), placeholders(loc[key])]);
    }
    if (loc[key] === en[key] && !hasNoWords(en[key])) {
      const allow = ALLOWED_IDENTICAL[key];
      const ok = allow === "*" || (Array.isArray(allow) && allow.includes(code));
      if (!ok) problems.untranslated.push([code, key, String(en[key]).slice(0, 60)]);
    }
  }
  for (const key of Object.keys(loc)) {
    if (!(key in en)) problems.extra.push([code, key]);
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(problems, null, 2));
} else {
  const show = (title, rows, fmt) => {
    console.log(`\n${title}: ${rows.length}`);
    for (const r of rows.slice(0, 60)) console.log("   ", fmt(r));
    if (rows.length > 60) console.log(`    ... and ${rows.length - 60} more`);
  };
  console.log(`Locales: ${locales.join(", ")}  |  keys: ${Object.keys(en).length}`);
  show("Missing keys", problems.missing, ([c, k]) => `${c}  ${k}`);
  show("Unknown keys (not in en)", problems.extra, ([c, k]) => `${c}  ${k}`);
  show(
    "Placeholder mismatches",
    problems.placeholder,
    ([c, k, a, b]) => `${c}  ${k}  en={${a}} ${c}={${b}}`,
  );
  show("Untranslated", problems.untranslated, ([c, k, v]) => `${c}  ${k}  "${v}"`);
}

const failed =
  problems.missing.length +
  problems.extra.length +
  problems.placeholder.length +
  problems.untranslated.length;
if (failed > 0) {
  console.error(`\n${failed} issue(s) found.`);
  process.exit(1);
}
console.log("\nAll locales complete.");
