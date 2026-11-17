/**
 * Pen presets stored with a note. They come from the note file, which in a
 * shared notebook another user wrote, and the toolbar interpolates them into
 * markup and styles: only well-formed numbers and known types are kept.
 */

export const DEFAULT_PEN_PRESETS = Object.freeze([
  { width: 1.5, colorIndex: 0, type: "pen" },
  { width: 2, colorIndex: 1, type: "pen" },
  { width: 2, colorIndex: 2, type: "pen" },
  { width: 2, colorIndex: 3, type: "pen" },
  { width: 25, colorIndex: 0, type: "marker" }, // Yellow
  { width: 25, colorIndex: 1, type: "marker" }, // Green
  { width: 25, colorIndex: 2, type: "marker" }, // Orange
]);

const MAX_WIDTH = 100;

function normalizePreset(preset) {
  const width = Number(preset?.width);
  const colorIndex = Number(preset?.colorIndex);
  if (!Number.isFinite(width) || width <= 0 || width > MAX_WIDTH) return null;
  if (!Number.isInteger(colorIndex) || colorIndex < 0) return null;
  return { width, colorIndex, type: preset.type === "marker" ? "marker" : "pen" };
}

/**
 * The presets to use for a note: its own where they are well-formed, the
 * defaults when it has none (or none usable), and the marker presets added to
 * notes from before markers existed.
 * @param {unknown} stored - `note.penPresets`
 * @returns {Array<{width: number, colorIndex: number, type: "pen"|"marker"}>}
 */
export function normalizePenPresets(stored) {
  const kept = Array.isArray(stored) ? stored.map(normalizePreset).filter(Boolean) : [];
  if (kept.length === 0) return DEFAULT_PEN_PRESETS.map((p) => ({ ...p }));
  if (kept.some((p) => p.type === "marker")) return kept;
  return [
    ...kept,
    ...DEFAULT_PEN_PRESETS.filter((p) => p.type === "marker").map((p) => ({ ...p })),
  ];
}
