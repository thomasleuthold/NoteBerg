/**
 * MediaManager - Manages media items (images, PDFs) for the NoteCanvas
 * Handles loading binary data from storage, creating object URLs, and managing image objects.
 */

import { getFile } from "../../modules/storage.js";

export class MediaManager {
  /**
   * @param {string} noteId - The ID of the note
   * @param {Array} initialMedia - Initial array of media items from note data
   */
  constructor(noteId, initialMedia = []) {
    this.noteId = noteId;
    this.mediaItems = initialMedia; // [{ id, type: 'image', x, y, width, height, fileId, rotation }]

    // Cache for loaded image elements and blob URLs
    this.images = new Map(); // fileId -> HTMLImageElement
    this.blobUrls = new Map(); // fileId -> string (blob URL)
    this.loading = new Set(); // fileIds currently loading

    // Callback for when an image loads (to trigger redraw)
    this.onImageLoaded = null;
  }

  /**
   * Set callback for redraw requests
   * @param {Function} callback
   */
  setOnImageLoaded(callback) {
    this.onImageLoaded = callback;
  }

  /**
   * Get all media items
   */
  getItems() {
    return this.mediaItems;
  }

  /**
   * Add a new media item
   */
  addItem(item) {
    this.mediaItems.push(item);
    // Trigger load immediately if it has a fileId
    if (item.fileId) {
      this._loadImage(item.fileId);
    }
  }

  /**
   * Remove a media item by ID
   * @param {string} id - The ID of the item to remove
   */
  removeItem(id) {
    this.mediaItems = this.mediaItems.filter((item) => item.id !== id);
  }

  /**
   * Get the HTMLImageElement for a file ID if loaded
   * @param {string} fileId
   * @returns {HTMLImageElement|null}
   */
  getImage(fileId) {
    // If not loaded and not loading, trigger load
    if (!this.images.has(fileId) && !this.loading.has(fileId)) {
      this._loadImage(fileId);
    }
    return this.images.get(fileId) || null;
  }

  /**
   * Check if a point intersects with any media item
   * @param {number} x - Content X coordinate
   * @param {number} y - Content Y coordinate
   * @returns {Object|null} The intersected media item or null
   */
  hitTest(x, y) {
    // Iterate in reverse to find top-most item (rendered last)
    for (let i = this.mediaItems.length - 1; i >= 0; i--) {
      const item = this.mediaItems[i];
      if (x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height) {
        return item;
      }
    }
    return null;
  }

  /**
   * Load image data from storage
   * @private
   */
  async _loadImage(fileId) {
    if (this.loading.has(fileId) || this.images.has(fileId)) return;

    this.loading.add(fileId);
    try {
      const blob = await getFile(fileId);
      if (blob) {
        const url = URL.createObjectURL(blob);
        this.blobUrls.set(fileId, url);

        const img = new Image();
        img.onload = () => {
          this.images.set(fileId, img);
          this.loading.delete(fileId);
          if (this.onImageLoaded) this.onImageLoaded();
        };
        img.onerror = (e) => {
          console.error(`[MediaManager] Failed to load image ${fileId}`, e);
          this.loading.delete(fileId);
          // Revoke blob URL to prevent memory leak on error
          URL.revokeObjectURL(url);
          this.blobUrls.delete(fileId);
        };
        img.src = url;
      } else {
        console.warn(`[MediaManager] File not found in storage: ${fileId}`);
        this.loading.delete(fileId);
      }
    } catch (error) {
      console.error(`[MediaManager] Error loading file ${fileId}:`, error);
      this.loading.delete(fileId);
    }
  }

  /**
   * Clean up resources (revoke blob URLs)
   */
  destroy() {
    for (const url of this.blobUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.blobUrls.clear();
    this.images.clear();
    this.loading.clear();
  }
}
