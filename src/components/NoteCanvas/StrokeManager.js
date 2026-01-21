/**
 * StrokeManager - Manages stroke data and persistence
 *
 * Handles:
 * - Current stroke construction
 * - Stroke list management
 * - Asynchronous saving (debounced)
 */

import { generateId } from "../../modules/storage.js";

export class StrokeManager {
  constructor(noteId, initialStrokes = []) {
    this.noteId = noteId;
    this.strokes = initialStrokes;
    this.currentStroke = null;

    // Initialize Web Worker
    this.worker = new Worker(new URL("./StorageWorker.js", import.meta.url), { type: "module" });
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
      this._save();
    }

    this.currentStroke = null;
    return stroke;
  }

  _save() {
    // Offload to worker
    this.worker.postMessage({
      type: "SAVE_STROKES",
      noteId: this.noteId,
      strokes: this.strokes,
    });
  }

  destroy() {
    if (this.worker) {
      this.worker.terminate();
    }
  }
}
