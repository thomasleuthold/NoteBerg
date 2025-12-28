/**
 * Licenses Dialog Component
 * Shows open source software licenses and attributions
 */

import { getIcon } from "../utils/icons.js";

/**
 * Open source libraries and their information
 */
const licenses = [
  {
    name: "Tauri",
    description: "Build smaller, faster, and more secure desktop applications",
    url: "https://tauri.app/",
    license: "MIT License / Apache License 2.0",
    licenseUrl: "https://github.com/tauri-apps/tauri/blob/dev/LICENSE_MIT",
  },
  {
    name: "Vite",
    description: "Next generation frontend tooling",
    url: "https://vitejs.dev/",
    license: "MIT License",
    licenseUrl: "https://github.com/vitejs/vite/blob/main/LICENSE",
  },
  {
    name: "Biome",
    description: "One toolchain for your web project",
    url: "https://biomejs.dev/",
    license: "MIT License",
    licenseUrl: "https://github.com/biomejs/biome/blob/main/LICENSE-MIT",
  },
  {
    name: "idb",
    description: "IndexedDB, but with promises",
    url: "https://github.com/jakearchibald/idb",
    license: "ISC License",
    licenseUrl: "https://github.com/jakearchibald/idb/blob/main/LICENSE",
  },
  {
    name: "Feather Icons",
    description: "Simply beautiful open source icons",
    url: "https://feathericons.com/",
    license: "MIT License",
    licenseUrl: "https://github.com/feathericons/feather/blob/master/LICENSE",
  },
];

/**
 * Show licenses dialog
 */
export function showLicensesDialog() {
  // Remove existing dialog if any
  const existing = document.getElementById("licenses-dialog");
  if (existing) {
    existing.remove();
  }

  // Create dialog overlay
  const overlay = document.createElement("div");
  overlay.id = "licenses-dialog";
  overlay.className = "modal-overlay";
  overlay.style.zIndex = "10000";

  // Build licenses list HTML
  const licensesHtml = licenses
    .map(
      (lib) => `
    <div class="license-item">
      <div class="license-header">
        <h4 class="license-name">
          <a href="${lib.url}" target="_blank" rel="noopener noreferrer">${lib.name}</a>
        </h4>
        <span class="license-type">${lib.license}</span>
      </div>
      <p class="license-description">${lib.description}</p>
      <a href="${lib.licenseUrl}" target="_blank" rel="noopener noreferrer" class="license-link">
        View License
      </a>
    </div>
  `,
    )
    .join("");

  overlay.innerHTML = `
    <div class="modal-dialog" style="max-width: 600px; max-height: 80vh; overflow: auto;">
      <div class="modal-header">
        <h3 class="modal-title">Open Source Licenses</h3>
        <button class="modal-close" aria-label="Close">
          ${getIcon("x", 24)}
        </button>
      </div>
      <div class="modal-body">
        <div class="licenses-intro">
          <p>oneJournal is built with the help of these amazing open source projects:</p>
        </div>
        <div class="licenses-list">
          ${licensesHtml}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-primary close-licenses-btn">Close</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Close handlers
  const closeDialog = () => {
    overlay.remove();
  };

  overlay.querySelector(".modal-close")?.addEventListener("click", closeDialog);
  overlay.querySelector(".close-licenses-btn")?.addEventListener("click", closeDialog);

  // Close on overlay click
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      closeDialog();
    }
  });

  // Close on Escape key
  const escapeHandler = (e) => {
    if (e.key === "Escape") {
      closeDialog();
      document.removeEventListener("keydown", escapeHandler);
    }
  };
  document.addEventListener("keydown", escapeHandler);
}
