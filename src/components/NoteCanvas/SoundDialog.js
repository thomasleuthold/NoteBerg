/**
 * SoundDialog - Floating dialog for managing audio recordings in a note.
 *
 * Renders a microphone icon button and, when clicked, shows a dialog listing
 * finished recordings with play/stop/delete controls and an active-recording
 * indicator with pause/stop.
 *
 * Depends on RecordingManager for all state; this class is pure UI.
 */

import { getFile } from "../../modules/storage.js";
import { getIcon } from "../../utils/icons.js";

/** Format seconds as M:SS */
function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export class SoundDialog {
  /**
   * @param {HTMLElement} parentElement - The scroller-container element
   * @param {import('./RecordingManager.js').RecordingManager} recordingManager
   */
  constructor(parentElement, recordingManager) {
    this.parentElement = parentElement;
    this.rm = recordingManager;
    this._open = false;

    // Wire RecordingManager onChange to re-render dialog when open
    const prevOnChange = this.rm.onChange;
    this.rm.onChange = () => {
      prevOnChange();
      if (this._open) this._renderDialogContent();
      this._updateButtonState();
    };

    this._meterRaf = null;

    this._buildButton();
    this._buildDialog();
    this._attachDocumentListener();
  }

  destroy() {
    this._stopMeter();
    this._removeDocumentListener();
    this._btnEl?.remove();
    this._dialogEl?.remove();
    this._btnEl = null;
    this._dialogEl = null;
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  _buildButton() {
    this._btnEl = document.createElement("button");
    this._btnEl.className = "sound-dialog__trigger-btn";
    this._btnEl.title = "Recordings";
    this._btnEl.innerHTML = getIcon("mic", 22);

    this._btnEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this._toggle();
    });

    this.parentElement.appendChild(this._btnEl);
    this._updateButtonState();
  }

  _buildDialog() {
    this._dialogEl = document.createElement("div");
    this._dialogEl.className = "sound-dialog";
    this._dialogEl.style.display = "none";

    this.parentElement.appendChild(this._dialogEl);
  }

  _showError(err) {
    let msg = "Could not start recording.";
    if (err?.name === "NotFoundError") {
      msg = "No audio device found. Please connect a microphone.";
    } else if (err?.name === "NotAllowedError") {
      msg = "Microphone access denied.";
    }

    if (!this._open) this._toggle();

    // Remove existing error if any
    this._dialogEl.querySelector(".sound-dialog__error")?.remove();

    const el = document.createElement("p");
    el.className = "sound-dialog__error";
    el.textContent = msg;
    this._dialogEl.appendChild(el);
  }

  // ── Toggle ─────────────────────────────────────────────────────────────────

  _toggle() {
    this._open = !this._open;
    if (this._open) {
      this._renderDialogContent();
      this._dialogEl.style.display = "block";
    } else {
      this._dialogEl.style.display = "none";
    }
  }

  _close() {
    this._open = false;
    this._dialogEl.style.display = "none";
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  _renderDialogContent() {
    this._stopMeter();
    const recordings = this.rm.getRecordings();
    const recording = this.rm.isRecording();
    const paused = this.rm.isPaused();
    const elapsed = this.rm.getElapsed();

    this._dialogEl.innerHTML = "";

    // Header
    const header = document.createElement("div");
    header.className = "sound-dialog__header";

    const title = document.createElement("span");
    title.className = "sound-dialog__title";
    title.textContent = "Recordings";
    header.appendChild(title);

    const closeBtn = document.createElement("button");
    closeBtn.className = "sound-dialog__close-btn";
    closeBtn.innerHTML = getIcon("x", 16);
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._close();
    });
    header.appendChild(closeBtn);
    this._dialogEl.appendChild(header);

    // Active recording strip
    if (recording) {
      const strip = document.createElement("div");
      strip.className = "sound-dialog__active-strip";

      const indicator = document.createElement("span");
      indicator.className = "sound-dialog__rec-indicator";
      indicator.textContent = "●";
      strip.appendChild(indicator);

      const meter = document.createElement("canvas");
      meter.className = "sound-dialog__meter";
      meter.width = 48;
      meter.height = 14;
      strip.appendChild(meter);
      this._startMeter(meter);

      const label = document.createElement("span");
      label.className = "sound-dialog__rec-label";
      label.textContent = paused ? "Paused" : "Recording…";
      strip.appendChild(label);

      const timer = document.createElement("span");
      timer.className = "sound-dialog__rec-timer";
      timer.textContent = formatDuration(elapsed);
      strip.appendChild(timer);

      const pauseBtn = document.createElement("button");
      pauseBtn.className = "sound-dialog__icon-btn";
      pauseBtn.title = paused ? "Resume" : "Pause";
      pauseBtn.innerHTML = paused ? getIcon("play", 16) : getIcon("pause", 16);
      pauseBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (paused) {
          this.rm.resumeRecording();
        } else {
          this.rm.pauseRecording();
        }
      });
      strip.appendChild(pauseBtn);

      const stopBtn = document.createElement("button");
      stopBtn.className = "sound-dialog__icon-btn sound-dialog__icon-btn--stop";
      stopBtn.title = "Stop recording";
      stopBtn.innerHTML = getIcon("stopCircle", 16);
      stopBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.rm.stopRecording();
      });
      strip.appendChild(stopBtn);

      this._dialogEl.appendChild(strip);
    } else {
      // New recording button
      const newBtn = document.createElement("button");
      newBtn.className = "sound-dialog__new-btn";
      newBtn.innerHTML = `${getIcon("mic", 16)}<span>New recording</span>`;
      newBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await this.rm.startRecording("mic");
        } catch (err) {
          this._showError(err);
        }
      });

      this._dialogEl.appendChild(newBtn);
    }

    // Finished recordings list
    if (recordings.length > 0) {
      const list = document.createElement("div");
      list.className = "sound-dialog__list";

      for (const rec of [...recordings].reverse()) {
        list.appendChild(this._buildRecordingRow(rec));
      }

      this._dialogEl.appendChild(list);
    } else if (!recording) {
      const empty = document.createElement("p");
      empty.className = "sound-dialog__empty";
      empty.textContent = "No recordings yet.";
      this._dialogEl.appendChild(empty);
    }
  }

  _buildRecordingRow(rec) {
    const row = document.createElement("div");
    row.className = "sound-dialog__row";

    const info = document.createElement("div");
    info.className = "sound-dialog__row-info";

    const name = document.createElement("span");
    name.className = "sound-dialog__row-name";
    name.textContent = rec.name;
    info.appendChild(name);

    const playing = this.rm.isPlaying(rec.id);
    const pos = playing ? this.rm.getPlaybackPosition() : 0;
    const total = rec.duration ?? 0;

    const dur = document.createElement("span");
    dur.className = "sound-dialog__row-duration";
    dur.textContent = playing
      ? `${formatDuration(pos)} / ${formatDuration(total)}`
      : formatDuration(total);
    info.appendChild(dur);

    row.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "sound-dialog__row-actions";

    const playBtn = document.createElement("button");
    playBtn.className = "sound-dialog__icon-btn";
    playBtn.title = playing ? "Stop" : "Play";
    playBtn.innerHTML = playing ? getIcon("stopCircle", 16) : getIcon("play", 16);
    playBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (playing) {
        this.rm.stopPlayback(rec.id);
      } else {
        try {
          const blob = await getFile(rec.fileId);
          if (blob) this.rm.playRecording(rec.id, blob);
        } catch (err) {
          console.error("[SoundDialog] Failed to load recording:", err);
        }
      }
    });
    actions.appendChild(playBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "sound-dialog__icon-btn sound-dialog__icon-btn--danger";
    delBtn.title = "Delete";
    delBtn.innerHTML = getIcon("trash", 16);
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.rm.deleteRecording(rec.id);
    });
    actions.appendChild(delBtn);

    row.appendChild(actions);
    return row;
  }

  _updateButtonState() {
    if (!this._btnEl) return;
    if (this.rm.isRecording()) {
      this._btnEl.classList.add("sound-dialog__trigger-btn--recording");
    } else {
      this._btnEl.classList.remove("sound-dialog__trigger-btn--recording");
    }
  }

  // ── Outside-click handling ─────────────────────────────────────────────────

  _attachDocumentListener() {
    this._onDocumentPointerDown = (e) => {
      if (this._open && !this._dialogEl?.contains(e.target) && !this._btnEl?.contains(e.target)) {
        this._close();
      }
    };
    document.addEventListener("pointerdown", this._onDocumentPointerDown, true);
  }

  _removeDocumentListener() {
    if (this._onDocumentPointerDown) {
      document.removeEventListener("pointerdown", this._onDocumentPointerDown, true);
    }
  }

  _startMeter(canvas) {
    this._stopMeter();
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    const BAR_COUNT = 10;
    const GAP = 2;
    const barW = (W - GAP * (BAR_COUNT - 1)) / BAR_COUNT;

    const tick = () => {
      this._meterRaf = requestAnimationFrame(tick);
      const amplitude = this.rm.getAmplitude();
      const lit = Math.round(amplitude * BAR_COUNT);

      ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < BAR_COUNT; i++) {
        const activeColor = i < 6 ? "#22c55e" : i < 9 ? "#f59e0b" : "#ef4444";
        ctx.fillStyle = i < lit ? activeColor : "#cbd5e1";
        ctx.fillRect(i * (barW + GAP), 0, barW, H);
      }
    };
    tick();
  }

  _stopMeter() {
    if (this._meterRaf) {
      cancelAnimationFrame(this._meterRaf);
      this._meterRaf = null;
    }
  }
}
