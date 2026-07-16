/**
 * Shared MIME ↔ file-extension mapping for media files.
 * Used by the native sync layer (nextcloudSync.js) and the NC WebDAV backend
 * (storage.webdav.js) — both must agree so files written by one are found by
 * the other ({fileId}{ext} naming).
 */

export const MIME_TO_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "audio/webm": ".webm",
  "audio/webm;codecs=opus": ".webm",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
};

export function extFromMime(mimeType) {
  return MIME_TO_EXT[mimeType] || ".bin";
}

/** Reverse lookup: first MIME type matching the extension. */
export function mimeFromExt(ext) {
  return (
    Object.keys(MIME_TO_EXT).find((key) => MIME_TO_EXT[key] === ext) || "application/octet-stream"
  );
}
