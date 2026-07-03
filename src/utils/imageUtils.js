/**
 * Image handling utilities for media support
 * Uses HTML5 APIs for cross-platform compatibility (desktop + mobile)
 */

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
 * Capture image from camera using HTML5 file input with capture attribute
 * Falls back to getUserMedia if cancelled
 * @param {string} facing - Camera facing mode: 'user' (front) or 'environment' (back)
 * @returns {Promise<File|null>} - Captured image file or null if cancelled
 */
export async function captureFromCamera(facing = "environment") {
  // Use getUserMedia with camera preview (works everywhere)
  try {
    return await captureWithGetUserMedia(facing);
  } catch (error) {
    console.error("getUserMedia failed:", error);
    return null; // Failed
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
    // Check if getUserMedia is supported
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
        document.body.removeChild(modal);
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

      const onCapture = async (capturedFile) => {
        // Stop camera
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        document.body.removeChild(modal);
        resolve(capturedFile);
      };

      const onCancel = () => {
        // Cancel
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        document.body.removeChild(modal);
        resolve(null);
      };

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

    // Show error to user in the modal if it exists
    if (modal?.parentNode) {
      const labelElement = modal.querySelector(".camera-label");
      if (labelElement) {
        labelElement.textContent = `Camera Error: ${error.message}`;
        labelElement.style.color = "#ef4444"; // Red color
      }

      // Hide loading indicator
      const loadingIndicator = modal.querySelector(".camera-loading");
      if (loadingIndicator) {
        loadingIndicator.style.display = "none";
      }

      // Make cancel button work to close the modal
      const cancelBtn = modal.querySelector(".cancel-btn");
      if (cancelBtn) {
        cancelBtn.style.opacity = "1";
        cancelBtn.style.pointerEvents = "auto";
        cancelBtn.onclick = () => {
          document.body.removeChild(modal);
        };
      }

      // Don't throw - let user see the error and close manually
      return null;
    }

    // Clean up on error if modal hasn't been added yet
    if (stream) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
    }

    // Return null instead of throwing to prevent uncaught errors
    return null;
  }
}

/**
 * Setup auto-focus for camera stream
 * @param {MediaStream} stream - Camera stream
 */
async function setupAutoFocus(stream) {
  try {
    const track = stream.getVideoTracks()[0];
    if (!track) return;

    // Check if focus mode is supported
    const capabilities = track.getCapabilities();
    if (!capabilities.focusMode) {
      console.log("Auto-focus not supported on this camera");
      return;
    }

    // Apply continuous auto-focus if supported
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
  // Update video source
  const video = modal.querySelector("video");
  if (video) {
    video.srcObject = stream;
  }

  // Update camera label
  updateCameraLabel(modal, cameraLabel);

  // Hide loading indicator
  showLoadingState(modal, false);

  // Add switch camera button if needed
  if (showSwitchButton && onSwitchCamera) {
    const videoContainer = modal.querySelector(".video-container");
    let switchBtn = modal.querySelector(".switch-camera-btn");

    if (!switchBtn) {
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
      videoContainer.appendChild(switchBtn);
    }

    switchBtn.onclick = async () => {
      if (onSwitchCamera) {
        await onSwitchCamera();
      }
    };
  }

  // Update button handlers
  const captureBtn = modal.querySelector(".capture-btn");
  const cancelBtn = modal.querySelector(".cancel-btn");

  if (captureBtn) {
    captureBtn.onclick = async () => {
      // Capture frame from video
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0);

      // Convert to blob then to file
      canvas.toBlob(
        (blob) => {
          const file = new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" });
          onCapture(file);
        },
        "image/jpeg",
        0.92,
      );
    };
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
    videoContainer.appendChild(switchBtn);
  }

  const controls = document.createElement("div");
  controls.className = "camera-controls";
  controls.style.cssText = `
    display: flex;
    gap: 20px;
    margin-top: 20px;
    padding: 20px;
    opacity: ${isLoading ? "0.5" : "1"};
    pointer-events: ${isLoading ? "none" : "auto"};
    transition: opacity 0.3s ease;
  `;

  const captureBtn = document.createElement("button");
  captureBtn.className = "capture-btn";
  captureBtn.textContent = "Capture";
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
  cancelBtn.textContent = "Cancel";
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
    captureBtn.addEventListener("click", async () => {
      // Capture frame from video
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0);

      // Convert to blob then to file
      canvas.toBlob(
        (blob) => {
          const file = new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" });
          onCapture(file);
        },
        "image/jpeg",
        0.92,
      );
    });
  }

  if (onCancel) {
    cancelBtn.addEventListener("click", () => {
      onCancel();
    });
  }

  videoContainer.appendChild(video);
  videoContainer.appendChild(loadingIndicator);
  controls.appendChild(captureBtn);
  controls.appendChild(cancelBtn);
  modal.appendChild(labelContainer);
  modal.appendChild(videoContainer);
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
 * Compress image to target file size using JPEG compression
 * Iteratively adjusts quality to meet target size
 * @param {string} dataUrl - Image data URL
 * @param {number} targetSizeKB - Target size in kilobytes (default: TARGET_SIZE_KB)
 * @returns {Promise<string>} - Compressed image data URL
 */
export async function compressImage(dataUrl, targetSizeKB = TARGET_SIZE_KB) {
  const img = await loadImage(dataUrl);

  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;

  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0);

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

  // Use JPEG with high quality for good compression/quality balance
  const optimizedDataUrl = canvas.toDataURL("image/jpeg", 0.92);

  return {
    dataUrl: optimizedDataUrl,
    width: targetWidth,
    height: targetHeight,
  };
}
