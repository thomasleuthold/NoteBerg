/**
 * src/i18n/index.nextcloud.test.js
 *
 * Exercises initI18n()'s Nextcloud branch (IS_NEXTCLOUD = true), which reads
 * the UI language from window.OC.getLocale() instead of the stored setting.
 * Unreachable under the default `npm test` — see vitest.config.nextcloud.js.
 *
 * Covers: supported locales are detected and activated; locales we have no
 * translation for fall back to English instead of leaving i18next reporting
 * an unregistered language as active.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("initI18n (Nextcloud locale detection)", () => {
  beforeEach(() => {
    window.OC = { getLocale: () => "en_US" };
  });

  afterEach(() => {
    delete window.OC;
  });

  it.each([
    ["de_DE", "de"],
    ["fr_FR", "fr"],
    ["es_ES", "es"],
    ["it_IT", "it"],
    ["zh_CN", "zh"],
    ["pt_PT", "pt"],
    ["ja_JP", "ja"],
    ["ko_KR", "ko"],
  ])("activates %s as %s", async (ocLocale, expected) => {
    window.OC.getLocale = () => ocLocale;
    const { initI18n, getCurrentLanguage } = await import("./index.js");
    await initI18n();
    expect(getCurrentLanguage()).toBe(expected);
  });

  it("falls back to English for a locale with no translation resources", async () => {
    window.OC.getLocale = () => "nl_NL";
    const { initI18n, getCurrentLanguage } = await import("./index.js");
    await initI18n();
    expect(getCurrentLanguage()).toBe("en");
  });

  it("falls back to English when OC.getLocale is unavailable", async () => {
    window.OC = {};
    const { initI18n, getCurrentLanguage } = await import("./index.js");
    await initI18n();
    expect(getCurrentLanguage()).toBe("en");
  });
});
