import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClock } from "../../modules/hlc.js";
import { NoteVersioner } from "../../modules/noteVersions.js";
import { NoteCanvas } from "./NoteCanvas.js";

// Polyfill DOMMatrix for pdfjs-dist (safeguard)
if (!globalThis.DOMMatrix) {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor() {
      this.a = 1;
      this.b = 0;
      this.c = 0;
      this.d = 1;
      this.e = 0;
      this.f = 0;
    }
    toString() {
      return "matrix(1, 0, 0, 1, 0, 0)";
    }
    translate() {
      return this;
    }
    scale() {
      return this;
    }
    multiply() {
      return this;
    }
  };
}

// Polyfill PointerEvent for jsdom
globalThis.PointerEvent = class PointerEvent extends Event {
  constructor(type, props = {}) {
    super(type, props);
    this.clientX = props.clientX || 0;
    this.clientY = props.clientY || 0;
    this.pointerId = props.pointerId || 0;
    this.pressure = props.pressure || 0;
    this.pointerType = props.pointerType || "mouse";
    this.buttons = props.buttons ?? 0;
  }
};

// Polyfill WheelEvent for jsdom
globalThis.WheelEvent = class WheelEvent extends MouseEvent {
  constructor(type, props = {}) {
    super(type, props);
    this.deltaY = props.deltaY || 0;
  }
};

// Polyfill ResizeObserver for jsdom
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Mock dependencies
vi.mock("../../modules/storage.js", () => ({
  getNote: vi.fn(),
  getNoteIndex: vi.fn(async () => null),
  getNotebook: vi.fn(async () => null),
  updateNote: vi.fn(),
  updateNoteCoalesced: vi.fn(() => Promise.resolve()),
  flushNoteWrites: vi.fn(() => Promise.resolve()),
  deleteNote: vi.fn(),
  deleteFile: vi.fn(() => Promise.resolve()), // Return a promise
  saveFile: vi.fn((blob) => Promise.resolve(`file-${blob.size}`)),
  generateId: vi.fn(() => "mock-id"),
}));

vi.mock("../../modules/pdfManager.js", () => ({
  importPdf: vi.fn(),
}));

vi.mock("../modals.js", () => ({
  showAlertDialog: vi.fn(),
  showConfirmDialog: vi.fn(),
  showProgressDialog: vi.fn(() => ({
    update: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("../../modules/autoRecognition.js", () => ({
  forceRecognition: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../utils/imageUtils.js", () => ({
  pickImages: vi.fn(),
  processImageFile: vi.fn(),
  captureFromCamera: vi.fn(),
  fileToDataUrl: vi.fn(),
  optimizeImageForDisplay: vi.fn((url) =>
    Promise.resolve({ dataUrl: url, width: 100, height: 100 }),
  ),
}));

vi.mock("./VirtualScroller.js");
vi.mock("./CanvasRenderer.js");
vi.mock("./SpatialIndex.js");
vi.mock("./InputHandler.js");
vi.mock("./MediaManager.js");
vi.mock("./MediaOverlay.js");
vi.mock("./NoteToolbar.js");
vi.mock("./StrokeManager.js");
vi.mock("./HistoryManager.js");
vi.mock("./PdfTextLayerManager.js", () => {
  class PdfTextLayerManagerMock {
    update = vi.fn();
    setMode = vi.fn();
    destroy = vi.fn();
    refresh = vi.fn();
    onPageRemoved = vi.fn();
    highlightSearchTerms = vi.fn();
    clearHighlights = vi.fn();
  }
  return { PdfTextLayerManager: PdfTextLayerManagerMock };
});
vi.mock("./TextLayer.js", () => {
  class TextLayerMock {
    init = vi.fn();
    update = vi.fn();
    setMode = vi.fn();
    setReadOnly = vi.fn();
    setContentHeight = vi.fn();
    getContent = vi.fn(() => "");
    forceSave = vi.fn();
    destroy = vi.fn();
    highlightSearchTerms = vi.fn();
    clearHighlights = vi.fn();
    renderTaskCheckboxes = vi.fn();
    cleanupOrphanedTextTasks = vi.fn();
    findTaskElement = vi.fn(() => null);
    flushHistory = vi.fn();
    boxIdsBelow = vi.fn(() => []);
    moveBoxes = vi.fn();
  }
  return { TextLayer: TextLayerMock };
});

// Mock global window events
window.scrollTo = vi.fn();
window.requestAnimationFrame = vi.fn((cb) => setTimeout(cb, 0));
window.cancelAnimationFrame = vi.fn((id) => clearTimeout(id));

describe("_onVisibilityChange and a running recording", () => {
  // Android mutes the microphone of a background app, so a recording is ended
  // and saved when the page is hidden. Windows hides the page on minimize or
  // full occlusion while capture keeps working, so there it must keep running.
  let host;
  let userAgent;

  beforeEach(() => {
    host = Object.create(NoteCanvas.prototype);
    host.activePointers = new Map();
    host.recordingManager = {
      isRecording: () => true,
      stopRecordingForBackground: vi.fn(),
    };
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    userAgent = vi.spyOn(navigator, "userAgent", "get");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops and saves the recording on Android", () => {
    userAgent.mockReturnValue("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36");
    host._onVisibilityChange();
    expect(host.recordingManager.stopRecordingForBackground).toHaveBeenCalledTimes(1);
  });

  it("keeps recording on Windows", () => {
    userAgent.mockReturnValue(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/129.0",
    );
    host._onVisibilityChange();
    expect(host.recordingManager.stopRecordingForBackground).not.toHaveBeenCalled();
  });
});

describe("per-frame caches", () => {
  // _getStrokeTasks and _getFirstPdfPage run on every scroll frame. They are
  // pure functions of noteData.tasks / the media list, so they are exercised
  // directly on a minimal object rather than through the full canvas harness.
  let host;

  beforeEach(async () => {
    const { NoteCanvas } = await import("./NoteCanvas.js");
    host = Object.create(NoteCanvas.prototype);
  });

  describe("_getStrokeTasks", () => {
    it("filters to stroke-type tasks", () => {
      host.noteData = {
        tasks: [
          { id: "a", type: "stroke" },
          { id: "b", type: "text" },
          { id: "c", type: "stroke" },
        ],
      };
      expect(host._getStrokeTasks().map((t) => t.id)).toEqual(["a", "c"]);
    });

    it("returns the same array while tasks are unchanged", () => {
      host.noteData = { tasks: [{ id: "a", type: "stroke" }] };
      expect(host._getStrokeTasks()).toBe(host._getStrokeTasks());
    });

    it("recomputes when the tasks array is replaced", () => {
      host.noteData = { tasks: [{ id: "a", type: "stroke" }] };
      host._getStrokeTasks();

      host.noteData.tasks = [
        { id: "a", type: "stroke" },
        { id: "b", type: "stroke" },
      ];
      expect(host._getStrokeTasks()).toHaveLength(2);
    });

    it("recomputes when a task is pushed in place", () => {
      // Several call sites push onto the existing array rather than replacing
      // it, so identity alone would serve a stale list forever.
      host.noteData = { tasks: [{ id: "a", type: "stroke" }] };
      expect(host._getStrokeTasks()).toHaveLength(1);

      host.noteData.tasks.push({ id: "b", type: "stroke" });
      expect(host._getStrokeTasks()).toHaveLength(2);
    });

    it("recomputes when a task is spliced out in place", () => {
      host.noteData = {
        tasks: [
          { id: "a", type: "stroke" },
          { id: "b", type: "stroke" },
        ],
      };
      expect(host._getStrokeTasks()).toHaveLength(2);

      host.noteData.tasks.splice(0, 1);
      expect(host._getStrokeTasks()).toHaveLength(1);
    });

    it("returns an empty list when there are no tasks", () => {
      host.noteData = {};
      expect(host._getStrokeTasks()).toEqual([]);
      host.noteData = { tasks: [] };
      expect(host._getStrokeTasks()).toEqual([]);
    });
  });

  describe("_getFirstPdfPage", () => {
    it("returns the page with the smallest y, regardless of array order", () => {
      const items = [
        { id: "p2", type: "pdf-page", y: 800 },
        { id: "p1", type: "pdf-page", y: 0 },
        { id: "img", type: "image", y: -500 }, // must be ignored
      ];
      host.mediaManager = { version: 0, getItems: () => items };
      expect(host._getFirstPdfPage().id).toBe("p1");
    });

    it("reuses the cached page until the media version changes", () => {
      const items = [{ id: "p1", type: "pdf-page", y: 100 }];
      const manager = { version: 0, getItems: () => items };
      host.mediaManager = manager;
      expect(host._getFirstPdfPage().id).toBe("p1");

      items.unshift({ id: "p0", type: "pdf-page", y: 0 });
      expect(host._getFirstPdfPage().id).toBe("p1"); // still cached

      manager.version++;
      expect(host._getFirstPdfPage().id).toBe("p0");
    });

    it("returns null when there are no PDF pages", () => {
      host.mediaManager = { version: 0, getItems: () => [{ id: "i", type: "image", y: 0 }] };
      expect(host._getFirstPdfPage()).toBeNull();
    });
  });
});

describe("NoteCanvas Class", () => {
  let container;
  let noteCanvas;
  let mockNoteData;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockNoteData = {
      id: "note-1",
      strokes: [],
      deletedStrokes: [],
      media: [],
      deletedMedia: [],
      background: "none",
    };

    const { getNote } = await import("../../modules/storage.js");
    getNote.mockResolvedValue(mockNoteData);

    const { MediaManager } = await import("./MediaManager.js");
    let mediaManagerItems;
    MediaManager.mockImplementation(function (_noteId, media) {
      mediaManagerItems = media;
      Object.assign(this, {
        setOnImageLoaded: vi.fn(),
        setItems: vi.fn((items) => {
          mediaManagerItems = items;
        }),
        getItems: vi.fn(() => mediaManagerItems),
        addItem: vi.fn((item) => mediaManagerItems.push(item)),
        removeItem: vi.fn((id) => {
          const index = mediaManagerItems.findIndex((i) => i.id === id);
          if (index > -1) mediaManagerItems.splice(index, 1);
        }),
        updateItem: vi.fn((id, props) => {
          const item = mediaManagerItems.find((i) => i.id === id);
          if (item) Object.assign(item, props);
        }),
        resolvePendingItem: vi.fn((id, fileId, geometry = {}) => {
          const item = mediaManagerItems.find((i) => i.id === id);
          if (!item) return false;
          Object.assign(item, geometry, { fileId });
          delete item.pending;
          return true;
        }),
        moveItemToFront: vi.fn((id) => {
          const item = mediaManagerItems.find((i) => i.id === id);
          const index = mediaManagerItems.findIndex((i) => i.id === id);
          if (index > -1) mediaManagerItems.splice(index, 1);
          mediaManagerItems.push(item);
        }),
        moveItemToBack: vi.fn((id) => {
          const item = mediaManagerItems.find((i) => i.id === id);
          const index = mediaManagerItems.findIndex((i) => i.id === id);
          if (index > -1) mediaManagerItems.splice(index, 1);
          mediaManagerItems.unshift(item);
        }),
        hitTest: vi.fn(() => null),
        getImage: vi.fn(),
        destroy: vi.fn(),
      });
    });

    const { VirtualScroller } = await import("./VirtualScroller.js");
    VirtualScroller.mockImplementation(function () {
      const viewportElement = document.createElement("div");
      viewportElement.getBoundingClientRect = vi.fn(() => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
      }));
      viewportElement.setPointerCapture = vi.fn();
      viewportElement.releasePointerCapture = vi.fn();
      viewportElement.hasPointerCapture = vi.fn(() => false);
      Object.assign(this, {
        getViewportSize: () => ({ width: 800, height: 600 }),
        getViewportElement: () => viewportElement,
        setContentSize: vi.fn(),
        getScrollLeft: () => 0,
        getScrollTop: () => 0,
        getViewportBounds: () => ({ left: 0, top: 0, width: 800, height: 600 }),
        setZoom: vi.fn(),
        scrollBy: vi.fn(),
        destroy: vi.fn(),
        container: document.createElement("div"),
      });
    });

    const { InputHandler } = await import("./InputHandler.js");
    InputHandler.mockImplementation(function () {
      Object.assign(this, {
        isDrawing: false,
        activePointerType: null,
        getContentCoordinates: vi.fn(() => ({ x: 0, y: 0 })),
        cancelActiveStroke: vi.fn(function () {
          if (!this.isDrawing) return false;
          this.isDrawing = false;
          this.activePointerType = null;
          return true;
        }),
        destroy: vi.fn(),
      });
    });

    const { CanvasRenderer } = await import("./CanvasRenderer.js");
    CanvasRenderer.mockImplementation(function () {
      Object.assign(this, {
        setData: vi.fn(),
        setSpatialIndex: vi.fn(),
        setMediaManager: vi.fn(),
        setContentSize: vi.fn(),
        resize: vi.fn(),
        render: vi.fn(),
        drawDirectStroke: vi.fn(),
        drawEraserCursor: vi.fn(),
        drawLassoTrail: vi.fn(),
        clearOverlay: vi.fn(),
        forceRedraw: vi.fn(),
        startPendingMediaAnimation: vi.fn(),
        stopPendingMediaAnimation: vi.fn(),
        setZoom: vi.fn(),
        setSelectedStrokes: vi.fn(),
        setSelectedMedia: vi.fn(),
        setLineSeparators: vi.fn(),
        selectionBounds: null,
        selectedStrokeIndices: new Set(),
        lineSeparators: [],
        lineIndentLevels: [],
        destroy: vi.fn(),
      });
    });

    const { SpatialIndex } = await import("./SpatialIndex.js");
    SpatialIndex.mockImplementation(function () {
      const strokeBounds = new Map();
      return {
        strokeBounds,
        build: vi.fn((strokes) => {
          strokeBounds.clear();
          strokes?.forEach((s, i) => {
            if (s && !s._deleted) {
              const minX = Math.min(...s.x);
              const maxX = Math.max(...s.x);
              const minY = Math.min(...s.y);
              const maxY = Math.max(...s.y);
              strokeBounds.set(i, { minX, maxX, minY, maxY });
            }
          });
        }),
        getContentBounds: () => ({ minX: 0, minY: 0, maxX: 100, maxY: 100 }),
        query: vi.fn(() => []),
        insert: vi.fn((stroke, index) => {
          const minX = Math.min(...stroke.x);
          const maxX = Math.max(...stroke.x);
          const minY = Math.min(...stroke.y);
          const maxY = Math.max(...stroke.y);
          strokeBounds.set(index, { minX, maxX, minY, maxY });
        }),
        remove: vi.fn(),
        clear: vi.fn(),
      };
    });

    const { StrokeManager } = await import("./StrokeManager.js");
    StrokeManager.mockImplementation(function (_noteId, strokes) {
      this.currentStroke = null;
      this.startStroke = vi.fn(function (props) {
        this.currentStroke = {
          ...props,
          id: `s-${strokes.length}`,
          x: [props.x],
          y: [props.y],
          pressure: [props.pressure],
        };
        return this.currentStroke;
      });
      this.addPoints = vi.fn(function (points) {
        points.forEach((p) => {
          this.currentStroke.x.push(p.x);
          this.currentStroke.y.push(p.y);
        });
        return this.currentStroke;
      });
      this.endStroke = vi.fn(function () {
        const stroke = this.currentStroke;
        if (stroke) {
          if (!stroke._keep) strokes.push(stroke);
          this.currentStroke = null;
          return stroke;
        }
        return null;
      });
      this.cancelCurrentStroke = vi.fn(function () {
        if (this.currentStroke) this.currentStroke._keep = false;
        this.currentStroke = null;
      });
      this.markDirty = vi.fn();
      this.saveMedia = vi.fn();
      this.forceSave = vi.fn();
      this.destroy = vi.fn();
    });

    const { HistoryManager } = await import("./HistoryManager.js");
    HistoryManager.mockImplementation(function () {
      this.push = vi.fn();
      this.undo = vi.fn();
      this.redo = vi.fn();
      this.setNoteCanvas = vi.fn();
      this.destroy = vi.fn();
      this.clear = vi.fn();
    });

    noteCanvas = new NoteCanvas(container);
  });

  afterEach(() => {
    if (noteCanvas) noteCanvas.destroy();
    document.body.removeChild(container);
    vi.clearAllMocks();
  });

  describe("PDF Handling", () => {
    let importPdf, showConfirmDialog;

    beforeEach(async () => {
      const pdfManager = await import("../../modules/pdfManager.js");
      const modals = await import("../modals.js");
      importPdf = pdfManager.importPdf;
      showConfirmDialog = modals.showConfirmDialog;

      const pickPdfSpy = vi.spyOn(NoteCanvas.prototype, "_pickPdfFile");
      pickPdfSpy.mockResolvedValue(new File(["fake-pdf"], "test.pdf"));
    });

    it("should insert a PDF and create an undo command", async () => {
      importPdf.mockResolvedValue({
        pages: [{ id: "page1", type: "pdf-page", width: 500, height: 700 }],
        fileId: "pdf-file-id",
      });
      await noteCanvas.load("note-1");
      const historyPushSpy = vi.spyOn(noteCanvas.historyManager, "push");

      await noteCanvas.insertPdf();

      expect(noteCanvas.noteData.media).toHaveLength(1);
      expect(historyPushSpy).toHaveBeenCalledWith(
        expect.any((await import("./commands/index.js")).InsertMediaCommand),
      );
    });

    it("anchors imported PDF pages at the top of the canvas", async () => {
      // The pages *are* the document, so they must line up with the stroke and
      // text layers, which both start at content Y=0. Inserting at the scroll
      // position left a gap above page 1 (and shifted every page below it).
      importPdf.mockResolvedValue({
        pages: [
          { id: "page1", type: "pdf-page", width: 500, height: 700 },
          { id: "page2", type: "pdf-page", width: 500, height: 700 },
        ],
        fileId: "pdf-file-id",
      });
      await noteCanvas.load("note-1");

      // Import while scrolled away from the top — the old code anchored to
      // viewport.top, so this is what made the offset arbitrary.
      noteCanvas.scroller.getViewportBounds = vi.fn(() => ({
        top: 900,
        bottom: 1900,
        left: 0,
        right: 1200,
        height: 1000,
        width: 1200,
      }));

      await noteCanvas.insertPdf();

      const pdfPages = noteCanvas.noteData.media.filter((m) => m.type === "pdf-page");
      expect(pdfPages).toHaveLength(2);
      expect(pdfPages[0].y).toBe(0);
      // Pages chain directly onto each other, with no gap between them.
      expect(pdfPages[1].y).toBe(pdfPages[0].height);
    });

    it("expands the canvas to fit the scaled page stack", async () => {
      // importPdf returns raw PDF-point dimensions; pages are scaled up to the
      // canvas width on insert. Measuring the raw pages under-reported the
      // bottom by the scale factor, leaving the canvas too short to reach the
      // end of the document.
      importPdf.mockResolvedValue({
        pages: [
          { id: "page1", type: "pdf-page", width: 595, height: 842, y: 0 },
          { id: "page2", type: "pdf-page", width: 595, height: 842, y: 842 },
        ],
        fileId: "pdf-file-id",
      });
      await noteCanvas.load("note-1");
      const expandSpy = vi.spyOn(noteCanvas, "_expandCanvas");

      await noteCanvas.insertPdf();

      const pdfPages = noteCanvas.noteData.media.filter((m) => m.type === "pdf-page");
      const actualBottom = pdfPages[1].y + pdfPages[1].height;
      // Scaled to 1200 wide, two A4 pages are ~3400px tall — well beyond the
      // ~1684px the raw dimensions would have suggested.
      expect(actualBottom).toBeGreaterThan(3000);

      if (actualBottom > noteCanvas.contentHeight) {
        expect(expandSpy).toHaveBeenCalledWith(actualBottom - noteCanvas.contentHeight + 500);
      }
    });

    it("should delete a PDF and create an undo command", async () => {
      mockNoteData.pdfSource = "pdf-file-id";
      mockNoteData.media.push({ id: "page1", type: "pdf-page" });
      showConfirmDialog.mockResolvedValue(true);
      await noteCanvas.load("note-1");
      const historyPushSpy = vi.spyOn(noteCanvas.historyManager, "push");

      await noteCanvas.deletePdf();

      expect(noteCanvas.noteData.media).toHaveLength(0);
      expect(historyPushSpy).toHaveBeenCalledWith(
        expect.any((await import("./commands/index.js")).DeleteMediaCommand),
      );
    });
  });

  describe("Scratch-out Gesture", () => {
    it("should detect and erase strokes with a scratch-out gesture", async () => {
      const strokeToErase1 = { id: "s-erase-1", x: [50, 51], y: [50, 51], _deleted: false };
      mockNoteData.strokes.push(strokeToErase1);
      await noteCanvas.load("note-1");

      const points = [];
      let x = 55;
      for (let i = 0; i < 50; i++) {
        points.push({ x: x, y: 55, pressure: 0.5 });
        x += i % 2 === 0 ? 30 : -30;
      }

      noteCanvas.spatialIndex.query.mockReturnValue([0]);
      const historyPushSpy = vi.spyOn(noteCanvas.historyManager, "push");

      noteCanvas._setMode("draw");
      noteCanvas._onStrokeStart({ ...points[0], pointerType: "pen" });
      noteCanvas._onStrokeMove(points.slice(1));
      noteCanvas._onStrokeEnd();

      expect(strokeToErase1._deleted).toBe(true);
      expect(historyPushSpy).toHaveBeenCalledWith(
        expect.any((await import("./commands/index.js")).EraseStrokesCommand),
      );
    });
  });

  describe("Initialization & Loading", () => {
    it("should load note data and initialize components", async () => {
      await noteCanvas.load("note-1");

      expect(noteCanvas.noteData).toEqual(mockNoteData);
      expect(noteCanvas.renderer.setData).toHaveBeenCalled();
      expect(noteCanvas.spatialIndex.build).toHaveBeenCalled();
      expect(noteCanvas.textEditorLayer.init).toHaveBeenCalled();
    });
  });

  describe("Interaction Modes", () => {
    it("should switch modes correctly", () => {
      noteCanvas._setMode("draw");
      expect(noteCanvas.mode).toBe("draw");
      expect(noteCanvas.containerElement.classList.contains("note-canvas--draw-mode")).toBe(true);

      noteCanvas._setMode("eraser");
      expect(noteCanvas.mode).toBe("eraser");
      expect(noteCanvas.containerElement.classList.contains("note-canvas--eraser-mode")).toBe(true);
    });
  });

  describe("Drawing", () => {
    it("should handle drawing strokes", async () => {
      await noteCanvas.load("note-1");
      noteCanvas._setMode("draw");

      const startProps = { x: 10, y: 10, pressure: 0.5, pointerType: "pen", pointerId: 1 };
      noteCanvas._onStrokeStart(startProps);
      expect(noteCanvas.strokeManager.startStroke).toHaveBeenCalled();

      const movePoints = [{ x: 20, y: 20, pressure: 0.6, time: 100 }];
      noteCanvas._onStrokeMove(movePoints);
      expect(noteCanvas.strokeManager.addPoints).toHaveBeenCalled();

      noteCanvas._onStrokeEnd();
      expect(noteCanvas.strokeManager.endStroke).toHaveBeenCalled();
      expect(noteCanvas.historyManager.push).toHaveBeenCalledWith(
        expect.any((await import("./commands/index.js")).DrawStrokeCommand),
      );
    });

    it("ignores strokes that start in the gutter beside the page", async () => {
      // A note narrower than the window leaves viewport on either side of the
      // page. Nothing there is rendered, so a stroke started there must not be
      // recorded as invisible note data.
      await noteCanvas.load("note-1");
      noteCanvas._setMode("draw");
      const props = { y: 10, pressure: 0.5, pointerType: "pen", pointerId: 1 };

      expect(noteCanvas._onStrokeStart({ ...props, x: noteCanvas.maxContentWidth + 1 })).toBe(
        false,
      );
      expect(noteCanvas._onStrokeStart({ ...props, x: -1 })).toBe(false);
      expect(noteCanvas.strokeManager.startStroke).not.toHaveBeenCalled();

      expect(noteCanvas._onStrokeStart({ ...props, x: noteCanvas.maxContentWidth })).toBe(true);
      expect(noteCanvas.strokeManager.startStroke).toHaveBeenCalledTimes(1);
    });
  });

  describe("Eraser", () => {
    it("should erase strokes", async () => {
      await noteCanvas.load("note-1");
      const stroke = { id: "s1", x: [10], y: [10], _deleted: false };
      mockNoteData.strokes = [stroke];
      noteCanvas.spatialIndex.query.mockReturnValue([0]); // Return index 0

      noteCanvas._setMode("eraser");

      // Mock intersection check to return true
      noteCanvas._strokeIntersectsCircle = vi.fn(() => true);

      noteCanvas._onStrokeStart({ x: 10, y: 10, clientX: 10, clientY: 10, pointerType: "pen" });
      noteCanvas._onStrokeMove([{ x: 10, y: 10, clientX: 10, clientY: 10 }]);
      noteCanvas._onStrokeEnd();

      expect(stroke._deleted).toBe(true);
      expect(noteCanvas.historyManager.push).toHaveBeenCalled();
    });

    it("saves once when the gesture ends, not on every move", async () => {
      await noteCanvas.load("note-1");
      const strokes = [1, 2, 3].map((i) => ({ id: `s${i}`, x: [i], y: [i], _deleted: false }));
      mockNoteData.strokes = strokes;
      noteCanvas._setMode("eraser");
      noteCanvas._strokeIntersectsCircle = vi.fn(() => true);

      noteCanvas._onStrokeStart({ x: 1, y: 1, clientX: 1, clientY: 1, pointerType: "pen" });
      for (const i of [0, 1, 2]) {
        // Each move hits one more stroke
        noteCanvas.spatialIndex.query.mockReturnValue([i]);
        noteCanvas._onStrokeMove([{ x: i, y: i, clientX: i, clientY: i }]);
      }
      expect(noteCanvas.strokeManager.forceSave).not.toHaveBeenCalled();

      noteCanvas._onStrokeEnd();
      expect(strokes.every((s) => s._deleted)).toBe(true);
      expect(noteCanvas.strokeManager.forceSave).toHaveBeenCalledTimes(1);
    });
  });

  describe("Insert space", () => {
    it("records the shift although nothing of this editor's lies below the line", async () => {
      // A collaborator's ink drawn there meanwhile still has to move (DESIGN §10.7 D)
      await noteCanvas.load("note-1");
      mockNoteData.strokes = [];
      noteCanvas.noteData.media = [];
      noteCanvas._setMode("insert-space");
      noteCanvas.insertSpaceState = { startY: 100, currentY: 160 };

      noteCanvas._onStrokeEnd();

      expect(noteCanvas.noteData.shifts).toEqual([expect.objectContaining({ y: 100, delta: 60 })]);
      expect(noteCanvas.strokeManager.forceSave).toHaveBeenCalled();
    });

    it("moves the text boxes below the line in the same undo step, after pending typing", async () => {
      await noteCanvas.load("note-1");
      mockNoteData.strokes = [];
      noteCanvas.noteData.media = [];
      const layer = noteCanvas.textEditorLayer;
      layer.boxIdsBelow.mockReturnValue(["tb_1"]);
      const order = [];
      layer.flushHistory.mockImplementation(() => order.push("typing"));
      noteCanvas.historyManager.push.mockImplementation(() => order.push("shift"));
      noteCanvas._setMode("insert-space");
      noteCanvas.insertSpaceState = { startY: 100, currentY: 160 };

      noteCanvas._onStrokeEnd();

      expect(layer.boxIdsBelow).toHaveBeenCalledWith(100);
      expect(order).toEqual(["typing", "shift"]);
      const [command] = noteCanvas.historyManager.push.mock.calls.at(-1);
      expect(command.boxIds).toEqual(["tb_1"]);
      expect(layer.moveBoxes).toHaveBeenCalledWith(["tb_1"], 60);
    });
  });

  describe("Lasso Selection", () => {
    it("should select strokes with lasso", async () => {
      await noteCanvas.load("note-1");
      const stroke = { id: "s1", x: [10], y: [10], _deleted: false };
      mockNoteData.strokes = [stroke];

      // Mock spatial index to return stroke
      noteCanvas.spatialIndex.query.mockReturnValue([0]);
      noteCanvas.spatialIndex.strokeBounds.set(0, { minX: 0, maxX: 20, minY: 0, maxY: 20 });

      noteCanvas._setMode("lasso");

      // Simulate lasso drawing
      noteCanvas._onStrokeStart({ x: 0, y: 0, clientX: 0, clientY: 0, pointerType: "pen" });
      noteCanvas._onStrokeMove([{ x: 100, y: 0, clientX: 100, clientY: 0 }]);
      noteCanvas._onStrokeMove([{ x: 100, y: 100, clientX: 100, clientY: 100 }]);
      noteCanvas._onStrokeMove([{ x: 0, y: 100, clientX: 0, clientY: 100 }]);

      // Mock internal helpers
      noteCanvas._isStrokeFullyInPolygon = vi.fn(() => true);

      noteCanvas._onStrokeEnd();

      expect(noteCanvas.renderer.setSelectedStrokes).toHaveBeenCalledWith(
        new Set([0]),
        expect.objectContaining({ minX: expect.any(Number) }),
      );
    });

    it("never selects or moves a text box (the lasso is for strokes only)", async () => {
      await noteCanvas.load("note-1");
      mockNoteData.strokes = [];
      noteCanvas.spatialIndex.query.mockReturnValue([]);
      noteCanvas._setMode("lasso");

      // A lasso around the whole page, where a box would be
      noteCanvas._onStrokeStart({ x: 0, y: 0, clientX: 0, clientY: 0, pointerType: "pen" });
      noteCanvas._onStrokeMove([{ x: 1200, y: 0, clientX: 1200, clientY: 0 }]);
      noteCanvas._onStrokeMove([{ x: 1200, y: 2000, clientX: 1200, clientY: 2000 }]);
      noteCanvas._onStrokeMove([{ x: 0, y: 2000, clientX: 0, clientY: 2000 }]);
      noteCanvas._onStrokeEnd();

      const layer = noteCanvas.textEditorLayer;
      expect(layer.moveBoxes).not.toHaveBeenCalled();
      expect(layer.boxIdsBelow).not.toHaveBeenCalled();
      expect(noteCanvas.renderer.setSelectedStrokes).not.toHaveBeenCalledWith(
        expect.any(Set),
        expect.objectContaining({ minX: expect.any(Number) }),
      );
    });
  });

  describe("a notebook shared with the user", () => {
    const sharedNotebook = (sharePermissions, extra = {}) => ({
      id: "nb-shared",
      origin: "shared",
      sharePermissions,
      ...extra,
    });

    async function loadIn(notebook) {
      const { getNotebook } = await import("../../modules/storage.js");
      mockNoteData.notebookId = notebook?.id ?? null;
      mockNoteData.tasks = [{ id: "t1", type: "text", checked: false, modified: 1 }];
      getNotebook.mockResolvedValue(notebook);
      await noteCanvas.load("note-1");
    }

    describe("read-only", () => {
      beforeEach(async () => {
        await loadIn(sharedNotebook(1));
      });

      it("builds the editor for a viewer", async () => {
        const { NoteToolbar } = await import("./NoteToolbar.js");
        expect(noteCanvas.readOnly).toBe(true);
        expect(noteCanvas.permissions).toEqual({ canEdit: false, canManage: false });
        expect(NoteToolbar.mock.calls.at(-1)[2]).toMatchObject({
          canEdit: false,
          canManage: false,
        });
        expect(noteCanvas.strokeManager.readOnly).toBe(true);
        expect(noteCanvas.textEditorLayer.setReadOnly).toHaveBeenCalledWith(true);
      });

      it("only lets the user look around", () => {
        for (const mode of ["draw", "eraser", "lasso", "text", "insert-space"]) {
          noteCanvas._setMode(mode);
          expect(noteCanvas.mode).toBe("pan");
        }
      });

      it("keeps a stylus from switching into drawing", () => {
        noteCanvas._onStrokeStart({ x: 1, y: 1, clientX: 1, clientY: 1, pointerType: "pen" });
        expect(noteCanvas.mode).toBe("pan");
        expect(noteCanvas.strokeManager.startStroke).not.toHaveBeenCalled();
      });

      it("ignores editing shortcuts", () => {
        noteCanvas._onKeyDown({ ctrlKey: true, key: "z", preventDefault: vi.fn() });
        noteCanvas._onKeyDown({ ctrlKey: true, key: "y", preventDefault: vi.fn() });
        noteCanvas._onKeyDown({ ctrlKey: true, key: "v", preventDefault: vi.fn() });
        expect(noteCanvas.historyManager.undo).not.toHaveBeenCalled();
        expect(noteCanvas.historyManager.redo).not.toHaveBeenCalled();
      });

      it("does not select media, so it cannot be moved, cropped or deleted", () => {
        expect(noteCanvas._handleMediaInteraction(1, 1, 1, 1)).toEqual({ consumed: false });
      });

      it("does not tick a task: the box is put back and nothing is saved", async () => {
        const { updateNoteCoalesced } = await import("../../modules/storage.js");
        noteCanvas.textEditorLayer.renderTaskCheckboxes.mockClear();

        noteCanvas._toggleTask("t1", true);

        expect(noteCanvas.noteData.tasks[0].checked).toBe(false);
        expect(noteCanvas.textEditorLayer.renderTaskCheckboxes).toHaveBeenCalled();
        expect(updateNoteCoalesced).not.toHaveBeenCalled();
      });

      it("never writes: not tasks, not text, not media, not recordings", async () => {
        const storage = await import("../../modules/storage.js");
        storage.updateNote.mockClear();
        storage.updateNoteCoalesced.mockClear();

        noteCanvas._saveTasks();
        noteCanvas._createTextTask("t2");
        noteCanvas._onTextContentChange("<p>typed</p>");
        await noteCanvas._saveMediaChanges();
        noteCanvas._saveRecordingChanges([], []);

        expect(storage.updateNote).not.toHaveBeenCalled();
        expect(storage.updateNoteCoalesced).not.toHaveBeenCalled();
        expect(noteCanvas.noteData.content).not.toBe("<p>typed</p>");
        expect(noteCanvas.noteData.tasks).toHaveLength(1);
      });

      it("cannot add or remove media, images or PDFs through any entry point", async () => {
        const { pickImages } = await import("../../utils/imageUtils.js");
        const { importPdf } = await import("../../modules/pdfManager.js");
        noteCanvas.mediaManager.removeItem.mockClear?.();

        await noteCanvas.insertImage("picker");
        await noteCanvas.insertPdf();
        await noteCanvas.deletePdf();
        await noteCanvas.deleteSelectedMedia("m1");
        noteCanvas._showPdfOptions(1, 1);

        expect(pickImages).not.toHaveBeenCalled();
        expect(importPdf).not.toHaveBeenCalled();
        expect(document.getElementById("pdf-options-menu")).toBeNull();
      });

      it("offers no paste on the canvas, by context menu or long-press", async () => {
        const { AppClipboard } = await import("./AppClipboard.js");
        const copied = { id: "c1", x: [1, 2], y: [1, 2], pressure: [1, 1], width: 2 };
        AppClipboard.copy("strokes", [copied], { minX: 1, minY: 1, maxX: 2, maxY: 2 });
        try {
          const before = noteCanvas.noteData.strokes.length;
          noteCanvas._showPasteMenu(10, 10);
          noteCanvas._pasteAtContentPoint(10, 10);
          expect(noteCanvas.inputHandler.getContentCoordinates).not.toHaveBeenCalled();
          expect(noteCanvas.noteData.strokes).toHaveLength(before);
        } finally {
          AppClipboard.type = null;
        }
      });

      it("offers no PDF menu", () => {
        noteCanvas.noteData.pdfSource = "pdf-1";
        noteCanvas._renderPdfControls();
        expect(container.querySelector(".note-canvas__pdf-controls")).toBeNull();
      });
    });

    describe("collaborative", () => {
      beforeEach(async () => {
        await loadIn(sharedNotebook(7));
      });

      it("lets the user edit, but not manage the note", async () => {
        const { NoteToolbar } = await import("./NoteToolbar.js");
        expect(noteCanvas.readOnly).toBe(false);
        expect(noteCanvas.permissions).toEqual({ canEdit: true, canManage: false });
        expect(NoteToolbar.mock.calls.at(-1)[2]).toMatchObject({ canEdit: true, canManage: false });
        expect(noteCanvas.strokeManager.readOnly).toBe(false);
        noteCanvas._setMode("draw");
        expect(noteCanvas.mode).toBe("draw");
      });

      it("lets the user change tasks", () => {
        noteCanvas._toggleTask("t1", true);
        expect(noteCanvas.noteData.tasks[0].checked).toBe(true);
      });
    });

    describe("a share that ends while the note is open", () => {
      beforeEach(async () => {
        await loadIn(sharedNotebook(7));
        noteCanvas.textEditorLayer.setReadOnly.mockClear();
      });

      const endShare = (notebookId = "nb-shared") =>
        window.dispatchEvent(new CustomEvent("share-ended", { detail: { notebookId } }));

      it("stops accepting changes, rebuilds the toolbar for a viewer and says why", async () => {
        const { NoteToolbar } = await import("./NoteToolbar.js");
        expect(noteCanvas.readOnly).toBe(false);

        endShare();

        expect(noteCanvas.readOnly).toBe(true);
        expect(noteCanvas.permissions).toEqual({ canEdit: false, canManage: false });
        expect(noteCanvas.strokeManager.readOnly).toBe(true);
        expect(noteCanvas.textEditorLayer.setReadOnly).toHaveBeenCalledWith(true);
        expect(NoteToolbar.mock.calls.at(-1)[2]).toMatchObject({ canEdit: false });
        expect(container.querySelector(".note-canvas__share-ended")).not.toBeNull();
      });

      it("removes the PDF button that was already showing", () => {
        noteCanvas.noteData.pdfSource = "pdf-1";
        noteCanvas._renderPdfControls();
        expect(container.querySelector(".note-canvas__pdf-controls")).not.toBeNull();
        endShare();
        expect(container.querySelector(".note-canvas__pdf-controls")).toBeNull();
      });

      it("drops out of drawing mode", () => {
        noteCanvas._setMode("draw");
        endShare();
        expect(noteCanvas.mode).toBe("pan");
      });

      it("lets the notice be dismissed", () => {
        endShare();
        container.querySelector(".note-canvas__share-ended button").click();
        expect(container.querySelector(".note-canvas__share-ended")).toBeNull();
      });

      it("ignores the end of some other share", () => {
        endShare("another-notebook");
        expect(noteCanvas.readOnly).toBe(false);
        expect(container.querySelector(".note-canvas__share-ended")).toBeNull();
      });

      it("shows the notice only once", () => {
        endShare();
        endShare();
        expect(container.querySelectorAll(".note-canvas__share-ended")).toHaveLength(1);
      });

      it("stops listening when the note is closed", () => {
        noteCanvas.destroy();
        expect(() => endShare()).not.toThrow();
      });

      it("drops a stroke being drawn instead of letting it finish on screen", () => {
        noteCanvas._setMode("draw");
        noteCanvas.inputHandler.isDrawing = true;

        endShare();

        expect(noteCanvas.strokeManager.cancelCurrentStroke).toHaveBeenCalled();
        expect(noteCanvas.inputHandler.cancelActiveStroke).toHaveBeenCalled();
      });

      it("saves a running recording before turning read-only", async () => {
        const order = [];
        noteCanvas.recordingManager = {
          isRecording: () => true,
          finishRecording: vi.fn(async () => order.push("recording saved")),
          destroy: vi.fn(async () => {}),
        };
        const become = noteCanvas._becomeReadOnly.bind(noteCanvas);
        noteCanvas._becomeReadOnly = (message) => {
          order.push("read-only");
          become(message);
        };

        endShare();
        await vi.waitFor(() => expect(noteCanvas.readOnly).toBe(true));

        expect(order).toEqual(["recording saved", "read-only"]);
      });
    });

    describe("a note the owner deletes while it is open", () => {
      const storedDeleted = () => ({ ...structuredClone(noteCanvas.noteData), deleted: true });

      it("turns read-only and says so, for a collaborator", async () => {
        await loadIn(sharedNotebook(7));

        noteCanvas._takeInNote(storedDeleted());

        expect(noteCanvas.readOnly).toBe(true);
        expect(container.querySelector(".note-canvas__share-ended")).not.toBeNull();
      });

      it("leaves an own note editable (its owner can restore it)", async () => {
        await loadIn({ id: "nb-own" });

        noteCanvas._takeInNote(storedDeleted());

        expect(noteCanvas.readOnly).toBe(false);
        expect(container.querySelector(".note-canvas__share-ended")).toBeNull();
      });
    });

    describe("ended", () => {
      it("is view-only even if the share once granted editing", async () => {
        await loadIn(sharedNotebook(7, { shareEnded: true }));
        expect(noteCanvas.readOnly).toBe(true);
      });
    });

    describe("an own notebook or a quick note", () => {
      it("is unaffected", async () => {
        await loadIn({ id: "nb-own" });
        expect(noteCanvas.permissions).toEqual({ canEdit: true, canManage: true });
        expect(noteCanvas.readOnly).toBe(false);
      });

      it("a quick note has no notebook to ask", async () => {
        await loadIn(null);
        expect(noteCanvas.permissions).toEqual({ canEdit: true, canManage: true });
      });
    });
  });

  describe("Zooming", () => {
    it("should handle zoom via setZoom", async () => {
      await noteCanvas.load("note-1");
      noteCanvas.setZoom(2.0);
      expect(noteCanvas.zoomScale).toBe(2.0);
      expect(noteCanvas.scroller.setZoom).toHaveBeenCalledWith(2.0, undefined);
      expect(noteCanvas.renderer.setZoom).toHaveBeenCalled();
    });

    it("should handle wheel zoom", async () => {
      await noteCanvas.load("note-1");
      const event = new WheelEvent("wheel", {
        deltaY: -100,
        ctrlKey: true,
        clientX: 100,
        clientY: 100,
      });

      noteCanvas._onWheel(event);

      expect(noteCanvas.zoomScale).toBeGreaterThan(1.0);
    });
  });

  describe("a pen hovering over the page", () => {
    const hover = (pointerType, buttons) =>
      noteCanvas.scroller
        .getViewportElement()
        .dispatchEvent(new PointerEvent("pointermove", { pointerType, buttons, bubbles: true }));

    it("holds off the live check: writing is about to resume", async () => {
      await noteCanvas.load("note-1");
      expect(noteCanvas.liveRefresh.isIdle()).toBe(true);
      hover("pen", 0);
      expect(noteCanvas.liveRefresh.isIdle()).toBe(false);
    });

    it("is not a mouse passing over it", async () => {
      await noteCanvas.load("note-1");
      hover("mouse", 0);
      expect(noteCanvas.liveRefresh.isIdle()).toBe(true);
    });
  });

  // Looking for other people's changes to the open note belongs to notebook
  // sharing, a preview that is off until the user turns it on. Off, the open note
  // is refreshed only by the periodic sync, as before sharing existed.
  describe("looking for others' changes while the note is open", () => {
    afterEach(() => {
      localStorage.removeItem("sharing_enabled");
    });

    it("is not scheduled while sharing is off", async () => {
      localStorage.setItem("sharing_enabled", "false");
      await noteCanvas.load("note-1");
      expect(noteCanvas.liveRefresh._timer).toBeNull();
    });

    it("is scheduled while sharing is on", async () => {
      localStorage.setItem("sharing_enabled", "true");
      await noteCanvas.load("note-1");
      expect(noteCanvas.liveRefresh._timer).not.toBeNull();
    });

    it("starts and stops when sharing is switched on and off meanwhile", async () => {
      localStorage.setItem("sharing_enabled", "false");
      await noteCanvas.load("note-1");

      localStorage.setItem("sharing_enabled", "true");
      window.dispatchEvent(
        new CustomEvent("sharing-preference-changed", { detail: { enabled: true } }),
      );
      expect(noteCanvas.liveRefresh._timer).not.toBeNull();

      localStorage.setItem("sharing_enabled", "false");
      window.dispatchEvent(
        new CustomEvent("sharing-preference-changed", { detail: { enabled: false } }),
      );
      expect(noteCanvas.liveRefresh._timer).toBeNull();
    });

    it("makes no request for a look while sharing is off, but still takes in a change announced earlier", async () => {
      localStorage.setItem("sharing_enabled", "false");
      await noteCanvas.load("note-1");
      noteCanvas._liveCheckNextcloud = vi.fn();
      noteCanvas._liveSyncOpenNote = vi.fn();
      noteCanvas._takeInExternalChange = vi.fn(async () => true);

      await expect(noteCanvas._liveCheck()).resolves.toBeUndefined();
      expect(noteCanvas._liveCheckNextcloud).not.toHaveBeenCalled();
      expect(noteCanvas._liveSyncOpenNote).not.toHaveBeenCalled();
      expect(noteCanvas._takeInExternalChange).not.toHaveBeenCalled();

      noteCanvas.pendingLiveUpdate = true;
      await noteCanvas._liveCheck();
      expect(noteCanvas._takeInExternalChange).toHaveBeenCalledTimes(1);
    });

    it("stops listening when the note is closed", async () => {
      await noteCanvas.load("note-1");
      const refresh = vi.spyOn(noteCanvas.liveRefresh, "refresh");
      await noteCanvas.destroy();
      window.dispatchEvent(
        new CustomEvent("sharing-preference-changed", { detail: { enabled: true } }),
      );
      expect(refresh).not.toHaveBeenCalled();
    });
  });

  describe("typing", () => {
    it("holds off the live check when it happens in the note", async () => {
      await noteCanvas.load("note-1");
      const editor = document.createElement("div");
      editor.setAttribute("contenteditable", "true");
      noteCanvas.containerElement.appendChild(editor);
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      expect(noteCanvas.liveRefresh.isIdle()).toBe(false);
    });

    it("does not when it happens in a field outside the note", async () => {
      await noteCanvas.load("note-1");
      const field = document.createElement("input");
      document.body.appendChild(field);
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.remove();
      expect(noteCanvas.liveRefresh.isIdle()).toBe(true);
    });
  });

  describe("Two-finger touch gestures (non-stylus pan/zoom)", () => {
    let viewport;

    beforeEach(async () => {
      await noteCanvas.load("note-1");
      noteCanvas._setMode("draw");
      viewport = noteCanvas.scroller.getViewportElement();
    });

    function firePointer(type, pointerId, clientX, clientY) {
      viewport.dispatchEvent(
        new PointerEvent(type, {
          pointerId,
          pointerType: "touch",
          clientX,
          clientY,
          bubbles: true,
        }),
      );
    }

    it("cancels an in-progress touch stroke when a second finger lands, instead of drawing with it", () => {
      // Finger 1 starts a stroke, same as any single-touch draw in draw mode.
      noteCanvas.strokeManager.currentStroke = {
        pointerType: "touch",
        x: [10],
        y: [10],
        pressure: [0.5],
      };
      noteCanvas.inputHandler.isDrawing = true;
      noteCanvas.inputHandler.activePointerType = "touch";

      // Finger 2 lands before finger 1 lifts.
      firePointer("pointerdown", 1, 100, 100);
      firePointer("pointerdown", 2, 200, 100);

      expect(noteCanvas.strokeManager.cancelCurrentStroke).toHaveBeenCalled();
      expect(noteCanvas.inputHandler.cancelActiveStroke).toHaveBeenCalled();
      expect(noteCanvas.inputHandler.isDrawing).toBe(false);
      expect(noteCanvas.renderer.forceRedraw).toHaveBeenCalled();
    });

    it("does not touch the stroke when a second finger lands and nothing was drawing", () => {
      firePointer("pointerdown", 1, 100, 100);
      firePointer("pointerdown", 2, 200, 100);

      expect(noteCanvas.strokeManager.cancelCurrentStroke).not.toHaveBeenCalled();
      expect(noteCanvas.inputHandler.cancelActiveStroke).not.toHaveBeenCalled();
    });

    it("pans by the two-finger midpoint delta while pinch-zooming", () => {
      firePointer("pointerdown", 1, 100, 100);
      firePointer("pointerdown", 2, 200, 100);
      // Midpoint starts at (150, 100).

      // Move both fingers right by 20px and apart (pinch-out) — midpoint shifts to (170, 100).
      firePointer("pointermove", 1, 100, 100);
      firePointer("pointermove", 2, 240, 100);

      expect(noteCanvas.scroller.scrollBy).toHaveBeenCalledWith(-20, -0);
    });

    function fireTouch(type, points) {
      const event = new Event(type, { bubbles: true });
      const touches = points.map(([clientX, clientY], i) => ({ identifier: i, clientX, clientY }));
      Object.defineProperty(event, "touches", { value: touches });
      viewport.dispatchEvent(event);
    }

    it("follows both fingers from touch events when the browser stops sending the second finger's pointermoves", () => {
      // Observed in Firefox/Chrome (not the Android WebView): touchmove keeps
      // reporting both fingers, but pointermove for the second one stops.
      firePointer("pointerdown", 1, 100, 100);
      firePointer("pointerdown", 2, 200, 100);
      // Midpoint (150, 100), distance 100.

      // Pure two-finger pan: both fingers slide down 40px, distance unchanged —
      // but only finger 1's pointermove arrives.
      firePointer("pointermove", 1, 100, 140);
      fireTouch("touchmove", [
        [100, 140],
        [200, 140],
      ]);

      // Pointer-only tracking would see finger 2 frozen at (200,100): a
      // midpoint move of 20px and a growing distance, i.e. a zoom.
      const scrolled = noteCanvas.scroller.scrollBy.mock.calls.reduce((sum, [, dy]) => sum + dy, 0);
      expect(scrolled).toBe(-40);
      expect(noteCanvas.zoomScale).toBeCloseTo(1, 5);
    });

    it("hands the pinch back to pointer tracking when touches is not just the two pinch fingers", () => {
      firePointer("pointerdown", 1, 100, 100);
      firePointer("pointerdown", 2, 200, 100);
      fireTouch("touchmove", [
        [100, 100],
        [200, 100],
      ]);

      // A stylus (listed in touches on Chromium) lands mid-pinch.
      fireTouch("touchmove", [
        [100, 100],
        [200, 100],
        [400, 400],
      ]);
      noteCanvas.scroller.scrollBy.mockClear();
      firePointer("pointermove", 1, 100, 140);
      firePointer("pointermove", 2, 200, 140);

      const scrolled = noteCanvas.scroller.scrollBy.mock.calls.reduce((sum, [, dy]) => sum + dy, 0);
      expect(scrolled).toBe(-40);
    });

    it("does not pan with a single finger in draw mode without a stylus", () => {
      firePointer("pointerdown", 1, 100, 100);

      // Single touch in draw mode is reserved for InputHandler (drawing), not nav/pan.
      firePointer("pointermove", 1, 150, 100);

      expect(noteCanvas.scroller.scrollBy).not.toHaveBeenCalled();
    });

    it("undoes a partial eraser gesture when a second finger lands mid-erase", () => {
      noteCanvas._setMode("eraser");
      const stroke = { id: "s1", x: [50, 60], y: [50, 60], width: 2, _deleted: true };
      noteCanvas.noteData.strokes = [stroke];
      noteCanvas._eraserBatch = [{ index: 0, id: "s1" }];
      noteCanvas.inputHandler.isDrawing = true;
      noteCanvas.inputHandler.activePointerType = "touch";

      firePointer("pointerdown", 1, 100, 100);
      firePointer("pointerdown", 2, 200, 100);

      expect(stroke._deleted).toBe(false);
      expect(noteCanvas._eraserBatch).toBeNull();
      expect(noteCanvas.historyManager.push).not.toHaveBeenCalled();
      expect(noteCanvas.inputHandler.isDrawing).toBe(false);
    });

    it("undoes a partial part-eraser gesture when a second finger lands mid-erase", () => {
      noteCanvas._setMode("eraser");
      noteCanvas.eraserMode = "part";
      // Mid-gesture state: s1 was split, its fragment appended at index 1.
      const original = { id: "s1", x: [50, 60, 70], y: [50, 60, 70], width: 2, _deleted: true };
      const fragment = { id: "f1", x: [50, 60], y: [50, 60], width: 2, _deleted: false };
      noteCanvas.noteData.strokes = [original, fragment];
      noteCanvas.noteData.deletedStrokes = ["s1"];
      noteCanvas._partEraserOps = [
        { originalIndex: 0, originalId: "s1", subStrokes: [{ stroke: fragment, index: 1 }] },
      ];
      noteCanvas.inputHandler.isDrawing = true;
      noteCanvas.inputHandler.activePointerType = "touch";

      firePointer("pointerdown", 1, 100, 100);
      firePointer("pointerdown", 2, 200, 100);

      expect(original._deleted).toBe(false);
      expect(fragment._deleted).toBe(true);
      expect(noteCanvas.noteData.deletedStrokes).not.toContain("s1");
      expect(noteCanvas._partEraserOps).toBeNull();
      expect(noteCanvas.historyManager.push).not.toHaveBeenCalled();
    });

    it("abandons an in-progress insert-space drag when a second finger lands", () => {
      noteCanvas._setMode("insert-space");
      noteCanvas.insertSpaceState = { startY: 100, currentY: 160 };
      noteCanvas.inputHandler.isDrawing = true;
      noteCanvas.inputHandler.activePointerType = "touch";
      noteCanvas.renderer.clearOverlay.mockClear();

      firePointer("pointerdown", 1, 100, 100);
      firePointer("pointerdown", 2, 200, 100);

      expect(noteCanvas.insertSpaceState).toBeNull();
      expect(noteCanvas.renderer.clearOverlay).toHaveBeenCalled();
      // Nothing was shifted, so nothing to undo — and the user stays in the
      // mode to try again rather than being bounced back to pan.
      expect(noteCanvas.historyManager.push).not.toHaveBeenCalled();
      expect(noteCanvas.mode).toBe("insert-space");
    });

    it("discards an in-progress lasso selection trail when a second finger lands", () => {
      noteCanvas._setMode("lasso");
      noteCanvas.lassoPoints = [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ];
      noteCanvas.inputHandler.isDrawing = true;
      noteCanvas.inputHandler.activePointerType = "touch";

      firePointer("pointerdown", 1, 100, 100);
      firePointer("pointerdown", 2, 200, 100);

      expect(noteCanvas.lassoPoints).toEqual([]);
      expect(noteCanvas.inputHandler.isDrawing).toBe(false);
    });

    it("reverts an in-progress lasso transform (move/resize/rotate) when a second finger lands", () => {
      noteCanvas._setMode("lasso");
      const stroke = { id: "s1", x: [100, 110], y: [100, 110] };
      noteCanvas.noteData.strokes = [stroke];
      noteCanvas.transformState = {
        mode: "move",
        handle: null,
        startX: 0,
        startY: 0,
        initialBounds: { minX: 95, minY: 95, maxX: 115, maxY: 115 },
        initialStrokes: [{ x: [100, 110], y: [100, 110] }],
        selectedIndices: [0],
        initialLineSeparators: [105],
        initialLineIndentLevels: [0],
      };
      // Simulate the drag having moved the stroke already.
      stroke.x = [150, 160];
      stroke.y = [150, 160];
      noteCanvas.inputHandler.isDrawing = true;
      noteCanvas.inputHandler.activePointerType = "touch";

      firePointer("pointerdown", 1, 100, 100);
      firePointer("pointerdown", 2, 200, 100);

      expect(stroke.x).toEqual([100, 110]);
      expect(stroke.y).toEqual([100, 110]);
      // The selection box and line separators go back with the strokes, not
      // left at the dragged position.
      expect(noteCanvas.renderer.setSelectedStrokes).toHaveBeenLastCalledWith(
        noteCanvas.renderer.selectedStrokeIndices,
        { minX: 95, minY: 95, maxX: 115, maxY: 115 },
      );
      expect(noteCanvas.renderer.setLineSeparators).toHaveBeenLastCalledWith([105], [0]);
      expect(noteCanvas.transformState).toBeNull();
      expect(noteCanvas.historyManager.push).not.toHaveBeenCalled();
      expect(noteCanvas.inputHandler.isDrawing).toBe(false);
    });

    it("leaves a stylus stroke alone when two touches (a resting palm) land mid-stroke", () => {
      noteCanvas.strokeManager.currentStroke = {
        pointerType: "pen",
        x: [10],
        y: [10],
        pressure: [0.5],
      };
      noteCanvas.inputHandler.isDrawing = true;
      noteCanvas.inputHandler.activePointerType = "pen";

      firePointer("pointerdown", 1, 100, 100);
      firePointer("pointerdown", 2, 200, 100);
      firePointer("pointermove", 1, 80, 100);
      firePointer("pointermove", 2, 260, 120);

      expect(noteCanvas.strokeManager.cancelCurrentStroke).not.toHaveBeenCalled();
      expect(noteCanvas.inputHandler.cancelActiveStroke).not.toHaveBeenCalled();
      expect(noteCanvas.inputHandler.isDrawing).toBe(true);
      // The palm must not pan or zoom the page under the pen either.
      expect(noteCanvas.scroller.scrollBy).not.toHaveBeenCalled();
      expect(noteCanvas.scroller.setZoom).not.toHaveBeenCalled();
    });

    it("keeps a stylus erase when two touches land mid-erase", () => {
      noteCanvas._setMode("eraser");
      const stroke = { id: "s1", x: [50, 60], y: [50, 60], width: 2, _deleted: true };
      noteCanvas.noteData.strokes = [stroke];
      noteCanvas._eraserBatch = [{ index: 0, id: "s1" }];
      noteCanvas.inputHandler.isDrawing = true;
      noteCanvas.inputHandler.activePointerType = "pen";

      firePointer("pointerdown", 1, 100, 100);
      firePointer("pointerdown", 2, 200, 100);

      expect(stroke._deleted).toBe(true);
      expect(noteCanvas._eraserBatch).toEqual([{ index: 0, id: "s1" }]);
    });

    it("moves the canvas on a two-finger pan even when zoom is clamped and unchanged", () => {
      noteCanvas.zoomScale = noteCanvas.maxZoom;
      firePointer("pointerdown", 1, 100, 100);
      firePointer("pointerdown", 2, 200, 100);
      noteCanvas.renderer.setZoom.mockClear();

      // Spread apart (would zoom in past max → clamped) while sliding down 30px.
      firePointer("pointermove", 1, 90, 130);
      firePointer("pointermove", 2, 230, 130);

      expect(noteCanvas.zoomScale).toBe(noteCanvas.maxZoom);
      expect(noteCanvas.scroller.scrollBy).toHaveBeenCalled();
      // During a pinch only setZoom repositions the canvas, so it must run after
      // the pan even though the zoom value did not change.
      expect(noteCanvas.renderer.setZoom).toHaveBeenCalled();
      const lastPan = noteCanvas.scroller.scrollBy.mock.invocationCallOrder.at(-1);
      const lastZoom = noteCanvas.renderer.setZoom.mock.invocationCallOrder.at(-1);
      expect(lastZoom).toBeGreaterThan(lastPan);
    });
  });

  describe("Tasks", () => {
    it("should create text task", async () => {
      await noteCanvas.load("note-1");
      noteCanvas._createTextTask("task-1");

      expect(noteCanvas.noteData.tasks).toHaveLength(1);
      expect(noteCanvas.noteData.tasks[0].id).toBe("task-1");
      expect(noteCanvas.historyManager.push).toHaveBeenCalled();
    });

    it("should toggle task", async () => {
      await noteCanvas.load("note-1");
      const task = { id: "task-1", checked: false, type: "text" };
      noteCanvas.noteData.tasks = [task];

      noteCanvas._toggleTask("task-1", true);

      expect(task.checked).toBe(true);
      expect(noteCanvas.textEditorLayer.renderTaskCheckboxes).toHaveBeenCalled();
    });
  });

  describe("Image Insertion", () => {
    it("should insert images", async () => {
      await noteCanvas.load("note-1");
      const { pickImages, processImageFile } = await import("../../utils/imageUtils.js");

      pickImages.mockResolvedValue([new File([""], "test.png")]);
      processImageFile.mockResolvedValue({
        dataUrl: "data:image/png;base64,test",
        width: 100,
        height: 100,
      });

      // Mock fetch for data URL conversion
      global.fetch = vi.fn(() =>
        Promise.resolve({
          blob: () => Promise.resolve(new Blob(["test"], { type: "image/png" })),
        }),
      );

      await noteCanvas.insertImage("picker");

      expect(noteCanvas.mediaManager.addItem).toHaveBeenCalled();
      expect(noteCanvas.historyManager.push).toHaveBeenCalledWith(
        expect.any((await import("./commands/index.js")).InsertMediaCommand),
      );
    });

    // Text mode's paste and drop (text boxes DESIGN §12): the image is a page
    // image at the caret, selected, one undo step; the text is not touched
    it("places a pasted image at a point, on the page, selected, as one undo step", async () => {
      await noteCanvas.load("note-1");
      noteCanvas.noteData.media = [];
      noteCanvas.mediaManager.setItems(noteCanvas.noteData.media);
      const { processImageFile } = await import("../../utils/imageUtils.js");
      processImageFile.mockResolvedValue({
        dataUrl: "data:image/png;base64,dGVzdA==",
        width: 400,
        height: 200,
      });
      global.fetch = vi.fn(() =>
        Promise.resolve({ blob: () => Promise.resolve(new Blob(["test"], { type: "image/png" })) }),
      );
      noteCanvas.historyManager.push.mockClear();
      const textBefore = noteCanvas.noteData.content;

      // Near the right edge: kept on the page
      await noteCanvas.insertImageFiles(
        [new File(["x"], "shot.png", { type: "image/png" })],
        {
          x: 1100,
          y: 240,
        },
        { select: true },
      );

      const images = noteCanvas.mediaManager.getItems().filter((m) => m.type === "image");
      expect(images).toHaveLength(1);
      expect(images[0]).toMatchObject({ x: 1000, y: 240, width: 200, height: 100 });
      expect(images[0].pending).toBeUndefined();
      expect(noteCanvas.historyManager.push).toHaveBeenCalledTimes(1);
      expect(noteCanvas.historyManager.push).toHaveBeenCalledWith(
        expect.any((await import("./commands/index.js")).InsertMediaCommand),
      );
      expect(noteCanvas.selectedMediaId).toBe(images[0].id);
      expect(noteCanvas.noteData.content).toBe(textBefore);
      expect(noteCanvas.textChanged).toBeFalsy();
    });

    // On a slow device, encoding and storing a camera photo takes seconds. The
    // canvas must show a placeholder for that whole window instead of staying
    // unchanged, which reads as "nothing happened".
    describe("pending placeholder", () => {
      /** Hold processImageFile open so the in-flight state can be inspected. */
      function deferProcessing(processImageFile) {
        let release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        processImageFile.mockImplementation(async () => {
          await gate;
          return { dataUrl: "data:image/png;base64,test", width: 100, height: 100 };
        });
        return () => release();
      }

      async function setupInsert() {
        await noteCanvas.load("note-1");
        const { pickImages, processImageFile } = await import("../../utils/imageUtils.js");
        pickImages.mockResolvedValue([new File([""], "test.png")]);
        global.fetch = vi.fn(() =>
          Promise.resolve({
            blob: () => Promise.resolve(new Blob(["test"], { type: "image/png" })),
          }),
        );
        return { processImageFile };
      }

      it("shows a placeholder before processing finishes, then resolves it", async () => {
        const { processImageFile } = await setupInsert();
        const release = deferProcessing(processImageFile);

        const insertion = noteCanvas.insertImage("picker");
        // Let the placeholder be added before processing is allowed to finish.
        await vi.waitFor(() => {
          expect(noteCanvas.mediaManager.getItems().some((i) => i.pending)).toBe(true);
        });

        // The user must see the placeholder and its spinner right away.
        expect(noteCanvas.renderer.forceRedraw).toHaveBeenCalled();
        expect(noteCanvas.renderer.startPendingMediaAnimation).toHaveBeenCalled();

        release();
        await insertion;

        // Once the real image lands, no placeholder (or spinner) is left behind.
        expect(noteCanvas.mediaManager.getItems().some((i) => i.pending)).toBe(false);
        expect(noteCanvas.mediaManager.getItems().some((i) => i.fileId)).toBe(true);
        expect(noteCanvas.renderer.stopPendingMediaAnimation).toHaveBeenCalled();
      });

      it("removes the placeholder when processing fails", async () => {
        const { processImageFile } = await setupInsert();
        processImageFile.mockRejectedValue(new Error("decode failed"));

        await noteCanvas.insertImage("picker");

        // A failed insert must not leave a spinner running over an image that
        // is never coming.
        expect(noteCanvas.mediaManager.getItems().some((i) => i.pending)).toBe(false);
        expect(noteCanvas.renderer.stopPendingMediaAnimation).toHaveBeenCalled();
        expect(noteCanvas.historyManager.push).not.toHaveBeenCalled();
      });

      it("leaves a concurrent insert's placeholder and spinner alone when one fails", async () => {
        const { processImageFile } = await setupInsert();

        // Insert A stalls; insert B fails outright.
        const releaseA = deferProcessing(processImageFile);
        const insertionA = noteCanvas.insertImage("picker");
        await vi.waitFor(() => {
          expect(noteCanvas.mediaManager.getItems().filter((i) => i.pending)).toHaveLength(1);
        });

        processImageFile.mockRejectedValue(new Error("decode failed"));
        await noteCanvas.insertImage("picker");

        // B's failure must not take A's placeholder or the shared spinner down.
        expect(noteCanvas.mediaManager.getItems().filter((i) => i.pending)).toHaveLength(1);
        expect(noteCanvas.renderer.stopPendingMediaAnimation).not.toHaveBeenCalled();

        releaseA();
        await insertionA;
        expect(noteCanvas.renderer.stopPendingMediaAnimation).toHaveBeenCalled();
      });

      it("does not persist a placeholder that has no file yet", async () => {
        const { processImageFile } = await setupInsert();
        const release = deferProcessing(processImageFile);

        const insertion = noteCanvas.insertImage("picker");
        await vi.waitFor(() => {
          expect(noteCanvas.mediaManager.getItems().some((i) => i.pending)).toBe(true);
        });

        // A save triggered mid-insert (autosave, note close) must not write a
        // media entry pointing at a file that does not exist.
        await noteCanvas._saveMediaChanges();
        expect(noteCanvas.noteData.media.some((i) => i.pending)).toBe(false);
        expect(noteCanvas.noteData.media.every((i) => i.fileId)).toBe(true);

        // ...and the placeholder must survive that save, or the spinner would
        // vanish and there would be nothing left to resolve.
        expect(noteCanvas.mediaManager.getItems().some((i) => i.pending)).toBe(true);

        release();
        await insertion;
        expect(noteCanvas.mediaManager.getItems().some((i) => i.fileId)).toBe(true);
      });
    });
  });

  describe("Hit-detection geometry", () => {
    // These are pure functions on the instance (no note load needed). The
    // Eraser/Lasso interaction tests above stub them out to test wiring —
    // these test the actual math those stubs bypass.

    describe("_strokeIntersectsCircle", () => {
      it("returns true when a stroke point lies inside the circle", () => {
        const stroke = { x: [0, 50, 100], y: [0, 50, 100] };
        expect(noteCanvas._strokeIntersectsCircle(stroke, 50, 50, 10)).toBe(true);
      });

      it("returns false when no stroke point is within the radius", () => {
        const stroke = { x: [0, 100], y: [0, 100] };
        expect(noteCanvas._strokeIntersectsCircle(stroke, 50, 50, 10)).toBe(false);
      });

      it("treats a point exactly on the circle boundary as intersecting", () => {
        const stroke = { x: [10], y: [0] }; // distance from (0,0) is exactly 10
        expect(noteCanvas._strokeIntersectsCircle(stroke, 0, 0, 10)).toBe(true);
      });

      it("returns false for an empty stroke", () => {
        const stroke = { x: [], y: [] };
        expect(noteCanvas._strokeIntersectsCircle(stroke, 0, 0, 100)).toBe(false);
      });
    });

    describe("_isPointInPolygon", () => {
      const square = [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ];

      it("returns true for a point inside the polygon", () => {
        expect(noteCanvas._isPointInPolygon({ x: 50, y: 50 }, square)).toBe(true);
      });

      it("returns false for a point outside the polygon", () => {
        expect(noteCanvas._isPointInPolygon({ x: 150, y: 50 }, square)).toBe(false);
      });

      it("returns false for a point inside the carved-out notch of a concave polygon", () => {
        // C-shaped polygon: a square with a rectangular bite taken out of the right side.
        const concave = [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 40 },
          { x: 50, y: 40 },
          { x: 50, y: 60 },
          { x: 100, y: 60 },
          { x: 100, y: 100 },
          { x: 0, y: 100 },
        ];
        expect(noteCanvas._isPointInPolygon({ x: 90, y: 50 }, concave)).toBe(false); // in the bite
        expect(noteCanvas._isPointInPolygon({ x: 30, y: 50 }, concave)).toBe(true); // solid area
      });
    });

    describe("_isStrokeFullyInPolygon", () => {
      const square = [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ];

      it("returns true when every point of the stroke is inside the polygon", () => {
        const stroke = { x: [10, 50, 90], y: [10, 50, 90] };
        expect(noteCanvas._isStrokeFullyInPolygon(stroke, square)).toBe(true);
      });

      it("returns false when any single point falls outside the polygon", () => {
        const stroke = { x: [10, 50, 150], y: [10, 50, 50] }; // last point is outside
        expect(noteCanvas._isStrokeFullyInPolygon(stroke, square)).toBe(false);
      });

      it("returns true for a stroke with no points (vacuously true)", () => {
        const stroke = { x: [], y: [] };
        expect(noteCanvas._isStrokeFullyInPolygon(stroke, square)).toBe(true);
      });
    });
  });

  describe("Scrolling", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should handle scroll events and trigger render", async () => {
      await noteCanvas.load("note-1");

      // Initial render happens on load
      noteCanvas.renderer.render.mockClear();

      noteCanvas._onScroll(100, 0, 600);

      // Wait for RAF
      vi.runAllTimers();

      expect(noteCanvas.renderer.render).toHaveBeenCalledWith(100, 600, 0, null);
    });

    it("should expand canvas when scrolling near bottom", async () => {
      await noteCanvas.load("note-1");
      noteCanvas.contentHeight = 1200;

      // Scroll near bottom
      noteCanvas._onScroll(800, 0, 600);

      vi.runAllTimers();

      expect(noteCanvas.scroller.setContentSize).toHaveBeenCalled();
      expect(noteCanvas.contentHeight).toBeGreaterThan(1200);
    });
  });

  describe("Transformations", () => {
    it("should handle moving selected strokes", async () => {
      await noteCanvas.load("note-1");
      const stroke = { id: "s1", x: [10, 20], y: [10, 20], _deleted: false };
      mockNoteData.strokes = [stroke];

      // Setup selection
      noteCanvas.renderer.selectedStrokeIndices = new Set([0]);
      noteCanvas.renderer.selectionBounds = { minX: 10, minY: 10, maxX: 20, maxY: 20 };

      // Start transform
      noteCanvas._startTransform("move", 15, 15);

      // Move
      noteCanvas._handleTransformMove(25, 25); // dx=10, dy=10

      // Verify renderer update
      expect(noteCanvas.renderer.setSelectedStrokes).toHaveBeenCalled();
      const lastCall = noteCanvas.renderer.setSelectedStrokes.mock.calls.at(-1);
      const newBounds = lastCall[1];
      expect(newBounds.minX).toBe(20); // 10 + 10

      // End transform
      noteCanvas._endTransform();

      expect(stroke.x[0]).toBe(20); // 10 + 10
      expect(noteCanvas.historyManager.push).toHaveBeenCalledWith(
        expect.any((await import("./commands/index.js")).TransformStrokesCommand),
      );
    });
  });

  describe("Text Editor Integration", () => {
    it("should handle text content changes", async () => {
      await noteCanvas.load("note-1");

      // Mock worker on strokeManager
      noteCanvas.strokeManager.worker = { postMessage: vi.fn() };

      noteCanvas._onTextContentChange("<p>New Content</p>");

      expect(noteCanvas.noteData.content).toBe("<p>New Content</p>");
      expect(noteCanvas.strokeManager.worker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SAVE_CONTENT",
          content: "<p>New Content</p>",
        }),
      );
    });
  });

  describe("Viewport Resize", () => {
    it("should handle viewport resize", async () => {
      await noteCanvas.load("note-1");

      noteCanvas._onViewportResize(1000, 800);

      expect(noteCanvas.renderer.resize).toHaveBeenCalledWith(1000, 800);
      expect(noteCanvas.renderer.render).toHaveBeenCalled();
    });
  });

  // Coalescing media-save: rapid calls must collapse to one in-flight run plus at
  // most one trailing run, so concurrent WebDAV PUTs can't collide (423 Locked).
  // We borrow the real _saveMediaChanges onto a fake `this` with a controllable
  // _runMediaSave, so the test exercises production code without a full instance.
  describe("_saveMediaChanges coalescing", () => {
    function makeCtx() {
      let resolveRun;
      const ctx = {
        noteId: "n1",
        mediaManager: {},
        noteData: {},
        _mediaSaveRunning: null,
        _mediaSaveDirty: false,
        _mediaSaveProgress: null,
        runCalls: [],
        // One pending run at a time; the test resolves it via releaseRun()
        _runMediaSave: vi.fn(function (progress) {
          ctx.runCalls.push(progress ?? null);
          return new Promise((r) => {
            resolveRun = r;
          });
        }),
        save: NoteCanvas.prototype._saveMediaChanges,
      };
      ctx.releaseRun = async () => {
        const r = resolveRun;
        resolveRun = null;
        r();
        await Promise.resolve(); // let the runner loop advance
        await Promise.resolve();
      };
      return ctx;
    }

    it("runs a single save when called once", async () => {
      const ctx = makeCtx();
      const p = ctx.save();
      expect(ctx._runMediaSave).toHaveBeenCalledTimes(1);
      await ctx.releaseRun();
      await p;
      expect(ctx.runCalls).toHaveLength(1);
      expect(ctx._mediaSaveRunning).toBeNull();
    });

    it("collapses a burst of calls into one in-flight + one trailing run", async () => {
      const ctx = makeCtx();
      const p1 = ctx.save(); // starts run #1
      const p2 = ctx.save(); // flags dirty
      const p3 = ctx.save(); // still just dirty
      expect(ctx._runMediaSave).toHaveBeenCalledTimes(1);

      await ctx.releaseRun(); // run #1 finishes → dirty → trailing run #2 starts
      expect(ctx._runMediaSave).toHaveBeenCalledTimes(2);

      await ctx.releaseRun(); // run #2 finishes, not dirty → done
      await Promise.all([p1, p2, p3]);
      expect(ctx._runMediaSave).toHaveBeenCalledTimes(2); // never a 3rd
      expect(ctx._mediaSaveRunning).toBeNull();
    });

    it("passes a progress callback to an executed run", async () => {
      const ctx = makeCtx();
      const onProgress = vi.fn();
      const p = ctx.save(onProgress);
      await ctx.releaseRun();
      await p;
      expect(ctx.runCalls[0]).toBe(onProgress);
    });

    // Regression: closing the note mid-save must NOT abandon the trailing pass.
    // The trailing pass is what carries edits made while the first run was in
    // flight — including an image placeholder that resolved during the awaits.
    // Skipping it (the old behaviour, which keyed the loop guard off this.noteId)
    // meant the last state written was the snapshot taken *before* the image
    // resolved, so a photo added just before closing was silently lost.
    it("still runs the trailing pass after the note is closed (noteId nulled)", async () => {
      const ctx = makeCtx();
      const p1 = ctx.save();
      ctx.save(); // flag dirty
      ctx.noteId = null; // simulate destroy() during the in-flight run
      await ctx.releaseRun(); // run #1 ends; dirty → trailing run #2 starts anyway
      expect(ctx._runMediaSave).toHaveBeenCalledTimes(2);

      await ctx.releaseRun(); // run #2 finishes, not dirty → done
      await p1;
      expect(ctx._mediaSaveRunning).toBeNull();
    });

    // The captured identity is what makes the above safe: the pass must keep
    // using the note it started on, never re-read a this.noteId that destroy()
    // has since nulled (which would write media to an undefined path).
    it("passes the captured note identity to every run", async () => {
      const ctx = makeCtx();
      const noteData = ctx.noteData;
      const mediaManager = ctx.mediaManager;
      const p1 = ctx.save();
      ctx.save(); // flag dirty → forces a trailing pass
      ctx.noteId = null;
      ctx.noteData = null;
      ctx.mediaManager = null;

      await ctx.releaseRun();
      await ctx.releaseRun();
      await p1;

      expect(ctx._runMediaSave).toHaveBeenCalledTimes(2);
      for (const call of ctx._runMediaSave.mock.calls) {
        expect(call[1]).toEqual({ noteId: "n1", noteData, mediaManager });
      }
    });
  });

  // ── flushPendingSaves ───────────────────────────────────────────────────────
  // Closing the tab/app never runs destroy(), so without an explicit flush the
  // last strokes drawn are never written. Regression guard for exactly that.
  describe("flushPendingSaves", () => {
    it("forces a stroke save and resolves once it lands", async () => {
      const canvas = Object.create(NoteCanvas.prototype);
      let resolveSave;
      const save = new Promise((r) => {
        resolveSave = r;
      });
      canvas.strokeManager = { forceSave: vi.fn(() => save) };
      canvas.textEditorLayer = null;

      let settled = false;
      const p = canvas.flushPendingSaves().then(() => {
        settled = true;
      });

      expect(canvas.strokeManager.forceSave).toHaveBeenCalled();
      await Promise.resolve();
      expect(settled).toBe(false); // must not resolve before the write lands

      resolveSave();
      await p;
      expect(settled).toBe(true);
    });

    it("also flushes pending text and does not throw without a stroke manager", async () => {
      const canvas = Object.create(NoteCanvas.prototype);
      canvas.strokeManager = null;
      canvas.textEditorLayer = {
        forceSave: vi.fn(function () {
          canvas._pendingTextSave = Promise.resolve();
        }),
      };

      await expect(canvas.flushPendingSaves()).resolves.toBeUndefined();
      expect(canvas.textEditorLayer.forceSave).toHaveBeenCalled();
    });
  });

  // ── handleExternalDataChange ────────────────────────────────────────────────
  // A queued recognition lands long after it was requested, and the ordinary
  // datachange path deliberately ignores it (recognition writes are
  // source:"local"). This handler is the only way an open note learns.
  describe("_onRecognitionJobComplete", () => {
    function makeCanvas(overrides = {}) {
      const c = Object.create(NoteCanvas.prototype);
      c.noteId = "n1";
      c.noteData = { id: "n1", recognition: null };
      c.activeSearchQuery = null;
      c._highlightSearchTerms = vi.fn();
      return Object.assign(c, overrides);
    }

    const RESULT = { fullText: "hi", words: [{ text: "hi" }] };

    function event(detail) {
      return new CustomEvent("recognition-job-complete", { detail });
    }

    it("adopts a result for the open note", () => {
      const c = makeCanvas();
      c._onRecognitionJobComplete(event({ noteId: "n1", recognition: RESULT }));
      expect(c.noteData.recognition).toBe(RESULT);
    });

    it("re-applies an active search so matches highlight without reopening", () => {
      const c = makeCanvas({ activeSearchQuery: "hi" });
      c._onRecognitionJobComplete(event({ noteId: "n1", recognition: RESULT }));
      expect(c._highlightSearchTerms).toHaveBeenCalledWith("hi");
    });

    it("ignores a result for a different note", () => {
      // The user may have moved on to another note while the job ran; adopting
      // its result here would show one note's text on another.
      const c = makeCanvas();
      c._onRecognitionJobComplete(event({ noteId: "other", recognition: RESULT }));
      expect(c.noteData.recognition).toBeNull();
      expect(c._highlightSearchTerms).not.toHaveBeenCalled();
    });

    it("does not reload the note", () => {
      // applyLiveUpdate rebuilds noteData and clears the undo history. Taking
      // just the recognition field is what keeps undo intact.
      const c = makeCanvas({ applyLiveUpdate: vi.fn() });
      c._onRecognitionJobComplete(event({ noteId: "n1", recognition: RESULT }));
      expect(c.applyLiveUpdate).not.toHaveBeenCalled();
    });

    it("survives a malformed or empty event", () => {
      const c = makeCanvas();
      expect(() => c._onRecognitionJobComplete(new CustomEvent("x"))).not.toThrow();
      expect(() => c._onRecognitionJobComplete(event({ noteId: "n1" }))).not.toThrow();
      expect(c.noteData.recognition).toBeNull();
    });

    it("does nothing once the canvas has been torn down", () => {
      // destroy() can run while a job is in flight; noteData is gone by then.
      const c = makeCanvas({ noteData: null });
      expect(() =>
        c._onRecognitionJobComplete(event({ noteId: "n1", recognition: RESULT })),
      ).not.toThrow();
    });
  });

  // The owner made the share view only while the note is open
  describe("when the right to edit is taken away", () => {
    function makeCanvas() {
      const c = Object.create(NoteCanvas.prototype);
      const order = [];
      c.noteId = "n1";
      c.noteData = { id: "n1", notebookId: "nb-shared" };
      c.readOnly = false;
      c.flushPendingSaves = vi.fn(async () => void order.push("flush"));
      c._becomeReadOnly = vi.fn(() => order.push("read-only"));
      return { c, order };
    }
    const event = (notebookId) =>
      new CustomEvent("share-access-reduced", { detail: { notebookId } });

    it("stores what the user typed first, then stops accepting changes and says why", async () => {
      const { c, order } = makeCanvas();

      await c._onAccessReduced(event("nb-shared"));

      expect(order).toEqual(["flush", "read-only"]);
      expect(c._becomeReadOnly).toHaveBeenCalledTimes(1);
    });

    it("ignores another notebook", async () => {
      const { c } = makeCanvas();
      await c._onAccessReduced(event("other"));
      expect(c.flushPendingSaves).not.toHaveBeenCalled();
      expect(c._becomeReadOnly).not.toHaveBeenCalled();
    });

    it("does nothing to a note closed while its changes were being stored", async () => {
      const { c } = makeCanvas();
      c.flushPendingSaves = vi.fn(async () => {
        c.noteId = null;
      });
      await c._onAccessReduced(event("nb-shared"));
      expect(c._becomeReadOnly).not.toHaveBeenCalled();
    });
  });

  // The text of an open note goes to and from the storage worker as requests
  // with answers: a save reports whether storage took it, a read returns what is
  // stored. liveText.js builds on exactly these two answers.
  describe("text requests to the storage worker", () => {
    function makeCanvas(answer) {
      const c = Object.create(NoteCanvas.prototype);
      c.noteId = "n1";
      c._contentRequests = new Map();
      c._nextContentRequest = 0;
      c._encryptionKey = () => null;
      const posted = [];
      c.strokeManager = {
        worker: {
          postMessage: (message) => {
            posted.push(message);
            queueMicrotask(() => c._onWorkerMessage({ data: answer(message) }));
          },
        },
      };
      return { c, posted };
    }

    it("a save names the text it replaces and resolves with what the worker did", async () => {
      const { c, posted } = makeCanvas((m) => ({
        type: "CONTENT_SAVED",
        requestId: m.requestId,
        noteId: "n1",
        outcome: "stale",
      }));

      await expect(c._writeText("<p>new</p>", "<p>old</p>")).resolves.toBe("stale");
      expect(posted[0]).toMatchObject({
        type: "SAVE_CONTENT",
        content: "<p>new</p>",
        expected: "<p>old</p>",
      });
    });

    it("a read returns the stored text and its author", async () => {
      const { c } = makeCanvas((m) => ({
        type: "CONTENT",
        requestId: m.requestId,
        noteId: "n1",
        content: "<p>stored</p>",
        author: "bob",
      }));
      await expect(c._readStoredText()).resolves.toEqual({
        content: "<p>stored</p>",
        author: "bob",
      });
    });

    it("a read of text that cannot be decrypted returns nothing", async () => {
      const { c } = makeCanvas((m) => ({ type: "CONTENT", requestId: m.requestId, content: null }));
      await expect(c._readStoredText()).resolves.toBeNull();
    });

    it("adopting stored text shows it without an undo step that would revert it", () => {
      const c = Object.create(NoteCanvas.prototype);
      c.noteData = { content: "<p>old</p>", tasks: [] };
      c.textEditorLayer = { replaceContent: vi.fn(), renderTaskCheckboxes: vi.fn() };
      c.historyManager = { clear: vi.fn() };
      c.activeSearchQuery = null;

      c._adoptText("<p>merged</p>");

      expect(c.noteData.content).toBe("<p>merged</p>");
      expect(c.textEditorLayer.replaceContent).toHaveBeenCalledWith("<p>merged</p>");
      expect(c.historyManager.clear).toHaveBeenCalled();
    });
  });

  // Single owner of "should this datachange reload the open note?". The guards
  // used to be split between this method and a second listener in index.js, so
  // each guard only applied to whichever listener the event routed through.
  describe("handleExternalDataChange", () => {
    let canvas;

    function makeCanvas(overrides = {}) {
      const c = Object.create(NoteCanvas.prototype);
      c.noteId = "n1";
      c.isInitialized = true;
      c.inputHandler = { isDrawing: false };
      c.pendingLiveUpdate = false;
      c.applyLiveUpdate = vi.fn(async () => true);
      return Object.assign(c, overrides);
    }

    beforeEach(() => {
      canvas = makeCanvas();
    });

    it("reloads on a detail-less event (sync, overview, recycle bin)", async () => {
      // sync.js dispatches with no detail. This used to miss _onDataChange
      // entirely (it returned early on !noteId), so those reloads bypassed the
      // mid-drawing deferral below.
      await expect(canvas.handleExternalDataChange(new CustomEvent("datachange"))).resolves.toBe(
        true,
      );
      expect(canvas.applyLiveUpdate).toHaveBeenCalled();
    });

    it("defers a detail-less event while the user is drawing", async () => {
      canvas.inputHandler.isDrawing = true;

      await canvas.handleExternalDataChange(new CustomEvent("datachange"));

      expect(canvas.applyLiveUpdate).not.toHaveBeenCalled();
      expect(canvas.pendingLiveUpdate).toBe(true);
    });

    it("ignores our own local writes", async () => {
      await canvas.handleExternalDataChange(
        new CustomEvent("datachange", { detail: { noteId: "n1", source: "local" } }),
      );
      expect(canvas.applyLiveUpdate).not.toHaveBeenCalled();
    });

    it("takes in nothing while the user is drawing, not even the text, until they pause", async () => {
      // Replacing editor content mid-stroke is exactly what must never happen
      canvas.liveText = { reconcile: vi.fn(async () => {}) };
      canvas.inputHandler.isDrawing = true;

      await canvas.handleExternalDataChange(new CustomEvent("datachange"));

      expect(canvas.liveText.reconcile).not.toHaveBeenCalled();
      expect(canvas.applyLiveUpdate).not.toHaveBeenCalled();
      expect(canvas.pendingLiveUpdate).toBe(true);

      // The live check at the user's next pause takes it in, once
      canvas.inputHandler.isDrawing = false;
      await canvas._liveCheck();
      expect(canvas.liveText.reconcile).toHaveBeenCalledTimes(1);
      expect(canvas.applyLiveUpdate).toHaveBeenCalledTimes(1);
      expect(canvas.pendingLiveUpdate).toBe(false);
    });

    it("takes in a version the Nextcloud app merged in on save", async () => {
      canvas.liveText = { reconcile: vi.fn(async () => {}) };
      await canvas.handleExternalDataChange(
        new CustomEvent("datachange", { detail: { noteId: "n1", source: "merge" } }),
      );
      expect(canvas.liveText.reconcile).toHaveBeenCalledTimes(1);
    });

    it("does not look at the stored text for its own writes", async () => {
      canvas.liveText = { reconcile: vi.fn(async () => {}) };
      await canvas.handleExternalDataChange(
        new CustomEvent("datachange", { detail: { noteId: "n1", source: "local" } }),
      );
      expect(canvas.liveText.reconcile).not.toHaveBeenCalled();
    });

    it("ignores an event addressed to a different note", async () => {
      await canvas.handleExternalDataChange(
        new CustomEvent("datachange", { detail: { noteId: "other" } }),
      );
      expect(canvas.applyLiveUpdate).not.toHaveBeenCalled();
    });

    /** The canvas with the real take-in path over a stored note. */
    async function withStoredNote(stored, inMemory = {}) {
      const base = { strokes: [], deletedStrokes: [], media: [], tasks: [], background: "none" };
      const { getNote } = await import("../../modules/storage.js");
      getNote.mockResolvedValue(structuredClone({ ...base, ...stored }));
      const c = makeCanvas();
      delete c.applyLiveUpdate; // the real one
      c.noteData = { ...base, ...structuredClone(stored), ...inMemory };
      c.strokeManager = { markDirty: vi.fn() };
      c.spatialIndex = { insert: vi.fn(), build: vi.fn(), getContentBounds: () => null };
      c.renderer = {
        drawAddedStrokes: vi.fn(),
        forceRedraw: vi.fn(),
        setData: vi.fn(),
        setSelectedStrokes: vi.fn(),
      };
      c.contentHeight = 1000;
      c.mediaManager = { setItems: vi.fn(), getItems: () => [] };
      c.historyManager = { clear: vi.fn() };
      c._saveTasks = vi.fn();
      c._updateTaskCheckboxes = vi.fn();
      c._updateNavigatorSubjects = vi.fn();
      c._renderPdfControls = vi.fn();
      // As load() leaves it: what the editor holds is the starting point
      c.versions = new NoteVersioner({ clock: createClock({ device: "editor" }) });
      c.versions.adopt(c.noteData);
      return c;
    }
    const stroke = (id, x = 1, v) => ({
      id,
      x: [x, x + 1],
      y: [1, 2],
      pressure: [1, 1],
      width: 2,
      ...(v ? { v } : {}),
    });
    // A stamp later than anything this editor made: another device's edit
    const LATER = "zzzzzzzzz-000-other";

    it("redraws and writes nothing when only metadata changed", async () => {
      const stored = { id: "n1", strokes: [stroke("a")], lastSyncedEtag: "new" };
      const c = await withStoredNote(stored, { lastSyncedEtag: "old" });

      await expect(c.handleExternalDataChange(new CustomEvent("datachange"))).resolves.toBe(false);
      expect(c.renderer.forceRedraw).not.toHaveBeenCalled();
      expect(c.renderer.drawAddedStrokes).toHaveBeenCalledWith([]);
      expect(c.historyManager.clear).not.toHaveBeenCalled();
      expect(c.strokeManager.markDirty).not.toHaveBeenCalled();
      expect(c._saveTasks).not.toHaveBeenCalled();
    });

    it("takes in a change that keeps the stroke count (a stroke moved)", async () => {
      const c = await withStoredNote(
        { id: "n1", strokes: [stroke("a", 50, LATER)] },
        { strokes: [stroke("a", 1)] },
      );

      await expect(c.handleExternalDataChange(new CustomEvent("datachange"))).resolves.toBe(true);
      expect(c.noteData.strokes[0].x[0]).toBe(50);
      expect(c.renderer.forceRedraw).toHaveBeenCalled();
    });

    it("keeps a move the user made but has not saved yet against the stored copy", async () => {
      const c = await withStoredNote({ id: "n1", strokes: [stroke("a", 1)] });
      // Moved after the editor last took in storage; the save is still pending
      c.noteData.strokes[0].x = [80, 81];

      await c.handleExternalDataChange(new CustomEvent("datachange"));
      expect(c.noteData.strokes[0].x[0]).toBe(80);
      // Storage lacks it: the editor's state is to be saved
      expect(c.strokeManager.markDirty).toHaveBeenCalled();
    });

    it("stamps the user's edits and returns the version bookkeeping for a save", async () => {
      const c = await withStoredNote({ id: "n1", strokes: [stroke("a")] });
      c.noteData.strokes.push(stroke("b"));
      c.noteData.deletedStrokes.push("a");
      c.noteData.strokes[0]._deleted = true;

      const fields = c._versionFields("strokes");
      expect(c.noteData.strokes[1].v).toBeTruthy();
      expect(fields.tombstones).toEqual({ a: expect.any(String) });

      c.readOnly = true;
      expect(c._versionFields("strokes")).toBeUndefined();
    });

    it("sends the version bookkeeping with a task save", async () => {
      const c = await withStoredNote({ id: "n1", tasks: [] });
      c._saveTasks = NoteCanvas.prototype._saveTasks;
      c.strokeManager.worker = { postMessage: vi.fn() };
      c.noteData.tasks.push({ id: "t1", type: "text", checked: false });
      c.noteData.deletedTasks = ["t0"];

      c._saveTasks();
      const message = c.strokeManager.worker.postMessage.mock.calls[0][0];
      expect(message.tasks[0].v).toBeTruthy();
      expect(message.versionFields.tombstones).toEqual({ t0: expect.any(String) });
    });

    it("takes in one stroke erased and another drawn", async () => {
      const c = await withStoredNote(
        { id: "n1", strokes: [stroke("b")], deletedStrokes: ["a"] },
        { strokes: [stroke("a")] },
      );

      await c.handleExternalDataChange(new CustomEvent("datachange"));
      expect(c.noteData.strokes.map((s) => s.id)).toEqual(["b"]);
    });

    it("paints only the arrived strokes on a note with rendered PDF pages", async () => {
      const page = { id: "p1", type: "pdf-page", fileId: "f", page: 1 };
      const c = await withStoredNote(
        { id: "n1", strokes: [stroke("a"), stroke("b")], media: [page] },
        // What the renderer adds to a page while the note is open
        { strokes: [stroke("a")], media: [{ ...page, renderable: {}, loading: false }] },
      );
      const shownMedia = c.noteData.media;

      await c.handleExternalDataChange(new CustomEvent("datachange"));
      expect(c.renderer.forceRedraw).not.toHaveBeenCalled();
      expect(c.renderer.drawAddedStrokes).toHaveBeenCalledWith([
        expect.objectContaining({ id: "b" }),
      ]);
      // The rendered page stays what the media manager shows
      expect(c.noteData.media).toBe(shownMedia);
      expect(c.mediaManager.setItems).not.toHaveBeenCalled();
    });

    it("stands down while the instance is still loading (index.js rebuilds it)", async () => {
      canvas.isInitialized = false;

      await canvas.handleExternalDataChange(new CustomEvent("datachange"));

      expect(canvas.applyLiveUpdate).not.toHaveBeenCalled();
    });

    it("takes nothing in if the note was closed while it was read", async () => {
      const c = await withStoredNote({ id: "n1", strokes: [stroke("a"), stroke("b")] });
      c.noteData.strokes = [stroke("a")];
      const { getNote } = await import("../../modules/storage.js");
      getNote.mockImplementationOnce(async () => {
        c.noteId = null; // destroy() ran mid-await
        return { id: "n1", strokes: [stroke("a"), stroke("b")] };
      });

      await expect(c.handleExternalDataChange(new CustomEvent("datachange"))).resolves.toBe(false);
      expect(c.noteData.strokes.map((s) => s.id)).toEqual(["a"]);
    });
  });
});

describe("task methods", () => {
  // The task methods only touch noteData, the renderer's selection and a few
  // UI refresh hooks, so they run on a bare instance with those stubbed.
  let host;
  let ids;

  const bar = (id, y, x0 = 100, x1 = 300) => ({ id, x: [x0, x1], y: [y, y + 30], width: 2 });

  beforeEach(async () => {
    const { generateId } = await import("../../modules/storage.js");
    ids = 0;
    generateId.mockImplementation(() => `task-${++ids}`);

    host = Object.create(NoteCanvas.prototype);
    host.noteData = { strokes: [], tasks: [], deletedTasks: [], content: "" };
    host.selectionRotated = false;
    host.selectedTaskId = null;
    host.renderer = {
      selectedStrokeIndices: new Set(),
      setSelectedStrokes: vi.fn(),
    };
    host.selectionOverlay = { hide: vi.fn(), setTaskMode: vi.fn() };
    host.historyManager = { push: vi.fn() };
    host.textEditorLayer = { renderTaskCheckboxes: vi.fn() };
    host._saveTasks = vi.fn();
    host._updateTaskCheckboxes = vi.fn();
    host._updateNavigatorSubjects = vi.fn();
    host._updateSelectionOverlay = vi.fn();
  });

  afterEach(async () => {
    const { generateId } = await import("../../modules/storage.js");
    generateId.mockImplementation(() => "mock-id");
  });

  describe("_markSelectedStrokesAsTask", () => {
    const selectAll = () => {
      host.renderer.selectedStrokeIndices = new Set(host.noteData.strokes.map((_, i) => i));
    };

    it("does nothing without a selection", () => {
      host._markSelectedStrokesAsTask();
      expect(host.noteData.tasks).toEqual([]);
      expect(host._saveTasks).not.toHaveBeenCalled();
    });

    it("makes one open task per line of the selection, with default properties", () => {
      host.noteData.strokes = [bar("a", 100), bar("b", 200)];
      selectAll();
      host._markSelectedStrokesAsTask();

      expect(host.noteData.tasks.map((t) => t.strokeIds)).toEqual([["a"], ["b"]]);
      expect(host.noteData.tasks[0]).toMatchObject({
        type: "stroke",
        status: "open",
        priority: "none",
        dueDate: "",
        checked: false,
      });
      expect(host._saveTasks).toHaveBeenCalledTimes(1);
    });

    it("folds an indented line into the task above it", () => {
      host.noteData.strokes = [bar("a", 100), bar("b", 200, 180, 300), bar("c", 300)];
      selectAll();
      host._markSelectedStrokesAsTask();

      expect(host.noteData.tasks.map((t) => t.strokeIds)).toEqual([["a", "b"], ["c"]]);
    });

    it("treats a rotated selection as one block", () => {
      host.noteData.strokes = [bar("a", 100), bar("b", 200)];
      host.selectionRotated = true;
      selectAll();
      host._markSelectedStrokesAsTask();

      expect(host.noteData.tasks).toHaveLength(1);
      expect(host.noteData.tasks[0].strokeIds).toEqual(["a", "b"]);
    });

    it("replaces an existing task that shares strokes and records it as deleted", () => {
      host.noteData.strokes = [bar("a", 100)];
      host.noteData.tasks = [{ id: "old", type: "stroke", strokeIds: ["a"] }];
      selectAll();
      host._markSelectedStrokesAsTask();

      expect(host.noteData.tasks.map((t) => t.id)).toEqual(["task-1"]);
      expect(host.noteData.deletedTasks).toEqual(["old"]);
    });

    it("leaves unrelated tasks alone", () => {
      host.noteData.strokes = [bar("a", 100), bar("z", 500)];
      host.noteData.tasks = [{ id: "other", type: "stroke", strokeIds: ["z"] }];
      host.renderer.selectedStrokeIndices = new Set([0]);
      host._markSelectedStrokesAsTask();

      expect(host.noteData.tasks.map((t) => t.id)).toEqual(["other", "task-1"]);
      expect(host.noteData.deletedTasks).toEqual([]);
    });

    it("pushes one undoable command for all created tasks and clears the selection", () => {
      host.noteData.strokes = [bar("a", 100), bar("b", 200)];
      selectAll();
      host._markSelectedStrokesAsTask();

      expect(host.historyManager.push).toHaveBeenCalledTimes(1);
      expect(host.renderer.setSelectedStrokes).toHaveBeenLastCalledWith(new Set(), null);
      expect(host._updateTaskCheckboxes).toHaveBeenCalled();
    });
  });

  describe("status and removal", () => {
    beforeEach(() => {
      host.noteData.tasks = [{ id: "t", type: "text", status: "open", checked: false }];
    });

    it("_cycleTaskStatus goes open, doing, done, open and saves each time", () => {
      const seen = [];
      for (let i = 0; i < 3; i++) {
        host._cycleTaskStatus("t");
        seen.push([host.noteData.tasks[0].status, host.noteData.tasks[0].checked]);
      }
      expect(seen).toEqual([
        ["doing", false],
        ["done", true],
        ["open", false],
      ]);
      expect(host._saveTasks).toHaveBeenCalledTimes(3);
      expect(host.textEditorLayer.renderTaskCheckboxes).toHaveBeenCalledWith(host.noteData.tasks);
    });

    it("_cycleTaskStatus ignores an unknown task", () => {
      host._cycleTaskStatus("nope");
      expect(host._saveTasks).not.toHaveBeenCalled();
    });

    it("_toggleTask sets done or open", () => {
      host._toggleTask("t", true);
      expect(host.noteData.tasks[0]).toMatchObject({ status: "done", checked: true });
      host._toggleTask("t", false);
      expect(host.noteData.tasks[0]).toMatchObject({ status: "open", checked: false });
    });

    it("_removeTaskFromSelectedStrokes removes the task, keeps the strokes, records the deletion", () => {
      host.noteData.strokes = [bar("a", 100)];
      host.noteData.tasks = [{ id: "t", type: "stroke", strokeIds: ["a"] }];
      host.selectedTaskId = "t";
      host._removeTaskFromSelectedStrokes();

      expect(host.noteData.tasks).toEqual([]);
      expect(host.noteData.deletedTasks).toEqual(["t"]);
      expect(host.noteData.strokes).toHaveLength(1);
      expect(host.selectedTaskId).toBeNull();
      expect(host._saveTasks).toHaveBeenCalled();
    });

    it("_removeTaskFromSelectedStrokes does nothing without a selected task", () => {
      host._removeTaskFromSelectedStrokes();
      expect(host._saveTasks).not.toHaveBeenCalled();
    });
  });

  describe("_selectTaskStrokes", () => {
    it("selects the live strokes of the task with padded bounds", () => {
      host.noteData.strokes = [
        bar("a", 100),
        { ...bar("gone", 100), _deleted: true },
        bar("z", 400),
      ];
      host.noteData.tasks = [{ id: "t", type: "stroke", strokeIds: ["a", "gone"] }];
      host._selectTaskStrokes("t");

      const [indices, bounds] = host.renderer.setSelectedStrokes.mock.calls[0];
      expect([...indices]).toEqual([0]);
      expect(bounds.minX).toBeLessThan(100);
      expect(bounds.maxY).toBeGreaterThan(130);
      expect(host.selectedTaskId).toBe("t");
      expect(host.selectionOverlay.setTaskMode).toHaveBeenCalledWith(true);
    });

    it("ignores text tasks, unknown tasks and tasks whose strokes are all gone", () => {
      host.noteData.strokes = [{ ...bar("a", 100), isDeleted: true }];
      host.noteData.tasks = [
        { id: "txt", type: "text" },
        { id: "dead", type: "stroke", strokeIds: ["a"] },
      ];
      for (const id of ["txt", "nope", "dead"]) host._selectTaskStrokes(id);
      expect(host.renderer.setSelectedStrokes).not.toHaveBeenCalled();
    });
  });

  describe("_openTaskPropertiesDialog", () => {
    let showTaskPropertiesDialog;

    beforeEach(() => {
      showTaskPropertiesDialog = vi.fn();
      vi.doMock("../TaskPropertiesDialog.js", () => ({ showTaskPropertiesDialog }));
      host.noteData.tasks = [{ id: "t", type: "text", status: "open", priority: "none" }];
      host.noteData.content =
        '<div><span class="task-text" data-task-id="t">Call Bob</span><br>about the offer</div>';
    });

    afterEach(() => {
      vi.doUnmock("../TaskPropertiesDialog.js");
    });

    it("passes details and recognised text, and saves what the dialog returns", async () => {
      showTaskPropertiesDialog.mockResolvedValue({
        status: "doing",
        priority: "high",
        dueDate: "2026-12-01",
        title: "Call Rob",
      });
      await host._openTaskPropertiesDialog("t");

      const [, options] = showTaskPropertiesDialog.mock.calls[0];
      expect(options.suggestedTitle).toBe("Call Bob");
      expect(options.details.text).toEqual(["about the offer"]);
      expect(host.noteData.tasks[0]).toMatchObject({
        status: "doing",
        checked: false,
        priority: "high",
        dueDate: "2026-12-01",
        title: "Call Rob",
        label: "Call Rob",
      });
      expect(host._saveTasks).toHaveBeenCalledTimes(1);
      expect(host.textEditorLayer.renderTaskCheckboxes).toHaveBeenCalled();
    });

    it("saves nothing when cancelled", async () => {
      showTaskPropertiesDialog.mockResolvedValue(null);
      await host._openTaskPropertiesDialog("t");
      expect(host._saveTasks).not.toHaveBeenCalled();
      expect(host.noteData.tasks[0].priority).toBe("none");
    });

    it("ignores a missing task id or task", async () => {
      await host._openTaskPropertiesDialog("");
      await host._openTaskPropertiesDialog("nope");
      expect(showTaskPropertiesDialog).not.toHaveBeenCalled();
    });
  });
});
