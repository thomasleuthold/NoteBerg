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
vi.mock("./PdfTextLayerManager.js", () => ({
  PdfTextLayerManager: vi.fn().mockImplementation(() => ({
    update: vi.fn(),
    setMode: vi.fn(),
    destroy: vi.fn(),
    refresh: vi.fn(),
    onPageRemoved: vi.fn(),
    highlightSearchTerms: vi.fn(),
    clearHighlights: vi.fn(),
  })),
}));
vi.mock("./TextEditorLayer.js", () => ({
  TextEditorLayer: vi.fn().mockImplementation(() => ({
    init: vi.fn(),
    update: vi.fn(),
    setMode: vi.fn(),
    setContentHeight: vi.fn(),
    getContent: vi.fn(() => ""),
    forceSave: vi.fn(),
    destroy: vi.fn(),
    highlightSearchTerms: vi.fn(),
    clearHighlights: vi.fn(),
    renderTaskCheckboxes: vi.fn(),
    cleanupOrphanedTextTasks: vi.fn(),
  })),
}));

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
    MediaManager.mockImplementation((_noteId, media) => {
      mediaManagerItems = media;
      return {
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
      };
    });

    const { VirtualScroller } = await import("./VirtualScroller.js");
    VirtualScroller.mockImplementation(() => {
      const viewportElement = document.createElement("div");
      return {
        getViewportSize: () => ({ width: 800, height: 600 }),
        getViewportElement: () => viewportElement,
        setContentSize: vi.fn(),
        getScrollLeft: () => 0,
        getScrollTop: () => 0,
        getViewportBounds: () => ({ left: 0, top: 0, width: 800, height: 600 }),
        setZoom: vi.fn(),
        scrollBy: vi.fn(),
        destroy: vi.fn(),
      };
    });

    const { InputHandler } = await import("./InputHandler.js");
    InputHandler.mockImplementation(() => ({
      isDrawing: false,
      getContentCoordinates: vi.fn(() => ({ x: 0, y: 0 })),
      destroy: vi.fn(),
    }));

    const { CanvasRenderer } = await import("./CanvasRenderer.js");
    CanvasRenderer.mockImplementation(() => ({
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
      selectionBounds: null,
      selectedStrokeIndices: new Set(),
      destroy: vi.fn(),
    }));

    const { SpatialIndex } = await import("./SpatialIndex.js");
    SpatialIndex.mockImplementation(() => {
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
    StrokeManager.mockImplementation((_noteId, strokes) => ({
      currentStroke: null,
      startStroke: vi.fn(function (props) {
        this.currentStroke = {
          ...props,
          id: `s-${strokes.length}`,
          x: [props.x],
          y: [props.y],
          pressure: [props.pressure],
        };
        return this.currentStroke;
      }),
      addPoints: vi.fn(function (points) {
        points.forEach((p) => {
          this.currentStroke.x.push(p.x);
          this.currentStroke.y.push(p.y);
        });
        return this.currentStroke;
      }),
      endStroke: vi.fn(function () {
        const stroke = this.currentStroke;
        if (stroke) {
          if (!stroke._keep) strokes.push(stroke);
          this.currentStroke = null;
          return stroke;
        }
        return null;
      }),
      cancelCurrentStroke: vi.fn(function () {
        if (this.currentStroke) this.currentStroke._keep = false;
        this.currentStroke = null;
      }),
      markDirty: vi.fn(),
      saveMedia: vi.fn(),
      forceSave: vi.fn(),
      destroy: vi.fn(),
    }));

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
});
