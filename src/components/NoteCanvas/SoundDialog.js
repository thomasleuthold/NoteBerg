/**
 * SoundDialog - Floating dialog for managing audio recordings in a note.
 *
 * Renders a microphone icon button and, when clicked, shows a dialog listing
 * finished recordings. Selecting a row loads it into a shared <audio> player.
 * Playback positions are memorized per recording.
 *
 * Depends on RecordingManager for all state; this class is pure UI.
 */

import { t } from "../../i18n/index.js";
import { getFile, waitForFileUrl } from "../../modules/storage.js";
import { logger } from "../../utils/logger.js";

const _IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";
const _IS_NATIVE = typeof window.__TAURI_INTERNALS__ !== "undefined";

import { getIcon } from "../../utils/icons.js";
import { showConfirmDialog } from "../modals.js";

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

    // Blob URLs created for recordings — revoked on dialog close
    this._blobUrls = new Map(); // fileId → url

    // Playback state
    this._selectedId = null; // id of selected recording
    this._playbackPositions = new Map(); // id → seconds

    // Snapshot for structural-change detection
    this._lastRecording = false;
    this._lastPaused = false;
    this._lastRecordingCount = -1;

    // Wire RecordingManager onChange
    const prevOnChange = this.rm.onChange;
    this.rm.onChange = () => {
      prevOnChange();
      if (this._open) this._onStateChange();
      this._updateButtonState();
    };

    this._meterRaf = null;

    this._buildButton();
    this._buildDialog();
    this._buildAudioElement();
    this._attachDocumentListener();
  }

  destroy() {
    this._stopMeter();
    this._removeDocumentListener();
    this._revokeBlobUrls();
    this._btnEl?.remove();
    this._dialogEl?.remove();
    this._audioEl?.remove();
    this._btnEl = null;
    this._dialogEl = null;
    this._audioEl = null;
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  _buildButton() {
    this._btnEl = document.createElement("button");
    this._btnEl.className = "sound-dialog__trigger-btn";
    this._btnEl.title = t("soundDialog.trigger");
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

  _buildAudioElement() {
    // Persistent <audio> element — lives outside the dialog so it keeps playing
    // when the dialog is closed. It gets moved into the player slot on each open.
    this._audioEl = document.createElement("audio");
    this._audioEl.className = "sound-dialog__audio";
    this._audioEl.controls = true;
    this._audioEl.preload = "none";
    this._audioEl.style.display = "none"; // hidden when outside dialog
    this._audioEl.addEventListener("timeupdate", () => {
      if (this._selectedId && this._audioEl) {
        this._playbackPositions.set(this._selectedId, this._audioEl.currentTime);
      }
    });
    this._audioEl.addEventListener("play", () => this._updateButtonState());
    this._audioEl.addEventListener("pause", () => this._updateButtonState());
    this._audioEl.addEventListener("ended", () => this._updateButtonState());

    this.parentElement.appendChild(this._audioEl);
  }

  _showError(err) {
    let msg = t("soundDialog.errorGeneric");
    if (err?.name === "NotFoundError") {
      msg = t("soundDialog.errorNoDevice");
    } else if (err?.name === "NotAllowedError") {
      msg = t("soundDialog.errorPermissionDenied");
    }

    // The user-facing message is deliberately generic; record the raw error so
    // it is visible in the debug logs for diagnosing recording failures.
    logger.error("SoundDialog", "Recording failed to start", {
      name: err?.name,
      message: err?.message ?? String(err),
    });

    if (!this._open) this._toggle();

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
      this._fullRender();
      this._dialogEl.style.display = "block";
    } else {
      this._stopMeter();
      // Move audio element back to parentElement so it keeps playing
      this._audioEl.style.display = "none";
      this.parentElement.appendChild(this._audioEl);
      this._dialogEl.style.display = "none";
    }
  }

  _close() {
    this._open = false;
    this._stopMeter();
    // Move audio element back to parentElement so it keeps playing
    this._audioEl.style.display = "none";
    this.parentElement.appendChild(this._audioEl);
    this._dialogEl.style.display = "none";
  }

  // ── Playback selection ─────────────────────────────────────────────────────

  _savePlaybackPosition() {
    if (this._audioEl && this._selectedId && !this._audioEl.paused) {
      this._playbackPositions.set(this._selectedId, this._audioEl.currentTime);
    }
  }

  _selectRecording(rec) {
    // Save position of currently playing recording
    if (this._audioEl && this._selectedId && this._selectedId !== rec.id) {
      this._playbackPositions.set(this._selectedId, this._audioEl.currentTime);
      this._audioEl.pause();
    }

    this._selectedId = rec.id;

    // Update selected state on rows
    this._dialogEl.querySelectorAll(".sound-dialog__row").forEach((row) => {
      row.classList.toggle("sound-dialog__row--selected", row.dataset.id === rec.id);
    });

    // Show the player and load the recording
    const playerWrap = this._dialogEl.querySelector(".sound-dialog__player");
    if (playerWrap) playerWrap.style.display = "block";

    this._loadAudio(rec);
  }

  _loadAudio(rec) {
    if (!this._audioEl) return;
    const savedPos = this._playbackPositions.get(rec.id) ?? 0;

    const applySource = (url) => {
      if (!this._audioEl) return;
      if (this._audioEl.src !== url) {
        this._audioEl.src = url;
      }
      this._audioEl.currentTime = savedPos;
    };

    if (this._blobUrls.has(rec.fileId)) {
      applySource(this._blobUrls.get(rec.fileId));
      return;
    }

    // In NC build, use the direct WebDAV URL to avoid blob: CSP restriction (media-src 'self')
    if (_IS_NEXTCLOUD) {
      waitForFileUrl(rec.fileId)
        .then((url) => {
          if (!url || !this._audioEl) return;
          this._blobUrls.set(rec.fileId, url);
          if (this._selectedId === rec.id) applySource(url);
        })
        .catch((err) => console.error("[SoundDialog] Failed to resolve recording URL:", err));
      return;
    }

    getFile(rec.fileId)
      .then((blob) => {
        if (!blob || !this._audioEl) return;
        const url = URL.createObjectURL(blob);
        this._blobUrls.set(rec.fileId, url);
        // Only apply if this recording is still selected
        if (this._selectedId === rec.id) applySource(url);
      })
      .catch((err) => console.error("[SoundDialog] Failed to load recording:", err));
  }

  // ── State change handler ───────────────────────────────────────────────────

  _onStateChange() {
    const recording = this.rm.isRecording();
    const paused = this.rm.isPaused();
    const count = this.rm.getRecordings().length;

    const structural =
      recording !== this._lastRecording ||
      paused !== this._lastPaused ||
      count !== this._lastRecordingCount;

    if (structural) {
      // If recording just started, deselect and hide player
      if (recording && !this._lastRecording) {
        this._savePlaybackPosition();
        this._audioEl?.pause();
        this._selectedId = null;
      }
      this._fullRender();
    } else if (recording) {
      const timerEl = this._dialogEl.querySelector(".sound-dialog__rec-timer");
      if (timerEl) timerEl.textContent = formatDuration(this.rm.getElapsed());
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  _fullRender() {
    this._stopMeter();

    const recordings = this.rm.getRecordings();
    const recording = this.rm.isRecording();
    const paused = this.rm.isPaused();
    const elapsed = this.rm.getElapsed();

    this._lastRecording = recording;
    this._lastPaused = paused;
    this._lastRecordingCount = recordings.length;

    this._dialogEl.innerHTML = "";

    // Header
    const header = document.createElement("div");
    header.className = "sound-dialog__header";

    const title = document.createElement("span");
    title.className = "sound-dialog__title";
    title.textContent = t("soundDialog.title");
    header.appendChild(title);

    const closeBtn = document.createElement("button");
    closeBtn.className = "sound-dialog__close-btn";
    closeBtn.innerHTML = getIcon("x", 16);
    closeBtn.title = t("soundDialog.close");
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._close();
    });
    header.appendChild(closeBtn);
    this._dialogEl.appendChild(header);

    // Active recording strip OR new-recording button + player
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

      const timer = document.createElement("span");
      timer.className = "sound-dialog__rec-timer";
      timer.textContent = formatDuration(elapsed);
      strip.appendChild(timer);

      const pauseBtn = document.createElement("button");
      pauseBtn.className = "sound-dialog__icon-btn sound-dialog__icon-btn--lg";
      pauseBtn.title = paused ? t("soundDialog.resume") : t("soundDialog.pause");
      pauseBtn.innerHTML = paused ? getIcon("play", 22) : getIcon("pause", 22);
      pauseBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (paused) this.rm.resumeRecording();
        else this.rm.pauseRecording();
      });
      strip.appendChild(pauseBtn);

      const stopBtn = document.createElement("button");
      stopBtn.className =
        "sound-dialog__icon-btn sound-dialog__icon-btn--lg sound-dialog__icon-btn--stop";
      stopBtn.title = t("soundDialog.stopRecording");
      stopBtn.innerHTML = getIcon("stopCircle", 22);
      stopBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.rm.stopRecording();
      });
      strip.appendChild(stopBtn);

      this._dialogEl.appendChild(strip);
    } else {
      // New recording button (native only)
      if (_IS_NATIVE) {
        const newBtn = document.createElement("button");
        newBtn.className = "sound-dialog__new-btn";
        // Static i18n key with no interpolation options — not attacker-controlled.
        newBtn.innerHTML = `${getIcon("mic", 16)}<span>${t("soundDialog.newRecording")}</span>`; // codeql[js/xss-through-dom]
        newBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (this._audioEl) {
            this._savePlaybackPosition();
            this._audioEl.pause();
          }
          const playerWrap = this._dialogEl.querySelector(".sound-dialog__player");
          if (playerWrap) playerWrap.style.display = "none";
          this._selectedId = null;
          for (const r of this._dialogEl.querySelectorAll(".sound-dialog__row--selected")) {
            r.classList.remove("sound-dialog__row--selected");
          }
          try {
            await this.rm.startRecording();
          } catch (err) {
            this._showError(err);
          }
        });
        this._dialogEl.appendChild(newBtn);
      }

      // Import audio file button (works everywhere)
      const importBtn = document.createElement("button");
      importBtn.className = "sound-dialog__new-btn";
      // Static i18n key with no interpolation options — not attacker-controlled.
      importBtn.innerHTML = `${getIcon("upload", 16)}<span>${t("soundDialog.importAudioFile")}</span>`; // codeql[js/xss-through-dom]
      importBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._importAudioFile();
      });
      this._dialogEl.appendChild(importBtn);

      // Shared audio player (hidden until a recording is selected)
      const playerWrap = document.createElement("div");
      playerWrap.className = "sound-dialog__player";
      playerWrap.style.display = this._selectedId ? "block" : "none";

      // Move the persistent audio element into the player slot
      this._audioEl.style.display = "block";
      playerWrap.appendChild(this._audioEl);
      this._dialogEl.appendChild(playerWrap);
    }

    // Recordings list
    if (recordings.length > 0) {
      const list = document.createElement("div");
      list.className = "sound-dialog__list";

      for (const rec of [...recordings].reverse()) {
        list.appendChild(this._buildRecordingRow(rec));
      }

      this._dialogEl.appendChild(list);

      // Re-select previously selected recording (restore player state after re-render)
      if (!recording && this._selectedId) {
        const stillExists = recordings.find((r) => r.id === this._selectedId);
        if (stillExists) {
          const playerWrap = this._dialogEl.querySelector(".sound-dialog__player");
          if (playerWrap) playerWrap.style.display = "block";
          const row = this._dialogEl.querySelector(`[data-id="${this._selectedId}"]`);
          if (row) row.classList.add("sound-dialog__row--selected");
          this._loadAudio(stillExists);
        } else {
          this._selectedId = null;
        }
      }
    } else if (!recording) {
      const empty = document.createElement("p");
      empty.className = "sound-dialog__empty";
      empty.textContent = t("soundDialog.noRecordings");
      this._dialogEl.appendChild(empty);
    }
  }

  _buildRecordingRow(rec) {
    const row = document.createElement("div");
    row.className = "sound-dialog__row";
    row.dataset.id = rec.id;

    // Label: date/time + duration
    const label = document.createElement("span");
    label.className = "sound-dialog__row-label";
    const datePart = rec.name.replace(/^Recording\s*/i, "");
    const durPart = rec.duration > 0 ? formatDuration(rec.duration) : "";
    label.textContent = durPart ? `${datePart}  (${durPart})` : datePart;
    row.appendChild(label);

    // Delete button
    const delBtn = document.createElement("button");
    delBtn.className = "sound-dialog__icon-btn sound-dialog__icon-btn--danger";
    delBtn.title = t("soundDialog.delete");
    delBtn.innerHTML = getIcon("trash", 16);
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await showConfirmDialog(
        t("soundDialog.deleteRecordingTitle"),
        t("soundDialog.deleteRecordingMessage"),
        t("soundDialog.delete"),
      );
      if (confirmed) {
        if (this._selectedId === rec.id) {
          this._audioEl?.pause();
          this._selectedId = null;
          const playerWrap = this._dialogEl.querySelector(".sound-dialog__player");
          if (playerWrap) playerWrap.style.display = "none";
        }
        this._playbackPositions.delete(rec.id);
        this._revokeUrl(rec.fileId);
        this.rm.deleteRecording(rec.id);
      }
    });
    row.appendChild(delBtn);

    // Select on click (anywhere on row except delete button)
    row.addEventListener("click", (e) => {
      if (delBtn.contains(e.target)) return;
      e.stopPropagation();
      this._selectRecording(rec);
    });

    return row;
  }

  _importAudioFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;

      // Read duration via a temporary audio element
      const duration = await new Promise((resolve) => {
        const audio = document.createElement("audio");
        audio.preload = "metadata";
        const url = URL.createObjectURL(file);
        audio.src = url;
        audio.addEventListener("loadedmetadata", () => {
          URL.revokeObjectURL(url);
          resolve(Number.isFinite(audio.duration) ? Math.round(audio.duration) : 0);
        });
        audio.addEventListener("error", () => {
          URL.revokeObjectURL(url);
          resolve(0);
        });
      });

      try {
        await this.rm.importFile(file, duration);
      } catch (err) {
        console.error("[SoundDialog] Import failed:", err);
      }
    });

    input.click();
  }

  _updateButtonState() {
    if (!this._btnEl) return;
    const isRecording = this.rm.isRecording();
    const isPlaying = this._audioEl && !this._audioEl.paused && !this._audioEl.ended;
    this._btnEl.classList.toggle("sound-dialog__trigger-btn--recording", isRecording);
    this._btnEl.classList.toggle("sound-dialog__trigger-btn--playing", isPlaying && !isRecording);
  }

  // ── Blob URL management ────────────────────────────────────────────────────

  _revokeUrl(fileId) {
    const url = this._blobUrls.get(fileId);
    if (url) {
      URL.revokeObjectURL(url);
      this._blobUrls.delete(fileId);
    }
  }

  _revokeBlobUrls() {
    // Keep the URL of any currently playing recording so playback isn't interrupted
    const keepUrl = this._selectedId
      ? this._blobUrls.get(this.rm.getRecordings().find((r) => r.id === this._selectedId)?.fileId)
      : null;
    for (const [fileId, url] of this._blobUrls) {
      if (url !== keepUrl) {
        URL.revokeObjectURL(url);
        this._blobUrls.delete(fileId);
      }
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
