/**
 * HTML sanitization for note content.
 *
 * Note content is HTML synced verbatim from other devices / the WebDAV folder,
 * so it must be treated as untrusted: `innerHTML` neuters <script> but NOT
 * event-handler attributes (<img src=x onerror=...>), which execute as soon as
 * the element is attached — in the Nextcloud build that means script execution
 * inside the NC origin with the user's session.
 *
 * Sanitize at every sink that injects note HTML into a live document:
 * thumbnail ghost (noteRenderer), editor load (TextLayer), PDF export
 * iframe (pdfExport), and the conflict dialog previews (modals).
 */

import DOMPurify from "dompurify";

/**
 * Sanitize note HTML. DOMPurify's default profile keeps formatting tags,
 * classes, and data-* attributes (needed for task spans like
 * `<span class="task-text" data-task-id=…>`), and strips scripts, event
 * handlers, and javascript: URLs.
 * @param {string} html - Untrusted note HTML
 * @returns {string} Safe HTML
 */
export function sanitizeNoteHtml(html) {
  if (!html) return "";
  return DOMPurify.sanitize(html);
}

/**
 * Sanitize HTML pasted into the text editor: as note HTML, and without images
 * (text boxes DESIGN §12.3). A web page's <img> would load a remote image (a
 * tracker, blocked by the Nextcloud CSP); pasted pictures become page images
 * instead, and images inside pasted HTML are dropped.
 * @param {string} html - Untrusted clipboard HTML
 * @returns {string} Safe HTML without images
 */
export function sanitizePastedHtml(html) {
  if (!html) return "";
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["img", "picture", "source"] });
}
