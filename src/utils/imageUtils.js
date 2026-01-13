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
 * Capture image from camera using HTML5 file input with capture attribute
 * @param {string} facing - Camera facing mode: 'user' (front) or 'environment' (back)
 * @returns {Promise<File|null>} - Captured image file or null if cancelled
 */
export function captureFromCamera(facing = "environment") {
  return new Promise((resolve, _reject) => {
    // Create a hidden file input element
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.capture = facing; // 'user' for front camera, 'environment' for back camera
    input.style.display = "none";

    // Handle file selection
    input.addEventListener("change", (e) => {
      const file = e.target.files?.[0] || null;
      document.body.removeChild(input);
      resolve(file);
    });

    // Handle cancellation
    input.addEventListener("cancel", () => {
      document.body.removeChild(input);
      resolve(null);
    });

    // Add to DOM and trigger click
    document.body.appendChild(input);
    input.click();
  });
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
