import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrokeManager } from './StrokeManager.js';

// Mock Worker
class MockWorker {
  constructor() {
    this.onmessage = null;
    this.postMessage = vi.fn();
    this.terminate = vi.fn();
  }
}
globalThis.Worker = MockWorker;

// Mock dependencies
vi.mock('../../modules/masterPassword.js', () => ({
  getEncryptionKey: vi.fn(() => 'mock-key'),
  isAppUnlocked: vi.fn(() => true),
}));

vi.mock('../../modules/storage.js', () => ({
  generateId: vi.fn(() => 'mock-id'),
}));

describe('StrokeManager', () => {
  let strokeManager;
  const noteId = 'test-note';

  beforeEach(() => {
    strokeManager = new StrokeManager(noteId);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('starts a stroke', () => {
    const props = { x: 10, y: 10, pressure: 0.5, pointerType: 'pen' };
    const stroke = strokeManager.startStroke(props);
    
    expect(stroke).toMatchObject({
      x: [10],
      y: [10],
      pressure: [0.5],
      pointerType: 'pen'
    });
    expect(strokeManager.currentStroke).toBe(stroke);
  });

  it('adds points to current stroke', () => {
    strokeManager.startStroke({ x: 10, y: 10, pressure: 0.5 });
    const points = [{ x: 20, y: 20, pressure: 0.6, time: 100 }];
    
    strokeManager.addPoints(points);
    
    expect(strokeManager.currentStroke.x).toEqual([10, 20]);
    expect(strokeManager.currentStroke.y).toEqual([10, 20]);
  });

  it('ends stroke and saves', () => {
    strokeManager.startStroke({ x: 10, y: 10, pressure: 0.5 });
    strokeManager.addPoints([{ x: 20, y: 20, pressure: 0.6 }]);
    
    const stroke = strokeManager.endStroke();
    
    expect(strokeManager.strokes).toHaveLength(1);
    expect(strokeManager.strokes[0]).toBe(stroke);
    expect(strokeManager.currentStroke).toBeNull();
    
    // Check worker message
    expect(strokeManager.worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'SAVE_STROKES',
      noteId: noteId,
      strokes: expect.any(Array),
      key: 'mock-key'
    }));
  });

  it('cancels current stroke', () => {
    strokeManager.startStroke({ x: 10, y: 10 });
    strokeManager.cancelCurrentStroke();
    expect(strokeManager.currentStroke).toBeNull();
    expect(strokeManager.strokes).toHaveLength(0);
  });
});