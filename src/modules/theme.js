/**
 * Theme Module
 * Handles theme switching between light, dark, and e-paper modes
 */

const THEMES = ["light", "dark"];
const DEFAULT_THEME = "light";
const THEME_STORAGE_KEY = "theme";
const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

let currentTheme = DEFAULT_THEME;

/**
 * Initialize theme system.
 * In Nextcloud: follows Nextcloud's own dark/light class on <body>.
 * In Tauri: detects system preference and loads saved theme.
 */
export async function initTheme() {
  if (IS_NEXTCLOUD) {
    // Nextcloud sets .theme--dark on <body> when dark mode is active
    const prefersDark = document.body.classList.contains("theme--dark");
    currentTheme = prefersDark ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", currentTheme);

    // Follow Nextcloud theme changes (user switches in NC settings)
    new MutationObserver(() => {
      const dark = document.body.classList.contains("theme--dark");
      const next = dark ? "dark" : "light";
      if (next !== currentTheme) {
        currentTheme = next;
        document.documentElement.setAttribute("data-theme", currentTheme);
      }
    }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

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
