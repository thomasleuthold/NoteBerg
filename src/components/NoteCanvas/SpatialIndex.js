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
    this.bucketHeight = bucketHeight;
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
   * Query for stroke indices that may be visible in the given Y range
   * @param {number} viewportTop - Top Y coordinate of viewport
   * @param {number} viewportBottom - Bottom Y coordinate of viewport
   * @returns {number[]} Array of stroke indices that intersect the viewport
   */
  query(viewportTop, viewportBottom) {
    const startBucket = Math.floor(viewportTop / this.bucketHeight);
    const endBucket = Math.floor(viewportBottom / this.bucketHeight);

    // Collect all candidate stroke indices from overlapping buckets
    const candidates = new Set();
    for (let bucket = startBucket; bucket <= endBucket; bucket++) {
      const bucketStrokes = this.buckets.get(bucket);
      if (bucketStrokes) {
        for (const strokeIndex of bucketStrokes) {
          candidates.add(strokeIndex);
        }
      }
    }

    // Filter candidates to only those that actually intersect the viewport
    const result = [];
    for (const strokeIndex of candidates) {
      const bounds = this.strokeBounds.get(strokeIndex);
      if (bounds && bounds.maxY >= viewportTop && bounds.minY <= viewportBottom) {
        result.push(strokeIndex);
      }
    }

    // Sort by index to maintain draw order
    result.sort((a, b) => a - b);

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
    this.bucketHeight = newBucketHeight;
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
   * Calculate the Y-axis bounding box for a stroke
   * @private
   * @param {Object} stroke - Stroke object with y[] and width properties
   * @returns {{ minY: number, maxY: number } | null}
   */
  _getStrokeBounds(stroke) {
    if (!stroke.y || stroke.y.length === 0) return null;

    let minY = Infinity;
    let maxY = -Infinity;

    for (const y of stroke.y) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }

    // Add padding for stroke width
    const padding = (stroke.width || 2) / 2;
    minY -= padding;
    maxY += padding;

    return { minY, maxY };
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
