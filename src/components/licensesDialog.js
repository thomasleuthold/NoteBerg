/**
 * Licenses Dialog Component
 * Shows open source software licenses and attributions
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "../i18n/index.js";
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
    name: "i18next",
    description: "An internationalization-framework written in and for JavaScript",
    url: "https://www.i18next.com/",
    license: "MIT License",
    licenseUrl: "https://github.com/i18next/i18next/blob/master/LICENSE",
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
  {
    name: "jQuery",
    description: "A fast, small, and feature-rich JavaScript library",
    url: "https://jquery.com/",
    license: "MIT License",
    licenseUrl: "https://github.com/jquery/jquery/blob/main/LICENSE.txt",
  },
  {
    name: "PDF.js",
    description: "PDF Reader in JavaScript",
    url: "https://mozilla.github.io/pdf.js/",
    license: "Apache License 2.0",
    licenseUrl: "https://github.com/mozilla/pdf.js/blob/master/LICENSE",
  },
  {
    name: "Trumbowyg",
    description: "A lightweight WYSIWYG editor",
    url: "https://alex-d.github.io/Trumbowyg/",
    license: "MIT License",
    licenseUrl: "https://github.com/Alex-D/Trumbowyg/blob/main/LICENSE",
  },
  {
    name: "pdf-lib",
    description: "Create and modify PDF documents in any JavaScript environment",
    url: "https://pdf-lib.js.org/",
    license: "MIT License",
    licenseUrl: "https://github.com/Hopding/pdf-lib/blob/master/LICENSE.md",
  },
  {
    name: "html2canvas",
    description: "Screenshots with JavaScript",
    url: "https://html2canvas.hertzen.com/",
    license: "MIT License",
    licenseUrl: "https://github.com/niklasvh/html2canvas/blob/master/LICENSE",
  },
  {
    name: "perspective-transform",
    description: "Create a perspective transform from 4 points",
    url: "https://github.com/fhguilherme/perspective-transform",
    license: "MIT License",
    licenseUrl: "https://github.com/fhguilherme/perspective-transform/blob/master/LICENSE",
  },
  {
    name: "Testing Library",
    description: "Simple and complete testing utilities that encourage good testing practices",
    url: "https://testing-library.com/",
    license: "MIT License",
    licenseUrl: "https://github.com/testing-library/dom-testing-library/blob/main/LICENSE",
  },
  {
    name: "Vitest",
    description: "A blazing fast unit-test framework powered by Vite",
    url: "https://vitest.dev/",
    license: "MIT License",
    licenseUrl: "https://github.com/vitest-dev/vitest/blob/main/LICENSE",
  },
  {
    name: "Express",
    description: "Fast, unopinionated, minimalist web framework for Node.js",
    url: "https://expressjs.com/",
    license: "MIT License",
    licenseUrl: "https://github.com/expressjs/express/blob/master/LICENSE",
  },
  {
    name: "cors",
    description: "Node.js CORS middleware",
    url: "https://github.com/expressjs/cors",
    license: "MIT License",
    licenseUrl: "https://github.com/expressjs/cors/blob/master/LICENSE",
  },
  {
    name: "jsdom",
    description: "A JavaScript implementation of many web standards",
    url: "https://github.com/jsdom/jsdom",
    license: "MIT License",
    licenseUrl: "https://github.com/jsdom/jsdom/blob/main/LICENSE.md",
  },
  {
    name: "cpal",
    description: "Cross-platform audio I/O library for Rust (Windows WASAPI audio capture)",
    url: "https://github.com/RustAudio/cpal",
    license: "Apache License 2.0",
    licenseUrl: "https://github.com/RustAudio/cpal/blob/master/LICENSE",
  },
  {
    name: "hound",
    description: "A wav encoding and decoding library for Rust",
    url: "https://github.com/ruuda/hound",
    license: "Apache License 2.0",
    licenseUrl: "https://github.com/ruuda/hound/blob/master/license",
  },
  {
    name: "keyring",
    description: "Cross-platform library for OS keychain access",
    url: "https://github.com/hwchen/keyring-rs",
    license: "MIT License / Apache License 2.0",
    licenseUrl: "https://github.com/hwchen/keyring-rs/blob/master/LICENSE-MIT",
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
        ${t("licenses.viewLicense")}
      </a>
    </div>
  `,
    )
    .join("");

  overlay.innerHTML = `
    <div class="modal-dialog" style="max-width: 600px; max-height: 80vh; overflow: auto;">
      <div class="modal-header">
        <h3 class="modal-title">${t("licenses.title")}</h3>
        <button class="modal-close" aria-label="${t("licenses.close")}">
          ${getIcon("x", 24)}
        </button>
      </div>
      <div class="modal-body">
        <div class="licenses-intro">
          <p>${t("licenses.intro")}</p>
        </div>
        <div class="licenses-list">
          ${licensesHtml}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-primary close-licenses-btn">${t("licenses.close")}</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Open all external links via Tauri opener (works on Android; target="_blank" does not)
  overlay.addEventListener("click", (e) => {
    const anchor = e.target.closest("a[href]");
    if (anchor) {
      e.preventDefault();
      openUrl(anchor.href).catch((err) => console.error("Failed to open URL:", err));
    }
  });

  // Close handlers
  const closeDialog = () => {
    document.removeEventListener("keydown", keyHandler);
    overlay.remove();
  };

  const closeBtn = overlay.querySelector(".close-licenses-btn");
  overlay.querySelector(".modal-close")?.addEventListener("click", closeDialog);
  closeBtn?.addEventListener("click", closeDialog);

  // Close on overlay click
  let mousedownOnOverlay = false;
  overlay.addEventListener("mousedown", (e) => {
    mousedownOnOverlay = e.target === overlay;
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && mousedownOnOverlay) {
      closeDialog();
    }
  });

  // ESC and ENTER both dismiss this read-only dialog (only Close is offered).
  const keyHandler = (e) => {
    if (e.key === "Escape" || e.key === "Enter") {
      e.preventDefault();
      closeDialog();
    }
  };
  document.addEventListener("keydown", keyHandler);

  // Focus the Close button so ENTER/SPACE dismiss it.
  setTimeout(() => closeBtn?.focus(), 100);
}
