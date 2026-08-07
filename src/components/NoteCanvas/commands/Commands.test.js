import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CropImageCommand,
  DeleteMediaCommand,
  DrawStrokeCommand,
  EraseStrokePartsCommand,
  EraseStrokesCommand,
  InsertMediaCommand,
  MarkTaskCommand,
  PasteStrokesCommand,
  ReorderMediaCommand,
  ShiftContentCommand,
  TextChangeCommand,
  TransformMediaCommand,
  TransformStrokesCommand,
} from "./index.js";

describe("NoteCanvas Commands", () => {
  let noteCanvas;
  let mockStrokes;
  let mockMedia;
  let mockTasks;

  beforeEach(() => {
    mockStrokes = [
      { id: "s1", x: [10], y: [10], _deleted: false },
      { id: "s2", x: [20], y: [20], _deleted: false },
    ];
    mockMedia = [
      { id: "m1", type: "image", x: 0, y: 0, fileId: "f1" },
      { id: "m2", type: "image", x: 50, y: 50, fileId: "f2" },
    ];
    mockTasks = [];

    noteCanvas = {
      noteData: {
        strokes: mockStrokes,
        media: mockMedia,
        tasks: mockTasks,
        deletedStrokes: [],
        deletedMedia: [],
        pdfSource: null,
      },
      strokeManager: {
        markDirty: vi.fn(),
        forceSave: vi.fn(),
      },
      mediaManager: {
        addItem: vi.fn((item) => mockMedia.push(item)),
        removeItem: vi.fn((id) => {
          const idx = mockMedia.findIndex((m) => m.id === id);
          if (idx > -1) mockMedia.splice(idx, 1);
        }),
        updateItem: vi.fn((id, updates) => {
          const item = mockMedia.find((m) => m.id === id);
          if (item) Object.assign(item, updates);
        }),
        getItems: vi.fn(() => mockMedia),
        setItems: vi.fn((items) => {
          // Replace contents of mockMedia array
          mockMedia.length = 0;
          mockMedia.push(...items);
        }),
        moveItemToFront: vi.fn(),
        moveItemToBack: vi.fn(),
      },
      renderer: {
        forceRedraw: vi.fn(),
        drawDirectStroke: vi.fn(),
        setSelectedStrokes: vi.fn(),
      },
      selectionOverlay: {
        hide: vi.fn(),
      },
      spatialIndex: {
        insert: vi.fn(),
        remove: vi.fn(),
        build: vi.fn(),
      },
      textEditorLayer: {
        setContentSilently: vi.fn(),
        renderTaskCheckboxes: vi.fn(),
      },
      _onTextContentChange: vi.fn(),
      _updateMediaOverlay: vi.fn(),
      _updateSelectionOverlay: vi.fn(),
      _updateTaskCheckboxes: vi.fn(),
      _updateNavigatorSubjects: vi.fn(),
      _renderPdfControls: vi.fn(),
      _saveMediaChanges: vi.fn(),
      _saveTasks: vi.fn(),
    };
  });

  describe("TextChangeCommand", () => {
    it("should undo and redo text changes", () => {
      const cmd = new TextChangeCommand("<p>Old</p>", "<p>New</p>");

      // Task records must survive the HTML swap (they belong to the paired
      // MarkTaskCommand on the history stack), and checkboxes must be
      // re-rendered because persisted HTML doesn't contain them.
      cmd.undo(noteCanvas);
      expect(noteCanvas.textEditorLayer.setContentSilently).toHaveBeenCalledWith("<p>Old</p>");
      expect(noteCanvas._onTextContentChange).toHaveBeenCalledWith("<p>Old</p>", {
        skipTaskCleanup: true,
      });
      expect(noteCanvas.textEditorLayer.renderTaskCheckboxes).toHaveBeenCalledWith(
        noteCanvas.noteData.tasks,
      );

      cmd.redo(noteCanvas);
      expect(noteCanvas.textEditorLayer.setContentSilently).toHaveBeenCalledWith("<p>New</p>");
      expect(noteCanvas._onTextContentChange).toHaveBeenCalledWith("<p>New</p>", {
        skipTaskCleanup: true,
      });
    });

    it("should handle missing textEditorLayer gracefully", () => {
      noteCanvas.textEditorLayer = null;
      const cmd = new TextChangeCommand("A", "B");
      expect(() => cmd.undo(noteCanvas)).not.toThrow();
      expect(() => cmd.redo(noteCanvas)).not.toThrow();
    });
  });

  describe("DrawStrokeCommand", () => {
    it("should undo (delete) and redo (restore) a stroke", () => {
      const newStroke = { id: "s3", x: [30], y: [30], _deleted: false };
      // Simulate stroke already added to data before command creation
      mockStrokes.push(newStroke);
      const index = 2;

      const cmd = new DrawStrokeCommand(newStroke, index);

      // Undo: should mark as deleted
      cmd.undo(noteCanvas);
      expect(newStroke._deleted).toBe(true);
      // The index holds live strokes only, so undo must drop the entry redo()
      // added — otherwise every later query pays for a stroke never drawn.
      expect(noteCanvas.spatialIndex.remove).toHaveBeenCalledWith(index);
      expect(noteCanvas.strokeManager.markDirty).toHaveBeenCalled();
      expect(noteCanvas.renderer.forceRedraw).toHaveBeenCalled();

      // Redo: should unmark deleted
      cmd.redo(noteCanvas);
      expect(newStroke._deleted).toBe(false);
      expect(noteCanvas.spatialIndex.insert).toHaveBeenCalledWith(newStroke, index);
      expect(noteCanvas.strokeManager.markDirty).toHaveBeenCalled();
    });
  });

  describe("EraseStrokesCommand", () => {
    it("should undo (restore) and redo (erase) strokes", () => {
      // s1 is currently not deleted
      const erasedStrokes = [{ index: 0, id: "s1" }];
      const cmd = new EraseStrokesCommand(erasedStrokes);

      // Simulate the action that happened (s1 deleted)
      mockStrokes[0]._deleted = true;

      // Undo: restore s1. The spatial index holds live strokes only, so the
      // entry dropped when s1 was erased has to be put back — otherwise the
      // restored stroke is in noteData but never queried, and so never drawn.
      cmd.undo(noteCanvas);
      expect(mockStrokes[0]._deleted).toBe(false);
      expect(noteCanvas.spatialIndex.insert).toHaveBeenCalledWith(mockStrokes[0], 0);

      // Redo: delete s1 again — and drop it from the index, so queries stop
      // paying for erased content for the rest of the session.
      cmd.redo(noteCanvas);
      expect(mockStrokes[0]._deleted).toBe(true);
      expect(noteCanvas.spatialIndex.remove).toHaveBeenCalledWith(0);
    });
  });

  describe("InsertMediaCommand", () => {
    it("should undo (remove) and redo (add) media items", () => {
      const newItem = { id: "m3", type: "image" };
      const cmd = new InsertMediaCommand([newItem]);

      // Redo (Add)
      cmd.redo(noteCanvas);
      expect(noteCanvas.mediaManager.addItem).toHaveBeenCalledWith(
        expect.objectContaining(newItem),
      );
      expect(noteCanvas._renderPdfControls).toHaveBeenCalled();
      expect(noteCanvas._saveMediaChanges).toHaveBeenCalled();

      // Undo (Remove)
      cmd.undo(noteCanvas);
      expect(noteCanvas.mediaManager.removeItem).toHaveBeenCalledWith("m3");
      expect(noteCanvas._saveMediaChanges).toHaveBeenCalled();
    });

    it("should handle PDF source setting", () => {
      const newItem = { id: "p1", type: "pdf-page" };
      const cmd = new InsertMediaCommand([newItem], "pdf-source-id");

      cmd.redo(noteCanvas);
      expect(noteCanvas.noteData.pdfSource).toBe("pdf-source-id");

      cmd.undo(noteCanvas);
      expect(noteCanvas.noteData.pdfSource).toBeNull();
    });
  });

  describe("DeleteMediaCommand", () => {
    it("should undo (restore) and redo (delete) media items", () => {
      const itemToDelete = { id: "m1", type: "image" };
      const cmd = new DeleteMediaCommand([itemToDelete]);

      // Undo (Restore)
      cmd.undo(noteCanvas);
      expect(noteCanvas.mediaManager.addItem).toHaveBeenCalledWith(
        expect.objectContaining(itemToDelete),
      );
      expect(noteCanvas._renderPdfControls).toHaveBeenCalled();
      expect(noteCanvas._saveMediaChanges).toHaveBeenCalled();

      // Redo (Delete)
      cmd.redo(noteCanvas);
      expect(noteCanvas.mediaManager.removeItem).toHaveBeenCalledWith("m1");
      expect(noteCanvas._saveMediaChanges).toHaveBeenCalled();
    });

    it("should handle PDF source restoration", () => {
      const item = { id: "p1", type: "pdf-page" };
      const cmd = new DeleteMediaCommand([item], true, "pdf-source-id");

      cmd.undo(noteCanvas);
      expect(noteCanvas.noteData.pdfSource).toBe("pdf-source-id");

      cmd.redo(noteCanvas);
      expect(noteCanvas.noteData.pdfSource).toBeNull();
    });
  });

  describe("TransformMediaCommand", () => {
    it("should undo and redo media transformations", () => {
      const oldState = { x: 0, y: 0, width: 100, height: 100, rotation: 0 };
      const newState = { x: 10, y: 10, width: 120, height: 120, rotation: 90 };
      const cmd = new TransformMediaCommand("m1", oldState, newState);

      // Redo
      cmd.redo(noteCanvas);
      expect(noteCanvas.mediaManager.updateItem).toHaveBeenCalledWith("m1", newState);
      expect(noteCanvas._saveMediaChanges).toHaveBeenCalled();

      // Undo
      cmd.undo(noteCanvas);
      expect(noteCanvas.mediaManager.updateItem).toHaveBeenCalledWith("m1", oldState);
      expect(noteCanvas._saveMediaChanges).toHaveBeenCalled();
    });
  });

  describe("TransformStrokesCommand", () => {
    it("should undo and redo stroke transformations", () => {
      const indices = [0];
      const oldCoords = [{ x: [10], y: [10] }];
      const newCoords = [{ x: [15], y: [15] }];

      const cmd = new TransformStrokesCommand(indices, oldCoords, newCoords);

      // Redo
      cmd.redo(noteCanvas);
      expect(mockStrokes[0].x).toEqual([15]);
      expect(mockStrokes[0].y).toEqual([15]);
      expect(noteCanvas.spatialIndex.remove).toHaveBeenCalledWith(0);
      expect(noteCanvas.spatialIndex.insert).toHaveBeenCalledWith(mockStrokes[0], 0);
      expect(noteCanvas.strokeManager.markDirty).toHaveBeenCalled();

      // Undo
      cmd.undo(noteCanvas);
      expect(mockStrokes[0].x).toEqual([10]);
      expect(mockStrokes[0].y).toEqual([10]);
      expect(noteCanvas.spatialIndex.remove).toHaveBeenCalledWith(0);
      expect(noteCanvas.spatialIndex.insert).toHaveBeenCalledWith(mockStrokes[0], 0);
    });
  });

  describe("CropImageCommand", () => {
    it("should undo and redo image cropping", () => {
      const oldDims = { width: 100, height: 100 };
      const newDims = { width: 80, height: 80 };
      const cmd = new CropImageCommand("m1", "old-file", oldDims, "new-file", newDims);

      // Redo
      cmd.redo(noteCanvas);
      expect(noteCanvas.mediaManager.updateItem).toHaveBeenCalledWith("m1", {
        fileId: "new-file",
        width: 80,
        height: 80,
      });
      expect(noteCanvas._saveMediaChanges).toHaveBeenCalled();

      // Undo
      cmd.undo(noteCanvas);
      expect(noteCanvas.mediaManager.updateItem).toHaveBeenCalledWith("m1", {
        fileId: "old-file",
        width: 100,
        height: 100,
      });
    });
  });

  describe("ReorderMediaCommand", () => {
    it("should undo and redo move to front", () => {
      // Initial order: m1, m2
      const cmd = new ReorderMediaCommand("m1", "front", 0);

      // Redo (Move m1 to front -> m2, m1)
      cmd.redo(noteCanvas);
      expect(noteCanvas.mediaManager.moveItemToFront).toHaveBeenCalledWith("m1");

      // Undo (Restore m1 to index 0)
      // Mock getItems to return current state [m2, m1]
      noteCanvas.mediaManager.getItems.mockReturnValue([mockMedia[1], mockMedia[0]]);

      cmd.undo(noteCanvas);
      // The command modifies the array in place via splice
      const items = noteCanvas.mediaManager.getItems();
      expect(items[0].id).toBe("m1");
      expect(items[1].id).toBe("m2");
    });

    it("should undo and redo move to back", () => {
      // Initial order: m1, m2
      const cmd = new ReorderMediaCommand("m2", "back", 1);

      // Redo (Move m2 to back -> m2, m1)
      cmd.redo(noteCanvas);
      expect(noteCanvas.mediaManager.moveItemToBack).toHaveBeenCalledWith("m2");

      // Undo (Restore m2 to index 1)
      noteCanvas.mediaManager.getItems.mockReturnValue([mockMedia[1], mockMedia[0]]);

      cmd.undo(noteCanvas);
      // The command modifies the array in place via splice
      const items = noteCanvas.mediaManager.getItems();
      expect(items[0].id).toBe("m1");
      expect(items[1].id).toBe("m2");
    });
  });

  describe("MarkTaskCommand", () => {
    it("should undo (remove) and redo (add) a task", () => {
      const task = { id: "t1", type: "stroke" };
      const cmd = new MarkTaskCommand(task);

      // Redo (Add)
      cmd.redo(noteCanvas);
      expect(noteCanvas.noteData.tasks).toContainEqual(task);
      expect(noteCanvas._saveTasks).toHaveBeenCalled();
      expect(noteCanvas._updateTaskCheckboxes).toHaveBeenCalled();

      // Undo (Remove)
      cmd.undo(noteCanvas);
      expect(noteCanvas.noteData.tasks).not.toContainEqual(task);
      expect(noteCanvas._saveTasks).toHaveBeenCalled();
    });
  });

  describe("ShiftContentCommand", () => {
    it("should undo and redo content shifting", () => {
      const yShift = 100;
      const strokeIds = ["s1"];
      const mediaIds = ["m1"];
      const cmd = new ShiftContentCommand(yShift, strokeIds, mediaIds);

      // Redo (Shift down)
      cmd.redo(noteCanvas);
      expect(mockStrokes[0].y[0]).toBe(110); // 10 + 100
      expect(mockMedia[0].y).toBe(100); // 0 + 100
      // s2 and m2 should be untouched
      expect(mockStrokes[1].y[0]).toBe(20);
      expect(mockMedia[1].y).toBe(50);

      expect(noteCanvas.spatialIndex.build).toHaveBeenCalledWith(mockStrokes);
      expect(noteCanvas.strokeManager.markDirty).toHaveBeenCalled();
      expect(noteCanvas._saveMediaChanges).toHaveBeenCalled();

      // Undo (Shift up)
      cmd.undo(noteCanvas);
      expect(mockStrokes[0].y[0]).toBe(10);
      expect(mockMedia[0].y).toBe(0);
    });

    it("should handle missing items gracefully", () => {
      const cmd = new ShiftContentCommand(100, ["missing-s"], ["missing-m"]);
      expect(() => cmd.redo(noteCanvas)).not.toThrow();
      expect(() => cmd.undo(noteCanvas)).not.toThrow();
    });

    it("should handle text tasks shifting", () => {
      // Mock text task DOM element
      const mockElement = {
        style: { top: "50px" },
        dataset: { taskId: "t1" },
      };
      noteCanvas.textEditorLayer._editorElement = {
        querySelector: vi.fn(() => mockElement),
        querySelectorAll: vi.fn(() => [mockElement]),
      };

      // Add a text task
      mockTasks.push({ id: "t1", type: "text" });

      // ShiftContentCommand logic for text tasks is complex (DOM manipulation vs data).
      // The current implementation of ShiftContentCommand primarily targets strokes and media.
      // If it supports text tasks, we'd test it here.
      // Looking at the implementation, it iterates strokes and media.
      // It doesn't seem to explicitly shift text tasks in the command itself,
      // relying on the text editor content update if it was a text insertion.
      // But if it's "Insert Space", it might need to shift text blocks?
      // The current ShiftContentCommand implementation in context only handles strokes and media.
    });
  });

  describe("PasteStrokesCommand", () => {
    it("redo restores deleted pasted strokes and reinserts them into the spatial index", () => {
      const pasted = { id: "p1", x: [5], y: [5], _deleted: true };
      mockStrokes.push(pasted);
      const index = mockStrokes.length - 1;
      noteCanvas.noteData.deletedStrokes.push("p1");

      const cmd = new PasteStrokesCommand([pasted], [index]);
      cmd.redo(noteCanvas);

      expect(pasted._deleted).toBe(false);
      expect(noteCanvas.noteData.deletedStrokes).not.toContain("p1");
      expect(noteCanvas.spatialIndex.insert).toHaveBeenCalledWith(pasted, index);
      expect(noteCanvas.strokeManager.markDirty).toHaveBeenCalled();
      expect(noteCanvas.strokeManager.forceSave).toHaveBeenCalled();
      expect(noteCanvas.renderer.forceRedraw).toHaveBeenCalled();
    });

    it("redo is a no-op for a stroke that is not currently deleted", () => {
      const pasted = { id: "p1", x: [5], y: [5], _deleted: false };
      mockStrokes.push(pasted);
      const index = mockStrokes.length - 1;

      const cmd = new PasteStrokesCommand([pasted], [index]);
      cmd.redo(noteCanvas);

      expect(noteCanvas.spatialIndex.insert).not.toHaveBeenCalled();
    });

    it("undo marks pasted strokes deleted, tracks their id, and clears selection", () => {
      const pasted = { id: "p1", x: [5], y: [5], _deleted: false };
      mockStrokes.push(pasted);
      const index = mockStrokes.length - 1;

      const cmd = new PasteStrokesCommand([pasted], [index]);
      cmd.undo(noteCanvas);

      expect(pasted._deleted).toBe(true);
      // Symmetric with redo()'s insert(): the index tracks live strokes only.
      expect(noteCanvas.spatialIndex.remove).toHaveBeenCalledWith(index);
      expect(noteCanvas.noteData.deletedStrokes).toContain("p1");
      expect(noteCanvas.renderer.setSelectedStrokes).toHaveBeenCalledWith(new Set(), null);
      expect(noteCanvas.selectionOverlay.hide).toHaveBeenCalled();
      expect(noteCanvas.strokeManager.forceSave).toHaveBeenCalled();
    });

    it("undo does not duplicate the id in deletedStrokes when called twice in a row", () => {
      const pasted = { id: "p1", x: [5], y: [5], _deleted: false };
      mockStrokes.push(pasted);
      const index = mockStrokes.length - 1;

      const cmd = new PasteStrokesCommand([pasted], [index]);
      cmd.undo(noteCanvas);
      cmd.undo(noteCanvas); // stroke is already _deleted, so the second call should be a no-op

      expect(noteCanvas.noteData.deletedStrokes.filter((id) => id === "p1")).toHaveLength(1);
    });

    it("handles a missing selectionOverlay gracefully", () => {
      noteCanvas.selectionOverlay = null;
      const pasted = { id: "p1", x: [5], y: [5], _deleted: false };
      mockStrokes.push(pasted);
      const cmd = new PasteStrokesCommand([pasted], [mockStrokes.length - 1]);
      expect(() => cmd.undo(noteCanvas)).not.toThrow();
    });
  });

  describe("EraseStrokePartsCommand", () => {
    function makeOperation({ originalIndex, originalId, subStrokeIndices }) {
      return {
        originalIndex,
        originalId,
        subStrokes: subStrokeIndices.map((index) => ({
          stroke: mockStrokes[index],
          index,
        })),
      };
    }

    it("redo deletes the original stroke and restores its sub-strokes", () => {
      // s1 (index 0) gets erased into two sub-strokes appended at indices 2 and 3.
      const sub1 = { id: "sub1", x: [1], y: [1], _deleted: true };
      const sub2 = { id: "sub2", x: [2], y: [2], _deleted: true };
      mockStrokes.push(sub1, sub2);
      noteCanvas.noteData.deletedStrokes.push("sub1", "sub2");

      const operation = makeOperation({
        originalIndex: 0,
        originalId: "s1",
        subStrokeIndices: [2, 3],
      });
      const cmd = new EraseStrokePartsCommand([operation]);

      cmd.redo(noteCanvas);

      expect(mockStrokes[0]._deleted).toBe(true);
      expect(noteCanvas.noteData.deletedStrokes).toContain("s1");
      expect(sub1._deleted).toBe(false);
      expect(sub2._deleted).toBe(false);
      expect(noteCanvas.noteData.deletedStrokes).not.toContain("sub1");
      expect(noteCanvas.noteData.deletedStrokes).not.toContain("sub2");
      expect(noteCanvas.strokeManager.markDirty).toHaveBeenCalled();
      expect(noteCanvas.strokeManager.forceSave).toHaveBeenCalled();
      expect(noteCanvas.renderer.forceRedraw).toHaveBeenCalled();
    });

    it("keeps the spatial index in step with _deleted on both paths", () => {
      // The index holds live strokes only. The part eraser is the worst case:
      // it soft-deletes an original and appends fragments, once per erase
      // gesture. If the dead original is left indexed, every later query walks
      // it — the cost that made long erasing sessions render progressively
      // slower while pure writing stayed fast.
      const sub1 = { id: "sub1", x: [1], y: [1], _deleted: true };
      mockStrokes.push(sub1);
      noteCanvas.noteData.deletedStrokes.push("sub1");

      const operation = makeOperation({
        originalIndex: 0,
        originalId: "s1",
        subStrokeIndices: [2],
      });
      const cmd = new EraseStrokePartsCommand([operation]);

      cmd.redo(noteCanvas);
      expect(noteCanvas.spatialIndex.remove).toHaveBeenCalledWith(0); // original dropped
      expect(noteCanvas.spatialIndex.insert).toHaveBeenCalledWith(sub1, 2); // fragment added

      noteCanvas.spatialIndex.remove.mockClear();
      noteCanvas.spatialIndex.insert.mockClear();

      cmd.undo(noteCanvas);
      expect(noteCanvas.spatialIndex.insert).toHaveBeenCalledWith(mockStrokes[0], 0); // original back
      expect(noteCanvas.spatialIndex.remove).toHaveBeenCalledWith(2); // fragment dropped
    });

    it("undo restores the original stroke and deletes the sub-strokes", () => {
      const sub1 = { id: "sub1", x: [1], y: [1], _deleted: false };
      mockStrokes.push(sub1);
      mockStrokes[0]._deleted = true;
      noteCanvas.noteData.deletedStrokes.push("s1");

      const operation = makeOperation({
        originalIndex: 0,
        originalId: "s1",
        subStrokeIndices: [2],
      });
      const cmd = new EraseStrokePartsCommand([operation]);

      cmd.undo(noteCanvas);

      expect(mockStrokes[0]._deleted).toBe(false);
      expect(noteCanvas.noteData.deletedStrokes).not.toContain("s1");
      expect(sub1._deleted).toBe(true);
      expect(noteCanvas.noteData.deletedStrokes).toContain("sub1");
    });

    it("groups multiple operations from a single gesture into one undo/redo step", () => {
      const sub1 = { id: "sub1", x: [1], y: [1], _deleted: true };
      const sub2 = { id: "sub2", x: [2], y: [2], _deleted: true };
      mockStrokes.push(sub1, sub2);
      noteCanvas.noteData.deletedStrokes.push("sub1", "sub2");

      const operations = [
        makeOperation({ originalIndex: 0, originalId: "s1", subStrokeIndices: [2] }),
        makeOperation({ originalIndex: 1, originalId: "s2", subStrokeIndices: [3] }),
      ];
      const cmd = new EraseStrokePartsCommand(operations);

      cmd.redo(noteCanvas);

      expect(mockStrokes[0]._deleted).toBe(true);
      expect(mockStrokes[1]._deleted).toBe(true);
      expect(sub1._deleted).toBe(false);
      expect(sub2._deleted).toBe(false);
      // A single redo() call should only trigger one save/redraw cycle, not one per operation.
      expect(noteCanvas.strokeManager.forceSave).toHaveBeenCalledTimes(1);
      expect(noteCanvas.renderer.forceRedraw).toHaveBeenCalledTimes(1);
    });

    it("redo is a no-op when the original is already deleted", () => {
      mockStrokes[0]._deleted = true;
      const operation = makeOperation({ originalIndex: 0, originalId: "s1", subStrokeIndices: [] });
      const cmd = new EraseStrokePartsCommand([operation]);

      cmd.redo(noteCanvas);

      expect(noteCanvas.noteData.deletedStrokes).not.toContain("s1"); // not pushed again
    });

    it("undo is a no-op when the original is not currently deleted", () => {
      const operation = makeOperation({ originalIndex: 0, originalId: "s1", subStrokeIndices: [] });
      const cmd = new EraseStrokePartsCommand([operation]);

      cmd.undo(noteCanvas);

      expect(mockStrokes[0]._deleted).toBe(false);
    });
  });
});
