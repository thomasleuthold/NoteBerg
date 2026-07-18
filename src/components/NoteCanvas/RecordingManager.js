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

let _invoke = null;
async function _getInvoke() {
  if (!_invoke) ({ invoke: _invoke } = await import("@tauri-apps/api/core"));
  return _invoke;
}
function _fireAndForget(cmd, args) {
  _getInvoke()
    .then((inv) => inv(cmd, args))
    .catch((err) => console.error(`[RecordingManager] ${cmd} error:`, err));
}

/** True when running inside any Tauri environment (desktop or mobile) */
const IS_NATIVE = typeof window.__TAURI_INTERNALS__ !== "undefined";

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
    this._nativePaused = false;

    this._recordingId = null;
    this._recordingStartTime = null;
    this._pausedDuration = 0;
    this._pauseStart = null;
    this._timerInterval = null;

    this._audioContext = null;
    this._analyser = null;
    this._analyserBuffer = null;

    this._nativeAmplitude = 0;
    this._amplitudePollInterval = null;
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
    if (this._nativeRecording) return this._nativePaused;
    return this._mediaRecorder !== null && this._mediaRecorder.state === "paused";
  }

  /** Returns current input amplitude as 0–1, or 0 if not recording */
  getAmplitude() {
    if (this._nativeRecording) return this._nativeAmplitude;
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

    if (IS_NATIVE) {
      try {
        await (await _getInvoke())("native_audio_start");
      } catch (err) {
        this._recordingId = null;
        this._recordingStartTime = null;
        console.error("[RecordingManager] Native audio start error:", err);
        // The native plugin reports a denied microphone permission via a
        // recognizable message. Surface it as NotAllowedError so the UI shows
        // the actionable "permission denied" message instead of a generic one.
        const message = String(err);
        const error = new Error(message);
        if (/permission denied|permission not granted/i.test(message)) {
          error.name = "NotAllowedError";
        }
        throw error;
      }
      this._nativeRecording = true;
      this._nativeAmplitude = 0;
      this._startAmplitudePoll();
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

    this._audioChunks = [];

    // Build audio processing chain: source → compressor → gain → analyser → destination
    // The processed stream is fed to MediaRecorder so recordings are auto-gained.
    let recordingStream = this._stream;
    try {
      this._audioContext = new AudioContext();
      const source = this._audioContext.createMediaStreamSource(this._stream);

      // Dynamics compressor: gentle upward compression for quiet passages
      const compressor = this._audioContext.createDynamicsCompressor();
      compressor.threshold.value = -18; // dB
      compressor.knee.value = 12; // dB — soft knee
      compressor.ratio.value = 3; // gentle ratio
      compressor.attack.value = 0.05; // seconds
      compressor.release.value = 0.3; // seconds

      // Modest make-up gain
      const gain = this._audioContext.createGain();
      gain.gain.value = 1.1;

      // Hard limiter at the end of the chain to prevent clipping on loud sounds
      const limiter = this._audioContext.createDynamicsCompressor();
      limiter.threshold.value = -1; // dB — kick in just below 0 dBFS
      limiter.knee.value = 0; // hard knee
      limiter.ratio.value = 20; // near-brick-wall limiting
      limiter.attack.value = 0.001; // seconds — fast to catch transients
      limiter.release.value = 0.1; // seconds

      // Analyser for the level meter
      this._analyser = this._audioContext.createAnalyser();
      this._analyser.fftSize = 256;
      this._analyserBuffer = new Uint8Array(this._analyser.frequencyBinCount);

      const destination = this._audioContext.createMediaStreamDestination();

      source.connect(compressor);
      compressor.connect(gain);
      gain.connect(limiter);
      limiter.connect(this._analyser);
      this._analyser.connect(destination);

      recordingStream = destination.stream;
    } catch (_e) {
      this._analyser = null;
    }

    const preferredTypes = [
      "audio/mp4",
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
    ];
    const mimeType = preferredTypes.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";

    this._mediaRecorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : {});
    this._mimeType = this._mediaRecorder.mimeType || mimeType || "audio/webm";

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
    if (!this.isRecording() || this.isPaused()) return;
    this._pauseStart = Date.now();
    this._stopTimer();
    if (this._nativeRecording) {
      this._nativePaused = true;
      this._stopAmplitudePoll();
      this._nativeAmplitude = 0;
      _fireAndForget("native_audio_pause");
    } else {
      this._mediaRecorder.pause();
    }
    this.onChange();
  }

  resumeRecording() {
    if (!this.isPaused()) return;
    if (this._pauseStart) {
      this._pausedDuration += Date.now() - this._pauseStart;
      this._pauseStart = null;
    }
    this._startTimer();
    if (this._nativeRecording) {
      this._nativePaused = false;
      this._startAmplitudePoll();
      _fireAndForget("native_audio_resume");
    } else {
      this._mediaRecorder.resume();
    }
    this.onChange();
  }

  stopRecording() {
    if (!this.isRecording()) return;
    this._stopTimer();
    if (this._nativeRecording) {
      this._nativeRecording = false;
      this._nativePaused = false;
      this._stopAmplitudePoll();
      _getInvoke()
        .then((inv) => inv("native_audio_stop"))
        .then((result) => {
          this._handleNativeStopped(result);
        })
        .catch((err) => {
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

  /** Import an external audio file as a new recording. */
  async importFile(file, duration) {
    const id = generateId();
    await this._saveCompletedRecording(id, file, Math.round(duration ?? 0));
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

  destroy() {
    this._stopTimer();
    if (this._nativeRecording) {
      this._nativeRecording = false;
      this._nativePaused = false;
      this._stopAmplitudePoll();
      _getInvoke()
        .then((inv) => inv("native_audio_cancel"))
        .catch(() => {});
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

    if (!result?.path) {
      this.onChange();
      return;
    }

    // Read file on Rust's native heap (avoids Android JVM heap OOM for large files)
    let blob;
    try {
      const base64 = await (await _getInvoke())("native_audio_read_and_delete", {
        path: result.path,
      });
      const mimeType = result.mimeType ?? "audio/mp4";
      const byteChars = atob(base64);
      const byteArr = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
      blob = new Blob([byteArr], { type: mimeType });
    } catch (err) {
      console.error("[RecordingManager] Failed to read native recording file:", err);
      this.onChange();
      return;
    }

    await this._saveCompletedRecording(id, blob, duration);
  }

  async _handleRecordingStopped() {
    const chunks = this._audioChunks;
    const id = this._recordingId;
    const duration = this.getElapsed();
    const mimeType = this._mimeType || "audio/webm";

    this._mediaRecorder = null;
    this._audioChunks = [];
    this._mimeType = null;
    this._recordingId = null;
    this._recordingStartTime = null;
    this._pausedDuration = 0;
    this._pauseStart = null;

    if (chunks.length === 0) {
      this.onChange();
      return;
    }

    const blob = new Blob(chunks, { type: mimeType });
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

  _startAmplitudePoll() {
    this._stopAmplitudePoll();
    this._amplitudePollInterval = setInterval(async () => {
      try {
        const result = await (await _getInvoke())("native_audio_get_amplitude");
        this._nativeAmplitude = result?.amplitude ?? 0;
      } catch (_e) {
        // ignore — recording may have just stopped
      }
    }, 100);
  }

  _stopAmplitudePoll() {
    if (this._amplitudePollInterval) {
      clearInterval(this._amplitudePollInterval);
      this._amplitudePollInterval = null;
    }
    this._nativeAmplitude = 0;
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

  _formatRecordingName(timestamp) {
    const d = new Date(timestamp);
    const pad = (n) => String(n).padStart(2, "0");
    return `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}
