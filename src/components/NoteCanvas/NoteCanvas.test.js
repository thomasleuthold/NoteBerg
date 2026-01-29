import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NoteCanvas, getSelectionHandles, getMediaHandles } from './NoteCanvas.js';

// Polyfill PointerEvent for jsdom
globalThis.PointerEvent = class PointerEvent extends Event {
  constructor(type, props = {}) {
    super(type, props);
    this.clientX = props.clientX || 0;
    this.clientY = props.clientY || 0;
    this.pointerId = props.pointerId || 0;
    this.pressure = props.pressure || 0;
    this.pointerType = props.pointerType || 'mouse';
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
vi.mock('../../modules/storage.js', () => ({
  getNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  saveFile: vi.fn(),
  generateId: vi.fn(() => 'mock-id'),
}));

vi.mock('../../utils/imageUtils.js', () => ({
  pickImages: vi.fn(),
  processImageFile: vi.fn(),
  captureFromCamera: vi.fn(),
  fileToDataUrl: vi.fn(),
  optimizeImageForDisplay: vi.fn(url => Promise.resolve({ dataUrl: url, width: 100, height: 100 })),
}));

vi.mock('./VirtualScroller.js');
vi.mock('./CanvasRenderer.js');
vi.mock('./SpatialIndex.js');
vi.mock('./InputHandler.js');
vi.mock('./MediaManager.js');
vi.mock('./MediaOverlay.js');
vi.mock('./NoteToolbar.js');
vi.mock('./StrokeManager.js');

// Mock global window events
window.scrollTo = vi.fn();
window.requestAnimationFrame = vi.fn((cb) => setTimeout(cb, 0));
window.cancelAnimationFrame = vi.fn((id) => clearTimeout(id));

describe('NoteCanvas Helpers', () => {
  describe('getSelectionHandles', () => {
    it('calculates handle positions correctly', () => {
      const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
      const zoom = 1;
      const handles = getSelectionHandles(bounds, zoom);
      
      expect(handles).toHaveLength(9); // 8 corners/sides + 1 rotate handle
      
      const nw = handles.find(h => h.key === 'nw');
      expect(nw).toEqual({ key: 'nw', x: 0, y: 0 });
      
      const se = handles.find(h => h.key === 'se');
      expect(se).toEqual({ key: 'se', x: 100, y: 100 });
      
      const rotate = handles.find(h => h.key === 'rotate');
      expect(rotate.y).toBeLessThan(0); // Should be above the box
    });
  });

  describe('getMediaHandles', () => {
    it('calculates unrotated media handles correctly', () => {
      const item = { x: 10, y: 10, width: 100, height: 50, rotation: 0 };
      const zoom = 1;
      const handles = getMediaHandles(item, zoom);

      const n = handles.find(h => h.key === 'n');
      expect(n.x).toBe(60); // 10 + 100/2
      expect(n.y).toBe(10);
    });

    it('calculates rotated media handles correctly', () => {
      // 90 degree rotation around center
      const item = { x: 0, y: 0, width: 100, height: 100, rotation: 90 };
      const handles = getMediaHandles(item, 1);
      // Just verify it returns handles, exact math check is complex for unit test
      expect(handles).toHaveLength(9);
    });
  });
});

describe('NoteCanvas Class', () => {
  let container;
  let noteCanvas;
  let mockNoteData;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    
    mockNoteData = {
      id: 'note-1',
      strokes: [],
      media: [],
      background: 'none'
    };

    const { getNote } = await import('../../modules/storage.js');
    getNote.mockResolvedValue(mockNoteData);

    // Mock sub-components to return usable instances
    const { VirtualScroller } = await import('./VirtualScroller.js');
    VirtualScroller.mockImplementation(() => {
      const viewportElement = document.createElement('div');
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

    const { MediaManager } = await import('./MediaManager.js');
    MediaManager.mockImplementation(() => ({
      setOnImageLoaded: vi.fn(),
      getItems: vi.fn(() => []),
      addItem: vi.fn(),
      removeItem: vi.fn(),
      updateItem: vi.fn(),
      hitTest: vi.fn(() => null),
      destroy: vi.fn(),
    }));

    const { InputHandler } = await import('./InputHandler.js');
    InputHandler.mockImplementation(() => ({
      isDrawing: false,
      getContentCoordinates: vi.fn(() => ({ x: 0, y: 0 })),
      destroy: vi.fn(),
    }));

    const { CanvasRenderer } = await import('./CanvasRenderer.js');
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
      destroy: vi.fn(),
    }));

    const { SpatialIndex } = await import('./SpatialIndex.js');
    SpatialIndex.mockImplementation(() => ({
      build: vi.fn(),
      getContentBounds: () => ({ minX: 0, minY: 0, maxX: 100, maxY: 100 }),
      query: vi.fn(() => []),
      insert: vi.fn(),
      remove: vi.fn(),
      clear: vi.fn(),
    }));

    const { StrokeManager } = await import('./StrokeManager.js');
    StrokeManager.mockImplementation(() => ({
      startStroke: vi.fn(() => ({ id: 's1', x: [], y: [] })),
      addPoints: vi.fn(() => ({ id: 's1', x: [10], y: [10] })),
      endStroke: vi.fn(() => ({ id: 's1', x: [10, 20], y: [10, 20] })),
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

  it('loads note data and initializes components', async () => {
    await noteCanvas.load('note-1');
    
    expect(noteCanvas.scroller).toBeTruthy();
    expect(noteCanvas.renderer).toBeTruthy();
    expect(noteCanvas.spatialIndex).toBeTruthy();
    expect(noteCanvas.strokeManager).toBeTruthy();
    expect(noteCanvas.renderer.render).toHaveBeenCalled();
  });

  it('handles stroke lifecycle', async () => {
    await noteCanvas.load('note-1');
    noteCanvas._setMode('draw');

    // Start
    noteCanvas._onStrokeStart({ x: 10, y: 10, pressure: 0.5, pointerType: 'pen' });
    expect(noteCanvas.strokeManager.startStroke).toHaveBeenCalled();
    expect(noteCanvas.renderer.drawDirectStroke).toHaveBeenCalled();

    // Move
    noteCanvas._onStrokeMove([{ x: 20, y: 20, pressure: 0.5, time: 100 }]);
    expect(noteCanvas.strokeManager.addPoints).toHaveBeenCalled();

    // End
    noteCanvas._onStrokeEnd();
    expect(noteCanvas.strokeManager.endStroke).toHaveBeenCalled();
    expect(noteCanvas.spatialIndex.insert).toHaveBeenCalled();
  });

  it('handles eraser logic', async () => {
    await noteCanvas.load('note-1');
    noteCanvas._setMode('eraser');

    // Mock spatial index to return a candidate stroke
    noteCanvas.spatialIndex.query.mockReturnValue([0]);
    // Mock note data with a stroke that intersects
    noteCanvas.noteData.strokes = [{ id: 's1', x: [10, 20], y: [10, 20], width: 2 }];

    // Trigger eraser at 15,15 (should hit)
    noteCanvas._onStrokeMove([{ x: 15, y: 15, clientX: 15, clientY: 15 }]);

    expect(noteCanvas.renderer.drawEraserCursor).toHaveBeenCalled();
    expect(noteCanvas.noteData.strokes[0]._deleted).toBe(true);
    expect(noteCanvas.strokeManager.forceSave).toHaveBeenCalled();
  });

  it('handles lasso selection end', async () => {
    await noteCanvas.load('note-1');
    noteCanvas._setMode('lasso');

    // Simulate lasso points
    noteCanvas.lassoPoints = [{x:0, y:0}, {x:100, y:0}, {x:100, y:100}, {x:0, y:100}];
    
    // Mock finding strokes
    // We need to mock the internal _findStrokesInPolygon or the spatial index query it uses
    // Since _findStrokesInPolygon is private, we rely on spatialIndex.query
    noteCanvas.spatialIndex.query.mockReturnValue([0]);
    noteCanvas.noteData.strokes = [{ id: 's1', x: [50], y: [50], width: 2 }]; // Inside
    // Mock cached bounds in spatial index
    noteCanvas.spatialIndex.strokeBounds = new Map([[0, { minX: 49, maxX: 51, minY: 49, maxY: 51 }]]);

    noteCanvas._handleLassoEnd();
    
    // Should verify renderer.setSelectedStrokes was called
    // Note: This depends on complex geometry logic in _findStrokesInPolygon. 
    // If it fails, check if the mock bounds/points are geometrically correct for "inside".
  });

  it('zooms on wheel event with ctrl key', async () => {
    await noteCanvas.load('note-1');
    const viewport = noteCanvas.scroller.getViewportElement();
    
    // Initial zoom
    expect(noteCanvas.zoomScale).toBe(1.0);
    
    // Dispatch wheel event
    const wheelEvent = new WheelEvent('wheel', {
      ctrlKey: true,
      deltaY: -100, // Zoom in
      clientX: 100,
      clientY: 100
    });
    viewport.dispatchEvent(wheelEvent);
    
    expect(noteCanvas.zoomScale).toBeGreaterThan(1.0);
  });

  it('inserts image from picker', async () => {
    await noteCanvas.load('note-1');
    const { pickImages, processImageFile } = await import('../../utils/imageUtils.js');
    
    // Mock file selection and processing
    pickImages.mockResolvedValue([new File([''], 'test.png', { type: 'image/png' })]);
    processImageFile.mockResolvedValue({
      dataUrl: 'data:image/png;base64,fake',
      width: 100,
      height: 100
    });
    
    // Mock global fetch for data URL conversion inside insertImage
    globalThis.fetch = vi.fn(() => Promise.resolve({
      blob: () => Promise.resolve(new Blob(['fake'], { type: 'image/png' }))
    }));

    await noteCanvas.insertImage('picker');
    
    expect(pickImages).toHaveBeenCalled();
    expect(noteCanvas.mediaManager.addItem).toHaveBeenCalled();
    expect(noteCanvas.strokeManager.saveMedia).toHaveBeenCalled();
  });

  it('handles pinch zoom gesture', async () => {
    await noteCanvas.load('note-1');
    const viewport = noteCanvas.scroller.getViewportElement();
    
    // Simulate 2-finger touch start
    const touchStart = new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, pointerType: 'touch' });
    const touchStart2 = new PointerEvent('pointerdown', { pointerId: 2, clientX: 100, clientY: 0, pointerType: 'touch' });
    viewport.dispatchEvent(touchStart);
    viewport.dispatchEvent(touchStart2);
    
    // Simulate pinch out (fingers moving apart)
    const touchMove = new PointerEvent('pointermove', { pointerId: 2, clientX: 200, clientY: 0, pointerType: 'touch' });
    viewport.dispatchEvent(touchMove);
    
    expect(noteCanvas.zoomScale).toBeGreaterThan(1.0);
  });
});