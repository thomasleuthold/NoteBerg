/**
 * RecordingManager - Manages audio recordings for a note.
 *
 * Records through the native recorder behind the Tauri `native_audio_*`
 * commands: `win_audio` (cpal/WASAPI capture → DSP → AAC via Media Foundation,
 * falling back to WAV) on Windows, and `AudioRecorderPlugin.kt` on Android
 * (AudioRecord → DSP → MediaCodec/MediaMuxer, falling back to MediaRecorder).
 * There is no browser recording path — the Nextcloud build, the only one
 * without Tauri, never renders the "New recording" button, so `getUserMedia`
 * was unreachable on every shipped build.
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

import { getAutoGainAggressiveness } from "../../modules/audioSettings.js";
import { generateId, saveFile } from "../../modules/storage.js";
import { logger } from "../../utils/logger.js";

let _invoke = null;
async function _getInvoke() {
  if (!_invoke) ({ invoke: _invoke } = await import("@tauri-apps/api/core"));
  return _invoke;
}
/**
 * Bytes per native_audio_read_chunk call. Small enough that peak JS memory is
 * one chunk even for a multi-hour recording, large enough that the per-call IPC
 * overhead stays negligible (a 2 h stereo WAV is ~350 calls).
 */
const NATIVE_READ_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * How long destroy() waits for a stop-and-save before giving up and letting the
 * note close anyway. Generous, because the save includes reading a potentially
 * large file across IPC; a hung native stop must not block navigation forever.
 */
const DESTROY_SAVE_TIMEOUT_MS = 30_000;

function _fireAndForget(cmd, args) {
  _getInvoke()
    .then((inv) => inv(cmd, args))
    .catch((err) => console.error(`[RecordingManager] ${cmd} error:`, err));
}

export class RecordingManager {
  /**
   * @param {Object} options
   * @param {Function} options.onChange - Called whenever recordings list or state changes
   * @param {Function} options.onSave   - Called with ({ recordings, deletedRecordings }) to persist
   * @param {Function} [options.onSaveFailed] - Called with ({ path, mimeType, error }) when a
   *   finished recording could not be read or stored. Defaults to offering the user to save
   *   the temp file elsewhere (recordingRecovery.js); without that, the next startup sweep
   *   deletes it.
   */
  constructor(options = {}) {
    this.onChange = options.onChange || (() => {});
    this.onSave = options.onSave || (() => {});
    this.onSaveFailed =
      options.onSaveFailed ||
      ((info) =>
        import("./recordingRecovery.js")
          .then(({ offerRecordingRecovery }) => offerRecordingRecovery(info))
          .catch((err) => console.error("[RecordingManager] Recovery offer failed:", err)));

    /** @type {Array<{id:string, fileId:string, name:string, duration:number, created:number, deleted:boolean}>} */
    this.recordings = [];
    /** @type {string[]} */
    this.deletedRecordings = [];

    this._nativeRecording = false;
    this._nativePaused = false;

    this._recordingId = null;
    this._recordingStartTime = null;
    this._pausedDuration = 0;
    this._pauseStart = null;
    this._timerInterval = null;

    this._nativeAmplitude = 0;
    this._amplitudePollInterval = null;

    /** Set while destroy() waits for an in-flight stop to finish. */
    this._stopSettled = null;

    /**
     * Resolves when the stop currently in flight has finished saving. Set by
     * stopRecording() rather than only by destroy(), because a stop the user
     * started — or stopRecordingForBackground() — can still be reading and
     * saving when the note closes.
     */
    this._stopInFlight = null;

    /**
     * True when the last recording was ended by the app being backgrounded
     * rather than by the user. Read by SoundDialog to explain why it stopped;
     * cleared when the next recording starts or the notice is acknowledged.
     */
    this.stoppedInBackground = false;

    /**
     * Auto-gain aggressiveness (0.0-1.0) of the recording in progress.
     * Seeded from the global default (audioSettings.js) at startRecording();
     * a live change via setAggressiveness() is deliberately not written back
     * to that default, so it affects only the current recording.
     */
    this._aggressiveness = 0;
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
    return this._nativeRecording;
  }

  isPaused() {
    return this._nativeRecording && this._nativePaused;
  }

  /** Returns current input amplitude as 0–1, or 0 if not recording */
  getAmplitude() {
    return this._nativeRecording ? this._nativeAmplitude : 0;
  }

  /** Returns elapsed seconds of the active recording */
  getElapsed() {
    if (!this._recordingStartTime) return 0;
    const paused = this._pausedDuration + (this._pauseStart ? Date.now() - this._pauseStart : 0);
    return Math.floor((Date.now() - this._recordingStartTime - paused) / 1000);
  }

  /** Auto-gain aggressiveness (0.0-1.0) of the recording in progress. */
  getAggressiveness() {
    return this._aggressiveness;
  }

  /**
   * Live-update the auto-gain aggressiveness of the recording in progress.
   * Deliberately does not touch the global default (audioSettings.js): this is
   * a per-recording override, made while watching the level meter, not a
   * change to what the next recording starts with.
   * @param {number} value - 0.0-1.0
   */
  setAggressiveness(value) {
    if (!this.isRecording()) return;
    this._aggressiveness = Math.min(1, Math.max(0, Number(value) || 0));
    _fireAndForget("native_audio_set_aggressiveness", { aggressiveness: this._aggressiveness });
  }

  /**
   * Start recording from the microphone via the native recorder.
   * @returns {Promise<void>}
   */
  async startRecording() {
    if (this.isRecording()) return;

    this._recordingId = generateId();
    this._recordingStartTime = Date.now();
    this._pausedDuration = 0;
    this._pauseStart = null;
    this._aggressiveness = getAutoGainAggressiveness();

    try {
      const started = await (await _getInvoke())("native_audio_start", {
        aggressiveness: this._aggressiveness,
      });
      this._logPipeline(started);
    } catch (err) {
      this._recordingId = null;
      this._recordingStartTime = null;
      console.error("[RecordingManager] Native audio start error:", err);
      // Map recognizable native error messages to the standard getUserMedia
      // error names so the UI shows an actionable message instead of the
      // generic one: NotAllowedError → "permission denied", NotFoundError →
      // "no microphone found".
      const message = String(err);
      const error = new Error(message);
      if (/permission denied|permission not granted/i.test(message)) {
        error.name = "NotAllowedError";
      } else if (/no audio input device|no input device|device not found/i.test(message)) {
        error.name = "NotFoundError";
      }
      throw error;
    }

    this.stoppedInBackground = false;
    this._nativeRecording = true;
    this._nativeAmplitude = 0;
    this._startAmplitudePoll();
    this._startTimer();
    this.onChange();
  }

  pauseRecording() {
    if (!this.isRecording() || this.isPaused()) return;
    this._pauseStart = Date.now();
    this._stopTimer();
    this._nativePaused = true;
    this._stopAmplitudePoll();
    this._nativeAmplitude = 0;
    _fireAndForget("native_audio_pause");
    this.onChange();
  }

  resumeRecording() {
    if (!this.isPaused()) return;
    if (this._pauseStart) {
      this._pausedDuration += Date.now() - this._pauseStart;
      this._pauseStart = null;
    }
    this._startTimer();
    this._nativePaused = false;
    this._startAmplitudePoll();
    _fireAndForget("native_audio_resume");
    this.onChange();
  }

  stopRecording() {
    if (!this.isRecording()) return;
    this._stopTimer();
    this._nativeRecording = false;
    this._nativePaused = false;
    this._stopAmplitudePoll();
    // Published so destroy() can await a stop it did not itself start.
    this._stopInFlight = new Promise((resolve) => {
      this._stopSettled = resolve;
    });
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
        this._settleStop();
      });
    this.onChange();
  }

  /**
   * Stop because the app is no longer in the foreground, flagging why.
   *
   * Android silences the microphone for a backgrounded process, so continuing
   * would record silence. See NoteCanvas._onVisibilityChange.
   */
  stopRecordingForBackground() {
    if (!this.isRecording()) return;
    this.stoppedInBackground = true;
    this.stopRecording();
  }

  /** Dismiss the "stopped in background" notice. */
  clearBackgroundNotice() {
    if (!this.stoppedInBackground) return;
    this.stoppedInBackground = false;
    this.onChange();
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

  /**
   * Tear down, keeping any recording that is still running.
   *
   * Stops and saves rather than cancelling: closing a note used to discard an
   * in-progress recording silently, so navigating to the overview mid-sentence
   * destroyed the audio with no warning and no way back.
   *
   * @returns {Promise<void>} resolves once a recording in progress has been
   *   saved. `NoteCanvas.destroy()` includes this in the work it awaits, so the
   *   note's save and sync see the new recording.
   */
  destroy() {
    this._stopTimer();

    // A stop may already be in flight — started by the user pressing stop, or
    // by stopRecordingForBackground(). isRecording() is false the moment
    // stopRecording() is called, so without this the recording would land via
    // onSave after NoteCanvas.destroy() had already finished, and the note's
    // save and sync would miss it.
    if (!this._nativeRecording) {
      return this._stopInFlight
        ? Promise.race([
            this._stopInFlight,
            new Promise((resolve) => setTimeout(resolve, DESTROY_SAVE_TIMEOUT_MS)),
          ])
        : Promise.resolve();
    }

    // stopRecording() drives stop → read → save asynchronously and publishes
    // _stopInFlight, resolved by _handleNativeStopped and by the stop error
    // path.
    this.stopRecording();
    const done = this._stopInFlight ?? Promise.resolve();

    // Backstop: never leave note close hanging on a native stop that does not
    // come back.
    return Promise.race([
      done,
      new Promise((resolve) => setTimeout(resolve, DESTROY_SAVE_TIMEOUT_MS)),
    ]);
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
      this._settleStop();
      return;
    }

    // Move the file across in binary chunks rather than as one base64 string.
    // invoke() resolves a Rust `tauri::ipc::Response` as an ArrayBuffer, so
    // there is no JSON body, no base64 and no atob() on the main thread — the
    // old path peaked at 5-6x the file size in transient memory and threw
    // "Invalid string length" outright past ~403 MB (~35 min of stereo WAV).
    const mimeType = result.mimeType ?? "audio/mp4";
    let blob;
    try {
      blob = await this._readNativeFile(result.path, mimeType);
    } catch (err) {
      console.error("[RecordingManager] Failed to read native recording file:", err);
      this.onChange();
      this._settleStop();
      this._reportSaveFailure(result.path, mimeType, err);
      return;
    }

    const { saved, error } = await this._saveCompletedRecording(id, blob, duration);

    // Delete only once the bytes are safely in storage. The previous command
    // read and deleted in one step, so a saveFile() failure destroyed the only
    // copy; leaving the temp file behind lets the user save it elsewhere.
    if (saved) {
      _fireAndForget("native_audio_delete", { path: result.path });
    }
    this._settleStop();
    if (!saved) this._reportSaveFailure(result.path, mimeType, error);
  }

  /**
   * Tell the user a finished recording was not stored, and let them keep it.
   * Called after _settleStop(): the recovery dialog waits on the user, and a
   * note close (destroy) must not wait on that.
   * @private
   */
  _reportSaveFailure(path, mimeType, error) {
    try {
      this.onSaveFailed({ path, mimeType, error });
    } catch (err) {
      console.error("[RecordingManager] onSaveFailed threw:", err);
    }
  }

  /**
   * Record which capture pipeline the native side actually started.
   *
   * Logged at warning level so it appears without the user changing the log
   * level (the logger defaults to `warning`). It is not a fault — a successful
   * recording says nothing about which pipeline produced it, and on Android the
   * MediaRecorder fallback is otherwise invisible without logcat.
   * @private
   */
  _logPipeline(started) {
    const pipeline = started?.pipeline;
    if (!pipeline) return;
    logger.warning("RecordingManager", `Recording pipeline: ${pipeline}`, {
      pipeline,
      // Present only when the Android engine failed and the fallback took over.
      ...(started.fallbackReason ? { fallbackReason: started.fallbackReason } : {}),
    });
  }

  /** Release a destroy() that is waiting for the stop to finish. */
  _settleStop() {
    this._stopInFlight = null;
    if (this._stopSettled) {
      const resolve = this._stopSettled;
      this._stopSettled = null;
      resolve();
    }
  }

  /**
   * Read a native recording file into a Blob, in chunks.
   * Chromium stores Blob parts lazily and pages large blobs to disk, so peak
   * JS memory is one chunk rather than the whole file.
   * @private
   */
  async _readNativeFile(path, mimeType) {
    const inv = await _getInvoke();
    const size = await inv("native_audio_file_size", { path });

    const chunks = [];
    for (let offset = 0; offset < size; offset += NATIVE_READ_CHUNK_BYTES) {
      const len = Math.min(NATIVE_READ_CHUNK_BYTES, size - offset);
      const bytes = await inv("native_audio_read_chunk", { path, offset, len });
      // Tauri resolves a Response as ArrayBuffer; older shapes may hand back a
      // typed array or a plain byte array, all of which Blob accepts directly.
      const part = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
      if (!part || part.length === 0) break; // short read: file ended early
      chunks.push(part);
    }

    return new Blob(chunks, { type: mimeType });
  }

  /** @returns {Promise<{saved: boolean, error?: Error}>} saved is true when the blob reached storage. */
  async _saveCompletedRecording(id, blob, duration) {
    let fileId;
    try {
      fileId = await saveFile(blob);
    } catch (err) {
      console.error("[RecordingManager] Failed to save recording:", err);
      this.onChange();
      return { saved: false, error: err };
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
    return { saved: true };
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
        // The native worker died mid-recording (an encoder or disk failure).
        // Everything captured from here on is lost, so stop rather than let the
        // user keep "recording" into nothing until they press stop themselves.
        if (result?.failed && this._nativeRecording) {
          logger.warning("RecordingManager", "Native recorder failed; stopping", {});
          this.stopRecording();
        }
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

  _formatRecordingName(timestamp) {
    const d = new Date(timestamp);
    const pad = (n) => String(n).padStart(2, "0");
    return `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}
