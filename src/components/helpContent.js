/**
 * Help tour copy — resolves all first-use guidance text from i18n at call time.
 *
 * Kept as a function (not a static object) so it always reflects the current
 * language: the hook sites call getHelpContent() when a tour starts, so a
 * language change between sessions is picked up without any cached strings.
 *
 * Each entry is `{ title, body }`. The hook site pairs it with a live `target`
 * element to build the `steps` array for startHelpTour(). getHelpLabels()
 * returns the shared Next/Back/Skip/Got it button labels.
 */

import { t } from "../i18n/index.js";

const KEYS = [
  "welcome",
  "pan",
  "text",
  "draw",
  "eraser",
  "lasso",
  "options",
  "insert",
  "firstImage",
  "markAsTask",
];

export function getHelpContent() {
  const content = {};
  for (const key of KEYS) {
    content[key] = {
      title: t(`helpOverlay.${key}.title`),
      body: t(`helpOverlay.${key}.body`),
    };
  }
  return content;
}

/** Localized labels + progress formatter for the overlay footer controls. */
export function getHelpLabels() {
  return {
    nextLabel: t("helpOverlay.next"),
    prevLabel: t("helpOverlay.back"),
    skipLabel: t("helpOverlay.skip"),
    dismissLabel: t("helpOverlay.dismiss"),
    progressLabel: (current, total) => t("helpOverlay.progress", { current, total }),
  };
}
