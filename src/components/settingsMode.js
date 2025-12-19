/**
 * Settings Mode Component
 * Renders the settings panel with theme selection and other preferences
 */

import { getTheme, setTheme } from '../modules/theme.js';
import {
  isAuthenticated,
  getStoredCredentials,
  startLoginFlow,
  clearCredentials,
  testConnection,
  fullSync,
} from '../modules/nextcloudSync.js';
import { getAllNotebooks, getAllNotes, saveNotebook, saveNote } from '../modules/storage.js';

/**
 * Render settings UI
 * @param {HTMLElement} container - Container element to render into
 */
export function renderSettings(container) {
  const currentTheme = getTheme();
  const authenticated = isAuthenticated();
  const credentials = getStoredCredentials();

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
        <h3>Nextcloud Sync</h3>

        ${
          !authenticated
            ? `
        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">Connect to Nextcloud</span>
            <span class="setting-description">Use Nextcloud Login Flow to securely connect your account</span>
          </div>
        </div>

        <div class="setting-item">
          <label for="nextcloud-url" class="setting-label">
            <span class="setting-name">Nextcloud Server URL</span>
            <span class="setting-description">Enter your Nextcloud server address</span>
          </label>
          <input
            type="url"
            id="nextcloud-url"
            class="setting-control"
            placeholder="https://cloud.example.com"
          />
        </div>

        <div class="setting-item">
          <button id="test-connection-btn" class="btn-secondary">Test Connection</button>
          <button id="connect-nextcloud-btn" class="btn-primary">Connect to Nextcloud</button>
          <span id="connection-status" class="setting-note"></span>
        </div>

        <div class="setting-item" id="login-url-container" style="display: none;">
          <label for="login-url" class="setting-label">
            <span class="setting-name">Login URL</span>
            <span class="setting-description">Copy and open this URL in your browser to complete login</span>
          </label>
          <input
            type="text"
            id="login-url"
            class="setting-control"
            readonly
            style="user-select: all; -webkit-user-select: all;"
          />
          <button id="copy-login-url-btn" class="btn-secondary" style="margin-top: 8px;">Copy URL</button>
        </div>
        `
            : `
        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">Connected</span>
            <span class="setting-description">Logged in as ${credentials?.loginName || 'Unknown'}</span>
          </div>
          <div class="setting-label">
            <span class="setting-description">Server: ${credentials?.serverUrl || 'Unknown'}</span>
          </div>
        </div>

        <div class="setting-item">
          <button id="sync-now-btn" class="btn-primary">Sync Now</button>
          <button id="disconnect-btn" class="btn-secondary">Disconnect</button>
          <span id="sync-status" class="setting-note"></span>
        </div>
        `
        }
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

  // Nextcloud sync event listeners
  if (!authenticated) {
    const testBtn = container.querySelector('#test-connection-btn');
    const connectBtn = container.querySelector('#connect-nextcloud-btn');
    const urlInput = container.querySelector('#nextcloud-url');
    const statusSpan = container.querySelector('#connection-status');

    testBtn?.addEventListener('click', async () => {
      const serverUrl = urlInput.value.trim();

      if (!serverUrl) {
        statusSpan.textContent = 'Please enter a server URL';
        statusSpan.style.color = 'var(--color-error)';
        return;
      }

      testBtn.disabled = true;
      testBtn.textContent = 'Testing...';
      statusSpan.textContent = '';

      try {
        const result = await testConnection(serverUrl);
        if (result.success) {
          statusSpan.textContent = `✓ Connected to Nextcloud ${result.versionstring}`;
          statusSpan.style.color = 'var(--color-success)';
        } else {
          statusSpan.textContent = `✗ ${result.error}`;
          statusSpan.style.color = 'var(--color-error)';
        }
      } catch (error) {
        statusSpan.textContent = `✗ ${error.message}`;
        statusSpan.style.color = 'var(--color-error)';
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = 'Test Connection';
      }
    });

    connectBtn?.addEventListener('click', async () => {
      const serverUrl = urlInput.value.trim();

      if (!serverUrl) {
        statusSpan.textContent = 'Please enter a server URL';
        statusSpan.style.color = 'var(--color-error)';
        return;
      }

      connectBtn.disabled = true;
      connectBtn.textContent = 'Initializing...';
      statusSpan.textContent = 'Starting Nextcloud Login Flow...';
      statusSpan.style.color = 'var(--color-text)';

      const loginUrlContainer = container.querySelector('#login-url-container');
      const loginUrlInput = container.querySelector('#login-url');
      const copyLoginUrlBtn = container.querySelector('#copy-login-url-btn');

      try {
        await startLoginFlow(serverUrl, (loginUrl) => {
          // Show the login URL field
          loginUrlContainer.style.display = 'block';
          loginUrlInput.value = loginUrl;

          statusSpan.textContent = 'Waiting for login... Open the URL above in your browser';
          statusSpan.style.color = 'var(--color-text)';

          // Add copy button handler
          copyLoginUrlBtn.onclick = async () => {
            try {
              loginUrlInput.select();
              await navigator.clipboard.writeText(loginUrl);
              copyLoginUrlBtn.textContent = '✓ Copied!';
              setTimeout(() => {
                copyLoginUrlBtn.textContent = 'Copy URL';
              }, 2000);
            } catch (err) {
              // Fallback: select the text
              loginUrlInput.select();
              copyLoginUrlBtn.textContent = 'Selected - use Ctrl+C';
              setTimeout(() => {
                copyLoginUrlBtn.textContent = 'Copy URL';
              }, 2000);
            }
          };
        });

        // Login successful
        loginUrlContainer.style.display = 'none';
        statusSpan.textContent = '✓ Connected successfully!';
        statusSpan.style.color = 'var(--color-success)';

        // Notify footer about auth change
        window.dispatchEvent(new CustomEvent('nextcloud-auth-changed'));

        // Reload settings to show authenticated state
        setTimeout(() => renderSettings(container), 1000);
      } catch (error) {
        console.error('Login flow error caught in settings:', error);
        const errorMessage = error?.message || error?.toString() || 'Unknown error occurred';
        loginUrlContainer.style.display = 'none';
        statusSpan.textContent = `✗ ${errorMessage}`;
        statusSpan.style.color = 'var(--color-error)';
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect to Nextcloud';
      }
    });
  } else {
    const syncBtn = container.querySelector('#sync-now-btn');
    const disconnectBtn = container.querySelector('#disconnect-btn');
    const syncStatus = container.querySelector('#sync-status');

    syncBtn?.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing...';
      syncStatus.textContent = 'Syncing with Nextcloud...';
      syncStatus.style.color = 'var(--color-text)';

      try {
        const notebooks = await getAllNotebooks();
        const notes = await getAllNotes();

        const result = await fullSync(notebooks, notes);

        // Save downloaded notebooks to local storage
        let downloadedNotebooks = 0;
        let downloadedNotes = 0;

        for (const notebook of result.downloaded.notebooks) {
          await saveNotebook(notebook);
          downloadedNotebooks++;
        }

        // Save downloaded notes to local storage
        for (const note of result.downloaded.notes) {
          await saveNote(note);
          downloadedNotes++;
        }

        syncStatus.textContent = `✓ Sync complete! Uploaded ${result.uploaded.notebooks.uploaded} notebooks, ${result.uploaded.notes.uploaded} notes. Downloaded ${downloadedNotebooks} notebooks, ${downloadedNotes} notes.`;
        syncStatus.style.color = 'var(--color-success)';

        // Trigger a UI refresh if notes/notebooks were downloaded
        if (downloadedNotebooks > 0 || downloadedNotes > 0) {
          // Dispatch event to refresh sidebar
          window.dispatchEvent(new CustomEvent('notes-updated'));
        }
      } catch (error) {
        syncStatus.textContent = `✗ Sync failed: ${error.message}`;
        syncStatus.style.color = 'var(--color-error)';
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = 'Sync Now';
      }
    });

    disconnectBtn?.addEventListener('click', () => {
      if (confirm('Are you sure you want to disconnect from Nextcloud?')) {
        clearCredentials();

        // Notify footer about auth change
        window.dispatchEvent(new CustomEvent('nextcloud-auth-changed'));

        renderSettings(container);
      }
    });
  }
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
