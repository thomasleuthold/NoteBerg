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
      // Soft-deleted strokes stay in noteData.strokes (undo needs them, and the
      // array index is the index key), but they must never enter a bucket:
      // query() walks every reference it finds and the renderer only filters
      // _deleted afterwards, so indexing them makes every frame pay for content
      // that is not drawn.
      if (stroke?._deleted || stroke?.isDeleted) continue;
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
    // Mirrors build(): never index a soft-deleted stroke. Callers re-insert on
    // undo (DrawStrokeCommand/EraseStrokesCommand clear _deleted first), so
    // skipping here cannot strand a stroke that should be visible.
    if (stroke?._deleted || stroke?.isDeleted) return;
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
      const entries = this.buckets.get(bucket);
      if (!entries) continue;
      entries.delete(index);
      // Drop the bucket once it is empty — query() iterates the bucket range and
      // would otherwise keep visiting Sets that can never yield a hit.
      if (entries.size === 0) this.buckets.delete(bucket);
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

    // Collect candidates from all overlapping buckets.
    // `touched` records every index whose seen-flag was set, so the reset below
    // is a single pass over exactly those entries. Previously the reset walked
    // the result and then re-walked every bucket again, making the cleanup cost
    // as much as the query itself on stroke-heavy notes.
    const result = [];
    if (!this._touchedBuffer) this._touchedBuffer = [];
    const touched = this._touchedBuffer;
    touched.length = 0;

    for (let bucket = startBucket; bucket <= endBucket; bucket++) {
      const bucketStrokes = this.buckets.get(bucket);
      if (bucketStrokes) {
        for (const strokeIndex of bucketStrokes) {
          if (!seen[strokeIndex]) {
            seen[strokeIndex] = 1;
            touched.push(strokeIndex);
            const bounds = this.strokeBounds.get(strokeIndex);
            if (bounds && bounds.maxY >= viewportTop && bounds.minY <= viewportBottom) {
              result.push(strokeIndex);
            }
          }
        }
      }
    }

    // Reset seen flags for the next query — exactly the indices we set.
    for (let i = 0; i < touched.length; i++) {
      seen[touched[i]] = 0;
    }
    touched.length = 0;

    // Draw order IS array order, so the result must always be sorted ascending.
    // A single bucket used to be safe to skip because indices were only ever
    // appended in ascending order — but undoing an erase re-inserts an older
    // index, which lands at the END of the bucket's Set. Skipping the sort then
    // renders the restored stroke on top of strokes drawn after it, until the
    // next full build(). Insertion sort is O(n) on already-sorted input, so
    // always running it costs almost nothing in the common case.
    if (result.length > 1) {
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
