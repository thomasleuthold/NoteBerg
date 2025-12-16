/**
 * Note Card Component
 * Renders a clickable card for a note with preview and metadata
 */

/**
 * Render a note card
 * @param {Object} note - Note object from storage
 * @returns {string} HTML string for the note card
 */
export function renderNoteCard(note) {
  const lastModified = new Date(note.modified).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  // Determine content indicators
  const hasText = note.textContent && note.textContent.trim().length > 0;
  const hasStrokes = note.strokes && note.strokes.length > 0;
  const hasCanvas = note.canvasData !== null;

  // Get preview text
  const previewText = hasText
    ? truncateText(note.textContent, 120)
    : hasStrokes || hasCanvas
      ? '(Handwritten content)'
      : '(Empty note)';

  // Build content type indicators
  const indicators = [];
  if (hasText) indicators.push('<span class="note-indicator text">T</span>');
  if (hasStrokes) indicators.push('<span class="note-indicator handwriting">H</span>');
  if (hasCanvas) indicators.push('<span class="note-indicator drawing">D</span>');

  const indicatorsHtml = indicators.length > 0
    ? `<div class="note-indicators">${indicators.join('')}</div>`
    : '';

  // Tags
  const tagsHtml = note.tags && note.tags.length > 0
    ? `<div class="note-tags">${note.tags.map(tag => `<span class="note-tag">${escapeHtml(tag)}</span>`).join('')}</div>`
    : '';

  return `
    <div class="note-card" data-note-id="${note.id}">
      <button class="card-delete-btn" data-note-id="${note.id}" title="Delete note" aria-label="Delete note">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
        </svg>
      </button>
      <div class="note-card-header">
        <h4 class="note-card-title">${escapeHtml(note.title || 'Untitled')}</h4>
        ${indicatorsHtml}
      </div>
      <p class="note-card-preview">${escapeHtml(previewText)}</p>
      ${tagsHtml}
      <div class="note-card-footer">
        <span class="note-card-date">${lastModified}</span>
      </div>
    </div>
  `;
}

/**
 * Truncate text to specified length
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated text with ellipsis if needed
 */
function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + '...';
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
