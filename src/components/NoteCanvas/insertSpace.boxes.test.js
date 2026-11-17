/**
 * Insert-space moves text boxes with the ink (text boxes DESIGN §7): the real
 * text layer and the real ShiftContentCommand, on a note with strokes and boxes
 * above, below and across the line. One undo step puts ink and boxes back.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ShiftContentCommand } from "./commands/ShiftContentCommand.js";
import { TextLayer } from "./TextLayer.js";

vi.mock("../../i18n/index.js", () => ({ t: (key) => key }));
vi.mock("../HelpOverlay.js", () => ({ startHelpTour: vi.fn() }));

const box = (id, x, y, w, inner) =>
  `<div class="text-box" data-box-id="${id}" data-x="${x}" data-y="${y}" data-w="${w}">${inner}</div>`;

// Split at y 300: "above" ends above it, "across" starts above and reaches
// below it, "below" starts below it
const HTML =
  "<p>legacy main text</p>" +
  box("tb_above", 100, 100, 400, "<p>above</p>") +
  box("tb_across", 600, 280, 400, "<p>across</p>") +
  box("tb_below", 100, 500, 400, "<p>below</p>");

describe("insert-space with text boxes", () => {
  let layer;
  let noteCanvas;
  let saved;

  beforeEach(() => {
    const viewport = document.createElement("div");
    const scroller = document.createElement("div");
    document.body.append(viewport, scroller);
    global.ResizeObserver = vi.fn(function ResizeObserverMock() {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    });
    saved = [];
    layer = new TextLayer(viewport, scroller, { onContentChange: (html) => saved.push(html) });
    layer.init(HTML);
    noteCanvas = {
      textEditorLayer: layer,
      noteData: {
        strokes: [
          { id: "s_above", x: [10], y: [200] },
          { id: "s_below", x: [10], y: [700] },
        ],
        media: [],
      },
      spatialIndex: { build: vi.fn() },
      renderer: { forceRedraw: vi.fn() },
      strokeManager: { markDirty: vi.fn(), forceSave: vi.fn() },
      _saveMediaChanges: vi.fn(),
    };
  });

  afterEach(() => {
    layer.destroy();
    document.body.innerHTML = "";
  });

  test("moves the boxes whose top is below the line, with the ink below it", () => {
    const boxIds = layer.boxIdsBelow(300);
    expect(boxIds).toEqual(["tb_below"]); // a box across the line stays, as strokes do

    const command = new ShiftContentCommand(120, ["s_below"], [], 300, boxIds);
    command.redo(noteCanvas);

    const moved =
      "<p>legacy main text</p>" +
      box("tb_above", 100, 100, 400, "<p>above</p>") +
      box("tb_across", 600, 280, 400, "<p>across</p>") +
      box("tb_below", 100, 620, 400, "<p>below</p>");
    expect(layer.getContent()).toBe(moved);
    expect(saved.at(-1)).toBe(moved);
    expect(noteCanvas.noteData.strokes[1].y).toEqual([820]);

    // One undo step: ink and boxes together
    command.undo(noteCanvas);
    expect(layer.getContent()).toBe(HTML);
    expect(noteCanvas.noteData.strokes[1].y).toEqual([700]);
    expect(saved.at(-1)).toBe(HTML);
  });

  test("leaves the legacy main text where it is while every box below the line moves", () => {
    // A split at the very top: everything is below it, but the unwrapped main
    // text is not a box and stays (DESIGN §7)
    const boxIds = layer.boxIdsBelow(10);
    expect(boxIds).toEqual(["tb_above", "tb_across", "tb_below"]);
    new ShiftContentCommand(120, [], [], 10, boxIds).redo(noteCanvas);
    expect(layer.getContent()).toBe(
      "<p>legacy main text</p>" +
        box("tb_above", 100, 220, 400, "<p>above</p>") +
        box("tb_across", 600, 400, 400, "<p>across</p>") +
        box("tb_below", 100, 620, 400, "<p>below</p>"),
    );
  });

  test("a split below every box moves none", () => {
    expect(layer.boxIdsBelow(900)).toEqual([]);
    new ShiftContentCommand(120, [], [], 900, []).redo(noteCanvas);
    expect(layer.getContent()).toBe(HTML);
  });
});
