import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MediaManager } from './MediaManager.js';

// Mock storage
vi.mock('../../modules/storage.js', () => ({
  getFile: vi.fn(),
  checkFileExists: vi.fn(),
}));

describe('MediaManager', () => {
  let mediaManager;
  const noteId = 'test-note';
  const initialMedia = [
    { id: '1', type: 'image', x: 10, y: 10, width: 100, height: 100, fileId: 'f1', rotation: 0 },
    { id: '2', type: 'image', x: 50, y: 50, width: 100, height: 100, fileId: 'f2', rotation: 45 }
  ];

  beforeEach(() => {
    // Mock URL APIs
    global.URL.createObjectURL = vi.fn(() => 'blob:url');
    global.URL.revokeObjectURL = vi.fn();
    
    // Use deep copy to prevent test pollution (objects in array are references)
    mediaManager = new MediaManager(noteId, JSON.parse(JSON.stringify(initialMedia)));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('initializes with provided media', () => {
    expect(mediaManager.getItems()).toHaveLength(2);
    expect(mediaManager.getItems()[0].id).toBe('1');
  });

  it('adds an item', () => {
    const newItem = { id: '3', type: 'image', x: 0, y: 0, width: 50, height: 50 };
    mediaManager.addItem(newItem);
    expect(mediaManager.getItems()).toHaveLength(3);
    expect(mediaManager.getItems()[2].id).toBe('3');
  });

  it('removes an item', () => {
    mediaManager.removeItem('1');
    expect(mediaManager.getItems()).toHaveLength(1);
    expect(mediaManager.getItems()[0].id).toBe('2');
  });

  it('moves item to front', () => {
    mediaManager.moveItemToFront('1');
    const items = mediaManager.getItems();
    expect(items[0].id).toBe('2');
    expect(items[1].id).toBe('1');
  });

  it('moves item to back', () => {
    // Reset order first or use current state
    // Current state: 1, 2
    mediaManager.moveItemToBack('2');
    const items = mediaManager.getItems();
    expect(items[0].id).toBe('2');
    expect(items[1].id).toBe('1');
  });

  it('updates an item', () => {
    mediaManager.updateItem('1', { x: 100 });
    const item = mediaManager.getItems().find(i => i.id === '1');
    expect(item.x).toBe(100);
  });

  it('performs hit test correctly on unrotated item', () => {
    // Item 1: 10,10 100x100 -> 10,10 to 110,110
    const hit = mediaManager.hitTest(50, 50);
    expect(hit).not.toBeNull();
    expect(hit.id).toBe('1'); // 2 is on top but 50,50 is edge of 2 (50,50 100x100)
    
    // Item 2 is at 50,50. 
    // hitTest iterates in reverse (top to bottom).
    // Item 2 is index 1. Item 1 is index 0.
    // Point 50,50.
    // Item 2 (rotated 45 deg around center). Center = 100, 100.
    // Let's test simple hit on Item 1 first.
    
    // Point 20, 20 should hit Item 1 and not Item 2
    const hit1 = mediaManager.hitTest(20, 20);
    expect(hit1.id).toBe('1');
  });

  it('performs hit test correctly on rotated item', () => {
    // Item 2: x:50, y:50, w:100, h:100, rot:45
    // Center: 100, 100.
    // Point at center should hit
    const hit = mediaManager.hitTest(100, 100);
    expect(hit).not.toBeNull();
    expect(hit.id).toBe('2');
  });

  it('returns null for miss', () => {
    const hit = mediaManager.hitTest(0, 0);
    expect(hit).toBeNull();
  });

  it('loads image on demand', async () => {
    const { getFile } = await import('../../modules/storage.js');
    getFile.mockResolvedValue(new Blob(['fake-image'], { type: 'image/png' }));

    // Should trigger load
    const img = mediaManager.getImage('f1');
    expect(img).toBeNull(); // First call returns null but starts load
    expect(getFile).toHaveBeenCalledWith('f1');
    
    // Wait for promise resolution (simulated)
    await new Promise(process.nextTick);
    
    // We can't easily test the onload callback of Image in jsdom without more mocking,
    // but we verified the storage call was made.
  });

  it('handles image load errors gracefully', async () => {
    const { getFile } = await import('../../modules/storage.js');
    getFile.mockRejectedValue(new Error('File not found'));
    
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    mediaManager.getImage('f2');
    await new Promise(process.nextTick);
    
    expect(consoleSpy).toHaveBeenCalled();
  });
});