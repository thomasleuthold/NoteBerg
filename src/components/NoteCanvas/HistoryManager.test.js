import { describe, expect, it, vi } from "vitest";
import { HistoryManager } from "./HistoryManager.js";

// Mock command class
const createMockCommand = () => ({
  undo: vi.fn(),
  redo: vi.fn(),
  cleanup: vi.fn(),
});

describe("HistoryManager", () => {
  it("should initialize with empty stacks", () => {
    const historyManager = new HistoryManager();
    expect(historyManager.canUndo()).toBe(false);
    expect(historyManager.canRedo()).toBe(false);
    expect(historyManager.getState()).toEqual({
      undoCount: 0,
      redoCount: 0,
      canUndo: false,
      canRedo: false,
    });
  });

  it("should push a command to the undo stack", () => {
    const historyManager = new HistoryManager();
    const command = createMockCommand();
    historyManager.push(command);

    expect(historyManager.canUndo()).toBe(true);
    expect(historyManager.undoStack).toHaveLength(1);
    expect(historyManager.undoStack[0]).toBe(command);
  });

  it("should not push a null command", () => {
    const historyManager = new HistoryManager();
    historyManager.push(null);
    expect(historyManager.canUndo()).toBe(false);
  });

  it("should call onStateChange when state changes", () => {
    const onStateChange = vi.fn();
    const historyManager = new HistoryManager({ onStateChange });

    // Push
    historyManager.push(createMockCommand());
    expect(onStateChange).toHaveBeenCalledWith({ canUndo: true, canRedo: false });

    // Undo
    historyManager.undo();
    expect(onStateChange).toHaveBeenCalledWith({ canUndo: false, canRedo: true });

    // Redo
    historyManager.redo();
    expect(onStateChange).toHaveBeenCalledWith({ canUndo: true, canRedo: false });

    // Clear
    historyManager.clear();
    expect(onStateChange).toHaveBeenCalledWith({ canUndo: false, canRedo: false });
  });

  it("should clear the redo stack when a new command is pushed", () => {
    const historyManager = new HistoryManager();
    historyManager.push(createMockCommand());
    historyManager.undo();
    expect(historyManager.canRedo()).toBe(true);

    historyManager.push(createMockCommand());
    expect(historyManager.canRedo()).toBe(false);
    expect(historyManager.redoStack).toHaveLength(0);
  });

  it("should enforce max history limit", () => {
    const historyManager = new HistoryManager({ maxHistory: 2 });
    const cmd1 = createMockCommand();
    const cmd2 = createMockCommand();
    const cmd3 = createMockCommand();

    historyManager.push(cmd1);
    historyManager.push(cmd2);
    historyManager.push(cmd3);

    expect(historyManager.undoStack).toHaveLength(2);
    expect(historyManager.undoStack[0]).toBe(cmd2);
    expect(historyManager.undoStack[1]).toBe(cmd3);
    expect(cmd1.cleanup).toHaveBeenCalled();
  });

  describe("undo", () => {
    it("should not undo if the stack is empty", () => {
      const historyManager = new HistoryManager();
      const result = historyManager.undo();
      expect(result).toBe(false);
    });

    it("should move command from undo to redo stack and call its undo method", () => {
      const historyManager = new HistoryManager();
      const command = createMockCommand();
      const noteCanvasMock = {};
      historyManager.setNoteCanvas(noteCanvasMock);
      historyManager.push(command);

      const result = historyManager.undo();

      expect(result).toBe(true);
      expect(historyManager.canUndo()).toBe(false);
      expect(historyManager.canRedo()).toBe(true);
      expect(historyManager.redoStack[0]).toBe(command);
      expect(command.undo).toHaveBeenCalledWith(noteCanvasMock);
    });

    it("should not undo if NoteCanvas is actively drawing", () => {
      const historyManager = new HistoryManager();
      const command = createMockCommand();
      const noteCanvasMock = { inputHandler: { isDrawing: true } };
      historyManager.setNoteCanvas(noteCanvasMock);
      historyManager.push(command);

      const result = historyManager.undo();

      expect(result).toBe(false);
      expect(historyManager.canUndo()).toBe(true);
      expect(command.undo).not.toHaveBeenCalled();
    });

    it("should handle error during command undo and restore state", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const historyManager = new HistoryManager();
      const command = createMockCommand();
      command.undo.mockImplementation(() => {
        throw new Error("Undo failed");
      });
      historyManager.push(command);

      const result = historyManager.undo();

      expect(result).toBe(false);
      expect(historyManager.canUndo()).toBe(true);
      expect(historyManager.canRedo()).toBe(false);
      expect(historyManager.undoStack[0]).toBe(command);
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe("redo", () => {
    it("should not redo if the stack is empty", () => {
      const historyManager = new HistoryManager();
      const result = historyManager.redo();
      expect(result).toBe(false);
    });

    it("should move command from redo to undo stack and call its redo method", () => {
      const historyManager = new HistoryManager();
      const command = createMockCommand();
      const noteCanvasMock = {};
      historyManager.setNoteCanvas(noteCanvasMock);
      historyManager.push(command);
      historyManager.undo();

      const result = historyManager.redo();

      expect(result).toBe(true);
      expect(historyManager.canUndo()).toBe(true);
      expect(historyManager.canRedo()).toBe(false);
      expect(historyManager.undoStack[0]).toBe(command);
      expect(command.redo).toHaveBeenCalledWith(noteCanvasMock);
    });

    it("should not redo if NoteCanvas is actively drawing", () => {
      const historyManager = new HistoryManager();
      const command = createMockCommand();
      const noteCanvasMock = { inputHandler: { isDrawing: false } }; // Initially false
      historyManager.setNoteCanvas(noteCanvasMock);
      historyManager.push(command);
      historyManager.undo(); // This should succeed

      // Now, set isDrawing to true and try to redo
      noteCanvasMock.inputHandler.isDrawing = true;
      const result = historyManager.redo();

      expect(result).toBe(false);
      expect(historyManager.canRedo()).toBe(true);
      expect(command.redo).not.toHaveBeenCalled();
    });

    it("should handle error during command redo and restore state", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const historyManager = new HistoryManager();
      const command = createMockCommand();
      command.redo.mockImplementation(() => {
        throw new Error("Redo failed");
      });
      historyManager.push(command);
      historyManager.undo();

      const result = historyManager.redo();

      expect(result).toBe(false);
      expect(historyManager.canUndo()).toBe(false);
      expect(historyManager.canRedo()).toBe(true);
      expect(historyManager.redoStack[0]).toBe(command);
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe("clear", () => {
    it("should clear both undo and redo stacks", () => {
      const historyManager = new HistoryManager();
      historyManager.push(createMockCommand());
      historyManager.undo();
      expect(historyManager.canUndo()).toBe(false);
      expect(historyManager.canRedo()).toBe(true);

      historyManager.clear();

      expect(historyManager.canUndo()).toBe(false);
      expect(historyManager.canRedo()).toBe(false);
    });

    it("should call cleanup on all commands in both stacks", () => {
      const historyManager = new HistoryManager();
      const cmd1 = createMockCommand();
      const cmd2 = createMockCommand();

      historyManager.push(cmd1);
      historyManager.push(cmd2);
      historyManager.undo();

      historyManager.clear();

      expect(cmd1.cleanup).toHaveBeenCalled();
      expect(cmd2.cleanup).toHaveBeenCalled();
    });
  });

  describe("destroy", () => {
    it("should clear history and nullify references", () => {
      const historyManager = new HistoryManager();
      const onStateChange = vi.fn();
      historyManager.onStateChange = onStateChange;
      historyManager.setNoteCanvas({});
      historyManager.push(createMockCommand());

      historyManager.destroy();

      expect(historyManager.canUndo()).toBe(false);
      expect(historyManager.canRedo()).toBe(false);
      expect(historyManager.noteCanvas).toBeNull();
      expect(historyManager.onStateChange).toBeNull();
      // destroy calls clear, which calls onStateChange one last time
      expect(onStateChange).toHaveBeenCalledWith({ canUndo: false, canRedo: false });
    });
  });
});
