/**
 * Image handling utilities for media support
 * Uses HTML5 APIs for cross-platform compatibility (desktop + mobile)
 */

/**
 * Maximum dimensions for imported images (2048x2048)
 * Images larger than this will be resized proportionally
 */
const MAX_IMAGE_DIMENSION = 2048;

/**
 * Target file size for compressed images (~500KB)
 * Will adjust JPEG quality to meet this target
 */
const TARGET_SIZE_KB = 500;

/**
 * Minimum JPEG quality (0-1 scale)
 * Won't compress below this even if target size not met
 */
const MIN_QUALITY = 0.6;

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
 * Detect if running on mobile/Android device
 */
function isMobileDevice() {
  const ua = navigator.userAgent.toLowerCase();
  return /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(ua);
}

/**
 * Capture image from camera using HTML5 file input with capture attribute
 * Falls back to getUserMedia if cancelled
 * @param {string} facing - Camera facing mode: 'user' (front) or 'environment' (back)
 * @returns {Promise<File|null>} - Captured image file or null if cancelled
 */
export async function captureFromCamera(facing = "environment") {
  // On mobile devices, try Method 1 first (native camera)
  // On desktop, skip directly to Method 2 (getUserMedia) to avoid file picker
  if (isMobileDevice()) {
    const file = await captureWithFileInput(facing);
    if (file) return file; // User captured photo successfully
    // User cancelled, fall through to Method 2
  }

  // Method 2: getUserMedia with camera preview (works everywhere)
  try {
    return await captureWithGetUserMedia(facing);
  } catch (error) {
    console.error("getUserMedia failed:", error);
    return null; // Failed
  }
}

/**
 * Method 1: Capture using file input with capture attribute (camera only, no file picker)
 */
function captureWithFileInput(facing = "environment") {
  return new Promise((resolve, _reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.capture = facing; // Camera only
    input.style.display = "none";

    let resolved = false;

    const cleanup = () => {
      try {
        if (input.parentNode) {
          document.body.removeChild(input);
        }
      } catch (_e) {
        // Already removed
      }
    };

    // Handle file selection
    input.addEventListener("change", (e) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      const file = e.target.files?.[0] || null;
      resolve(file); // Return the file or null
    });

    // Handle cancellation
    input.addEventListener("cancel", () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(null); // User cancelled
    });

    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Method 2: Capture using getUserMedia (more robust, works on Pixel)
 */
async function captureWithGetUserMedia(facing = "environment") {
  let stream = null;
  let modal = null;

  try {
    // Check if getUserMedia is supported
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("getUserMedia not supported");
    }

    // Request camera access
    const constraints = {
      video: {
        facingMode: facing === "user" ? "user" : "environment",
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);

    // Create camera preview modal and wait for user action
    return await new Promise((resolve, _reject) => {
      modal = createCameraModal(
        stream,
        async (capturedFile) => {
          // Stop camera
          stream.getTracks().forEach((track) => {
            track.stop();
          });
          document.body.removeChild(modal);
          resolve(capturedFile);
        },
        () => {
          // Cancel
          stream.getTracks().forEach((track) => {
            track.stop();
          });
          document.body.removeChild(modal);
          resolve(null);
        },
      );

      document.body.appendChild(modal);
    });
  } catch (error) {
    // Clean up on error
    if (stream) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
    }
    if (modal?.parentNode) {
      document.body.removeChild(modal);
    }
    throw error;
  }
}

/**
 * Create camera preview modal
 */
function createCameraModal(stream, onCapture, onCancel) {
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

  const videoContainer = document.createElement("div");
  videoContainer.style.cssText = `
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    max-height: calc(100% - 100px);
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
  `;

  const controls = document.createElement("div");
  controls.style.cssText = `
    display: flex;
    gap: 20px;
    margin-top: 20px;
    padding: 20px;
  `;

  const captureBtn = document.createElement("button");
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

  cancelBtn.addEventListener("click", () => {
    onCancel();
  });

  videoContainer.appendChild(video);
  controls.appendChild(captureBtn);
  controls.appendChild(cancelBtn);
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
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

  // Use JPEG with high quality for good compression/quality balance
  const optimizedDataUrl = canvas.toDataURL("image/jpeg", 0.92);

  return {
    dataUrl: optimizedDataUrl,
    width: targetWidth,
    height: targetHeight,
  };
}
