/**
 * Settings Mode Component
 * Renders the settings panel with theme selection and other preferences
 */

import {
  cleanupLegacyFiles,
  clearCredentials,
  fullSync,
  getStoredCredentials,
  isAuthenticated,
  listFiles,
  migrateToHierarchical,
  needsMigration,
  startLoginFlow,
  testConnection,
} from "../modules/nextcloudSync.js";
import {
  getAllNotebooksForSync,
  getAllNotesForSync,
  getStorageVersion,
  purgeLocalData,
  saveNote,
  saveNotebook,
  setStorageVersion,
} from "../modules/storage.js";
import { STORAGE_VERSION } from "../modules/storagePaths.js";
import { getTheme, setTheme } from "../modules/theme.js";
import { showConfirmDialog, showAlertDialog } from "./modals.js";

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
            <button class="theme-toggle ${currentTheme === "light" ? "active" : ""}" data-theme="light">
              <div class="theme-toggle-swatch light"></div>
              <span class="theme-toggle-label">Light</span>
            </button>
            <button class="theme-toggle ${currentTheme === "dark" ? "active" : ""}" data-theme="dark">
              <div class="theme-toggle-swatch dark"></div>
              <span class="theme-toggle-label">Dark</span>
            </button>
            <button class="theme-toggle ${currentTheme === "epaper" ? "active" : ""}" data-theme="epaper">
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
            <span class="setting-description">Logged in as ${credentials?.loginName || "Unknown"}</span>
          </div>
          <div class="setting-label">
            <span class="setting-description">Server: ${credentials?.serverUrl || "Unknown"}</span>
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

      ${
        authenticated
          ? `
      <div class="settings-section">
        <h3>Storage Migration</h3>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">Hierarchical Storage Structure</span>
            <span class="setting-description">Upgrade to organized folder structure with better support for media files</span>
          </div>
        </div>

        <div class="setting-item">
          <button id="check-migration-btn" class="btn-secondary">Check Migration Status</button>
          <button id="run-migration-btn" class="btn-primary" style="display: none;">Migrate Now</button>
          <button id="cleanup-legacy-btn" class="btn-secondary" style="display: none;">Clean Up Old Files</button>
          <span id="migration-status" class="setting-note"></span>
        </div>

        <div class="setting-item" id="migration-info" style="display: none;">
          <div class="setting-description">
            <p><strong>Migration Details:</strong></p>
            <ul style="margin: 8px 0; padding-left: 20px;">
              <li>Old structure: Flat files in /oneJournal/</li>
              <li>New structure: Organized folders (notebooks/{id}/notes/)</li>
              <li>Benefits: Better organization, media file support, faster sync</li>
              <li>Note: Old files will be kept for safety</li>
            </ul>
          </div>
        </div>

        <div class="setting-item" id="cleanup-info" style="display: none;">
          <div class="setting-description" style="color: var(--color-warning);">
            <p><strong>⚠️ Old Files Detected</strong></p>
            <p>Legacy flat structure files are still on the server. After confirming your data is safe, you can clean them up to save storage space.</p>
          </div>
        </div>
      </div>
      `
          : ""
      }

      <div class="settings-section">
        <h3 style="color: var(--color-danger);">Danger Zone</h3>

        <div class="setting-item">
          <div class="setting-label">
            <span class="setting-name">Purge Local Data</span>
            <span class="setting-description">Clears ALL local notebooks and notes from this device.</span>
          </div>
          <button id="purge-local-btn" class="btn-secondary" style="background-color: var(--color-danger); color: white;">Purge Local Data</button>
          <span id="purge-status" class="setting-note"></span>
        </div>

        <div class="setting-item">
          <div class="setting-description" style="color: var(--text-secondary); font-size: 0.875rem;">
            ⚠️ <strong>Warning:</strong> This action will delete all local data including notebooks, notes, and sync history. If you are connected to Nextcloud, you can restore your data by syncing again. Unsynced changes will be permanently lost.
          </div>
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
  const themeToggles = container.querySelectorAll(".theme-toggle");
  themeToggles.forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const theme = toggle.dataset.theme;
      setTheme(theme);

      // Update active state
      for (const t of themeToggles) {
        t.classList.remove("active");
      }
      toggle.classList.add("active");
    });
  });

  // Nextcloud sync event listeners
  if (!authenticated) {
    const testBtn = container.querySelector("#test-connection-btn");
    const connectBtn = container.querySelector("#connect-nextcloud-btn");
    const urlInput = container.querySelector("#nextcloud-url");
    const statusSpan = container.querySelector("#connection-status");

    testBtn?.addEventListener("click", async () => {
      const serverUrl = urlInput.value.trim();

      if (!serverUrl) {
        statusSpan.textContent = "Please enter a server URL";
        statusSpan.style.color = "var(--color-error)";
        return;
      }

      testBtn.disabled = true;
      testBtn.textContent = "Testing...";
      statusSpan.textContent = "";

      try {
        const result = await testConnection(serverUrl);
        if (result.success) {
          statusSpan.textContent = `✓ Connected to Nextcloud ${result.versionstring}`;
          statusSpan.style.color = "var(--color-success)";
        } else {
          statusSpan.textContent = `✗ ${result.error}`;
          statusSpan.style.color = "var(--color-error)";
        }
      } catch (error) {
        statusSpan.textContent = `✗ ${error.message}`;
        statusSpan.style.color = "var(--color-error)";
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = "Test Connection";
      }
    });

    connectBtn?.addEventListener("click", async () => {
      const serverUrl = urlInput.value.trim();

      if (!serverUrl) {
        statusSpan.textContent = "Please enter a server URL";
        statusSpan.style.color = "var(--color-error)";
        return;
      }

      connectBtn.disabled = true;
      connectBtn.textContent = "Initializing...";
      statusSpan.textContent = "Starting Nextcloud Login Flow...";
      statusSpan.style.color = "var(--color-text)";

      const loginUrlContainer = container.querySelector("#login-url-container");
      const loginUrlInput = container.querySelector("#login-url");
      const copyLoginUrlBtn = container.querySelector("#copy-login-url-btn");

      try {
        await startLoginFlow(serverUrl, (loginUrl) => {
          // Show the login URL field
          loginUrlContainer.style.display = "block";
          loginUrlInput.value = loginUrl;

          statusSpan.textContent = "Waiting for login... Open the URL above in your browser";
          statusSpan.style.color = "var(--color-text)";

          // Add copy button handler
          copyLoginUrlBtn.onclick = async () => {
            try {
              loginUrlInput.select();
              await navigator.clipboard.writeText(loginUrl);
              copyLoginUrlBtn.textContent = "✓ Copied!";
              setTimeout(() => {
                copyLoginUrlBtn.textContent = "Copy URL";
              }, 2000);
            } catch (_err) {
              // Fallback: select the text
              loginUrlInput.select();
              copyLoginUrlBtn.textContent = "Selected - use Ctrl+C";
              setTimeout(() => {
                copyLoginUrlBtn.textContent = "Copy URL";
              }, 2000);
            }
          };
        });

        // Login successful
        loginUrlContainer.style.display = "none";
        statusSpan.textContent = "✓ Connected successfully!";
        statusSpan.style.color = "var(--color-success)";

        // Notify footer about auth change
        window.dispatchEvent(new CustomEvent("nextcloud-auth-changed"));

        // Reload settings to show authenticated state
        setTimeout(() => renderSettings(container), 1000);
      } catch (error) {
        console.error("Login flow error caught in settings:", error);
        const errorMessage = error?.message || error?.toString() || "Unknown error occurred";
        loginUrlContainer.style.display = "none";
        statusSpan.textContent = `✗ ${errorMessage}`;
        statusSpan.style.color = "var(--color-error)";
        connectBtn.disabled = false;
        connectBtn.textContent = "Connect to Nextcloud";
      }
    });
  } else {
    const syncBtn = container.querySelector("#sync-now-btn");
    const disconnectBtn = container.querySelector("#disconnect-btn");
    const syncStatus = container.querySelector("#sync-status");

    syncBtn?.addEventListener("click", async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = "Syncing...";
      syncStatus.textContent = "Syncing with Nextcloud...";
      syncStatus.style.color = "var(--color-text)";

      try {
        const notebooks = await getAllNotebooksForSync();
        const notes = await getAllNotesForSync();

        const result = await fullSync(notebooks, notes);

        // Mark uploaded items as synced in local storage
        for (const id of result.uploaded.notebooks.uploadedIds || []) {
          const notebook = notebooks.find((n) => n.id === id);
          if (notebook) {
            await saveNotebook({ ...notebook, synced: true });
          }
        }

        for (const id of result.uploaded.notes.uploadedIds || []) {
          const note = notes.find((n) => n.id === id);
          if (note) {
            await saveNote({ ...note, synced: true });
          }
        }

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
        syncStatus.style.color = "var(--color-success)";

        // Trigger a UI refresh if notes/notebooks were downloaded
        if (downloadedNotebooks > 0 || downloadedNotes > 0) {
          // Dispatch event to refresh sidebar
          window.dispatchEvent(new CustomEvent("notes-updated"));
        }
      } catch (error) {
        syncStatus.textContent = `✗ Sync failed: ${error.message}`;
        syncStatus.style.color = "var(--color-error)";
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = "Sync Now";
      }
    });

    disconnectBtn?.addEventListener("click", () => {
      if (confirm("Are you sure you want to disconnect from Nextcloud?")) {
        clearCredentials();

        // Notify footer about auth change
        window.dispatchEvent(new CustomEvent("nextcloud-auth-changed"));

        renderSettings(container);
      }
    });

    // Migration button listeners
    const checkMigrationBtn = container.querySelector("#check-migration-btn");
    const runMigrationBtn = container.querySelector("#run-migration-btn");
    const cleanupLegacyBtn = container.querySelector("#cleanup-legacy-btn");
    const migrationStatus = container.querySelector("#migration-status");
    const migrationInfo = container.querySelector("#migration-info");
    const cleanupInfo = container.querySelector("#cleanup-info");

    checkMigrationBtn?.addEventListener("click", async () => {
      checkMigrationBtn.disabled = true;
      checkMigrationBtn.textContent = "Checking...";
      migrationStatus.textContent = "";

      try {
        const localVersion = await getStorageVersion();
        const remoteMigrationNeeded = await needsMigration();

        // Check if old files exist (for cleanup option)
        const rootFiles = await listFiles("/oneJournal");
        const hasOldFiles = rootFiles.some(
          (f) =>
            (f.name.startsWith("notebook_") || f.name.startsWith("note_")) &&
            f.name.endsWith(".json"),
        );

        if (localVersion >= STORAGE_VERSION && !remoteMigrationNeeded) {
          if (hasOldFiles) {
            migrationStatus.textContent =
              "✓ Using hierarchical structure (old backup files detected)";
            migrationStatus.style.color = "var(--color-success)";
            migrationInfo.style.display = "none";
            runMigrationBtn.style.display = "none";
            cleanupLegacyBtn.style.display = "inline-block";
            cleanupInfo.style.display = "block";
          } else {
            migrationStatus.textContent = "✓ Already using hierarchical structure";
            migrationStatus.style.color = "var(--color-success)";
            migrationInfo.style.display = "none";
            runMigrationBtn.style.display = "none";
            cleanupLegacyBtn.style.display = "none";
            cleanupInfo.style.display = "none";
          }
        } else if (remoteMigrationNeeded) {
          migrationStatus.textContent = "Migration available - old flat files detected on server";
          migrationStatus.style.color = "var(--color-warning)";
          migrationInfo.style.display = "block";
          runMigrationBtn.style.display = "inline-block";
          cleanupLegacyBtn.style.display = "none";
          cleanupInfo.style.display = "none";
        } else {
          migrationStatus.textContent = "No migration needed";
          migrationStatus.style.color = "var(--color-success)";
          migrationInfo.style.display = "none";
          runMigrationBtn.style.display = "none";
          cleanupLegacyBtn.style.display = "none";
          cleanupInfo.style.display = "none";
        }
      } catch (error) {
        migrationStatus.textContent = `Error: ${error.message}`;
        migrationStatus.style.color = "var(--color-error)";
      } finally {
        checkMigrationBtn.disabled = false;
        checkMigrationBtn.textContent = "Check Migration Status";
      }
    });

    runMigrationBtn?.addEventListener("click", async () => {
      if (
        !confirm(
          "This will migrate your data to the new hierarchical structure. Old files will be kept for safety. Continue?",
        )
      ) {
        return;
      }

      runMigrationBtn.disabled = true;
      runMigrationBtn.textContent = "Migrating...";
      migrationStatus.textContent = "Migrating data structure...";
      migrationStatus.style.color = "var(--color-text)";

      try {
        const result = await migrateToHierarchical();

        // Update local storage version
        await setStorageVersion(STORAGE_VERSION);

        migrationStatus.textContent = `✓ Migration complete! ${result.migratedNotebooks} notebooks, ${result.migratedNotes} notes migrated`;
        migrationStatus.style.color = "var(--color-success)";
        runMigrationBtn.style.display = "none";

        // Trigger data change event to refresh UI
        window.dispatchEvent(new CustomEvent("datachange"));

        // Trigger status check to show cleanup option
        checkMigrationBtn.click();
      } catch (error) {
        migrationStatus.textContent = `✗ Migration failed: ${error.message}`;
        migrationStatus.style.color = "var(--color-error)";
        runMigrationBtn.disabled = false;
        runMigrationBtn.textContent = "Migrate Now";
      }
    });

    cleanupLegacyBtn?.addEventListener("click", async () => {
      if (
        !confirm(
          "This will permanently delete old backup files from the server. Make sure your data has been migrated successfully before proceeding. Continue?",
        )
      ) {
        return;
      }

      cleanupLegacyBtn.disabled = true;
      cleanupLegacyBtn.textContent = "Cleaning up...";
      migrationStatus.textContent = "Deleting old files...";
      migrationStatus.style.color = "var(--color-text)";

      try {
        const result = await cleanupLegacyFiles();

        migrationStatus.textContent = `✓ Cleanup complete! Deleted ${result.deletedCount} old files`;
        migrationStatus.style.color = "var(--color-success)";
        cleanupLegacyBtn.style.display = "none";
        cleanupInfo.style.display = "none";
      } catch (error) {
        migrationStatus.textContent = `✗ Cleanup failed: ${error.message}`;
        migrationStatus.style.color = "var(--color-error)";
        cleanupLegacyBtn.disabled = false;
        cleanupLegacyBtn.textContent = "Clean Up Old Files";
      }
    });
  }

  // Purge local data listener (available regardless of auth status)
  const purgeLocalBtn = container.querySelector("#purge-local-btn");
  const purgeStatus = container.querySelector("#purge-status");

  purgeLocalBtn?.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog(
      "Purge Local Data",
      "⚠️ DANGER: This will DELETE ALL local notebooks and notes from this device!<br><br>" +
        "This includes:<ul>" +
        "<li>All notebooks and notes</li>" +
        "<li>All deleted items (recycle bin)</li>" +
        "<li>Local sync history</li></ul>" +
        "This action cannot be undone. Are you absolutely sure you want to continue?",
      "Purge Everything",
      "btn-danger",
    );

    if (!confirmed) return;

    purgeLocalBtn.disabled = true;
    purgeLocalBtn.textContent = "Purging...";
    if (purgeStatus) {
      purgeStatus.textContent = "Purging local data...";
      purgeStatus.style.color = "var(--color-danger)";
    }

    try {
      await purgeLocalData();

      const isAuth = isAuthenticated();
      if (purgeStatus) {
        purgeStatus.textContent = isAuth
          ? `✓ Local data purged successfully! Click "Sync Now" to download from server.`
          : `✓ Local data purged successfully!`;
        purgeStatus.style.color = "var(--color-success)";
      }

      // Refresh UI to show empty state
      window.dispatchEvent(new CustomEvent("notes-updated"));

      if (isAuth) {
        await showAlertDialog(
          "Purge Successful",
          "Local data purged successfully!<br><br>" +
            "Next steps:<ol>" +
            "<li>Click 'Sync Now' to download all data from Nextcloud</li>" +
            "<li>Wait for sync to complete</li>" +
            "<li>Your notes will be restored from the server</li></ol>"
        );
      } else {
        await showAlertDialog("Purge Successful", "Local data purged successfully!");
      }
    } catch (error) {
      if (purgeStatus) {
        purgeStatus.textContent = `✗ Purge failed: ${error.message}`;
        purgeStatus.style.color = "var(--color-error)";
      }
      await showAlertDialog("Purge Failed", `Purge failed: ${error.message}`);
    } finally {
      purgeLocalBtn.disabled = false;
      purgeLocalBtn.textContent = "Purge Local Data";
    }
  });
}

/**
 * Initialize settings component
 */
export function initSettings() {
  // Listen for render settings event from router
  window.addEventListener("rendersettings", () => {
    const container = document.getElementById("settings-content");
    if (container) {
      renderSettings(container);
    }
  });

  console.log("Settings component initialized");
}
