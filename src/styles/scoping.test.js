import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Guards two conventions that only fail inside the Nextcloud app.
 *
 * Our markup runs there among Nextcloud's own stylesheets and variables. Both
 * bugs below looked correct in the native builds and broke only under NC, which
 * is exactly the kind of regression a unit test is worth having for.
 */
const layoutCss = readFileSync("src/styles/layout.css", "utf8");
const allCss = [
  "src/styles/layout.css",
  "src/styles/main.css",
  "src/styles/components.css",
  "src/styles/notebookEditor.css",
]
  .map((file) => readFileSync(file, "utf8"))
  .join("");
const settingsJs = readFileSync("src/components/settingsMode.js", "utf8");

/** Lines that begin a CSS rule with the given class, i.e. unscoped ones. */
function bareRulesFor(className) {
  const pattern = new RegExp(`^\\.${className}[\\w-]*(:[\\w-]+)?\\s*[,{]`);
  return layoutCss
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => pattern.test(line));
}

describe("Nextcloud CSS scoping", () => {
  it("scopes the settings nav buttons so NC's button styling cannot win", () => {
    // These are bare <button> elements, so at equal specificity NC's own button
    // rules win on source order and turn the rail into a stack of pills.
    // :is(body, #app) raises ours to 0-2-0 — the pattern main.css already uses
    // for .btn-primary / .btn-secondary.
    //
    // A bare rule starts the line with the class; a scoped one starts with
    // ":is(". That difference is the whole check, and it caught a second
    // unscoped rule hiding inside the mobile breakpoint.
    expect(bareRulesFor("settings-nav__item")).toEqual([]);
    expect(layoutCss).toContain(":is(body, #app) .settings-nav__item {");
    expect(layoutCss).toContain(":is(body, #app) .settings-nav__item--current {");
  });

  it("leaves rules for elements NC does not style unscoped", () => {
    // The convention is not "scope everything": .settings-nav__list is our own
    // <ul> with our own class, so raising it would be noise. Only elements NC
    // also styles — buttons here — need it.
    expect(layoutCss).toContain(".settings-nav__list {");
  });
});

describe("status colours", () => {
  it("uses namespaced names Nextcloud cannot shadow", () => {
    // NC defines --color-success / --color-warning / --color-error on <body>
    // with its own, much paler palette. Ours are declared on :root, so every
    // element inside <body> — which is all of them — inherits NC's instead: a
    // "Saved" message came out in NC's pale green and read as disabled text.
    //
    // The --nb-status-* prefix removes the collision outright rather than
    // fighting it with specificity, and a future NC variable cannot shadow it
    // either. Anything the app colours itself must use the prefix.
    expect(allCss).not.toContain("var(--color-success)");
    expect(allCss).not.toContain("var(--color-warning)");
    expect(allCss).not.toContain("var(--color-error)");
    expect(settingsJs).not.toContain("var(--color-success)");
    expect(settingsJs).not.toContain("var(--color-warning)");
    expect(settingsJs).not.toContain("var(--color-error)");
  });

  it("themes every status colour for both light and dark", () => {
    // One defined only in the base palette would keep a single value in both
    // themes — readable in one and not in the other.
    for (const theme of ["light", "dark"]) {
      const themeCss = readFileSync(`src/styles/themes/${theme}.css`, "utf8");
      for (const name of ["success", "warning", "error"]) {
        expect(themeCss).toContain(`--nb-status-${name}:`);
      }
    }
  });
});
