/**
 * Help tour copy — all first-use guidance text in one place.
 *
 * Centralizing the strings here (rather than inlining them at each hook site)
 * keeps the copy consistent and makes the eventual localization pass a
 * single-file swap: replace these literals with `t("helpOverlay.X.title")` /
 * `.body` calls once the English wording is final (plan Phase 7).
 *
 * Each entry is `{ title, body }`. The hook site pairs it with a live `target`
 * element at call time to build the `steps` array for startHelpTour().
 */

export const HELP_CONTENT = Object.freeze({
  pan: {
    title: "Pan & zoom",
    body: "Drag with touch to pan and pinch to zoom. If you start writing with a stylus, the canvas switches to Draw automatically while touch stays locked to panning.",
  },
  draw: {
    title: "Draw",
    body: "Tap Draw again to pick a pen, marker, or highlighter and change color or width. For formatted, searchable text, use Text mode instead.",
  },
  text: {
    title: "Text",
    body: "Type formatted text anywhere on the page — headings, bold, lists, and links are all supported. Select some text and use the ✓ Task button to turn it into a checkable task.",
  },
  eraser: {
    title: "Eraser",
    body: "Erase whole strokes, or switch to the part eraser to rub out only the piece you touch. You can also limit erasing to highlighter strokes only.",
  },
  lasso: {
    title: "Lasso select",
    body: "Draw a loop around strokes to select them, then drag to move or resize the selection. With strokes selected, open the ⋮ menu and choose Mark as Task to turn them into a checkable task.",
  },
  options: {
    title: "More options",
    body: "Open the note menu for export, page settings, and other actions. Your work saves automatically — there's no save button.",
  },
  insert: {
    title: "Insert",
    body: "Add images, a PDF, or a photo from your camera to the page here. To select an image afterward, long-press it (touch) or open its ⋮ option menu and choose Select (mouse), then drag to move or resize it.",
  },
  firstImage: {
    title: "Working with images",
    body: "To select an image again later, long-press it (touch), or open its ⋮ option menu and choose Select (mouse). Once selected, drag to move or resize it.",
  },
  markAsTask: {
    title: "Tasks",
    body: "The text you marked is now a checkable task. Tick it off here or from your task list.",
  },
});
