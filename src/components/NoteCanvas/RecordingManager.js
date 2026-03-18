/**
 * RecordingManager - Manages audio recordings for a note.
 *
 * Uses getUserMedia({ audio: true }) to record from the microphone.
 *
 * Usage:
 *   const rm = new RecordingManager({ onChange, onSave });
 *   rm.setRecordings(note.recordings ?? []);
 *   await rm.startRecording();
 *   rm.pauseRecording();
 *   rm.resumeRecording();
 *   rm.stopRecording();
 *   rm.destroy();
 */

import { generateId, saveFile } from "../../modules/storage.js";
import { invoke } from "@tauri-apps/api/core";

/** True when running inside Tauri on Android */
const IS_ANDROID = typeof window.__TAURI_INTERNALS__ !== "undefined" &&
  /android/i.test(navigator.userAgent);

export class RecordingManager {
  /**
   * @param {Object} options
   * @param {Function} options.onChange - Called whenever recordings list or state changes
   * @param {Function} options.onSave   - Called with ({ recordings, deletedRecordings }) to persist
   */
  constructor(options = {}) {
    this.onChange = options.onChange || (() => {});
    this.onSave = options.onSave || (() => {});

    /** @type {Array<{id:string, fileId:string, name:string, duration:number, created:number, deleted:boolean}>} */
    this.recordings = [];
    /** @type {string[]} */
    this.deletedRecordings = [];

    this._mediaRecorder = null;
    this._audioChunks = [];
    this._stream = null;
    this._nativeRecording = false;

    this._recordingId = null;
    this._recordingStartTime = null;
    this._pausedDuration = 0;
    this._pauseStart = null;
    this._timerInterval = null;

    this._audioContext = null;
    this._analyser = null;
    this._analyserBuffer = null;

    this._playingId = null;
    this._audioElement = null;
    this._playbackTimerInterval = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  setRecordings(items) {
    this.recordings = Array.isArray(items) ? [...items] : [];
    this.deletedRecordings = [];
  }

  getRecordings() {
    return this.recordings.filter((r) => !r.deleted);
  }

  isRecording() {
    if (this._nativeRecording) return true;
    return (
      this._mediaRecorder !== null &&
      (this._mediaRecorder.state === "recording" || this._mediaRecorder.state === "paused")
    );
  }

  isPaused() {
    return this._mediaRecorder !== null && this._mediaRecorder.state === "paused";
  }

  /** Returns current input amplitude as 0–1, or 0 if not recording */
  getAmplitude() {
    if (!this._analyser || !this._analyserBuffer) return 0;
    this._analyser.getByteTimeDomainData(this._analyserBuffer);
    let max = 0;
    for (const v of this._analyserBuffer) {
      const deviation = Math.abs(v - 128) / 128;
      if (deviation > max) max = deviation;
    }
    return max;
  }

  /** Returns elapsed seconds of the active recording */
  getElapsed() {
    if (!this._recordingStartTime) return 0;
    const paused = this._pausedDuration + (this._pauseStart ? Date.now() - this._pauseStart : 0);
    return Math.floor((Date.now() - this._recordingStartTime - paused) / 1000);
  }

  /**
   * Start recording from microphone.
   * On Android uses native MediaRecorder via Tauri plugin (bypasses WebView getUserMedia).
   * @returns {Promise<void>}
   */
  async startRecording() {
    if (this.isRecording()) return;

    this._recordingId = generateId();
    this._recordingStartTime = Date.now();
    this._pausedDuration = 0;
    this._pauseStart = null;

    if (IS_ANDROID) {
      try {
        await invoke("native_audio_start");
      } catch (err) {
        this._recordingId = null;
        this._recordingStartTime = null;
        console.error("[RecordingManager] Native audio start error:", err);
        throw new Error(String(err));
      }
      this._nativeRecording = true;
      this._startTimer();
      this.onChange();
      return;
    }

    try {
      this._stream = await this._getUserMediaWithRetry();
    } catch (err) {
      this._recordingId = null;
      this._recordingStartTime = null;
      console.error("[RecordingManager] Stream error:", err.name, err.message);
      throw err;
    }

    // Set up amplitude analyser — deferred so MediaRecorder gets the stream first
    setTimeout(() => {
      try {
        this._audioContext = new AudioContext();
        this._analyser = this._audioContext.createAnalyser();
        this._analyser.fftSize = 256;
        this._analyserBuffer = new Uint8Array(this._analyser.frequencyBinCount);
        this._audioContext.createMediaStreamSource(this._stream).connect(this._analyser);
      } catch (_e) {
        this._analyser = null;
      }
    }, 500);

    this._audioChunks = [];

    const preferredTypes = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
      "audio/ogg",
    ];
    const mimeType = preferredTypes.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";

    this._mediaRecorder = new MediaRecorder(this._stream, mimeType ? { mimeType } : {});

    this._mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this._audioChunks.push(e.data);
      }
    };

    this._mediaRecorder.onstop = () => {
      this._handleRecordingStopped();
    };

    // Stop recording if the user ends the screen share via the browser UI
    this._stream.getTracks().forEach((track) => {
      track.onended = () => {
        if (this.isRecording()) {
          this._stopTimer();
          this._mediaRecorder?.stop();
        }
      };
    });

    this._mediaRecorder.start(1000);
    this._startTimer();
    this.onChange();
  }

  pauseRecording() {
    if (!this.isRecording() || this.isPaused() || this._nativeRecording) return;
    this._pauseStart = Date.now();
    this._stopTimer();
    this._mediaRecorder.pause();
    this.onChange();
  }

  resumeRecording() {
    if (!this.isPaused() || this._nativeRecording) return;
    if (this._pauseStart) {
      this._pausedDuration += Date.now() - this._pauseStart;
      this._pauseStart = null;
    }
    this._startTimer();
    this._mediaRecorder.resume();
    this.onChange();
  }

  stopRecording() {
    if (!this.isRecording()) return;
    this._stopTimer();
    if (this._nativeRecording) {
      this._nativeRecording = false;
      invoke("native_audio_stop").then((result) => {
        this._handleNativeStopped(result);
      }).catch((err) => {
        console.error("[RecordingManager] Native audio stop error:", err);
        this._recordingId = null;
        this._recordingStartTime = null;
        this.onChange();
      });
      this.onChange();
      return;
    }
    this._mediaRecorder.stop();
    this._releaseStream();
  }

  /** Soft-delete a finished recording. */
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
   * Toggle playback of a recording blob.
   * @param {string} id
   * @param {Blob} blob
   */
  playRecording(id, blob) {
    if (this._playingId === id) {
      this._stopPlayback();
      this.onChange();
      return;
    }
    this._stopPlayback();
    const url = URL.createObjectURL(blob);
    this._audioElement = new Audio(url);
    this._audioElement.onended = () => {
      this._stopPlayback();
      this.onChange();
    };
    this._audioElement.play();
    this._playingId = id;
    this._playbackTimerInterval = setInterval(() => this.onChange(), 250);
    this.onChange();
  }

  stopPlayback(id) {
    if (this._playingId === id) {
      this._stopPlayback();
      this.onChange();
    }
  }

  isPlaying(id) {
    return this._playingId === id;
  }

  /** Returns current playback position in seconds, or 0 */
  getPlaybackPosition() {
    return this._audioElement ? this._audioElement.currentTime : 0;
  }

  /** Returns playback duration in seconds, or 0 */
  getPlaybackDuration() {
    return this._audioElement ? (this._audioElement.duration || 0) : 0;
  }

  destroy() {
    this._stopPlayback(); // also calls _stopPlaybackTimer
    this._stopTimer();
    if (this._nativeRecording) {
      this._nativeRecording = false;
      invoke("native_audio_cancel").catch(() => {});
    }
    if (this._mediaRecorder && this._mediaRecorder.state !== "inactive") {
      this._mediaRecorder.ondataavailable = null;
      this._mediaRecorder.onstop = null;
      this._mediaRecorder.stop();
    }
    this._mediaRecorder = null;
    this._releaseStream();
    this._audioChunks = [];
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  async _handleNativeStopped(result) {
    const id = this._recordingId;
    const duration = this.getElapsed();
    this._recordingId = null;
    this._recordingStartTime = null;
    this._pausedDuration = 0;
    this._pauseStart = null;

    if (!result?.data) {
      this.onChange();
      return;
    }

    // Convert base64 audio/mp4 to Blob
    const byteChars = atob(result.data);
    const byteArr = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
    const blob = new Blob([byteArr], { type: result.mimeType ?? "audio/mp4" });

    await this._saveCompletedRecording(id, blob, duration);
  }

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
    await this._saveCompletedRecording(id, blob, duration);
  }

  async _saveCompletedRecording(id, blob, duration) {
    let fileId;
    try {
      fileId = await saveFile(blob);
    } catch (err) {
      console.error("[RecordingManager] Failed to save recording:", err);
      this.onChange();
      return;
    }

    const now = Date.now();
    const recording = {
      id,
      fileId,
      name: this._formatRecordingName(now),
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
    this._timerInterval = setInterval(() => this.onChange(), 1000);
  }

  _stopTimer() {
    if (this._timerInterval) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
    }
  }

  _releaseStream() {
    if (this._stream) {
      for (const track of this._stream.getTracks()) track.stop();
      this._stream = null;
    }
    if (this._audioContext) {
      this._audioContext.close();
      this._audioContext = null;
      this._analyser = null;
      this._analyserBuffer = null;
    }
  }

  async _getUserMediaWithRetry() {
    const constraintsEnhanced = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    };
    const constraintsBasic = { audio: true, video: false };

    try {
      return await navigator.mediaDevices.getUserMedia(constraintsEnhanced);
    } catch (err) {
      if (err.name === "NotReadableError" || err.name === "OverconstrainedError") {
        // Android often can't satisfy enhanced audio constraints — fall back to bare audio
        await new Promise((r) => setTimeout(r, 500));
        return await navigator.mediaDevices.getUserMedia(constraintsBasic);
      }
      throw err;
    }
  }

  _stopPlaybackTimer() {
    if (this._playbackTimerInterval) {
      clearInterval(this._playbackTimerInterval);
      this._playbackTimerInterval = null;
    }
  }

  _stopPlayback() {
    if (this._audioElement) {
      this._audioElement.pause();
      this._audioElement.onended = null;
      URL.revokeObjectURL(this._audioElement.src);
      this._audioElement = null;
    }
    this._playingId = null;
    this._stopPlaybackTimer();
  }

  _formatRecordingName(timestamp) {
    const d = new Date(timestamp);
    const pad = (n) => String(n).padStart(2, "0");
    return `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}
