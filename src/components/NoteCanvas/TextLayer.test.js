/**
 * Unit tests for TextLayer: text boxes over the page, with one editor mounted
 * on the active box (text boxes DESIGN §4–§5).
 *
 * The real Trumbowyg runs here (it works in jsdom), so mounting, leaving and
 * the toolbar are the editor's own behaviour. jsdom has no layout: the tests
 * give boxes and lines sizes (`layoutStub`), the way a browser would measure
 * them, and drive the layer with pointer events at content coordinates
 * (zoom 1, layer at the viewport origin).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { TextChangeCommand } from "./commands/TextChangeCommand.js";
import { TextLayer } from "./TextLayer.js";

vi.mock("../../i18n/index.js", () => ({
  t: (key, opts) => (opts?.user ? `${key}:${opts.user}` : key),
}));
vi.mock("../HelpOverlay.js", () => ({ startHelpTour: vi.fn() }));

const BOX_HEIGHT = 48; // a box with one line of text: 24 px line + padding, as measured

/** Sizes a browser would measure: every box BOX_HEIGHT tall, legacy main text one line wide. */
const layoutStub = {
  saved: {},
  install() {
    this.saved.offsetHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return this.classList?.contains("text-box") && !this.classList.contains("text-box--main")
          ? BOX_HEIGHT
          : 0;
      },
    });
    this.saved.getClientRects = Range.prototype.getClientRects;
    this.saved.getBoundingClientRect = Range.prototype.getBoundingClientRect;
    // The main box's text: one line from x 46 to 400, at y 16..40
    Range.prototype.getClientRects = function () {
      const node = this.startContainer;
      const element = node.nodeType === 1 ? node : node.parentElement;
      if (node.nodeType !== 3 || !element?.closest(".text-box--main")) return [];
      return [{ left: 46, right: 400, top: 16, bottom: 40, width: 354, height: 24 }];
    };
    Range.prototype.getBoundingClientRect = () => ({
      left: 100,
      right: 100,
      top: 300,
      bottom: 324,
      width: 0,
      height: 24,
    });
  },
  uninstall() {
    if (this.saved.offsetHeight) {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", this.saved.offsetHeight);
    }
    Range.prototype.getClientRects = this.saved.getClientRects;
    Range.prototype.getBoundingClientRect = this.saved.getBoundingClientRect;
  },
};

const box = (id, x, y, w, inner) =>
  `<div class="text-box" data-box-id="${id}" data-x="${x}" data-y="${y}" data-w="${w}">${inner}</div>`;

/** A pointer event of a given kind at content (= client) coordinates. */
function pointer(type, target, { x, y, kind = "mouse", button = 0, id = 1 }) {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button,
  });
  Object.defineProperty(e, "pointerType", { value: kind });
  Object.defineProperty(e, "pointerId", { value: id });
  target.dispatchEvent(e);
  return e;
}

/** A tap: press, release, click, as the browser sends them. */
function tap(target, at, kind = "mouse") {
  pointer("pointerdown", target, { ...at, kind });
  pointer("pointerup", target, { ...at, kind });
  pointer("click", target, { ...at, kind });
}

describe("TextLayer", () => {
  let viewportElement;
  let scrollerContainer;
  let history;
  let layer;
  let onContentChange;
  let onImageInsert;
  let resizeCallback;
  let tapCancelled;
  let canvasBusy;

  const editors = () => document.querySelectorAll(".trumbowyg-editor");
  const editor = () => layer.container.querySelector(".trumbowyg-editor");
  const boxEl = (id) => layer.container.querySelector(`.text-box[data-box-id="${id}"]`);
  const mainEl = () => layer.container.querySelector(".text-box--main");

  /** The user typed: the editor's HTML changes and Trumbowyg reports it. */
  function typeHtml(html) {
    editor().innerHTML = html;
    layer.$editor.trigger("tbwchange");
  }

  function makeLayer(html, options = {}) {
    layer = new TextLayer(viewportElement, scrollerContainer, {
      onContentChange,
      historyManager: history,
      onImageInsert,
      isTapCancelled: () => tapCancelled,
      isCanvasBusy: () => canvasBusy,
      ...options,
    });
    layer.init(html);
    layer.container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1200, bottom: 5000 });
    layer.setMode("text");
    return layer;
  }

  beforeAll(() => layoutStub.install());
  afterAll(() => layoutStub.uninstall());

  beforeEach(() => {
    viewportElement = document.createElement("div");
    scrollerContainer = document.createElement("div");
    document.body.append(viewportElement, scrollerContainer);
    history = { push: vi.fn() };
    onContentChange = vi.fn();
    onImageInsert = vi.fn();
    tapCancelled = false;
    canvasBusy = false;
    global.ResizeObserver = vi.fn(function ResizeObserverMock(cb) {
      resizeCallback = cb;
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    });
    global.MutationObserver = vi.fn(function MutationObserverMock() {
      return { observe: vi.fn(), disconnect: vi.fn() };
    });

    // Browsers have it (the editor calls it on focus); jsdom does not
    document.execCommand = vi.fn(() => false);
    vi.useFakeTimers();
    // Frames are measured on the next animation frame: run it right away
    // (after the fake timers, which would hold it otherwise)
    vi.stubGlobal("requestAnimationFrame", (cb) => {
      cb();
      return 1;
    });
  });

  afterEach(() => {
    layer?.destroy();
    layer = null;
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("a note written before boxes", () => {
    const LEGACY = '<p>Main text</p><p><img src="data:image/png;base64,AAAA"></p>';

    test("shows its text as static HTML, with no editor mounted", () => {
      makeLayer(LEGACY);
      expect(editors()).toHaveLength(0);
      expect(mainEl().textContent).toContain("Main text");
      expect(mainEl().querySelector("img")).not.toBeNull();
    });

    test("loads, renders and stores the same bytes (inline images included)", () => {
      makeLayer(LEGACY);
      expect(layer.getContent()).toBe(LEGACY);
      vi.runAllTimers();
      expect(onContentChange).not.toHaveBeenCalled();
    });

    test("a tap in the text mounts the editor there; leaving without typing changes nothing", () => {
      makeLayer("<p>Main   text</p>\n<p>two</p>");
      tap(mainEl().querySelector(".text-box__content"), { x: 100, y: 24 });
      expect(editors()).toHaveLength(1);
      expect(mainEl().contains(editor())).toBe(true);

      tap(layer.container, { x: 900, y: 600 }); // beside the text: leaves it
      vi.runAllTimers();
      expect(editors()).toHaveLength(0);
      expect(layer.getContent()).toBe("<p>Main   text</p>\n<p>two</p>");
      expect(onContentChange).not.toHaveBeenCalled();
      expect(history.push).not.toHaveBeenCalled();
    });

    test("the page right of its widest line is empty page", () => {
      makeLayer("<p>Main text</p>");
      // Widest line ends at 400: its frame reaches 448
      tap(layer.container, { x: 600, y: 24 });
      expect(mainEl().contains(editor())).toBe(false);
      expect(editor()).not.toBeNull(); // a new box was started beside it
    });
  });

  describe("one editor, on the active box", () => {
    const TWO = box("tb_a", 100, 100, 400, "<p>A</p>") + box("tb_b", 100, 400, 400, "<p>B</p>");

    test("is moved from box to box; never two at once", () => {
      makeLayer(TWO);
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      expect(boxEl("tb_a").contains(editor())).toBe(true);
      tap(boxEl("tb_b"), { x: 150, y: 410 });
      expect(editors()).toHaveLength(1);
      expect(boxEl("tb_b").contains(editor())).toBe(true);
      expect(boxEl("tb_a").querySelector(".text-box__content").textContent).toBe("A");
    });

    test("toolbar formats the active box only: its pane is the live editor's", () => {
      makeLayer(TWO);
      const pane = () => layer.toolbarWrapper.querySelector(".trumbowyg-button-pane");
      expect(pane().classList).toContain("note-canvas__toolbar-pane--disabled");
      expect(pane().title).toBe("canvas.textBox.toolbarHint");
      expect([...pane().querySelectorAll("button")].every((b) => b.disabled)).toBe(true);

      tap(boxEl("tb_b"), { x: 150, y: 410 });
      expect(pane().classList).not.toContain("note-canvas__toolbar-pane--disabled");
      expect(layer.$editor.data("trumbowyg").$btnPane[0]).toBe(pane());
      expect(layer.toolbarWrapper.querySelectorAll(".trumbowyg-button-pane")).toHaveLength(1);
    });

    test("mounting and leaving many times leaves no dropdowns or listeners behind", {
      timeout: 30_000,
    }, () => {
      makeLayer(TWO);
      const bodyEvents = () =>
        Object.keys(window.jQuery._data(document.body, "events") ?? {}).length;
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      const dropdowns = document.querySelectorAll(".trumbowyg-dropdown").length;
      const events = bodyEvents();
      for (let i = 0; i < 8; i++) {
        tap(boxEl("tb_b"), { x: 150, y: 410 });
        tap(boxEl("tb_a"), { x: 150, y: 110 });
      }
      expect(document.querySelectorAll(".trumbowyg-dropdown")).toHaveLength(dropdowns);
      expect(document.querySelectorAll(".trumbowyg-box")).toHaveLength(1);
      expect(bodyEvents()).toBe(events);
      tap(layer.container, { x: 900, y: 900 });
      expect(document.querySelectorAll(".trumbowyg-box")).toHaveLength(0);
      expect(document.querySelectorAll(".trumbowyg-dropdown")).toHaveLength(0);
    });

    test("typing saves and records one undo step, with only the active box read from the editor", () => {
      makeLayer(TWO);
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      typeHtml("<p>A typed</p>");
      vi.advanceTimersByTime(300);
      expect(history.push).toHaveBeenCalledTimes(1);
      const [command] = history.push.mock.calls[0];
      expect(command).toBeInstanceOf(TextChangeCommand);
      expect(command.beforeHtml).toBe(TWO);
      const typed =
        box("tb_a", 100, 100, 400, "<p>A typed</p>") + box("tb_b", 100, 400, 400, "<p>B</p>");
      expect(command.afterHtml).toBe(typed);
      vi.advanceTimersByTime(200);
      expect(onContentChange).toHaveBeenCalledWith(typed);
    });
  });

  describe("toolbar actions that report no change (the table plugin)", () => {
    test("are saved and undoable like typing", () => {
      makeLayer(box("tb_a", 100, 100, 400, "<p>A</p>"));
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      // What the table plugin's grid does: write the table, call syncCode only
      editor().insertAdjacentHTML("beforeend", "<table><tbody><tr><td>x</td></tr></tbody></table>");
      const cell = document.createElement("td");
      layer.toolbarWrapper.appendChild(cell);
      cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      vi.runAllTimers();
      const withTable = box(
        "tb_a",
        100,
        100,
        400,
        "<p>A</p><table><tbody><tr><td>x</td></tr></tbody></table>",
      );
      expect(onContentChange).toHaveBeenLastCalledWith(withTable);
      expect(history.push).toHaveBeenCalledTimes(1);
      expect(history.push.mock.calls[0][0].afterHtml).toBe(withTable);
    });

    test("that changed nothing save nothing", () => {
      makeLayer(box("tb_a", 100, 100, 400, "<p>A</p>"));
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      layer.toolbarWrapper
        .querySelector("button")
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      vi.runAllTimers();
      expect(onContentChange).not.toHaveBeenCalled();
      expect(history.push).not.toHaveBeenCalled();
    });

    test("the table dropdown is shown in the toolbar, not in the zoomed text layer", () => {
      makeLayer(box("tb_b", 100, 400, 400, "<p>B</p>"));
      tap(boxEl("tb_b"), { x: 150, y: 410 });
      layer.toolbarWrapper
        .querySelector(".trumbowyg-table-button")
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      const dropdowns = () => document.querySelectorAll(".trumbowyg-dropdown-table");
      expect(dropdowns()).toHaveLength(1);
      expect(layer.toolbarWrapper.contains(dropdowns()[0])).toBe(true);
      expect(layer.container.contains(dropdowns()[0])).toBe(false);
      // Opened again: still one
      layer.toolbarWrapper
        .querySelector(".trumbowyg-table-button")
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(dropdowns()).toHaveLength(1);
      // Leaving the box takes it away
      tap(layer.container, { x: 900, y: 1200 });
      expect(dropdowns()).toHaveLength(0);
    });

    test("color and highlight dropdowns remain hidden until their toolbar buttons are pressed", () => {
      makeLayer(box("tb_c", 100, 400, 400, "<p>C</p>"));
      tap(boxEl("tb_c"), { x: 150, y: 410 });

      const foreDropdown = layer.toolbarWrapper.querySelector(".trumbowyg-dropdown-foreColor");
      const backDropdown = layer.toolbarWrapper.querySelector(".trumbowyg-dropdown-backColor");
      expect(foreDropdown).not.toBeNull();
      expect(backDropdown).not.toBeNull();

      // Both must start hidden (display: none)
      expect(foreDropdown.style.display).toBe("none");
      expect(backDropdown.style.display).toBe("none");

      // Pressing foreColor button opens it
      const foreBtn = layer.toolbarWrapper.querySelector(".trumbowyg-foreColor-button");
      foreBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(foreDropdown.style.display).not.toBe("none");
      expect(foreDropdown.style.position).toBe("fixed");
      expect(backDropdown.style.display).toBe("none");

      // Clicking outside (or triggering mousedown on body) hides it
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      expect(foreDropdown.style.display).toBe("none");

      // Pressing backColor button opens highlight dropdown
      const backBtn = layer.toolbarWrapper.querySelector(".trumbowyg-backColor-button");
      backBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(backDropdown.style.display).not.toBe("none");
      expect(backDropdown.style.position).toBe("fixed");
      expect(foreDropdown.style.display).toBe("none");

      // Leaving the box takes dropdowns away
      tap(layer.container, { x: 900, y: 1200 });
      expect(layer.toolbarWrapper.querySelectorAll(".trumbowyg-dropdown")).toHaveLength(0);
    });

    test("a table dropdown button acts on the press, once, with any input, and keeps the box", () => {
      makeLayer(box("tb_b", 100, 400, 400, "<p>B</p>"));
      tap(boxEl("tb_b"), { x: 150, y: 410 });
      const dropdown = document.createElement("div");
      dropdown.className = "trumbowyg-dropdown trumbowyg-dropdown-table";
      const button = document.createElement("button");
      dropdown.appendChild(button);
      layer.toolbarWrapper.appendChild(dropdown);
      // Trumbowyg runs a dropdown button on mousedown (buildSubBtn)
      const action = vi.fn();
      window.jQuery(button).on("mousedown", action);

      for (const kind of ["touch", "pen", "mouse"]) {
        action.mockClear();
        const down = pointer("pointerdown", button, { x: 50, y: 900, kind });
        // A press keeps the editor's focus (no default action), acts on release
        expect(down.defaultPrevented, kind).toBe(true);
        expect(action, kind).not.toHaveBeenCalled();
        pointer("pointerup", button, { x: 50, y: 900, kind });
        expect(action, kind).toHaveBeenCalledTimes(1);
        pointer("click", button, { x: 50, y: 900, kind });
        expect(boxEl("tb_b").contains(editor()), kind).toBe(true);
      }

      // A finger that scrolls the menu runs nothing: it moved, or the browser cancelled it
      action.mockClear();
      pointer("pointerdown", button, { x: 50, y: 900, kind: "touch" });
      pointer("pointermove", button, { x: 50, y: 860, kind: "touch" });
      pointer("pointerup", button, { x: 50, y: 860, kind: "touch" });
      pointer("pointerdown", button, { x: 50, y: 900, kind: "touch" });
      pointer("pointercancel", button, { x: 50, y: 900, kind: "touch" });
      pointer("pointerup", button, { x: 50, y: 900, kind: "touch" });
      expect(action).not.toHaveBeenCalled();
    });

    test("a click whose press did not start on the layer (a menu closed under the finger) is no tap", () => {
      makeLayer(box("tb_b", 100, 400, 400, "<p>B</p>"));
      tap(boxEl("tb_b"), { x: 150, y: 410 });
      // The press was on a toolbar menu; the click lands on the page below it
      pointer("click", layer.container, { x: 600, y: 900, kind: "touch" });
      expect(boxEl("tb_b").contains(editor())).toBe(true);
      expect(layer.container.querySelectorAll(".text-box")).toHaveLength(1);
    });

    test("a press on the editor's own UI in the box (a dropdown) leaves the box active", () => {
      makeLayer(box("tb_b", 100, 400, 400, "<p>B</p>"));
      tap(boxEl("tb_b"), { x: 150, y: 410 });
      const dropdown = document.createElement("div");
      dropdown.className = "trumbowyg-dropdown";
      boxEl("tb_b").querySelector(".trumbowyg-box").appendChild(dropdown);
      // Fixed beside the toolbar: over empty page by its coordinates
      tap(dropdown, { x: 50, y: 900 });
      expect(boxEl("tb_b").contains(editor())).toBe(true);
    });
  });

  describe("creating a box", () => {
    test("a tap on empty page starts a box there, snapped; it is content once it holds text", () => {
      makeLayer("");
      tap(layer.container, { x: 500, y: 333 });
      expect(editor()).not.toBeNull();
      // Nothing typed yet: nothing to store, nothing to undo
      vi.runAllTimers();
      expect(layer.getContent()).toBe("");
      expect(onContentChange).not.toHaveBeenCalled();

      typeHtml("<p>Hello</p>");
      vi.runAllTimers();
      // Plain page: text origin snapped to 8 px across (504), to the 24 px line
      // the tap is in (312), the box around it by its padding
      expect(layer.getContent()).toMatch(
        /^<div class="text-box" data-box-id="tb_\w+" data-x="496" data-y="308" data-w="400"><p>Hello<\/p><\/div>$/,
      );
      expect(history.push).toHaveBeenCalledTimes(1);
      expect(history.push.mock.calls[0][0].beforeHtml).toBe("");
    });

    test("snaps to the lines of a ruled page", () => {
      makeLayer("", { getBackground: () => "ruled-medium" });
      tap(layer.container, { x: 500, y: 333 });
      typeHtml("<p>x</p>");
      // Lines every 30 px: the row the tap is in starts at 330
      expect(layer.getContent()).toContain('data-x="496" data-y="326"');
    });

    test("snaps both ways to the squares of a grid page", () => {
      makeLayer("", { getBackground: () => "grid-large" });
      tap(layer.container, { x: 515, y: 333 });
      typeHtml("<p>x</p>");
      expect(layer.getContent()).toContain('data-x="512" data-y="316"');
    });

    test("near the right edge a box shrinks before it moves left", () => {
      makeLayer("");
      tap(layer.container, { x: 900, y: 100 });
      typeHtml("<p>x</p>");
      expect(layer.getContent()).toContain('data-x="896" data-y="92" data-w="304"');

      layer.destroy();
      makeLayer("");
      tap(layer.container, { x: 1150, y: 100 });
      typeHtml("<p>x</p>");
      expect(layer.getContent()).toContain('data-x="1000" data-y="92" data-w="200"');
    });

    test("a tap on empty page while a box is active only leaves it; the next one creates", () => {
      makeLayer(box("tb_a", 100, 100, 400, "<p>A</p>"));
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      tap(layer.container, { x: 700, y: 700 });
      expect(editor()).toBeNull();
      tap(layer.container, { x: 700, y: 700 });
      expect(editor()).not.toBeNull();
      expect(boxEl("tb_a").contains(editor())).toBe(false);
    });

    test("with every input: mouse, pen and a finger", () => {
      for (const kind of ["mouse", "pen", "touch"]) {
        makeLayer("");
        tap(layer.container, { x: 300, y: 300 }, kind);
        expect(editor(), kind).not.toBeNull();
        layer.destroy();
      }
      layer = null;
    });

    test("a click that drags creates nothing", () => {
      makeLayer("");
      pointer("pointerdown", layer.container, { x: 300, y: 300 });
      pointer("pointerup", layer.container, { x: 340, y: 300 });
      pointer("click", layer.container, { x: 340, y: 300 });
      expect(editor()).toBeNull();
    });

    test("a touch that panned, pinched or stopped a scroll creates nothing", () => {
      makeLayer("");
      tapCancelled = true;
      tap(layer.container, { x: 300, y: 300 }, "touch");
      expect(editor()).toBeNull();
    });

    test("a press while an image is selected is the image's (it moves or deselects it)", () => {
      makeLayer(box("tb_a", 100, 100, 400, "<p>A</p>"));
      canvasBusy = true;
      tap(layer.container, { x: 700, y: 700 });
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      expect(editor()).toBeNull();
    });
  });

  describe("continue zone", () => {
    // A box at y 100, 48 tall: its last line ends at 144
    const ONE = box("tb_a", 100, 100, 400, "<p>A</p>");

    test("a tap up to two lines below a box continues it, with the caret at its end", () => {
      makeLayer(ONE);
      tap(layer.container, { x: 300, y: 144 + 20 });
      expect(boxEl("tb_a").contains(editor())).toBe(true);
      // Within one line: no new line
      expect(editor().querySelectorAll("p")).toHaveLength(1);
    });

    test("more than one line below adds an empty line to type in", () => {
      makeLayer(ONE);
      tap(layer.container, { x: 300, y: 144 + 40 });
      expect(boxEl("tb_a").contains(editor())).toBe(true);
      expect(editor().querySelectorAll("p")).toHaveLength(2);
    });

    test("works for the box being edited too: the tap continues it instead of leaving", () => {
      makeLayer(ONE);
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      const host = editor();
      tap(layer.container, { x: 300, y: 144 + 40 });
      expect(editor()).toBe(host);
      expect(editor().querySelectorAll("p")).toHaveLength(2);
      const selection = window.getSelection();
      expect(host.lastChild.contains(selection.anchorNode)).toBe(true);
    });

    test("below another box while one is active, the first tap only leaves", () => {
      makeLayer(`${ONE}${box("tb_b", 600, 600, 400, "<p>B</p>")}`);
      tap(boxEl("tb_b"), { x: 650, y: 610 });
      tap(layer.container, { x: 300, y: 144 + 20 });
      expect(editor()).toBeNull();
      tap(layer.container, { x: 300, y: 144 + 20 });
      expect(boxEl("tb_a").contains(editor())).toBe(true);
    });

    test("ends at 48 px below the last line, and at the box's column", () => {
      makeLayer(ONE);
      tap(layer.container, { x: 300, y: 144 + 48 });
      expect(boxEl("tb_a").contains(editor())).toBe(true);
      tap(layer.container, { x: 900, y: 900 }); // leave

      tap(layer.container, { x: 300, y: 144 + 49 });
      expect(editor()).not.toBeNull();
      expect(boxEl("tb_a").contains(editor())).toBe(false);
      tap(layer.container, { x: 900, y: 900 }); // leave (the new box is empty: gone)

      tap(layer.container, { x: 520, y: 144 + 10 });
      expect(boxEl("tb_a").contains(editor())).toBe(false);
    });
  });

  describe("deleting", () => {
    test("an empty box is removed when left", () => {
      makeLayer(box("tb_a", 100, 100, 400, "<p>A</p>"));
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      typeHtml("<p><br></p>");
      tap(layer.container, { x: 900, y: 900 });
      expect(boxEl("tb_a")).toBeNull();
      vi.runAllTimers();
      expect(layer.getContent()).toBe("");
    });

    test("Delete in an empty box removes it", () => {
      makeLayer(box("tb_a", 100, 100, 400, "<p>A</p>"));
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      typeHtml("");
      editor().dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
      expect(boxEl("tb_a")).toBeNull();
      expect(layer.getContent()).toBe("");
    });

    test("Delete in the box's options menu removes it as one undo step", () => {
      const html = box("tb_a", 100, 100, 400, "<p>A</p>") + box("tb_b", 100, 400, 400, "<p>B</p>");
      makeLayer(html);
      tap(boxEl("tb_b"), { x: 150, y: 410 });
      // The ⋮ only opens the menu: a slip on it deletes nothing
      layer.container.querySelector(".text-box__options").click();
      expect(boxEl("tb_b")).not.toBeNull();
      const items = [...viewportElement.querySelectorAll(".context-floating-menu__btn")];
      expect(items.map((b) => b.textContent)).toEqual(["common.delete"]);
      items[0].click();
      expect(boxEl("tb_b")).toBeNull();
      expect(viewportElement.querySelector(".context-floating-menu")).toBeNull();
      expect(history.push).toHaveBeenCalledTimes(1);
      const [command] = history.push.mock.calls[0];
      expect(command.beforeHtml).toBe(html);
      expect(command.afterHtml).toBe(box("tb_a", 100, 100, 400, "<p>A</p>"));
      expect(onContentChange).toHaveBeenLastCalledWith(command.afterHtml);
    });
  });

  describe("moving and resizing", () => {
    const ONE = box("tb_a", 100, 100, 400, "<p>A</p>");

    function drag(action, from, to) {
      const handle = layer.container.querySelector(
        action === "move" ? ".text-box__handle" : ".text-box__resize",
      );
      pointer("pointerdown", handle, from);
      pointer("pointermove", handle, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
      pointer("pointermove", handle, to);
      pointer("pointerup", handle, to);
    }

    test("the handle moves the box, snapped; one undo step on release", () => {
      makeLayer(ONE);
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      drag("move", { x: 300, y: 90 }, { x: 403, y: 160 });
      const moved = box("tb_a", 200, 164, 400, "<p>A</p>");
      expect(layer.getContent()).toBe(moved);
      expect(history.push).toHaveBeenCalledTimes(1);
      expect(history.push.mock.calls[0][0].beforeHtml).toBe(ONE);
      expect(history.push.mock.calls[0][0].afterHtml).toBe(moved);
    });

    test("a straight drag moves along one axis only", () => {
      makeLayer(box("tb_a", 101, 100, 400, "<p>A</p>"));
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      drag("move", { x: 300, y: 90 }, { x: 302, y: 190 });
      expect(layer.getContent()).toBe(box("tb_a", 101, 212, 400, "<p>A</p>"));
    });

    test("a move is kept on the page", () => {
      makeLayer(ONE);
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      drag("move", { x: 300, y: 90 }, { x: 2000, y: -500 });
      expect(layer.getContent()).toBe(box("tb_a", 800, 0, 400, "<p>A</p>"));
    });

    test("the right edge changes the width only, not below the minimum", () => {
      makeLayer(ONE);
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      drag("resize", { x: 505, y: 120 }, { x: 405, y: 300 });
      expect(layer.getContent()).toBe(box("tb_a", 100, 100, 300, "<p>A</p>"));
      drag("resize", { x: 405, y: 120 }, { x: 0, y: 120 });
      expect(layer.getContent()).toBe(box("tb_a", 100, 100, 80, "<p>A</p>"));
    });

    test("moving the legacy main box wraps it, its text in place; undo restores the unwrapped form", () => {
      makeLayer("<p>Main</p>");
      tap(mainEl().querySelector(".text-box__content"), { x: 100, y: 24 });
      drag("move", { x: 200, y: 0 }, { x: 201, y: 50 });
      // MAIN_BOX_GEOMETRY (38, 12, 1150) moved straight down: the text keeps its
      // x (46), its top (16 + 50) snaps to the 24 px line (72)
      expect(layer.getContent()).toMatch(
        /^<div class="text-box" data-box-id="tb_\w+" data-x="38" data-y="68" data-w="1150"><p>Main<\/p><\/div>$/,
      );
      const [command] = history.push.mock.calls.at(-1);
      expect(command.beforeHtml).toBe("<p>Main</p>");

      const noteCanvas = {
        textEditorLayer: layer,
        _onTextContentChange: vi.fn(),
        noteData: { tasks: [] },
      };
      command.undo(noteCanvas);
      expect(layer.getContent()).toBe("<p>Main</p>");
      expect(mainEl()).not.toBeNull();
      command.redo(noteCanvas);
      expect(layer.getContent()).toBe(command.afterHtml);
    });

    test("the legacy main box is resized from the width its frame shows", () => {
      makeLayer("<p>Main</p>");
      tap(mainEl().querySelector(".text-box__content"), { x: 100, y: 24 });
      // Its frame: x 38, up to the widest line (400) + 48 = 448, so 410 wide
      drag("resize", { x: 452, y: 24 }, { x: 412, y: 24 });
      expect(layer.getContent()).toMatch(/data-x="38" data-y="12" data-w="370"/);
    });

    test("at the top of the page the move handle sits below the frame", () => {
      makeLayer(`<p>Main</p>${box("tb_a", 100, 400, 400, "<p>A</p>")}`);
      const chrome = () => layer.container.querySelector(".text-box__chrome");
      tap(mainEl().querySelector(".text-box__content"), { x: 100, y: 24 });
      expect(chrome().classList).toContain("text-box__chrome--handle-below");
      tap(boxEl("tb_a"), { x: 150, y: 410 });
      expect(chrome().classList).not.toContain("text-box__chrome--handle-below");
    });

    test("handles are sized in screen pixels at any zoom", () => {
      makeLayer(ONE);
      layer.update(0.25, 0, 0, 0);
      expect(layer.container.style.getPropertyValue("--text-box-inv-zoom")).toBe("4");
    });
  });

  describe("content from elsewhere (undo, live take-in)", () => {
    const TWO = box("tb_a", 100, 100, 400, "<p>hello</p>") + box("tb_b", 100, 400, 400, "<p>B</p>");

    function caretAt(node, offset) {
      const range = document.createRange();
      range.setStart(node, offset);
      range.collapse(true);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }

    test("updates boxes by id: the active box's editor is left alone when another box changed", () => {
      makeLayer(TWO);
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      const host = editor();
      caretAt(host.querySelector("p").firstChild, 3); // hel|lo

      layer.replaceContent(
        box("tb_a", 100, 100, 400, "<p>hello</p>") +
          box("tb_b", 300, 600, 400, "<p>B from bob</p>"),
      );

      expect(editor()).toBe(host);
      expect(window.getSelection().anchorNode.textContent).toBe("hello");
      expect(window.getSelection().anchorOffset).toBe(3);
      expect(boxEl("tb_b").textContent).toBe("B from bob");
      expect(boxEl("tb_b").style.left).toBe("300px");
    });

    test("keeps the caret in its box when that box's text changed", () => {
      makeLayer(TWO);
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      caretAt(editor().querySelector("p").firstChild, 3);

      layer.replaceContent(
        box("tb_a", 100, 100, 400, "<p>from bob</p><p>hello</p>") +
          box("tb_b", 100, 400, 400, "<p>B</p>"),
      );

      expect(boxEl("tb_a").contains(window.getSelection().anchorNode)).toBe(true);
      expect(window.getSelection().anchorNode.textContent).toBe("hello");
      expect(window.getSelection().anchorOffset).toBe(3);
    });

    test("an undo that removes the active box leaves it first", () => {
      makeLayer(TWO);
      tap(boxEl("tb_b"), { x: 150, y: 410 });
      layer.setContentSilently(box("tb_a", 100, 100, 400, "<p>hello</p>"));
      expect(editor()).toBeNull();
      expect(boxEl("tb_b")).toBeNull();
      expect(document.querySelectorAll(".trumbowyg-box")).toHaveLength(0);
    });

    test("records no undo step and sanitizes what it is given", () => {
      makeLayer(TWO);
      layer.replaceContent(`${TWO}<img src=x onerror="alert(1)">`);
      vi.runAllTimers();
      expect(history.push).not.toHaveBeenCalled();
      expect(layer.container.innerHTML).not.toContain("onerror");
    });

    test("normalizes what old clients leave: text after a box joins it", () => {
      makeLayer(`${box("tb_a", 100, 100, 400, "<p>A</p>")}<p>typed at the end</p>`);
      expect(layer.getContent()).toBe(
        box("tb_a", 100, 100, 400, "<p>A</p><p>typed at the end</p>"),
      );
      // Normalizing is no edit
      vi.runAllTimers();
      expect(onContentChange).not.toHaveBeenCalled();
    });
  });

  describe("tasks", () => {
    const TASKS = [
      { id: "t1", type: "text", checked: false },
      { id: "t2", type: "text", checked: true },
    ];
    const HTML =
      box(
        "tb_a",
        100,
        100,
        400,
        '<p><span class="task-text" data-task-id="t1">one</span>&nbsp;</p>',
      ) +
      box(
        "tb_b",
        100,
        400,
        400,
        '<p><span class="task-text" data-task-id="t2">two</span>&nbsp;</p>',
      );

    test("tasks in boxes nobody is editing survive orphan cleanup", () => {
      makeLayer(HTML);
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      const tasks = TASKS.map((t) => ({ ...t }));
      expect(layer.cleanupOrphanedTextTasks(tasks)).toBe(false);
      expect(tasks).toHaveLength(2);
    });

    test("checkboxes render in every box and are not stored", () => {
      makeLayer(HTML);
      layer.renderTaskCheckboxes(TASKS);
      expect(layer.container.querySelectorAll(".task-text-checkbox")).toHaveLength(2);
      tap(boxEl("tb_b"), { x: 150, y: 410 });
      expect(boxEl("tb_b").querySelector(".task-text-checkbox--checked")).not.toBeNull();
      expect(layer.getContent()).not.toContain("task-text-checkbox");
      expect(layer.findTaskElement("t2")).toBe(boxEl("tb_b").querySelector(".task-text"));
    });
  });

  describe("search", () => {
    test("highlights matches in every box, without storing the marks", () => {
      makeLayer(`<p>apple</p>${box("tb_a", 100, 300, 400, "<p>apple pie</p>")}`);
      layer.highlightSearchTerms("apple");
      expect(layer.container.querySelectorAll("mark.search-highlight")).toHaveLength(2);
      tap(boxEl("tb_a"), { x: 150, y: 310 });
      expect(editor().querySelectorAll("mark.search-highlight")).toHaveLength(1);
      typeHtml(`${editor().innerHTML}<p>more</p>`);
      expect(layer.getContent()).not.toContain("<mark");
      layer.clearHighlights();
      expect(layer.container.querySelectorAll("mark.search-highlight")).toHaveLength(0);
    });
  });

  describe("paste", () => {
    function paste(target, { files = [], html = "" }) {
      const e = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(e, "clipboardData", {
        value: {
          items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
          getData: (type) => (type === "text/html" ? html : ""),
        },
      });
      target.dispatchEvent(e);
      return e;
    }

    test("a pasted image goes to the page at the caret; the text is unchanged", () => {
      makeLayer(box("tb_a", 100, 100, 400, "<p>A</p>"));
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      const host = editor();
      host.getBoundingClientRect = () => ({ left: 100, top: 100, right: 500, bottom: 148 });
      host.style.paddingLeft = "8px"; // the box padding, from the stylesheet in the app
      const range = document.createRange();
      range.selectNodeContents(host);
      range.collapse(false);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);

      const png = new File(["x"], "shot.png", { type: "image/png" });
      const e = paste(host, { files: [png] });

      expect(e.defaultPrevented).toBe(true);
      // The box's text column (box left + padding), just below the caret's line
      expect(onImageInsert).toHaveBeenCalledWith([png], { x: 108, y: 324 });
      vi.runAllTimers();
      expect(layer.getContent()).toBe(box("tb_a", 100, 100, 400, "<p>A</p>"));
      expect(history.push).not.toHaveBeenCalled();
    });

    test("pasted HTML loses its images and box wrappers, keeps its formatting", () => {
      makeLayer(box("tb_a", 100, 100, 400, "<p>A</p>"));
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      const exec = vi.fn();
      document.execCommand = exec;
      const e = paste(editor(), {
        html: `<p><b>bold</b><img src="https://tracker.example/p.gif"></p>${box("tb_x", 0, 0, 400, "<p>other</p>")}<img src="data:image/png;base64,AAAA">`,
      });
      expect(e.defaultPrevented).toBe(true);
      const inserted = exec.mock.calls[0][2];
      expect(exec.mock.calls[0][0]).toBe("insertHTML");
      expect(inserted).toContain("<b>bold</b>");
      expect(inserted).toContain("<p>other</p>");
      expect(inserted).not.toContain("<img");
      expect(inserted).not.toContain("text-box");
    });

    test("plain HTML is left to the editor", () => {
      makeLayer(box("tb_a", 100, 100, 400, "<p>A</p>"));
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      const e = paste(editor(), { html: "<p><b>bold</b></p>" });
      expect(e.defaultPrevented).toBe(false);
    });
  });

  describe("heights", () => {
    test("the content height is the lowest box bottom", () => {
      const onHeightChange = vi.fn();
      makeLayer(`<p>main</p>${box("tb_a", 100, 900, 400, "<p>A</p>")}`, { onHeightChange });
      const main = mainEl();
      resizeCallback([
        { target: main, borderBoxSize: [{ blockSize: 140 }] },
        { target: boxEl("tb_a"), borderBoxSize: [{ blockSize: 72 }] },
      ]);
      expect(onHeightChange).toHaveBeenLastCalledWith(972);
    });
  });

  describe("insert-space", () => {
    test("moves the boxes below a line and saves them", () => {
      const html = `<p>main</p>${box("tb_a", 100, 100, 400, "<p>A</p>")}${box("tb_b", 100, 600, 400, "<p>B</p>")}`;
      makeLayer(html);
      expect(layer.boxIdsBelow(300)).toEqual(["tb_b"]);
      layer.moveBoxes(["tb_b"], 120);
      const moved = `<p>main</p>${box("tb_a", 100, 100, 400, "<p>A</p>")}${box("tb_b", 100, 720, 400, "<p>B</p>")}`;
      expect(layer.getContent()).toBe(moved);
      expect(onContentChange).toHaveBeenLastCalledWith(moved);
      // Recorded by the shift's own command, not as a text step
      expect(history.push).not.toHaveBeenCalled();
    });
  });

  describe("modes and read-only", () => {
    test("leaving text mode leaves the box; other modes take no taps", () => {
      makeLayer(box("tb_a", 100, 100, 400, "<p>A</p>"));
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      layer.setMode("draw");
      expect(editor()).toBeNull();
      tap(layer.container, { x: 600, y: 600 });
      expect(editor()).toBeNull();
      expect(layer.container.querySelector(".text-box__chrome").hidden).toBe(true);
    });

    test("a viewer never gets the editor, and text mode cannot be entered", () => {
      makeLayer(box("tb_a", 100, 100, 400, "<p>shared</p>"));
      layer.setReadOnly(true);
      layer.setMode("text");
      expect(layer.mode).toBe("pan");
      expect(layer.toolbarWrapper.style.display).toBe("none");
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      expect(editor()).toBeNull();
    });

    test("can be used again when switched back", () => {
      makeLayer(box("tb_a", 100, 100, 400, "<p>A</p>"));
      layer.setReadOnly(true);
      layer.setReadOnly(false);
      layer.setMode("text");
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      expect(editor()).not.toBeNull();
    });
  });

  describe("merge conflict hints", () => {
    const STORED = box(
      "tb_a",
      100,
      100,
      400,
      '<p>kept<span class="merge-hint" data-conflict="c1" data-by="bob"></span></p>',
    );

    test("render in static and active boxes, and are stored without their label", () => {
      makeLayer(STORED);
      let hint = boxEl("tb_a").querySelector(".merge-hint");
      expect(hint.textContent).toBe("⚠");
      expect(hint.getAttribute("data-hint")).toBe("canvas.mergeHint:bob");
      tap(boxEl("tb_a"), { x: 150, y: 110 });
      hint = editor().querySelector(".merge-hint");
      expect(hint.getAttribute("contenteditable")).toBe("false");
      typeHtml(`${editor().innerHTML}<p>x</p>`);
      const saved = layer.getContent();
      expect(saved).toContain('data-conflict="c1"');
      expect(saved).not.toContain("⚠");
      expect(saved).not.toContain("data-hint");
    });
  });

  test("destroy saves pending typing and removes the layer and toolbar", () => {
    makeLayer(box("tb_a", 100, 100, 400, "<p>A</p>"));
    tap(boxEl("tb_a"), { x: 150, y: 110 });
    typeHtml("<p>A!</p>");
    layer.destroy();
    expect(onContentChange).toHaveBeenCalledWith(box("tb_a", 100, 100, 400, "<p>A!</p>"));
    expect(history.push).toHaveBeenCalledTimes(1);
    expect(viewportElement.querySelector(".note-canvas__text-editor-layer")).toBeNull();
    expect(scrollerContainer.querySelector(".note-canvas__trumbowyg-toolbar")).toBeNull();
    layer = null;
  });
});
