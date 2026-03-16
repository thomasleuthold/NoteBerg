/**
 * RecordingManager - Manages audio recordings for a note.
 *
 * Handles the MediaRecorder lifecycle (start/pause/resume/stop),
 * persists completed recordings as WebM/Opus blobs in the IndexedDB "files" store,
 * and maintains the in-memory recordings array for the current note.
 *
 * Usage:
 *   const rm = new RecordingManager({ onChange, onSave });
 *   rm.setRecordings(note.recordings ?? []);
 *   await rm.startRecording();
 *   rm.stopRecording();
 *   rm.destroy();
 */

import { generateId, saveFile } from "../../modules/storage.js";

export class RecordingManager {
  /**
   * @param {Object} options
   * @param {Function} options.onChange - Called whenever the recordings list changes
   * @param {Function} options.onSave - Called with ({ recordings, deletedRecordings }) to persist
   */
  constructor(options = {}) {
    this.onChange = options.onChange || (() => {});
    this.onSave = options.onSave || (() => {});

    /** @type {Array<{id:string, fileId:string, name:string, duration:number, created:number, deleted:boolean}>} */
    this.recordings = [];
    /** @type {string[]} */
    this.deletedRecordings = [];

    // Active recording state
    this._mediaRecorder = null;
    this._audioChunks = [];
    this._stream = null;
    this._recordingId = null;
    this._recordingStartTime = null;
    this._pausedDuration = 0;
    this._pauseStart = null;
    this._timerInterval = null;

    // Playback state
    this._playingId = null;
    this._audioElement = null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setRecordings(items) {
    this.recordings = Array.isArray(items) ? [...items] : [];
    this.deletedRecordings = [];
  }

  getRecordings() {
    return this.recordings.filter((r) => !r.deleted);
  }

  isRecording() {
    return (
      this._mediaRecorder !== null &&
      (this._mediaRecorder.state === "recording" || this._mediaRecorder.state === "paused")
    );
  }

  isPaused() {
    return this._mediaRecorder !== null && this._mediaRecorder.state === "paused";
  }

  /** Returns elapsed seconds of the active recording */
  getElapsed() {
    if (!this._recordingStartTime) return 0;
    const paused = this._pausedDuration + (this._pauseStart ? Date.now() - this._pauseStart : 0);
    return Math.floor((Date.now() - this._recordingStartTime - paused) / 1000);
  }

  /**
   * Request mic permission and start recording.
   * @returns {Promise<void>}
   */
  async startRecording() {
    if (this.isRecording()) return;

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      console.error("[RecordingManager] Mic permission denied:", err);
      throw err;
    }

    this._audioChunks = [];
    this._recordingId = generateId();
    this._recordingStartTime = Date.now();
    this._pausedDuration = 0;
    this._pauseStart = null;

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    this._mediaRecorder = new MediaRecorder(this._stream, { mimeType });

    this._mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this._audioChunks.push(e.data);
      }
    };

    this._mediaRecorder.onstop = () => {
      this._handleRecordingStopped();
    };

    this._mediaRecorder.start(1000); // collect chunks every second

    this._startTimer();
    this.onChange();
  }

  pauseRecording() {
    if (!this._mediaRecorder || this._mediaRecorder.state !== "recording") return;
    this._mediaRecorder.pause();
    this._pauseStart = Date.now();
    this._stopTimer();
    this.onChange();
  }

  resumeRecording() {
    if (!this._mediaRecorder || this._mediaRecorder.state !== "paused") return;
    if (this._pauseStart) {
      this._pausedDuration += Date.now() - this._pauseStart;
      this._pauseStart = null;
    }
    this._mediaRecorder.resume();
    this._startTimer();
    this.onChange();
  }

  stopRecording() {
    if (!this._mediaRecorder) return;
    if (this._mediaRecorder.state !== "inactive") {
      this._mediaRecorder.stop();
    }
    this._stopTimer();
    this._releaseStream();
  }

  /**
   * Soft-delete a finished recording.
   * @param {string} id
   */
  deleteRecording(id) {
    const rec = this.recordings.find((r) => r.id === id);
    if (!rec) return;

    rec.deleted = true;
    if (rec.fileId) {
      this.deletedRecordings = [...this.deletedRecordings, rec.fileId];
    }

    this._persist();
    this.onChange();
  }

  /**
   * Start or stop playback of a recording.
   * @param {string} id
   * @param {Blob} blob
   */
  playRecording(id, blob) {
    if (this._playingId === id) {
      // Toggle: stop current playback
      this._stopPlayback();
      return;
    }
    this._stopPlayback();

    const url = URL.createObjectURL(blob);
    this._audioElement = new Audio(url);
    this._audioElement.onended = () => {
      URL.revokeObjectURL(url);
      this._playingId = null;
      this._audioElement = null;
      this.onChange();
    };
    this._audioElement.play();
    this._playingId = id;
    this.onChange();
  }

  stopPlayback(id) {
    if (this._playingId === id) {
      this._stopPlayback();
    }
  }

  isPlaying(id) {
    return this._playingId === id;
  }

  destroy() {
    this._stopPlayback();
    this._stopTimer();
    if (this._mediaRecorder && this._mediaRecorder.state !== "inactive") {
      // Don't save — just discard
      this._mediaRecorder.ondataavailable = null;
      this._mediaRecorder.onstop = null;
      this._mediaRecorder.stop();
    }
    this._mediaRecorder = null;
    this._releaseStream();
    this._audioChunks = [];
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  async _handleRecordingStopped() {
    const chunks = this._audioChunks;
    const id = this._recordingId;
    const duration = this.getElapsed();

    this._mediaRecorder = null;
    this._audioChunks = [];
    this._recordingId = null;
    this._recordingStartTime = null;
    this._pausedDuration = 0;
    this._pauseStart = null;

    if (chunks.length === 0) {
      this.onChange();
      return;
    }

    const blob = new Blob(chunks, { type: "audio/webm" });

    let fileId;
    try {
      fileId = await saveFile(blob);
    } catch (err) {
      console.error("[RecordingManager] Failed to save recording:", err);
      this.onChange();
      return;
    }

    const now = Date.now();
    const name = this._formatRecordingName(now);

    const recording = {
      id,
      fileId,
      name,
      duration,
      created: now,
      deleted: false,
    };

    this.recordings = [...this.recordings, recording];
    this._persist();
    this.onChange();
  }

  _persist() {
    this.onSave({
      recordings: this.recordings,
      deletedRecordings: this.deletedRecordings,
    });
  }

  _startTimer() {
    this._stopTimer();
    this._timerInterval = setInterval(() => {
      this.onChange();
    }, 1000);
  }

  _stopTimer() {
    if (this._timerInterval) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
    }
  }

  _releaseStream() {
    if (this._stream) {
      for (const track of this._stream.getTracks()) {
        track.stop();
      }
      this._stream = null;
    }
  }

  _stopPlayback() {
    if (this._audioElement) {
      this._audioElement.pause();
      this._audioElement.onended = null;
      this._audioElement = null;
    }
    this._playingId = null;
  }

  _formatRecordingName(timestamp) {
    const d = new Date(timestamp);
    const pad = (n) => String(n).padStart(2, "0");
    return `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}
