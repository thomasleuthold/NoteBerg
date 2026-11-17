/**
 * Escape text for interpolation into an HTML template: element text, a
 * `<textarea>`, or a quoted attribute value. Quotes are escaped too (unlike the
 * textContent/innerHTML trick), so the same helper is safe in every one of those
 * places; the browser decodes the entities again, so the user sees the original.
 * @param {unknown} text - null and undefined become ""
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
