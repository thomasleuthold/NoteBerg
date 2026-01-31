/**
 * SpatialIndex - Y-axis bucket indexing for efficient stroke queries
 *
 * Divides the document into horizontal buckets and indexes strokes by their
 * Y-coordinate range. Enables O(1) lookup for strokes visible in a viewport.
 */

export class SpatialIndex {
  /**
   * @param {number} bucketHeight - Height of each bucket in pixels (typically viewport height)
   */
  constructor(bucketHeight = 800) {
    this.bucketHeight = Math.max(100, bucketHeight); // Ensure minimum height to prevent infinite loops
    this.buckets = new Map(); // bucketId -> Set of stroke indices
    this.strokeBounds = new Map(); // strokeIndex -> { minY, maxY }
    this.totalStrokes = 0;
  }

  /**
   * Build the index from an array of strokes
   * @param {Array} strokes - Array of stroke objects with x[], y[], width properties
   */
  build(strokes) {
    this.clear();
    this.totalStrokes = strokes.length;

    for (let i = 0; i < strokes.length; i++) {
      const stroke = strokes[i];
      const bounds = this._getStrokeBounds(stroke);

      if (!bounds) continue;

      // Store bounds for later filtering
      this.strokeBounds.set(i, bounds);

      // Calculate which buckets this stroke spans
      const startBucket = Math.floor(bounds.minY / this.bucketHeight);
      const endBucket = Math.floor(bounds.maxY / this.bucketHeight);

      // Add stroke index to all overlapping buckets
      for (let bucket = startBucket; bucket <= endBucket; bucket++) {
        if (!this.buckets.has(bucket)) {
          this.buckets.set(bucket, new Set());
        }
        this.buckets.get(bucket).add(i);
      }
    }
  }

  /**
   * Insert a single stroke into the index
   * @param {Object} stroke - Stroke object
   * @param {number} index - Index of the stroke in the strokes array
   */
  insert(stroke, index) {
    const bounds = this._getStrokeBounds(stroke);
    if (!bounds) return;

    this.strokeBounds.set(index, bounds);
    this.totalStrokes = Math.max(this.totalStrokes, index + 1);

    const startBucket = Math.floor(bounds.minY / this.bucketHeight);
    const endBucket = Math.floor(bounds.maxY / this.bucketHeight);

    for (let bucket = startBucket; bucket <= endBucket; bucket++) {
      if (!this.buckets.has(bucket)) {
        this.buckets.set(bucket, new Set());
      }
      this.buckets.get(bucket).add(index);
    }
  }

  /**
   * Remove a single stroke from the index
   * @param {number} index - Index of the stroke to remove
   */
  remove(index) {
    const bounds = this.strokeBounds.get(index);
    if (!bounds) return;

    const startBucket = Math.floor(bounds.minY / this.bucketHeight);
    const endBucket = Math.floor(bounds.maxY / this.bucketHeight);

    for (let bucket = startBucket; bucket <= endBucket; bucket++) {
      if (this.buckets.has(bucket)) {
        this.buckets.get(bucket).delete(index);
      }
    }
    this.strokeBounds.delete(index);
  }

  /**
   * Query for stroke indices that may be visible in the given Y range
   * Optimized to avoid Set allocation and O(n log n) sort on every call
   * @param {number} viewportTop - Top Y coordinate of viewport
   * @param {number} viewportBottom - Bottom Y coordinate of viewport
   * @returns {number[]} Array of stroke indices that intersect the viewport
   */
  query(viewportTop, viewportBottom) {
    const startBucket = Math.floor(viewportTop / this.bucketHeight);
    const endBucket = Math.floor(viewportBottom / this.bucketHeight);

    // Use a seen array to deduplicate (avoids Set allocation in hot path)
    // Reuse the buffer if possible to reduce GC pressure
    if (!this._seenBuffer || this._seenBuffer.length < this.totalStrokes) {
      this._seenBuffer = new Uint8Array(Math.max(this.totalStrokes, 1000));
    }
    const seen = this._seenBuffer;

    // Collect candidates from all overlapping buckets
    const result = [];
    for (let bucket = startBucket; bucket <= endBucket; bucket++) {
      const bucketStrokes = this.buckets.get(bucket);
      if (bucketStrokes) {
        for (const strokeIndex of bucketStrokes) {
          if (!seen[strokeIndex]) {
            seen[strokeIndex] = 1;
            const bounds = this.strokeBounds.get(strokeIndex);
            if (bounds && bounds.maxY >= viewportTop && bounds.minY <= viewportBottom) {
              result.push(strokeIndex);
            }
          }
        }
      }
    }

    // Clear seen flags for next query (only clear used indices)
    for (const idx of result) {
      seen[idx] = 0;
    }
    // Also clear any candidates that didn't pass bounds check
    for (let bucket = startBucket; bucket <= endBucket; bucket++) {
      const bucketStrokes = this.buckets.get(bucket);
      if (bucketStrokes) {
        for (const strokeIndex of bucketStrokes) {
          seen[strokeIndex] = 0;
        }
      }
    }

    // Strokes are already mostly in draw order since buckets store them by insertion.
    // Only sort if we have strokes from multiple buckets that might be out of order.
    // For most cases, insertion sort would be O(n) on nearly-sorted data,
    // but we can skip entirely if single bucket or result is small.
    if (result.length > 1 && endBucket > startBucket) {
      // Use insertion sort - O(n) for nearly-sorted data (much faster than quicksort)
      for (let i = 1; i < result.length; i++) {
        const key = result[i];
        let j = i - 1;
        while (j >= 0 && result[j] > key) {
          result[j + 1] = result[j];
          j--;
        }
        result[j + 1] = key;
      }
    }

    return result;
  }

  /**
   * Get the content bounds (min/max X and Y of all strokes)
   * @returns {{ minX: number, maxX: number, minY: number, maxY: number } | null}
   */
  getContentBounds() {
    if (this.strokeBounds.size === 0) return null;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const bounds of this.strokeBounds.values()) {
      minX = Math.min(minX, bounds.minX);
      maxX = Math.max(maxX, bounds.maxX);
      minY = Math.min(minY, bounds.minY);
      maxY = Math.max(maxY, bounds.maxY);
    }

    return { minX, maxX, minY, maxY };
  }

  /**
   * Update bucket height and rebuild index
   * @param {number} newBucketHeight
   * @param {Array} strokes - Original strokes array to rebuild from
   */
  setBucketHeight(newBucketHeight, strokes) {
    this.bucketHeight = Math.max(100, newBucketHeight); // Ensure minimum height
    this.build(strokes);
  }

  /**
   * Clear all index data
   */
  clear() {
    this.buckets.clear();
    this.strokeBounds.clear();
    this.totalStrokes = 0;
  }

  /**
   * Calculate the bounding box for a stroke
   * @private
   * @param {Object} stroke - Stroke object with x[], y[] and width properties
   * @returns {{ minX: number, maxX: number, minY: number, maxY: number } | null}
   */
  _getStrokeBounds(stroke) {
    if (!stroke.x || !stroke.y || stroke.y.length === 0) return null;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < stroke.y.length; i++) {
      const x = stroke.x[i];
      const y = stroke.y[i];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }

    // Add padding for stroke width
    const padding = (stroke.width || 2) / 2;
    minX -= padding;
    maxX += padding;
    minY -= padding;
    maxY += padding;

    return { minX, maxX, minY, maxY };
  }

  /**
   * Get statistics about the index (useful for debugging)
   * @returns {Object}
   */
  getStats() {
    let maxBucketSize = 0;
    let totalEntries = 0;

    for (const bucket of this.buckets.values()) {
      maxBucketSize = Math.max(maxBucketSize, bucket.size);
      totalEntries += bucket.size;
    }

    return {
      bucketCount: this.buckets.size,
      bucketHeight: this.bucketHeight,
      totalStrokes: this.totalStrokes,
      maxBucketSize,
      avgBucketSize: this.buckets.size > 0 ? totalEntries / this.buckets.size : 0,
    };
  }
}
