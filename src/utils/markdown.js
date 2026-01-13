/**
 * Markdown Conversion Utilities
 * Simple markdown to HTML conversion for WYSIWYG editing
 */

/**
 * Convert markdown to HTML for display in contenteditable
 * @param {string} markdown - Markdown text
 * @returns {string} HTML string
 */
export function markdownToHtml(markdown) {
  let html = markdown
    // Headers
    .replace(/^### (.*$)/gim, "<h3>$1</h3>")
    .replace(/^## (.*$)/gim, "<h2>$1</h2>")
    .replace(/^# (.*$)/gim, "<h1>$1</h1>")
    // Bold
    .replace(/\*\*(.*?)\*\*/gim, "<strong>$1</strong>")
    // Italic
    .replace(/\*(.*?)\*/gim, "<em>$1</em>")
    // Lists
    .replace(/^- (.*$)/gim, "<li>$1</li>")
    // Paragraphs
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br>");

  // Wrap in paragraph if not already wrapped
  if (!html.startsWith("<")) {
    html = `<p>${html}</p>`;
  }

  // Wrap lists in ul tags
  html = html.replace(/(<li>.*<\/li>)/gim, "<ul>$1</ul>");

  return html;
}

/**
 * Convert HTML from contenteditable back to markdown for storage
 * @param {string} html - HTML string
 * @returns {string} Markdown text
 */
export function htmlToMarkdown(html) {
  let markdown = html
    // Headers
    .replace(/<h1>(.*?)<\/h1>/gim, "# $1\n\n")
    .replace(/<h2>(.*?)<\/h2>/gim, "## $1\n\n")
    .replace(/<h3>(.*?)<\/h3>/gim, "### $1\n\n")
    // Bold
    .replace(/<strong>(.*?)<\/strong>/gim, "**$1**")
    .replace(/<b>(.*?)<\/b>/gim, "**$1**")
    // Italic
    .replace(/<em>(.*?)<\/em>/gim, "*$1*")
    .replace(/<i>(.*?)<\/i>/gim, "*$1*")
    // Lists
    .replace(/<li>(.*?)<\/li>/gim, "- $1\n")
    .replace(/<\/?ul>/gim, "")
    // Line breaks and paragraphs
    .replace(/<br\s*\/?>/gim, "\n")
    .replace(/<\/p><p>/gim, "\n\n")
    .replace(/<\/?p>/gim, "");

  // Clean up extra whitespace
  markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();

  return markdown;
}
