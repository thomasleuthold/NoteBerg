/**
 * Settings Mode Component
 * Renders the settings panel with theme selection and other preferences
 */

import { getTheme, setTheme } from '../modules/theme.js';

/**
 * Render settings UI
 * @param {HTMLElement} container - Container element to render into
 */
export function renderSettings(container) {
  const currentTheme = getTheme();

  container.innerHTML = `
    <div class="settings-panel">
      <div class="settings-header">
        <h2>Settings</h2>
      </div>

      <div class="settings-section">
        <h3>Appearance</h3>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">Theme</span>
            <span class="setting-description">Choose your preferred color scheme</span>
          </div>
          <div class="theme-toggle-group">
            <button class="theme-toggle ${currentTheme === 'light' ? 'active' : ''}" data-theme="light">
              <div class="theme-toggle-swatch light"></div>
              <span class="theme-toggle-label">Light</span>
            </button>
            <button class="theme-toggle ${currentTheme === 'dark' ? 'active' : ''}" data-theme="dark">
              <div class="theme-toggle-swatch dark"></div>
              <span class="theme-toggle-label">Dark</span>
            </button>
            <button class="theme-toggle ${currentTheme === 'epaper' ? 'active' : ''}" data-theme="epaper">
              <div class="theme-toggle-swatch epaper"></div>
              <span class="theme-toggle-label">E-Paper</span>
            </button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>Sync</h3>

        <div class="setting-item">
          <label for="webdav-url" class="setting-label">
            <span class="setting-name">WebDAV Server URL</span>
            <span class="setting-description">Nextcloud or other WebDAV-compatible server</span>
          </label>
          <input
            type="url"
            id="webdav-url"
            class="setting-control"
            placeholder="https://cloud.example.com/remote.php/dav"
            disabled
          />
        </div>

        <div class="setting-item">
          <p class="setting-note">
            <em>WebDAV sync will be available in Phase 5</em>
          </p>
        </div>
      </div>

      <div class="settings-section">
        <h3>About</h3>

        <div class="setting-item">
          <div class="about-info">
            <p><strong>oneJournal</strong></p>
            <p>Version: 0.1.0 (Alpha)</p>
            <p>A note-taking app supporting handwritten notes, text, and drawings.</p>
          </div>
        </div>
      </div>
    </div>
  `;

  // Attach event listeners to theme toggle buttons
  const themeToggles = container.querySelectorAll('.theme-toggle');
  themeToggles.forEach(toggle => {
    toggle.addEventListener('click', () => {
      const theme = toggle.dataset.theme;
      setTheme(theme);

      // Update active state
      themeToggles.forEach(t => t.classList.remove('active'));
      toggle.classList.add('active');
    });
  });
}

/**
 * Initialize settings component
 */
export function initSettings() {
  // Listen for render settings event from router
  window.addEventListener('rendersettings', () => {
    const container = document.getElementById('settings-content');
    if (container) {
      renderSettings(container);
    }
  });

  console.log('Settings component initialized');
}
