import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  updateNote: vi.fn(),
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
vi.mock("./TextEditorLayer.js", () => {
  class TextEditorLayerMock {
    init = vi.fn();
    update = vi.fn();
    setMode = vi.fn();
    setContentHeight = vi.fn();
    getContent = vi.fn(() => "");
    forceSave = vi.fn();
    destroy = vi.fn();
    highlightSearchTerms = vi.fn();
    clearHighlights = vi.fn();
    renderTaskCheckboxes = vi.fn();
    cleanupOrphanedTextTasks = vi.fn();
  }
  return { TextEditorLayer: TextEditorLayerMock };
});

// Mock global window events
window.scrollTo = vi.fn();
window.requestAnimationFrame = vi.fn((cb) => setTimeout(cb, 0));
window.cancelAnimationFrame = vi.fn((id) => clearTimeout(id));

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
        getContentCoordinates: vi.fn(() => ({ x: 0, y: 0 })),
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
      expect(noteCanvas.historyManager.push).toHaveBeenCalled();
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

      expect(noteCanvas.renderer.setSelectedStrokes).toHaveBeenCalled();
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
      expect(noteCanvas.historyManager.push).toHaveBeenCalled();
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

    it("stops the trailing run once the note is closed (noteId nulled)", async () => {
      const ctx = makeCtx();
      const p1 = ctx.save();
      ctx.save(); // flag dirty
      ctx.noteId = null; // simulate destroy() during the in-flight run
      await ctx.releaseRun(); // run #1 ends; loop guard sees noteId null → no trailing
      await p1;
      expect(ctx._runMediaSave).toHaveBeenCalledTimes(1);
      expect(ctx._mediaSaveRunning).toBeNull();
    });
  });
});
