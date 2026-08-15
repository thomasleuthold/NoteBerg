import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaManager } from "./MediaManager.js";

// Mock storage
vi.mock("../../modules/storage.js", () => ({
  getFile: vi.fn(),
  checkFileExists: vi.fn(),
}));

describe("MediaManager", () => {
  let mediaManager;
  const noteId = "test-note";
  const initialMedia = [
    { id: "1", type: "image", x: 10, y: 10, width: 100, height: 100, fileId: "f1", rotation: 0 },
    { id: "2", type: "image", x: 50, y: 50, width: 100, height: 100, fileId: "f2", rotation: 45 },
  ];

  beforeEach(() => {
    // Mock URL APIs
    window.URL.createObjectURL = vi.fn(() => "blob:url");
    window.URL.revokeObjectURL = vi.fn();

    // Use deep copy to prevent test pollution (objects in array are references)
    mediaManager = new MediaManager(noteId, JSON.parse(JSON.stringify(initialMedia)));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("initializes with provided media", () => {
    expect(mediaManager.getItems()).toHaveLength(2);
    expect(mediaManager.getItems()[0].id).toBe("1");
  });

  it("adds an item", () => {
    const newItem = { id: "3", type: "image", x: 0, y: 0, width: 50, height: 50 };
    mediaManager.addItem(newItem);
    expect(mediaManager.getItems()).toHaveLength(3);
    expect(mediaManager.getItems()[2].id).toBe("3");
  });

  it("removes an item", () => {
    mediaManager.removeItem("1");
    expect(mediaManager.getItems()).toHaveLength(1);
    expect(mediaManager.getItems()[0].id).toBe("2");
  });

  it("sets items and triggers load", async () => {
    const { getFile } = await import("../../modules/storage.js");
    getFile.mockResolvedValue(new Blob(["fake"], { type: "image/png" }));

    const newItems = [{ id: "3", type: "image", fileId: "f3", x: 0, y: 0, width: 50, height: 50 }];

    mediaManager.setItems(newItems);

    expect(mediaManager.getItems()).toHaveLength(1);
    expect(mediaManager.getItems()[0].id).toBe("3");
    expect(getFile).toHaveBeenCalledWith("f3");
  });

  it("moves item to front", () => {
    mediaManager.moveItemToFront("1");
    const items = mediaManager.getItems();
    expect(items[0].id).toBe("2");
    expect(items[1].id).toBe("1");
  });

  it("moves item to back", () => {
    // Reset order first or use current state
    // Current state: 1, 2
    mediaManager.moveItemToBack("2");
    const items = mediaManager.getItems();
    expect(items[0].id).toBe("2");
    expect(items[1].id).toBe("1");
  });

  it("updates an item", () => {
    mediaManager.updateItem("1", { x: 100 });
    const item = mediaManager.getItems().find((i) => i.id === "1");
    expect(item.x).toBe(100);
  });

  it("performs hit test correctly on unrotated item", () => {
    // Item 1: 10,10 100x100 -> 10,10 to 110,110
    const hit = mediaManager.hitTest(50, 50);
    expect(hit).not.toBeNull();
    expect(hit.id).toBe("1"); // 2 is on top but 50,50 is edge of 2 (50,50 100x100)

    // Item 2 is at 50,50.
    // hitTest iterates in reverse (top to bottom).
    // Item 2 is index 1. Item 1 is index 0.
    // Point 50,50.
    // Item 2 (rotated 45 deg around center). Center = 100, 100.
    // Let's test simple hit on Item 1 first.

    // Point 20, 20 should hit Item 1 and not Item 2
    const hit1 = mediaManager.hitTest(20, 20);
    expect(hit1.id).toBe("1");
  });

  it("performs hit test correctly on rotated item", () => {
    // Item 2: x:50, y:50, w:100, h:100, rot:45
    // Center: 100, 100.
    // Point at center should hit
    const hit = mediaManager.hitTest(100, 100);
    expect(hit).not.toBeNull();
    expect(hit.id).toBe("2");
  });

  it("returns null for miss", () => {
    const hit = mediaManager.hitTest(0, 0);
    expect(hit).toBeNull();
  });

  describe("pending insert placeholders", () => {
    // A placeholder is shown as soon as an image insert starts, before the file
    // has been encoded and stored. It has no fileId until resolvePendingItem
    // attaches one.
    const placeholder = {
      id: "p1",
      type: "image",
      pending: true,
      x: 200,
      y: 200,
      width: 100,
      height: 100,
      rotation: 0,
    };

    it("does not attempt to load a file for a placeholder", async () => {
      const { getFile } = await import("../../modules/storage.js");
      mediaManager.addItem({ ...placeholder });
      expect(getFile).not.toHaveBeenCalledWith(undefined);
    });

    it("is not selectable by hit test while pending", () => {
      mediaManager.addItem({ ...placeholder });
      // Dead centre of the placeholder — a resolved image here would be hit.
      expect(mediaManager.hitTest(250, 250)).toBeNull();
    });

    it("becomes selectable once resolved", async () => {
      const { getFile } = await import("../../modules/storage.js");
      getFile.mockResolvedValue(new Blob(["fake"], { type: "image/jpeg" }));

      mediaManager.addItem({ ...placeholder });
      mediaManager.resolvePendingItem("p1", "f-new");

      const hit = mediaManager.hitTest(250, 250);
      expect(hit).not.toBeNull();
      expect(hit.id).toBe("p1");
    });

    it("attaches the file, applies final geometry and clears the pending flag", async () => {
      const { getFile } = await import("../../modules/storage.js");
      getFile.mockResolvedValue(new Blob(["fake"], { type: "image/jpeg" }));

      mediaManager.addItem({ ...placeholder });
      const resolved = mediaManager.resolvePendingItem("p1", "f-new", {
        width: 320,
        height: 240,
      });

      expect(resolved).toBe(true);
      const item = mediaManager.getItems().find((i) => i.id === "p1");
      expect(item.fileId).toBe("f-new");
      expect(item.width).toBe(320);
      expect(item.height).toBe(240);
      // Must be absent, not undefined: the item is serialized into the note JSON.
      expect("pending" in item).toBe(false);
      // Resolving is what triggers the real image to load.
      expect(getFile).toHaveBeenCalledWith("f-new");
    });

    // x/y are the top-left corner, so applying a new size alone would pin the
    // image to that corner and make it visibly jump as the real dimensions
    // replace the 4:3 estimate. Keeping the centre fixed means only the aspect
    // ratio changes on screen.
    it("keeps the placeholder's centre when the final size differs", async () => {
      const { getFile } = await import("../../modules/storage.js");
      getFile.mockResolvedValue(new Blob(["fake"], { type: "image/jpeg" }));

      mediaManager.addItem({ ...placeholder }); // 200,200 100x100 → centre 250,250
      mediaManager.resolvePendingItem("p1", "f-new", { width: 320, height: 240 });

      const item = mediaManager.getItems().find((i) => i.id === "p1");
      expect(item.x + item.width / 2).toBe(250);
      expect(item.y + item.height / 2).toBe(250);
    });

    it("leaves position untouched when no final geometry is supplied", async () => {
      const { getFile } = await import("../../modules/storage.js");
      getFile.mockResolvedValue(new Blob(["fake"], { type: "image/jpeg" }));

      mediaManager.addItem({ ...placeholder });
      mediaManager.resolvePendingItem("p1", "f-new");

      const item = mediaManager.getItems().find((i) => i.id === "p1");
      expect(item.x).toBe(200);
      expect(item.y).toBe(200);
    });

    it("reports failure when the placeholder is already gone", () => {
      // The note was closed or the insert undone while processing was in flight.
      expect(mediaManager.resolvePendingItem("missing", "f-new")).toBe(false);
    });

    it("bumps version so renderers refresh derived state", () => {
      mediaManager.addItem({ ...placeholder });
      const before = mediaManager.version;
      mediaManager.resolvePendingItem("p1", "f-new");
      expect(mediaManager.version).toBeGreaterThan(before);
    });
  });

  it("loads image on demand and caches it once the Image element fires onload", async () => {
    const { getFile } = await import("../../modules/storage.js");
    const blob = new Blob(["fake-image"], { type: "image/png" });
    getFile.mockResolvedValue(blob);

    // Stub Image so `img.src = ...` synchronously fires onload, like jsdom's
    // real Image (which never actually decodes anything) would never do on
    // its own — this lets us verify the cache/onImageLoaded effects, not just
    // that getFile was called.
    class FakeImage {
      set src(_value) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", FakeImage);
    const onImageLoaded = vi.fn();
    mediaManager.setOnImageLoaded(onImageLoaded);

    // First call: not cached yet, triggers a load, returns null.
    const img = mediaManager.getImage("f1");
    expect(img).toBeNull();
    expect(getFile).toHaveBeenCalledWith("f1");

    // Wait for getFile's promise and the stubbed Image's onload to resolve.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onImageLoaded).toHaveBeenCalled();
    // Second call: now cached, returns the loaded image without calling getFile again.
    getFile.mockClear();
    const cachedImg = mediaManager.getImage("f1");
    expect(cachedImg).toBeInstanceOf(FakeImage);
    expect(getFile).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  describe("version counter", () => {
    // Consumers (CanvasRenderer's PDF bounds and y-index caches, NoteCanvas's
    // first-page cache) key their per-frame caches on this. A mutation that
    // fails to bump it leaves those caches stale — wrong stroke palette on PDF
    // pages, or pages culled from the draw.
    it("bumps on every mutation", () => {
      const item = { id: "m1", type: "pdf-page", x: 0, y: 0, width: 10, height: 10 };
      const other = { id: "m2", type: "pdf-page", x: 0, y: 20, width: 10, height: 10 };

      const mutations = [
        () => mediaManager.setItems([item, other]),
        () => mediaManager.addItem({ id: "m3", type: "pdf-page", x: 0, y: 40 }),
        () => mediaManager.updateItem("m1", { y: 500 }),
        () => mediaManager.moveItemToFront("m1"),
        () => mediaManager.moveItemToBack("m1"),
        () => mediaManager.removeItem("m3"),
      ];

      for (const mutate of mutations) {
        const before = mediaManager.version;
        mutate();
        expect(mediaManager.version).toBeGreaterThan(before);
      }
    });

    it("does not bump when a mutation is a no-op", () => {
      mediaManager.setItems([{ id: "m1", type: "image", x: 0, y: 0 }]);
      const before = mediaManager.version;

      mediaManager.updateItem("does-not-exist", { y: 1 });
      mediaManager.moveItemToFront("m1"); // already the only (front) item

      expect(mediaManager.version).toBe(before);
    });
  });

  it("handles image load errors gracefully", async () => {
    const { getFile } = await import("../../modules/storage.js");
    getFile.mockRejectedValue(new Error("File not found"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mediaManager.getImage("f2");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleSpy).toHaveBeenCalled();
  });
});
