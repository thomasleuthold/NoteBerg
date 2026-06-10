/**
 * StrokeManager - Manages stroke data and persistence
 *
 * Handles:
 * - Current stroke construction
 * - Stroke list management
 * - Asynchronous saving (debounced)
 */

import { getEncryptionKey, isAppUnlocked } from "../../modules/masterPassword.js";
import { generateId, updateNote } from "../../modules/storage.js"; // updateNote aliases to webdav in NC build

const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

export class StrokeManager {
  constructor(noteId, initialStrokes = [], initialDeletedStrokes = []) {
    this.noteId = noteId;
    this.strokes = initialStrokes;
    this.deletedStrokes = initialDeletedStrokes;
    this.currentStroke = null;
    this.isDirty = false;

    // Initialize Web Worker (disabled in Nextcloud build — storage layer replaced in Step 5)
    if (!IS_NEXTCLOUD) {
      this.worker = new Worker(new URL("./StorageWorker.js", import.meta.url), { type: "module" });
      this.worker.onerror = (e) => {
        console.error("[StrokeManager] Worker error:", e.message, e);
      };
    }
  }

  startStroke(props) {
    this.currentStroke = {
      id: generateId(),
      x: [props.x],
      y: [props.y],
      pressure: [props.pressure],
      time: [Date.now()],
      colorIndex: props.colorIndex || 0,
      width: props.width || 2,
      pointerType: props.pointerType,
      type: props.type || "pen", // 'pen' or 'marker'
    };
    return this.currentStroke;
  }

  addPoints(points) {
    if (!this.currentStroke) return;

    for (const p of points) {
      this.currentStroke.x.push(p.x);
      this.currentStroke.y.push(p.y);
      this.currentStroke.pressure.push(p.pressure);
      this.currentStroke.time.push(p.time);
    }
    return this.currentStroke;
  }

  endStroke() {
    if (!this.currentStroke) return null;

    const stroke = { ...this.currentStroke };

    // Only add if it has enough points
    if (stroke.x.length > 0) {
      this.strokes.push(stroke);
      this.isDirty = true;
      this._save();
    }

    this.currentStroke = null;
    return stroke;
  }

  cancelCurrentStroke() {
    this.currentStroke = null;
  }

  markDirty() {
    this.isDirty = true;
  }

  _save() {
    if (!this.isDirty) return;

    // In Nextcloud build the worker is disabled. Mark dirty only — actual write happens
    // in forceSave()/destroy() to avoid blocking the main thread during drawing.
    if (IS_NEXTCLOUD) {
      return;
    }

    let key = null;
    if (isAppUnlocked()) {
      try {
        key = getEncryptionKey();
      } catch (e) {
        console.warn("[StrokeManager] Could not get encryption key:", e);
      }
    }

    // Filter out deleted strokes for storage (they are kept in memory for SpatialIndex validity)
    const activeStrokes = this.strokes.filter((s) => !s._deleted);

    // Offload to worker
    this.worker?.postMessage({
      type: "SAVE_STROKES",
      noteId: this.noteId,
      strokes: activeStrokes,
      deletedStrokes: this.deletedStrokes,
      key: key,
    });

    this.isDirty = false;
  }

  /**
   * Save media changes via the worker to ensure sequential writes
   */
  saveMedia({ media, deletedMedia, pdfSource }) {
    let key = null;
    if (isAppUnlocked()) {
      try {
        key = getEncryptionKey();
      } catch (e) {
        console.warn("[StrokeManager] Could not get encryption key:", e);
      }
    }

    this.worker?.postMessage({
      type: "SAVE_MEDIA",
      noteId: this.noteId,
      media,
      deletedMedia,
      pdfSource,
      key,
    });
  }

  /**
   * Save pen presets via the worker
   */
  savePresets(presets) {
    if (IS_NEXTCLOUD) {
      updateNote(this.noteId, { penPresets: presets }).catch((e) =>
        console.error("[StrokeManager] WebDAV presets save failed:", e),
      );
      return;
    }
    let key = null;
    if (isAppUnlocked()) {
      try {
        key = getEncryptionKey();
      } catch (e) {
        console.warn("[StrokeManager] Could not get encryption key:", e);
      }
    }
    this.worker?.postMessage({
      type: "SAVE_PRESETS",
      noteId: this.noteId,
      presets,
      key,
    });
  }

  /**
   * Save tasks via the worker
   */
  saveTasks(tasks) {
    if (!this.worker) return;

    this.worker.postMessage({
      type: "SAVE_TASKS",
      noteId: this.noteId,
      tasks,
    });
  }

  /**
   * Save recordings via the worker
   */
  saveRecordings({ recordings, deletedRecordings }) {
    if (!this.worker) return;

    let key = null;
    if (isAppUnlocked()) {
      try {
        key = getEncryptionKey();
      } catch (e) {
        console.warn("[StrokeManager] Could not get encryption key:", e);
      }
    }

    this.worker.postMessage({
      type: "SAVE_RECORDINGS",
      noteId: this.noteId,
      recordings,
      deletedRecordings,
      key,
    });
  }

  forceSave() {
    if (IS_NEXTCLOUD) {
      if (!this.isDirty) return;
      const activeStrokes = this.strokes.filter((s) => !s._deleted);
      this.isDirty = false;
      return updateNote(this.noteId, {
        strokes: activeStrokes,
        deletedStrokes: this.deletedStrokes,
      }).catch((e) => console.error("[StrokeManager] WebDAV force save failed:", e));
    }
    this._save();
  }

  destroy() {
    if (this.worker) {
      // Don't terminate immediately, as it might kill pending saves.
      // Send a close message so the worker shuts down after processing the queue.
      this.worker.postMessage({ type: "CLOSE" });
      this.worker = null;
    }
  }
}
