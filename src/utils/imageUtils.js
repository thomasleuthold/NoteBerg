/**
 * Image handling utilities for media support
 * Uses HTML5 APIs for cross-platform compatibility (desktop + mobile)
 */

import PerspT from "perspective-transform";
import { t } from "../i18n/index.js";
import { detectDocumentCorners } from "./documentDetector.js";

/**
 * Maximum dimensions for imported images (3072x3072)
 * Images larger than this will be resized proportionally.
 * 3072px keeps a handheld photo of an A4 page at ~200 DPI after
 * perspective cropping, which is needed for readable body text.
 */
const MAX_IMAGE_DIMENSION = 3072;

/**
 * Target file size for compressed images (~1200KB)
 * Will adjust JPEG quality to meet this target
 */
const TARGET_SIZE_KB = 1200;

/**
 * Minimum JPEG quality (0-1 scale)
 * Won't compress below this even if target size not met.
 * Below 0.75 dense text develops visible ringing artifacts.
 */
const MIN_QUALITY = 0.75;

/**
 * Maximum JPEG quality (0-1 scale)
 */
const MAX_QUALITY = 0.92;

/**
 * Pick images from file system using HTML5 file input
 * @param {boolean} multiple - Allow multiple file selection
 * @returns {Promise<File[]>} - Array of selected image files
 */
export function pickImages(multiple = true) {
  return new Promise((resolve, _reject) => {
    // Create a hidden file input element
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = multiple;
    input.style.display = "none";

    // Handle file selection
    input.addEventListener("change", (e) => {
      const files = Array.from(e.target.files || []);
      document.body.removeChild(input);
      resolve(files);
    });

    // Handle cancellation
    input.addEventListener("cancel", () => {
      document.body.removeChild(input);
      resolve([]);
    });

    // Add to DOM and trigger click
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Whether camera capture can work at all in this context.
 *
 * `navigator.mediaDevices` is undefined — not merely permission-gated — outside
 * a secure context. A Nextcloud instance reached over plain HTTP by hostname or
 * LAN IP (http://nextcloud.local, http://192.168.x.x) therefore has no camera
 * API whatsoever, which is indistinguishable at the call site from the user
 * cancelling unless it is checked up front.
 * @returns {boolean}
 */
export function isCameraAvailable() {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * Explain why the camera is unavailable, or null if it is available.
 *
 * Separated from isCameraAvailable so the UI can both hide the control AND give
 * a reason when it is invoked anyway.
 * @returns {{reason: string, message: string}|null}
 */
export function getCameraUnavailableReason() {
  if (isCameraAvailable()) return null;
  // isSecureContext is the discriminator: false means the browser withheld the
  // API because of the origin, which no amount of permission granting fixes.
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return { reason: "insecure-context", message: t("canvas.camera.insecureContext") };
  }
  return { reason: "unsupported", message: t("canvas.camera.unsupported") };
}

/**
 * Capture image from camera using getUserMedia with a live preview.
 *
 * @param {string} facing - Camera facing mode: 'user' (front) or 'environment' (back)
 * @returns {Promise<File|null>} - Captured image file, or null if the user cancelled
 * @throws {Error} With a `.reason` of 'insecure-context' | 'unsupported' |
 *   'permission-denied' | 'no-camera' | 'failed' when capture cannot proceed.
 *   Cancellation is NOT an error — it resolves null. Callers must distinguish
 *   the two: previously every failure was swallowed into null, so an origin
 *   without camera access looked exactly like a cancelled dialog and the button
 *   appeared to do nothing at all.
 */
export async function captureFromCamera(facing = "environment") {
  const unavailable = getCameraUnavailableReason();
  if (unavailable) {
    const error = new Error(unavailable.message);
    error.reason = unavailable.reason;
    throw error;
  }

  try {
    return await captureWithGetUserMedia(facing);
  } catch (error) {
    console.error("getUserMedia failed:", error);
    // Map the DOMException names getUserMedia rejects with onto messages that
    // tell the user what to actually do about it.
    const name = error?.name;
    let reason = "failed";
    let message = t("canvas.camera.failed");
    if (name === "NotAllowedError" || name === "SecurityError") {
      reason = "permission-denied";
      message = t("canvas.camera.permissionDenied");
    } else if (name === "NotFoundError" || name === "OverconstrainedError") {
      reason = "no-camera";
      message = t("canvas.camera.noCamera");
    } else if (name === "NotReadableError") {
      reason = "in-use";
      message = t("canvas.camera.inUse");
    }
    const wrapped = new Error(message);
    wrapped.reason = reason;
    wrapped.cause = error;
    throw wrapped;
  }
}

/**
 * Enumerate available video input devices
 * @returns {Promise<MediaDeviceInfo[]>} Array of video input devices
 */
async function enumerateCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "videoinput");
  } catch (error) {
    console.error("Failed to enumerate cameras:", error);
    return [];
  }
}

/**
 * Method 2: Capture using getUserMedia (more robust, works on Pixel)
 */
async function captureWithGetUserMedia(facing = "environment") {
  let stream = null;
  let modal = null;
  let cameras = [];
  let currentCameraIndex = 0;

  try {
    // Availability is checked by captureFromCamera before this runs, so the API
    // is present here. Kept as a guard for any direct caller.
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia not supported");
    }

    // Create modal immediately with loading state
    modal = createCameraModal(
      null, // No stream yet
      null, // No capture handler yet
      null, // No cancel handler yet
      null, // No switch handler yet
      false, // No switch button yet
      "Loading camera...",
      true, // Show loading indicator
    );
    document.body.appendChild(modal);

    // Make cancel button work even during loading
    const cancelBtn = modal.querySelector(".cancel-btn");
    if (cancelBtn) {
      cancelBtn.style.opacity = "1";
      cancelBtn.style.pointerEvents = "auto";
      cancelBtn.onclick = () => {
        if (stream) {
          stream.getTracks().forEach((track) => {
            track.stop();
          });
        }
        removeCameraModal(modal);
      };
    }

    // Update loading text
    const labelElement = modal.querySelector(".camera-label");
    if (labelElement) {
      labelElement.textContent = "Requesting camera access...";
    }

    // STEP 1: Request camera access first (without specifying deviceId)
    // This grants permission and initializes the camera system
    try {
      stream = await Promise.race([
        navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: facing, // Use facing mode for initial request
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Camera access timeout")), 10000),
        ),
      ]);
    } catch (cameraError) {
      console.error("getUserMedia failed:", cameraError);
      throw cameraError; // Let outer catch handle this
    }

    // STEP 2: Wait for camera system to fully initialize (Android needs this)
    await new Promise((resolve) => setTimeout(resolve, 200));

    // STEP 3: Now enumerate cameras - should detect all cameras
    if (labelElement) {
      labelElement.textContent = "Detecting cameras...";
    }

    try {
      cameras = await Promise.race([
        enumerateCameras(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Camera enumeration timeout")), 5000),
        ),
      ]);
      console.log(`Found ${cameras.length} cameras:`, cameras);
    } catch (enumError) {
      console.error("Failed to enumerate cameras:", enumError);
      // Continue with current stream
      cameras = [];
    }

    // STEP 4: Find the desired camera based on facing mode
    if (cameras.length > 1) {
      const facingLabel = facing === "user" ? "front" : "back";
      const desiredCameraIndex = cameras.findIndex((cam) =>
        cam.label.toLowerCase().includes(facingLabel),
      );

      // If we found a better camera, switch to it
      if (desiredCameraIndex !== -1 && desiredCameraIndex !== 0) {
        currentCameraIndex = desiredCameraIndex;

        if (labelElement) {
          labelElement.textContent = "Switching to preferred camera...";
        }

        // Stop current stream
        stream.getTracks().forEach((track) => {
          track.stop();
        });

        // Start new stream with preferred camera
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: { exact: cameras[currentCameraIndex].deviceId },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            },
            audio: false,
          });
        } catch (switchError) {
          console.error("Failed to switch to preferred camera, using default:", switchError);
          // Fallback: restart with default camera
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            },
            audio: false,
          });
          currentCameraIndex = 0;
        }
      } else {
        currentCameraIndex = 0; // Using first/default camera
      }
    } else {
      currentCameraIndex = 0; // Only one camera or enumeration failed
    }

    // Update modal with camera stream and handlers
    return await new Promise((resolve, _reject) => {
      const switchCamera = async () => {
        // Show loading state during switch
        showLoadingState(modal, true);

        // Stop current stream
        stream.getTracks().forEach((track) => {
          track.stop();
        });

        // Move to next camera
        currentCameraIndex = (currentCameraIndex + 1) % cameras.length;

        // Start new stream with next camera
        const newConstraints = {
          video: {
            deviceId: { exact: cameras[currentCameraIndex].deviceId },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        };

        stream = await navigator.mediaDevices.getUserMedia(newConstraints);

        // Update video source in modal
        const video = modal.querySelector("video");
        video.srcObject = stream;

        // Update camera label
        updateCameraLabel(modal, cameras[currentCameraIndex].label);

        // Hide loading state
        showLoadingState(modal, false);

        // Setup auto-focus for new stream
        await setupAutoFocus(stream);
      };

      // Capture and cancel can race (Cancel tapped while a capture is still
      // encoding). Settle once: the second path must not stop already-stopped
      // tracks or remove an already-removed modal.
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        removeCameraModal(modal);
        resolve(result);
      };

      const onCapture = (capturedFile) => finish(capturedFile);
      const onCancel = () => finish(null);

      // Update modal with stream and handlers
      updateCameraModal(
        modal,
        stream,
        onCapture,
        onCancel,
        switchCamera,
        cameras.length > 1, // Show switch button only if multiple cameras
        cameras[currentCameraIndex]?.label || "Camera",
      );

      // Setup auto-focus after modal is displayed
      setupAutoFocus(stream);
    });
  } catch (error) {
    console.error("getUserMedia error:", error);

    // Tear the modal down and rethrow. It previously stayed open showing a raw
    // English "Camera Error: ..." label and returned null, which the caller
    // could not distinguish from a cancellation — so the user was left with a
    // dead dialog and no localized explanation. captureFromCamera now maps the
    // error to a translated message and the caller shows it.
    if (stream) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
    }
    removeCameraModal(modal);
    throw error;
  }
}

/**
 * Bilinear perspective warp for quad image rectification.
 * Takes source image/canvas and 4 corner points {tl, tr, br, bl},
 * calculates true document width & height, computes homography matrix via perspective-transform,
 * and samples source pixels with bilinear interpolation.
 *
 * @param {HTMLImageElement|HTMLCanvasElement|HTMLVideoElement} source
 * @param {{ tl: {x:number, y:number}, tr: {x:number, y:number}, br: {x:number, y:number}, bl: {x:number, y:number} }} corners
 *   Corners in source pixels
 * @returns {HTMLCanvasElement|null} Rectified canvas, or null when the source has no
 *   size, corners are missing, or the corners do not define a valid transform —
 *   callers choose their own fallback
 */
export function warpPerspective(source, corners) {
  const srcW = source?.videoWidth || source?.naturalWidth || source?.width || 0;
  const srcH = source?.videoHeight || source?.naturalHeight || source?.height || 0;
  if (!srcW || !srcH || !corners) return null;

  const srcCorners = [
    corners.tl.x,
    corners.tl.y,
    corners.tr.x,
    corners.tr.y,
    corners.br.x,
    corners.br.y,
    corners.bl.x,
    corners.bl.y,
  ];

  const topWidth = Math.hypot(srcCorners[2] - srcCorners[0], srcCorners[3] - srcCorners[1]);
  const bottomWidth = Math.hypot(srcCorners[4] - srcCorners[6], srcCorners[5] - srcCorners[7]);
  const leftHeight = Math.hypot(srcCorners[6] - srcCorners[0], srcCorners[7] - srcCorners[1]);
  const rightHeight = Math.hypot(srcCorners[4] - srcCorners[2], srcCorners[5] - srcCorners[3]);

  const outputWidth = Math.max(20, Math.round(Math.sqrt(topWidth * bottomWidth)));
  const outputHeight = Math.max(20, Math.round(Math.sqrt(leftHeight * rightHeight)));

  const dstCorners = [0, 0, outputWidth, 0, outputWidth, outputHeight, 0, outputHeight];

  let perspT;
  try {
    perspT = PerspT(srcCorners, dstCorners);
  } catch (e) {
    console.error("[warpPerspective] Failed to create perspective transform:", e);
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  let srcCanvas = source;
  if (source.tagName !== "CANVAS") {
    srcCanvas = document.createElement("canvas");
    srcCanvas.width = srcW;
    srcCanvas.height = srcH;
    const sCtx = srcCanvas.getContext("2d");
    if (sCtx) {
      try {
        sCtx.drawImage(source, 0, 0);
      } catch (_e) {}
    }
  }

  const srcCtx = srcCanvas.getContext("2d");
  const srcImageData = srcCtx?.getImageData ? srcCtx.getImageData(0, 0, srcW, srcH) : null;
  const outputImageData = ctx.createImageData
    ? ctx.createImageData(outputWidth, outputHeight)
    : null;

  if (!srcImageData || !outputImageData) {
    return canvas;
  }

  const srcData = srcImageData.data;
  const outputData = outputImageData.data;

  for (let y = 0; y < outputHeight; y++) {
    for (let x = 0; x < outputWidth; x++) {
      const srcPt = perspT.transformInverse(x, y);
      const sx = srcPt[0];
      const sy = srcPt[1];

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = x0 + 1;
      const y1 = y0 + 1;

      if (x0 >= 0 && x1 < srcW && y0 >= 0 && y1 < srcH) {
        const wx = sx - x0;
        const wy = sy - y0;
        const w00 = (1 - wx) * (1 - wy);
        const w10 = wx * (1 - wy);
        const w01 = (1 - wx) * wy;
        const w11 = wx * wy;

        const i00 = (y0 * srcW + x0) * 4;
        const i10 = (y0 * srcW + x1) * 4;
        const i01 = (y1 * srcW + x0) * 4;
        const i11 = (y1 * srcW + x1) * 4;
        const dstIndex = (y * outputWidth + x) * 4;

        const a00 = srcData[i00 + 3];
        const a10 = srcData[i10 + 3];
        const a01 = srcData[i01 + 3];
        const a11 = srcData[i11 + 3];
        const outA = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;

        if (outA > 0) {
          outputData[dstIndex] =
            (srcData[i00] * a00 * w00 +
              srcData[i10] * a10 * w10 +
              srcData[i01] * a01 * w01 +
              srcData[i11] * a11 * w11) /
            outA;
          outputData[dstIndex + 1] =
            (srcData[i00 + 1] * a00 * w00 +
              srcData[i10 + 1] * a10 * w10 +
              srcData[i01 + 1] * a01 * w01 +
              srcData[i11 + 1] * a11 * w11) /
            outA;
          outputData[dstIndex + 2] =
            (srcData[i00 + 2] * a00 * w00 +
              srcData[i10 + 2] * a10 * w10 +
              srcData[i01 + 2] * a01 * w01 +
              srcData[i11 + 2] * a11 * w11) /
            outA;
          outputData[dstIndex + 3] = Math.round(outA);
        } else {
          outputData[dstIndex] = 0;
          outputData[dstIndex + 1] = 0;
          outputData[dstIndex + 2] = 0;
          outputData[dstIndex + 3] = 0;
        }
      } else if (x0 >= 0 && x0 < srcW && y0 >= 0 && y0 < srcH) {
        const srcIndex = (y0 * srcW + x0) * 4;
        const dstIndex = (y * outputWidth + x) * 4;
        outputData[dstIndex] = srcData[srcIndex];
        outputData[dstIndex + 1] = srcData[srcIndex + 1];
        outputData[dstIndex + 2] = srcData[srcIndex + 2];
        outputData[dstIndex + 3] = srcData[srcIndex + 3];
      }
    }
  }

  ctx.putImageData(outputImageData, 0, 0);
  return canvas;
}

/**
 * Normalize document lighting on a canvas to remove shadows and brighten paper.
 *
 * @param {HTMLCanvasElement} canvas
 */
export function normalizeDocumentLighting(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  if (w <= 0 || h <= 0) return;

  const scale = 0.25;
  const bw = Math.max(1, Math.round(w * scale));
  const bh = Math.max(1, Math.round(h * scale));

  const blurCanvas = document.createElement("canvas");
  blurCanvas.width = bw;
  blurCanvas.height = bh;
  const blurCtx = blurCanvas.getContext("2d");
  if (!blurCtx) return;

  try {
    blurCtx.drawImage(canvas, 0, 0, bw, bh);
  } catch (_e) {
    return;
  }

  const blurRadius = Math.round(Math.min(bw, bh) * 0.15);
  blurCtx.filter = `blur(${blurRadius}px)`;
  try {
    blurCtx.drawImage(blurCanvas, 0, 0);
  } catch (_e) {
    return;
  }
  blurCtx.filter = "none";

  const bgCanvas = document.createElement("canvas");
  bgCanvas.width = w;
  bgCanvas.height = h;
  const bgCtx = bgCanvas.getContext("2d");
  if (!bgCtx) return;
  try {
    bgCtx.drawImage(blurCanvas, 0, 0, w, h);
  } catch (_e) {
    return;
  }

  const srcData = ctx.getImageData ? ctx.getImageData(0, 0, w, h) : null;
  const bgData = bgCtx.getImageData ? bgCtx.getImageData(0, 0, w, h) : null;
  if (!srcData || !bgData) return;

  const pixels = srcData.data;
  const bg = bgData.data;

  const contrastLUT = new Uint8ClampedArray(256);
  const whitePoint = 235;
  const gamma = 1.4;
  for (let v = 0; v < 256; v++) {
    const normalized = Math.min(1, v / whitePoint);
    contrastLUT[v] = Math.round(normalized ** gamma * 255);
  }

  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue;
    const bgBright = Math.max(bg[i], bg[i + 1], bg[i + 2], 1);
    pixels[i] = contrastLUT[Math.min(255, Math.round((pixels[i] / bgBright) * 255))];
    pixels[i + 1] = contrastLUT[Math.min(255, Math.round((pixels[i + 1] / bgBright) * 255))];
    pixels[i + 2] = contrastLUT[Math.min(255, Math.round((pixels[i + 2] / bgBright) * 255))];
  }

  ctx.putImageData(srcData, 0, 0);
}

/**
 * Synchronize the overlay canvas position, dimensions, and aspect ratio to match
 * the actively rendered video stream within a <video> element.
 *
 * When a video is contained inside an element with differing aspect ratio, the browser
 * letterboxes or pillarboxes the video frames. This function calculates the exact pixel
 * viewport of the video stream and pins the overlay canvas directly over the video frames.
 *
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} overlayCanvas
 */
export function syncOverlayToVideo(video, overlayCanvas) {
  if (!video || !overlayCanvas || !video.videoWidth || !video.videoHeight) return;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const cw = video.clientWidth;
  const ch = video.clientHeight;
  if (!cw || !ch) return;

  // Advise the browser to size the video element matching its stream aspect ratio
  if (video.style.aspectRatio !== `${vw} / ${vh}`) {
    video.style.aspectRatio = `${vw} / ${vh}`;
  }

  const videoAspect = vw / vh;
  const elemAspect = cw / ch;
  let renderW = cw;
  let renderH = ch;
  let offsetX = 0;
  let offsetY = 0;

  // Calculate pillarbox (black bars left/right) or letterbox (black bars top/bottom)
  if (elemAspect > videoAspect) {
    renderH = ch;
    renderW = ch * videoAspect;
    offsetX = (cw - renderW) / 2;
    offsetY = 0;
  } else {
    renderW = cw;
    renderH = cw / videoAspect;
    offsetX = 0;
    offsetY = (ch - renderH) / 2;
  }

  const newLeft = `${Math.round(video.offsetLeft + offsetX)}px`;
  const newTop = `${Math.round(video.offsetTop + offsetY)}px`;
  const newW = `${Math.round(renderW)}px`;
  const newH = `${Math.round(renderH)}px`;

  if (overlayCanvas.style.position !== "absolute") overlayCanvas.style.position = "absolute";
  if (overlayCanvas.style.left !== newLeft) overlayCanvas.style.left = newLeft;
  if (overlayCanvas.style.top !== newTop) overlayCanvas.style.top = newTop;
  if (overlayCanvas.style.width !== newW) overlayCanvas.style.width = newW;
  if (overlayCanvas.style.height !== newH) overlayCanvas.style.height = newH;

  // Match drawing buffer resolution to original stream resolution
  if (overlayCanvas.width !== vw) overlayCanvas.width = vw;
  if (overlayCanvas.height !== vh) overlayCanvas.height = vh;
}

/**
 * Start live document corner detection on a video element.
 *
 * Continuously samples video frames at ~8-10 FPS, runs multi-pass corner detection,
 * applies exponential moving average (EMA) smoothing across frames, and renders a
 * high-contrast visual quadrilateral overlay with corner handles.
 *
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} overlayCanvas
 * @param {HTMLElement} statusPill
 * @param {HTMLElement} modal
 * @returns {{ stop: () => void, setEnabled: (enabled: boolean) => void }}
 */
export function startLiveDocumentDetection(video, overlayCanvas, statusPill, modal) {
  let active = false;
  let animId = null;
  let lastTimestamp = 0;
  let inFlight = false;
  let smoothedCorners = null;
  let missedFrames = 0;

  const handleResize = () => {
    syncOverlayToVideo(video, overlayCanvas);
  };

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("resize", handleResize);
  }
  if (video && typeof video.addEventListener === "function") {
    video.addEventListener("loadedmetadata", handleResize);
    video.addEventListener("resize", handleResize);
  }

  function clearOverlay() {
    if (!overlayCanvas) return;
    const ctx = overlayCanvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }
  }

  function updateStatus(detected) {
    if (!statusPill) return;
    if (detected) {
      statusPill.innerHTML =
        '<span style="width:8px; height:8px; border-radius:50%; background:#10b981; display:inline-block; box-shadow:0 0 8px #10b981;"></span>' +
        (t("canvas.camera.documentDetected") || "Document detected");
      statusPill.style.borderColor = "rgba(16, 185, 129, 0.5)";
    } else {
      statusPill.innerHTML =
        '<span style="width:8px; height:8px; border-radius:50%; background:#eab308; display:inline-block;"></span>' +
        (t("canvas.camera.searchingDocument") || "Position document in frame");
      statusPill.style.borderColor = "rgba(255, 255, 255, 0.2)";
    }
  }

  function renderOverlay(corners) {
    if (!overlayCanvas) return;
    const ctx = overlayCanvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    if (!corners) return;

    const { tl, tr, br, bl } = corners;
    const w = overlayCanvas.width;

    // Semi-transparent document quad fill
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.fillStyle = "rgba(16, 185, 129, 0.22)";
    ctx.fill();

    // Vibrant border
    ctx.strokeStyle = "#10b981";
    ctx.lineWidth = Math.max(3, Math.round(w * 0.004));
    ctx.lineJoin = "round";
    ctx.stroke();

    // Corner circles
    const radius = Math.max(8, Math.round(w * 0.012));
    const strokeWidth = Math.max(2, Math.round(radius * 0.35));

    for (const pt of [tl, tr, br, bl]) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "#10b981";
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
    }
  }

  const loop = async (timestamp) => {
    if (!active) return;

    syncOverlayToVideo(video, overlayCanvas);

    // Throttle to ~110ms (~9 FPS) and skip if a detection is still processing
    if (timestamp - lastTimestamp >= 110 && !inFlight) {
      if (video && video.videoWidth > 0 && video.videoHeight > 0 && !video.paused) {
        inFlight = true;
        lastTimestamp = timestamp;

        try {
          const detected = await detectDocumentCorners(video);
          if (active) {
            if (detected) {
              missedFrames = 0;
              if (!smoothedCorners) {
                smoothedCorners = {
                  tl: { ...detected.tl },
                  tr: { ...detected.tr },
                  br: { ...detected.br },
                  bl: { ...detected.bl },
                };
              } else {
                const alpha = 0.65;
                smoothedCorners = {
                  tl: {
                    x: smoothedCorners.tl.x * (1 - alpha) + detected.tl.x * alpha,
                    y: smoothedCorners.tl.y * (1 - alpha) + detected.tl.y * alpha,
                  },
                  tr: {
                    x: smoothedCorners.tr.x * (1 - alpha) + detected.tr.x * alpha,
                    y: smoothedCorners.tr.y * (1 - alpha) + detected.tr.y * alpha,
                  },
                  br: {
                    x: smoothedCorners.br.x * (1 - alpha) + detected.br.x * alpha,
                    y: smoothedCorners.br.y * (1 - alpha) + detected.br.y * alpha,
                  },
                  bl: {
                    x: smoothedCorners.bl.x * (1 - alpha) + detected.bl.x * alpha,
                    y: smoothedCorners.bl.y * (1 - alpha) + detected.bl.y * alpha,
                  },
                };
              }
              if (modal) modal._detectedCorners = smoothedCorners;
              renderOverlay(smoothedCorners);
              updateStatus(true);
            } else {
              missedFrames++;
              if (missedFrames > 2) {
                smoothedCorners = null;
                if (modal) modal._detectedCorners = null;
                clearOverlay();
                updateStatus(false);
              }
            }
          }
        } catch (err) {
          console.warn("[LiveDocumentDetection] Error:", err);
        } finally {
          inFlight = false;
        }
      }
    }

    if (active) {
      animId = requestAnimationFrame(loop);
    }
  };

  return {
    setEnabled(enabled) {
      if (enabled === active) return;
      active = enabled;
      if (active) {
        syncOverlayToVideo(video, overlayCanvas);
        if (statusPill) statusPill.style.display = "flex";
        if (overlayCanvas) overlayCanvas.style.display = "block";
        updateStatus(false);
        animId = requestAnimationFrame(loop);
      } else {
        if (animId) {
          cancelAnimationFrame(animId);
          animId = null;
        }
        if (statusPill) statusPill.style.display = "none";
        if (overlayCanvas) overlayCanvas.style.display = "none";
        clearOverlay();
        smoothedCorners = null;
        if (modal) modal._detectedCorners = null;
        inFlight = false;
      }
    },
    stop() {
      active = false;
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("resize", handleResize);
      }
      if (video && typeof video.removeEventListener === "function") {
        video.removeEventListener("loadedmetadata", handleResize);
        video.removeEventListener("resize", handleResize);
      }
      if (animId) {
        cancelAnimationFrame(animId);
        animId = null;
      }
      clearOverlay();
      smoothedCorners = null;
      if (modal) modal._detectedCorners = null;
      inFlight = false;
    },
  };
}

/**
 * Grab the current video frame as a loaded image.
 *
 * Encoded with toBlob and served from an object URL: unlike toDataURL this
 * does not block the main thread base64-encoding a multi-megapixel frame, and
 * waiting for the load event (rather than a timeout) guarantees the image is
 * decoded before anyone measures or draws it.
 *
 * @param {HTMLVideoElement} video
 * @returns {Promise<{img: HTMLImageElement, release: Function}|null>} The image plus
 *   a release() that frees its object URL, or null if the frame could not be captured
 */
async function snapshotVideoFrame(video) {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0);
  } catch (_e) {
    return null;
  }

  // JPEG: camera frames are opaque, and PNG-encoding a full frame is slow
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
  if (!blob) return null;

  const url = URL.createObjectURL(blob);
  const img = new Image();
  const loaded = await new Promise((resolve) => {
    img.addEventListener("load", () => resolve(true), { once: true });
    img.addEventListener("error", () => resolve(false), { once: true });
    img.src = url;
  });
  if (!loaded || !img.naturalWidth) {
    URL.revokeObjectURL(url);
    return null;
  }
  return { img, release: () => URL.revokeObjectURL(url) };
}

/**
 * Wire up the capture button of a camera modal.
 *
 * Captures the current frame and opens it in the ImageCropper — in perspective
 * mode with optional lighting normalization for Document mode, simple crop
 * otherwise. Cancelling the cropper ("Retake") returns to the live viewfinder.
 *
 * @param {HTMLElement} modal - Camera modal element
 * @param {HTMLVideoElement} video - Video element showing the stream
 * @param {HTMLButtonElement} captureBtn - The capture button
 * @param {Function} onCapture - Callback receiving the captured File
 */
export function attachCaptureHandler(modal, video, captureBtn, onCapture) {
  let capturing = false;

  captureBtn.onclick = async () => {
    if (capturing) return;

    if (!video.videoWidth || !video.videoHeight) return;

    capturing = true;
    showLoadingState(modal, true);
    captureBtn.disabled = true;

    const isDocumentMode = modal?.dataset?.cameraMode === "document";

    // The quad the live viewfinder was tracking at the moment of the shutter
    // press, read before detection is paused. Only a fallback: the cropper
    // re-detects on the captured frame itself, which accounts for any camera
    // movement since the last live detection.
    const liveCorners = isDocumentMode ? modal?._detectedCorners || null : null;

    const snapshot = await snapshotVideoFrame(video);

    if (snapshot) {
      // Pause live detection and hide camera viewfinder while crop dialog is open
      modal?._detectionController?.setEnabled?.(false);
      if (modal?.style) {
        modal.style.display = "none";
      }

      try {
        const { ImageCropper } = await import("../components/NoteCanvas/ImageCropper.js");
        const cropper = new ImageCropper();
        const croppedBlob = await cropper.show(snapshot.img, {
          initialMode: isDocumentMode ? "perspective" : "simple",
          normalizeLighting: isDocumentMode && modal?.dataset?.flattenLighting !== "false",
          cancelLabel: t("canvas.camera.retake"),
          fallbackCorners: liveCorners,
        });

        if (croppedBlob) {
          const type = croppedBlob.type || "image/jpeg";
          const ext = type === "image/png" ? "png" : "jpg";
          const prefix = isDocumentMode ? "document" : "camera";
          const file = new File([croppedBlob], `${prefix}-${Date.now()}.${ext}`, { type });
          onCapture(file);
          return;
        }
      } catch (err) {
        console.error("[attachCaptureHandler] Crop error:", err);
      } finally {
        snapshot.release();
      }
    }

    // User cancelled / retakes photo: restore camera viewfinder
    if (modal?.style) {
      modal.style.display = "";
    }
    if (isDocumentMode) {
      modal?._detectionController?.setEnabled?.(true);
    }
    capturing = false;
    captureBtn.disabled = false;
    showLoadingState(modal, false);
  };
}

/**
 * Remove the camera modal if it is still in the DOM.
 * @param {HTMLElement} modal
 */
function removeCameraModal(modal) {
  modal?._detectionController?.stop();
  modal?.parentNode?.removeChild(modal);
}

/**
 * Setup auto-focus for camera stream
 * @param {MediaStream} stream - Camera stream
 */
async function setupAutoFocus(stream) {
  try {
    const track = stream.getVideoTracks()[0];
    if (!track) return;

    const capabilities = track.getCapabilities();
    if (!capabilities.focusMode) {
      console.log("Auto-focus not supported on this camera");
      return;
    }

    const constraints = {
      advanced: [{ focusMode: "continuous" }],
    };

    await track.applyConstraints(constraints);
    console.log("Auto-focus enabled: continuous mode");
  } catch (error) {
    console.warn("Failed to enable auto-focus:", error);
  }
}

/**
 * Update camera label in modal
 * @param {HTMLElement} modal - Camera modal element
 * @param {string} label - Camera label
 */
function updateCameraLabel(modal, label) {
  const labelElement = modal.querySelector(".camera-label");
  if (labelElement) {
    labelElement.textContent = label || "Camera";
  }
}

/**
 * Show or hide loading state in camera modal
 * @param {HTMLElement} modal - Camera modal element
 * @param {boolean} show - Whether to show loading state
 */
function showLoadingState(modal, show) {
  const loadingIndicator = modal.querySelector(".camera-loading");
  const video = modal.querySelector("video");
  const controls = modal.querySelector(".camera-controls");
  const modeContainer = modal.querySelector(".camera-mode-container");

  if (loadingIndicator) {
    loadingIndicator.style.display = show ? "flex" : "none";
  }
  if (video) {
    video.style.opacity = show ? "0.3" : "1";
  }
  if (controls) {
    controls.style.opacity = show ? "0.5" : "1";
    controls.style.pointerEvents = show ? "none" : "auto";
  }
  if (modeContainer) {
    modeContainer.style.opacity = show ? "0.5" : "1";
    modeContainer.style.pointerEvents = show ? "none" : "auto";
  }
}

/**
 * Update camera modal with stream and handlers
 * @param {HTMLElement} modal - Camera modal element
 * @param {MediaStream} stream - Camera stream
 * @param {Function} onCapture - Callback when capture button is clicked
 * @param {Function} onCancel - Callback when cancel button is clicked
 * @param {Function} onSwitchCamera - Callback when switch camera button is clicked
 * @param {boolean} showSwitchButton - Whether to show the switch camera button
 * @param {string} cameraLabel - Label for the current camera
 */
function updateCameraModal(
  modal,
  stream,
  onCapture,
  onCancel,
  onSwitchCamera,
  showSwitchButton,
  cameraLabel,
) {
  const video = modal.querySelector("video");
  const overlayCanvas = modal.querySelector(".camera-document-overlay");
  if (video) {
    video.srcObject = stream;
    if (overlayCanvas && typeof video.addEventListener === "function") {
      video.addEventListener(
        "loadedmetadata",
        () => {
          syncOverlayToVideo(video, overlayCanvas);
        },
        { once: true },
      );
    }
  }

  updateCameraLabel(modal, cameraLabel);
  showLoadingState(modal, false);

  if (showSwitchButton && onSwitchCamera) {
    const parentContainer =
      modal.querySelector(".video-wrapper") || modal.querySelector(".video-container");
    let switchBtn = modal.querySelector(".switch-camera-btn");

    if (!switchBtn && parentContainer) {
      switchBtn = document.createElement("button");
      switchBtn.className = "switch-camera-btn";
      switchBtn.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10"></polyline>
          <polyline points="1 20 1 14 7 14"></polyline>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>
      `;
      switchBtn.style.cssText = `
        position: absolute;
        top: 10px;
        right: 10px;
        padding: 10px;
        background: rgba(59, 130, 246, 0.8);
        color: white;
        border: none;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 48px;
        height: 48px;
        z-index: 10;
      `;
      parentContainer.appendChild(switchBtn);
    }

    if (switchBtn) {
      switchBtn.onclick = async () => {
        if (onSwitchCamera) {
          await onSwitchCamera();
        }
      };
    }
  }

  const captureBtn = modal.querySelector(".capture-btn");
  const cancelBtn = modal.querySelector(".cancel-btn");

  if (captureBtn && video) {
    attachCaptureHandler(modal, video, captureBtn, onCapture);
  }

  if (cancelBtn) {
    cancelBtn.onclick = () => {
      onCancel();
    };
  }
}

/**
 * Create camera preview modal
 * @param {MediaStream|null} stream - Camera stream (null for loading state)
 * @param {Function|null} onCapture - Callback when capture button is clicked (null for loading state)
 * @param {Function|null} onCancel - Callback when cancel button is clicked (null for loading state)
 * @param {Function|null} onSwitchCamera - Callback when switch camera button is clicked
 * @param {boolean} showSwitchButton - Whether to show the switch camera button
 * @param {string} cameraLabel - Label for the current camera
 * @param {boolean} isLoading - Whether to show loading state
 */
function createCameraModal(
  stream,
  onCapture,
  onCancel,
  onSwitchCamera = null,
  showSwitchButton = false,
  cameraLabel = "Camera",
  isLoading = false,
) {
  const modal = document.createElement("div");
  modal.className = "camera-modal";
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.95);
    z-index: 10000;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 20px;
    box-sizing: border-box;
  `;

  // Camera label at top
  const labelContainer = document.createElement("div");
  labelContainer.style.cssText = `
    color: white;
    font-size: 16px;
    margin-bottom: 10px;
    text-align: center;
  `;
  const label = document.createElement("span");
  label.className = "camera-label";
  label.textContent = cameraLabel;
  labelContainer.appendChild(label);

  const videoContainer = document.createElement("div");
  videoContainer.className = "video-container";
  videoContainer.style.cssText = `
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    max-height: calc(100% - 150px);
    position: relative;
    overflow: hidden;
  `;

  const videoWrapper = document.createElement("div");
  videoWrapper.className = "video-wrapper";
  videoWrapper.style.cssText = `
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    max-width: 100%;
    max-height: 100%;
  `;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  video.style.cssText = `
    max-width: 100%;
    max-height: 100%;
    border-radius: 8px;
    background: #000;
    opacity: ${isLoading ? "0.3" : "1"};
    transition: opacity 0.3s ease;
    display: block;
    object-fit: contain;
  `;

  // Overlay canvas for real-time document boundary drawing
  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.className = "camera-document-overlay";
  overlayCanvas.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    border-radius: 8px;
    display: none;
  `;

  if (typeof video.addEventListener === "function") {
    video.addEventListener("loadedmetadata", () => {
      syncOverlayToVideo(video, overlayCanvas);
    });
  }

  // Status pill indicator ("Searching document" / "Document detected")
  const statusPill = document.createElement("div");
  statusPill.className = "camera-document-status";
  statusPill.style.cssText = `
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(4px);
    color: #ffffff;
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 500;
    display: none;
    align-items: center;
    gap: 8px;
    pointer-events: none;
    z-index: 5;
    border: 1px solid rgba(255, 255, 255, 0.2);
    transition: border-color 0.2s;
    white-space: nowrap;
  `;

  // Loading indicator (spinner)
  const loadingIndicator = document.createElement("div");
  loadingIndicator.className = "camera-loading";
  loadingIndicator.style.cssText = `
    position: absolute;
    display: ${isLoading ? "flex" : "none"};
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 10px;
  `;
  loadingIndicator.innerHTML = `
    <div style="
      border: 4px solid rgba(255, 255, 255, 0.3);
      border-top: 4px solid white;
      border-radius: 50%;
      width: 48px;
      height: 48px;
      animation: spin 1s linear infinite;
    "></div>
    <style>
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    </style>
  `;

  videoWrapper.appendChild(video);
  videoWrapper.appendChild(overlayCanvas);
  videoWrapper.appendChild(statusPill);
  videoWrapper.appendChild(loadingIndicator);

  // Switch camera button (floating on video, top-right)
  if (showSwitchButton && onSwitchCamera) {
    const switchBtn = document.createElement("button");
    switchBtn.className = "switch-camera-btn";
    switchBtn.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 4 23 10 17 10"></polyline>
        <polyline points="1 20 1 14 7 14"></polyline>
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
      </svg>
    `;
    switchBtn.style.cssText = `
      position: absolute;
      top: 10px;
      right: 10px;
      padding: 10px;
      background: rgba(59, 130, 246, 0.8);
      color: white;
      border: none;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 48px;
      height: 48px;
      z-index: 10;
    `;
    switchBtn.addEventListener("click", async () => {
      if (onSwitchCamera) {
        await onSwitchCamera();
      }
    });
    videoWrapper.appendChild(switchBtn);
  }

  videoContainer.appendChild(videoWrapper);

  // Mode selection container
  const modeContainer = document.createElement("div");
  modeContainer.className = "camera-mode-container";
  modeContainer.style.cssText = `
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
    opacity: ${isLoading ? "0.5" : "1"};
    pointer-events: ${isLoading ? "none" : "auto"};
    transition: opacity 0.3s ease;
  `;

  const modePill = document.createElement("div");
  modePill.className = "camera-mode-pill";
  modePill.style.cssText = `
    display: flex;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 24px;
    padding: 3px;
    gap: 4px;
  `;

  const modePhotoBtn = document.createElement("button");
  modePhotoBtn.type = "button";
  modePhotoBtn.className = "camera-mode-btn camera-mode-photo";
  modePhotoBtn.textContent = t("canvas.camera.modePhoto") || "Photo";
  modePhotoBtn.style.cssText = `
    padding: 6px 16px;
    font-size: 14px;
    font-weight: 600;
    border-radius: 20px;
    border: none;
    cursor: pointer;
    background: #3b82f6;
    color: #ffffff;
    transition: all 0.2s ease;
  `;

  const modeDocBtn = document.createElement("button");
  modeDocBtn.type = "button";
  modeDocBtn.className = "camera-mode-btn camera-mode-doc";
  modeDocBtn.textContent = t("canvas.camera.modeDocument") || "Document";
  modeDocBtn.style.cssText = `
    padding: 6px 16px;
    font-size: 14px;
    font-weight: 600;
    border-radius: 20px;
    border: none;
    cursor: pointer;
    background: transparent;
    color: rgba(255, 255, 255, 0.7);
    transition: all 0.2s ease;
  `;

  modePill.appendChild(modePhotoBtn);
  modePill.appendChild(modeDocBtn);

  // Flatten lighting checkbox (visible only in document mode)
  const flattenContainer = document.createElement("label");
  flattenContainer.className = "camera-flatten-container";
  flattenContainer.style.cssText = `
    display: none;
    align-items: center;
    gap: 6px;
    color: rgba(255, 255, 255, 0.85);
    font-size: 13px;
    cursor: pointer;
    user-select: none;
  `;

  const flattenCheckbox = document.createElement("input");
  flattenCheckbox.type = "checkbox";
  flattenCheckbox.className = "camera-flatten-checkbox";
  flattenCheckbox.checked = true;
  flattenCheckbox.style.cursor = "pointer";

  const flattenLabel = document.createElement("span");
  flattenLabel.textContent = t("canvas.camera.flattenLighting") || "Flatten lighting";

  flattenContainer.appendChild(flattenCheckbox);
  flattenContainer.appendChild(flattenLabel);

  modeContainer.appendChild(modePill);
  modeContainer.appendChild(flattenContainer);

  // Initialize live detection controller
  const detectionController = startLiveDocumentDetection(video, overlayCanvas, statusPill, modal);
  modal._detectionController = detectionController;
  modal.dataset.cameraMode = "photo";
  modal.dataset.flattenLighting = "true";

  flattenCheckbox.addEventListener("change", () => {
    modal.dataset.flattenLighting = flattenCheckbox.checked ? "true" : "false";
  });

  const setMode = (mode) => {
    modal.dataset.cameraMode = mode;
    if (mode === "document") {
      modeDocBtn.style.background = "#3b82f6";
      modeDocBtn.style.color = "#ffffff";
      modePhotoBtn.style.background = "transparent";
      modePhotoBtn.style.color = "rgba(255, 255, 255, 0.7)";
      flattenContainer.style.display = "flex";
      detectionController.setEnabled(true);
    } else {
      modePhotoBtn.style.background = "#3b82f6";
      modePhotoBtn.style.color = "#ffffff";
      modeDocBtn.style.background = "transparent";
      modeDocBtn.style.color = "rgba(255, 255, 255, 0.7)";
      flattenContainer.style.display = "none";
      detectionController.setEnabled(false);
    }
  };

  modePhotoBtn.onclick = () => setMode("photo");
  modeDocBtn.onclick = () => setMode("document");

  const controls = document.createElement("div");
  controls.className = "camera-controls";
  controls.style.cssText = `
    display: flex;
    gap: 20px;
    margin-top: 16px;
    padding: 10px 20px 20px;
    opacity: ${isLoading ? "0.5" : "1"};
    pointer-events: ${isLoading ? "none" : "auto"};
    transition: opacity 0.3s ease;
  `;

  const captureBtn = document.createElement("button");
  captureBtn.className = "capture-btn";
  captureBtn.textContent = t("common.capture");
  captureBtn.style.cssText = `
    padding: 12px 32px;
    font-size: 16px;
    background: #3b82f6;
    color: white;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 600;
  `;

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "cancel-btn";
  cancelBtn.textContent = t("common.cancel");
  cancelBtn.style.cssText = `
    padding: 12px 32px;
    font-size: 16px;
    background: #6b7280;
    color: white;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 600;
  `;

  if (onCapture) {
    attachCaptureHandler(modal, video, captureBtn, onCapture);
  }

  if (onCancel) {
    cancelBtn.addEventListener("click", () => {
      onCancel();
    });
  }

  controls.appendChild(cancelBtn);
  controls.appendChild(captureBtn);
  modal.appendChild(labelContainer);
  modal.appendChild(videoContainer);
  modal.appendChild(modeContainer);
  modal.appendChild(controls);

  return modal;
}

/**
 * Convert a File object to a data URL (base64)
 * @param {File} file - Image file
 * @returns {Promise<string>} - Data URL (base64 encoded)
 */
export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = (_e) => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

/**
 * Load an image from a data URL
 * @param {string} dataUrl - Data URL of the image
 * @returns {Promise<HTMLImageElement>} - Loaded image element
 */
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = dataUrl;
  });
}

/**
 * Resize image if it exceeds maximum dimensions
 * Maintains aspect ratio and returns a new data URL
 * @param {string} dataUrl - Original image data URL
 * @param {number} maxDimension - Maximum width or height (default: MAX_IMAGE_DIMENSION)
 * @returns {Promise<string>} - Resized image data URL
 */
export async function resizeImage(dataUrl, maxDimension = MAX_IMAGE_DIMENSION) {
  const img = await loadImage(dataUrl);

  // Check if resize is needed
  if (img.width <= maxDimension && img.height <= maxDimension) {
    return dataUrl; // No resize needed
  }

  // Calculate new dimensions maintaining aspect ratio
  let newWidth = img.width;
  let newHeight = img.height;

  if (img.width > img.height) {
    newWidth = maxDimension;
    newHeight = Math.round((img.height * maxDimension) / img.width);
  } else {
    newHeight = maxDimension;
    newWidth = Math.round((img.width * maxDimension) / img.height);
  }

  // Create canvas and resize
  const canvas = document.createElement("canvas");
  canvas.width = newWidth;
  canvas.height = newHeight;

  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, newWidth, newHeight);

  // Return as data URL (PNG to preserve quality during resize)
  return canvas.toDataURL("image/png");
}

/**
 * Check whether a canvas element contains any transparent or semi-transparent pixels.
 * @param {HTMLCanvasElement} canvas
 * @returns {boolean}
 */
export function hasTransparency(canvas) {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return false;
  const ctx = canvas.getContext?.("2d", { willReadFrequently: true });
  if (!ctx || typeof ctx.getImageData !== "function") return false;
  try {
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return true;
    }
  } catch (_e) {
    return false;
  }
  return false;
}

/**
 * Compress image to target file size using JPEG compression
 * Iteratively adjusts quality to meet target size.
 * Preserves PNG format if image contains transparency to avoid black backgrounds.
 * @param {string} dataUrl - Image data URL
 * @param {number} targetSizeKB - Target size in kilobytes (default: TARGET_SIZE_KB)
 * @returns {Promise<string>} - Compressed or transparency-preserved image data URL
 */
export async function compressImage(dataUrl, targetSizeKB = TARGET_SIZE_KB) {
  const img = await loadImage(dataUrl);

  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;

  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0);

  // If the image contains transparency, preserve it as PNG.
  // JPEG does not support alpha channels — converting to JPEG turns transparent areas black.
  if (hasTransparency(canvas)) {
    return canvas.toDataURL("image/png");
  }

  // Binary search for optimal quality
  let minQuality = MIN_QUALITY;
  let maxQuality = MAX_QUALITY;
  let bestDataUrl = dataUrl;
  let attempts = 0;
  const maxAttempts = 8; // Limit iterations

  while (attempts < maxAttempts && maxQuality - minQuality > 0.01) {
    const quality = (minQuality + maxQuality) / 2;
    const compressedDataUrl = canvas.toDataURL("image/jpeg", quality);

    // Calculate size in KB (data URL is base64, so divide by 1.37 to get approximate byte size)
    const sizeKB = (compressedDataUrl.length * 0.75) / 1024;

    if (sizeKB > targetSizeKB) {
      maxQuality = quality; // Too large, reduce quality
    } else {
      minQuality = quality; // Small enough, try higher quality
      bestDataUrl = compressedDataUrl;
    }

    attempts++;
  }

  return bestDataUrl;
}

/**
 * Process an image file for storage in a note
 * Resizes to max dimensions and compresses to target size
 * @param {File} file - Image file to process
 * @returns {Promise<{dataUrl: string, width: number, height: number, size: number}>} - Processed image data
 */
export async function processImageFile(file) {
  // Convert to data URL
  const originalDataUrl = await fileToDataUrl(file);

  // Resize if needed
  const resizedDataUrl = await resizeImage(originalDataUrl);

  // Compress to target size
  const compressedDataUrl = await compressImage(resizedDataUrl);

  // Load final image to get dimensions
  const finalImg = await loadImage(compressedDataUrl);

  // Calculate approximate size in KB
  const sizeKB = Math.round((compressedDataUrl.length * 0.75) / 1024);

  return {
    dataUrl: compressedDataUrl,
    width: finalImg.width,
    height: finalImg.height,
    size: sizeKB,
  };
}

/**
 * Process multiple image files
 * @param {File[]} files - Array of image files
 * @param {Function} onProgress - Optional progress callback (current, total)
 * @returns {Promise<Array>} - Array of processed image data
 */
export async function processImageFiles(files, onProgress = null) {
  const results = [];

  for (let i = 0; i < files.length; i++) {
    try {
      const processed = await processImageFile(files[i]);
      results.push({
        success: true,
        data: processed,
        fileName: files[i].name,
      });

      if (onProgress) {
        onProgress(i + 1, files.length);
      }
    } catch (error) {
      console.error(`Failed to process image ${files[i].name}:`, error);
      results.push({
        success: false,
        error: error.message,
        fileName: files[i].name,
      });

      if (onProgress) {
        onProgress(i + 1, files.length);
      }
    }
  }

  return results;
}

/**
 * Get human-readable file size string
 * @param {number} sizeKB - Size in kilobytes
 * @returns {string} - Formatted size string (e.g., "1.5 MB")
 */
export function formatFileSize(sizeKB) {
  if (sizeKB < 1024) {
    return `${Math.round(sizeKB)} KB`;
  }
  return `${(sizeKB / 1024).toFixed(1)} MB`;
}

/**
 * Optimize image to 2x its display size to reduce storage while maintaining quality
 * Only downsample if image is significantly larger than needed
 * @param {string} dataUrl - Original image data URL
 * @param {number} displayWidth - Current display width
 * @param {number} displayHeight - Current display height
 * @returns {Promise<{dataUrl: string, width: number, height: number}>} - Optimized image data
 */
export async function optimizeImageForDisplay(dataUrl, displayWidth, displayHeight) {
  const img = await loadImage(dataUrl);

  // Target size: 2x the display dimensions for quality headroom
  const targetWidth = Math.round(displayWidth * 2);
  const targetHeight = Math.round(displayHeight * 2);

  // Only downsample if image is significantly larger (>10% larger than target)
  const needsResize = img.width > targetWidth * 1.1 || img.height > targetHeight * 1.1;

  if (!needsResize) {
    // Image is already optimal size, return as-is
    return {
      dataUrl: dataUrl,
      width: img.width,
      height: img.height,
    };
  }

  // Resize to 2x display size
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

  // Preserve PNG format if image contains transparency; use JPEG otherwise
  const isTransparent = hasTransparency(canvas);
  const mimeType = isTransparent ? "image/png" : "image/jpeg";
  const optimizedDataUrl = canvas.toDataURL(mimeType, isTransparent ? undefined : 0.92);

  return {
    dataUrl: optimizedDataUrl,
    width: targetWidth,
    height: targetHeight,
  };
}
