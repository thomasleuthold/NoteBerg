/**
 * StrokeManager - Manages stroke data and persistence
 *
 * Handles:
 * - Current stroke construction
 * - Stroke list management
 * - Asynchronous saving (debounced)
 */

import { getEncryptionKey, isAppUnlocked } from "../../modules/masterPassword.js";
// Aliased to storage.webdav.js in the NC build (see vite.config.js). On native,
// updateNoteCoalesced is a thin passthrough — strokes go via StorageWorker there.
import {
  flushNoteWrites,
  generateId,
  updateNote,
  updateNoteCoalesced,
} from "../../modules/storage.js";

const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

export class StrokeManager {
  constructor(noteId, initialStrokes = [], initialDeletedStrokes = []) {
    this.noteId = noteId;
    this.strokes = initialStrokes;
    this.deletedStrokes = initialDeletedStrokes;
    this.currentStroke = null;
    this.isDirty = false;
    // A viewer of a read-only shared notebook: nothing is ever written (the
    // storage layer would refuse it anyway; this just never asks)
    this.readOnly = false;
    // Set by the editor: stamps the user's edits of what a save writes ("strokes",
    // "media", "recordings", "penPresets") and returns the note's version bookkeeping, sent
    // with every save so storage merges by element (DESIGN §10.7)
    this.beforeSave = null;
    // What storage holds of each stroke (id -> version), as far as it confirmed:
    // a save carries only the strokes that differ (review P4, 4.9). Posting the
    // whole list on every pen lift cost about 50 ms at 5,000 strokes. A save that
    // is never confirmed leaves its strokes here as they were, so the next save
    // carries them again.
    this._stored = new Map();
    this.markStored(initialStrokes);
    this._nextSave = 0;
    this._inFlight = new Map(); // requestId -> [[id, version]] sent

    // Initialize Web Worker (disabled in Nextcloud build — storage layer replaced in Step 5)
    if (!IS_NEXTCLOUD) {
      this.worker = new Worker(new URL("./StorageWorker.js", import.meta.url), { type: "module" });
      this.worker.onerror = (e) => {
        console.error("[StrokeManager] Worker error:", e.message, e);
      };
      this.worker.addEventListener?.("message", (event) => {
        if (event?.data?.type !== "STROKES_SAVED") return;
        const sent = this._inFlight.get(event.data.requestId);
        this._inFlight.delete(event.data.requestId);
        if (sent) this._confirm(sent);
      });
    }
  }

  /** Storage holds these strokes as they are now. */
  markStored(strokes) {
    for (const stroke of strokes ?? []) {
      if (stroke?.id) this._stored.set(stroke.id, stroke.v ?? null);
    }
  }

  /** Storage lacks these strokes: the next save carries them again. */
  markUnstored(ids) {
    for (const id of ids ?? []) this._stored.delete(id);
  }

  /** Strokes changed since storage last confirmed them (no copies). */
  unconfirmedStrokes() {
    return this.strokes.filter((s) => !s._deleted && this._stored.get(s.id) !== (s.v ?? null));
  }

  /**
   * A save was stored: storage holds what it carried. A stroke changed again
   * meanwhile still differs from that, and goes with the next save. Saves are
   * confirmed in the order they were made (one worker queue, one write queue).
   */
  _confirm(sent) {
    for (const [id, v] of sent) this._stored.set(id, v);
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
    if (!this.isDirty || this.readOnly) return;

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

    const versionFields = this.beforeSave?.("strokes");
    // Only what storage does not hold yet (the worker merges it with the rest);
    // deleted strokes stay in memory for SpatialIndex validity and go as ids
    const changed = this.unconfirmedStrokes();
    const requestId = ++this._nextSave;
    this._inFlight.set(
      requestId,
      changed.map((s) => [s.id, s.v ?? null]),
    );

    // Offload to worker
    this.worker?.postMessage({
      type: "SAVE_STROKES",
      noteId: this.noteId,
      strokes: changed,
      deletedStrokes: this.deletedStrokes,
      requestId,
      versionFields,
      key: key,
    });

    this.isDirty = false;
  }

  /**
   * Save media changes via the worker to ensure sequential writes
   */
  saveMedia({ media, deletedMedia, pdfSource }) {
    if (this.readOnly) return;
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
      versionFields: this.beforeSave?.("media"),
      key,
    });
  }

  /**
   * Save pen presets via the worker
   */
  savePresets(presets) {
    if (this.readOnly) return;
    const versionFields = this.beforeSave?.("penPresets");
    if (IS_NEXTCLOUD) {
      updateNote(this.noteId, { penPresets: presets, ...versionFields }).catch((e) =>
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
      versionFields,
      key,
    });
  }

  /**
   * Save recordings via the worker
   */
  saveRecordings({ recordings, deletedRecordings }) {
    if (!this.worker || this.readOnly) return;

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
      versionFields: this.beforeSave?.("recordings"),
      key,
    });
  }

  forceSave() {
    if (this.readOnly) return Promise.resolve();
    if (IS_NEXTCLOUD) {
      // Not dirty still needs a flush: the newest snapshot may be in flight (or
      // queued) from an earlier stroke, and destroy() must await it or the last
      // strokes drawn are lost on close.
      // Caught for the same reason as the dirty path below: destroy() feeds this
      // into a Promise.all, and a rejection there would abort the close sequence
      // in index.js before it dispatches datachange and runs syncOnNoteClose.
      if (!this.isDirty) {
        return flushNoteWrites(this.noteId).catch((e) =>
          console.error("[StrokeManager] WebDAV flush failed:", e),
        );
      }
      const versionFields = this.beforeSave?.("strokes");
      // Every stroke the server has not confirmed yet: a newer snapshot holds all
      // an older one did (nothing is confirmed before it is written), so the
      // coalescing writer may still replace a snapshot that has not started.
      // The writer merges them with the strokes on the server (strokesPartial).
      const changed = this.unconfirmedStrokes();
      const sent = changed.map((s) => [s.id, s.v ?? null]);
      this.isDirty = false;
      return updateNoteCoalesced(this.noteId, {
        strokes: changed,
        strokesPartial: true,
        deletedStrokes: this.deletedStrokes,
        ...versionFields,
      }).then(
        () => this._confirm(sent),
        (e) => console.error("[StrokeManager] WebDAV force save failed:", e),
      );
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
