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

    // Bumped on every structural change to mediaItems (add/remove/reorder/
    // geometry update). Consumers derive per-draw data from this list — the
    // renderer caches PDF page bounds, which are hit once per stroke on a hot
    // path — and compare this counter to know when their cache is stale.
    // A counter rather than callbacks: mutations happen from many places
    // (undo/redo commands, sync, direct edits), and each new call site would
    // otherwise have to remember to notify.
    this.version = 0;

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
   * Set all media items (replace existing)
   * @param {Array} items
   */
  setItems(items) {
    this.mediaItems = items || [];
    this.version++;
    // Trigger load for image items only — pdf-page items are rendered via pdfManager, not as <img>
    for (const item of this.mediaItems) {
      if (item.fileId && item.type === "image") {
        this._loadImage(item.fileId);
      }
    }
  }

  /**
   * Add a new media item
   */
  addItem(item) {
    this.mediaItems.push(item);
    this.version++;
    // Trigger load immediately for image items only
    if (item.fileId && item.type === "image") {
      this._loadImage(item.fileId);
    }
  }

  /**
   * Remove a media item by ID
   * @param {string} id - The ID of the item to remove
   */
  removeItem(id) {
    // Find the item to get its fileId before removal
    const item = this.mediaItems.find((i) => i.id === id);

    // Clean up blob URL to prevent memory leak
    if (item?.fileId) {
      const blobUrl = this.blobUrls.get(item.fileId);
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        this.blobUrls.delete(item.fileId);
      }
      this.images.delete(item.fileId);
      this.loading.delete(item.fileId);
    }

    this.mediaItems = this.mediaItems.filter((i) => i.id !== id);
    this.version++;
  }

  /**
   * Move an item to the front (end of array)
   * @param {string} id
   */
  moveItemToFront(id) {
    const index = this.mediaItems.findIndex((item) => item.id === id);
    if (index !== -1 && index < this.mediaItems.length - 1) {
      const item = this.mediaItems.splice(index, 1)[0];
      this.mediaItems.push(item);
      this.version++;
    }
  }

  /**
   * Move an item to the back (start of array)
   * @param {string} id
   */
  moveItemToBack(id) {
    const index = this.mediaItems.findIndex((item) => item.id === id);
    if (index !== -1 && index > 0) {
      const item = this.mediaItems.splice(index, 1)[0];
      this.mediaItems.unshift(item);
      this.version++;
    }
  }

  /**
   * Update an item's properties
   * @param {string} id
   * @param {Object} updates
   */
  updateItem(id, updates) {
    const item = this.mediaItems.find((i) => i.id === id);
    if (item) {
      Object.assign(item, updates);
      this.version++;
    }
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
   * Check if a point intersects with any media item (accounts for rotation)
   * @param {number} x - Content X coordinate
   * @param {number} y - Content Y coordinate
   * @returns {Object|null} The intersected media item or null
   */
  hitTest(x, y) {
    // Iterate in reverse to find top-most item (rendered last)
    for (let i = this.mediaItems.length - 1; i >= 0; i--) {
      const item = this.mediaItems[i];

      // Calculate center of the item
      const cx = item.x + item.width / 2;
      const cy = item.y + item.height / 2;

      // If item has rotation, transform the test point into the item's local coordinate space
      let localX = x;
      let localY = y;

      if (item.rotation) {
        // Rotate the point around the item's center by -rotation to get local coords
        const rad = (-item.rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const dx = x - cx;
        const dy = y - cy;
        localX = cx + dx * cos - dy * sin;
        localY = cy + dx * sin + dy * cos;
      }

      // Now check if local point is within the unrotated bounding box
      if (
        localX >= item.x &&
        localX <= item.x + item.width &&
        localY >= item.y &&
        localY <= item.y + item.height
      ) {
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
