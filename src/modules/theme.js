/**
 * Theme Module
 * Handles theme switching between light, dark, and e-paper modes
 */

const THEMES = ["light", "dark"];
const DEFAULT_THEME = "light";
const THEME_STORAGE_KEY = "theme";
const PDF_INVERT_DARK_STORAGE_KEY = "pdf_invert_dark_mode";
const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

let currentTheme = DEFAULT_THEME;
// Default: enabled — imported PDF pages invert in dark mode so annotations stay legible.
let pdfInvertDarkMode = localStorage.getItem(PDF_INVERT_DARK_STORAGE_KEY) !== "false";

/**
 * Initialize theme system.
 * In Nextcloud: follows Nextcloud's own dark/light class on <body>.
 * In Tauri: detects system preference and loads saved theme.
 */
/**
 * Detect whether Nextcloud is currently in dark mode.
 * Tries multiple signals across NC versions:
 *  1. .theme--dark class on <body>           (NC ≤ 25)
 *  2. prefers-color-scheme media query       (NC 25+ follows system by default)
 *  3. Luminance of --background-color CSS var (works regardless of class names)
 */
function _detectNextcloudDark() {
  const appEl = document.getElementById("app");
  const ncTheme = appEl?.getAttribute("data-nc-theme");

  // 1. NC 29+ sets data-theme-dark on <body> at runtime — most reliable signal
  if (document.body.hasAttribute("data-theme-dark")) return true;
  if (document.body.hasAttribute("data-theme-dark-highcontrast")) return true;
  if (document.body.hasAttribute("data-theme-light")) return false;

  // 2. Server-side value from PHP (fallback — may be stale if NC applies theme after load)
  if (ncTheme === "dark") return true;
  if (ncTheme === "light") return false;

  // 3. NC ≤28 accessibility app sets theme--dark / theme--light class on <body>
  if (document.body.classList.contains("theme--dark")) return true;
  if (document.body.classList.contains("theme--light")) return false;

  // 4. No reliable signal — default to light
  return false;
}

export async function initTheme() {
  if (IS_NEXTCLOUD) {
    currentTheme = _detectNextcloudDark() ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", currentTheme);

    // Follow Nextcloud theme changes: watch body and html for class/attribute changes
    const _onNcThemeChange = () => {
      const next = _detectNextcloudDark() ? "dark" : "light";
      if (next !== currentTheme) {
        currentTheme = next;
        document.documentElement.setAttribute("data-theme", currentTheme);
        window.dispatchEvent(new CustomEvent("themechange", { detail: { theme: currentTheme } }));
      }
    };
    new MutationObserver(_onNcThemeChange).observe(document.body, {
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "data-theme-dark",
        "data-theme-dark-highcontrast",
        "data-theme-light",
      ],
    });
    new MutationObserver(_onNcThemeChange).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme-dark"],
    });

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      const next = _detectNextcloudDark() ? "dark" : "light";
      if (next !== currentTheme) {
        currentTheme = next;
        document.documentElement.setAttribute("data-theme", currentTheme);
        window.dispatchEvent(new CustomEvent("themechange", { detail: { theme: currentTheme } }));
      }
    });

    console.log(`Theme initialized (Nextcloud): ${currentTheme}`);
    return;
  }

  // Try to load saved theme from localStorage
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);

  if (savedTheme && THEMES.includes(savedTheme)) {
    currentTheme = savedTheme;
  } else {
    // Detect system preference
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    currentTheme = prefersDark ? "dark" : "light";
  }

  await setTheme(currentTheme);

  // Listen for system theme changes
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    // Only auto-switch if user hasn't manually set a theme
    if (!localStorage.getItem(THEME_STORAGE_KEY)) {
      setTheme(e.matches ? "dark" : "light");
    }
  });

  console.log(`Theme initialized: ${currentTheme}`);
}

/**
 * Set the active theme
 * @param {string} theme - Theme name ('light', 'dark')
 */
export async function setTheme(theme) {
  if (!THEMES.includes(theme)) {
    console.warn(`Invalid theme: ${theme}. Using ${DEFAULT_THEME}`);
    theme = DEFAULT_THEME;
  }

  currentTheme = theme;

  // Set data-theme attribute on html element
  document.documentElement.setAttribute("data-theme", theme);

  // Save to localStorage
  localStorage.setItem(THEME_STORAGE_KEY, theme);

  // Dispatch theme change event
  window.dispatchEvent(
    new CustomEvent("themechange", {
      detail: { theme },
    }),
  );

  console.log(`Theme set to: ${theme}`);
}

/**
 * Get current theme
 * @returns {string} Current theme name
 */
export function getTheme() {
  return currentTheme;
}

/**
 * Toggle between themes
 * Cycles through: light → dark → light
 */
export function cycleTheme() {
  const currentIndex = THEMES.indexOf(currentTheme);
  const nextIndex = (currentIndex + 1) % THEMES.length;
  setTheme(THEMES[nextIndex]);
}

/**
 * Get all available themes
 * @returns {Array<string>} Array of theme names
 */
export function getAvailableThemes() {
  return [...THEMES];
}

/**
 * Whether imported PDF pages should be inverted while annotating in dark mode.
 * Off by user choice when preserving the PDF's original colors matters more
 * than stroke contrast (e.g. color-coded diagrams, scanned photos).
 * @returns {boolean}
 */
export function getPdfInvertDarkMode() {
  return pdfInvertDarkMode;
}

/**
 * Set whether imported PDF pages should be inverted while annotating in dark mode.
 * @param {boolean} enabled
 */
export function setPdfInvertDarkMode(enabled) {
  pdfInvertDarkMode = !!enabled;
  localStorage.setItem(PDF_INVERT_DARK_STORAGE_KEY, String(pdfInvertDarkMode));
  window.dispatchEvent(
    new CustomEvent("themechange", {
      detail: { theme: currentTheme },
    }),
  );
}
