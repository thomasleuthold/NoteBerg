import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getMediaHandles, getSelectionHandles, NoteCanvas } from "./NoteCanvas.js";

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

// Mock dependencies
vi.mock("../../modules/storage.js", () => ({
  getNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  saveFile: vi.fn((blob) => Promise.resolve(`file-${blob.size}`)),
  generateId: vi.fn(() => "mock-id"),
}));

vi.mock("../../modules/pdfManager.js", () => ({
  importPdf: vi.fn(),
  loadPdfPage: vi.fn(),
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
  })),
}));

// Mock global window events
window.scrollTo = vi.fn();
window.requestAnimationFrame = vi.fn((cb) => setTimeout(cb, 0));
window.cancelAnimationFrame = vi.fn((id) => clearTimeout(id));

describe("NoteCanvas Helpers", () => {
  describe("getSelectionHandles", () => {
    it("calculates handle positions correctly", () => {
      const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
      const zoom = 1;
      const handles = getSelectionHandles(bounds, zoom);
      expect(handles).toHaveLength(9);
    });
  });

  describe("getMediaHandles", () => {
    it("calculates unrotated media handles correctly", () => {
      const item = { x: 10, y: 10, width: 100, height: 50, rotation: 0 };
      const zoom = 1;
      const handles = getMediaHandles(item, zoom);
      const n = handles.find((h) => h.key === "n");
      expect(n.x).toBe(60);
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
    SpatialIndex.mockImplementation(() => ({
      build: vi.fn(),
      getContentBounds: () => ({ minX: 0, minY: 0, maxX: 100, maxY: 100 }),
      query: vi.fn(() => []),
      insert: vi.fn(),
      remove: vi.fn(),
      clear: vi.fn(),
    }));

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
          strokes.push(stroke);
          this.currentStroke = null;
          return stroke;
        }
        return null;
      }),
      cancelCurrentStroke: vi.fn(),
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

  describe("Undo/Redo", () => {
    let actualCommands;

    beforeAll(async () => {
      vi.unmock("./commands/index.js");
      actualCommands = await import("./commands/index.js");
    });

    it("should undo and redo a drawn stroke", async () => {
      await noteCanvas.load("note-1");
      const historyPushSpy = vi.spyOn(noteCanvas.historyManager, "push");
      noteCanvas._setMode("draw");

      noteCanvas._onStrokeStart({ x: 10, y: 10, pointerType: "pen" });
      noteCanvas._onStrokeEnd();

      expect(historyPushSpy).toHaveBeenCalledWith(expect.any(actualCommands.DrawStrokeCommand));
    });

    it("should undo and redo a DeleteMediaCommand", async () => {
      const mediaItem = { id: "media-1", type: "image", fileId: "file-1" };
      mockNoteData.media.push(mediaItem);
      await noteCanvas.load("note-1");

      noteCanvas.selectedMediaId = "media-1";
      await noteCanvas.deleteSelectedMedia();
      expect(noteCanvas.noteData.media).toHaveLength(0);

      noteCanvas.historyManager.undo();
      expect(noteCanvas.noteData.media).toHaveLength(1);

      noteCanvas.historyManager.redo();
      expect(noteCanvas.noteData.media).toHaveLength(0);
    });

    it("should undo and redo a TransformStrokesCommand", async () => {
      const stroke = { id: "s1", x: [10, 20], y: [10, 10] };
      mockNoteData.strokes.push(stroke);
      await noteCanvas.load("note-1");

      noteCanvas.renderer.selectedStrokeIndices = new Set([0]);
      noteCanvas.transformState = {
        selectedIndices: [0],
        initialStrokes: [{ x: [10, 20], y: [10, 10] }],
      };
      stroke.x = [15, 25];
      noteCanvas._endTransform();

      noteCanvas.historyManager.undo();
      expect(noteCanvas.noteData.strokes[0].x).toEqual([10, 20]);

      noteCanvas.historyManager.redo();
      expect(noteCanvas.noteData.strokes[0].x).toEqual([15, 25]);
    });

    it("should undo and redo a ReorderMediaCommand", async () => {
      const item1 = { id: "media-1", type: "image" };
      const item2 = { id: "media-2", type: "image" };
      mockNoteData.media.push(item1, item2);
      await noteCanvas.load("note-1");

      noteCanvas.moveSelectedMediaToFront("media-1");
      expect(noteCanvas.noteData.media.map((i) => i.id)).toEqual(["media-2", "media-1"]);

      noteCanvas.historyManager.undo();
      expect(noteCanvas.noteData.media.map((i) => i.id)).toEqual(["media-1", "media-2"]);

      noteCanvas.historyManager.redo();
      expect(noteCanvas.noteData.media.map((i) => i.id)).toEqual(["media-2", "media-1"]);
    });
  });
});
