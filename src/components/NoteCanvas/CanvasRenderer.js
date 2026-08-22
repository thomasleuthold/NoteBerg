/**
 * CanvasRenderer - Sliding buffer canvas with leapfrog technique
 *
 * Manages a canvas sized to 3x viewport height. Uses CSS translateY for
 * smooth scrolling within the buffer, and repositions + redraws when
 * scroll exceeds the safe zone (leapfrog).
 */

import {
  clearRenderCache,
  getRenderCacheKey,
  getRenderedMedia,
  setPinnedRenderKeys,
} from "../../modules/mediaManager.js";

/** On-screen width of the bar marking an approximate hit, in CSS px. */
const APPROX_MARKER_WIDTH = 6;

import { getPdfInvertDarkMode, getTheme } from "../../modules/theme.js";
import {
  MARKER_ALPHA,
  drawBackgroundPattern as sharedDrawBackgroundPattern,
  drawStroke as sharedDrawStroke,
  getMarkerPalette as sharedGetMarkerPalette,
  getPressureWidth as sharedGetPressureWidth,
  getThemePalette as sharedGetThemePalette,
} from "../../utils/noteRenderer.js";
import {
  getMediaHandles,
  getSelectionHandles,
  MEDIA_HANDLE_SIZE,
  SELECTION_HANDLE_SIZE,
} from "./NoteCanvas.js";

// PDF page render retry policy. A failed page render is usually transient (the
// PDF binary is still syncing, or a large page momentarily failed to allocate),
// so failures are retried with exponential backoff rather than latched forever.
// Capped so a genuinely undecodable page stops retrying and shows the error
// indicator instead of spinning: 2s + 4s + 8s ≈ 14s of grace.
const MAX_PDF_RENDER_ATTEMPTS = 3;
const PDF_RENDER_RETRY_BASE_MS = 2000;

// Smallest screen-space viewport dimension the buffer will be sized for. Guards
// against a degenerate (zero or negative) buffer, which cannot be painted into
// and composites as an all-black canvas. Only reachable via a collapsed
// container, since the buffer is sized in screen pixels and never divided by
// zoom.
const MIN_VIEWPORT_SIZE = 1;

// Bitmap dimensions are rounded up to a multiple of this many device pixels.
// Without it, every pointermove of a pinch would land on a slightly different
// bitmap size and reallocate several megabytes — and each reallocation discards
// the painted buffer. 256 keeps the waste under a few percent while making
// small zoom deltas free.
const BITMAP_SIZE_QUANTUM = 256;

// Hard ceiling on the buffer bitmap, in device pixels of area.
//
// Browsers cap the total area of a single canvas (~16M px on Chrome/Android,
// lower on some devices). Past the cap the backing store is silently dropped:
// the width/height assignment appears to succeed but every later draw is a
// no-op, leaving a permanently blank canvas — the exact failure the screen-space
// buffer sizing was introduced to make unreachable.
//
// The buffer multipliers below cannot enforce that on their own: they are
// constants, but the bitmap grows with VIEWPORT AREA, so a budget tuned on a
// 400x800 phone is exceeded by an ordinary 1400x900 laptop at dpr 2 (19M px)
// and badly exceeded by a 1920x1080 one (~30M px). This cap is what actually
// bounds the allocation; the multipliers are only a preferred lead-in that the
// cap trims when it does not fit.
const MAX_BITMAP_AREA = 12e6;

// Highlight styles
const HIGHLIGHT_FILL_STYLE = "rgba(255, 255, 0, 0.3)";
const HIGHLIGHT_STROKE_STYLE = "rgba(255, 200, 0, 0.8)";
const HIGHLIGHT_LINE_WIDTH = 2;

/**
 * Draw a list of marker strokes onto ctx, grouping sub-strokes that share a
 * groupId into a single beginPath…stroke() call so their alpha doesn't stack.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object[]} markerStrokes - Array of marker stroke objects
 * @param {string[]} palette - Pen palette, passed through to sharedDrawStroke for single-stroke groups
 * @param {Set<string>} [selectedIds] - Set of selected stroke IDs (for selection highlight)
 * @param {(stroke: object) => string[]} [getMarkerColorsForStroke] - Resolves the marker
 *   palette to use for a given stroke (defaults to the live theme marker palette).
 *   Lets callers use the light palette for strokes on an un-inverted PDF page.
 */
function drawMarkersGrouped(
  ctx,
  markerStrokes,
  palette,
  selectedIds = null,
  getMarkerColorsForStroke = null,
) {
  if (markerStrokes.length === 0) return;

  // Group by groupId, falling back to individual stroke id
  const groups = new Map(); // key -> stroke[]
  const groupOrder = [];
  for (const stroke of markerStrokes) {
    const key = stroke.groupId || stroke.id;
    if (!groups.has(key)) {
      groups.set(key, []);
      groupOrder.push(key);
    }
    groups.get(key).push(stroke);
  }

  for (const key of groupOrder) {
    const group = groups.get(key);
    const first = group[0];
    const isSelected = selectedIds != null && group.some((s) => selectedIds.has(s.id));
    // All sub-strokes in a group share one drawn path/color; the group's first
    // stroke position decides which palette the whole group uses.
    const colors = getMarkerColorsForStroke
      ? getMarkerColorsForStroke(first)
      : sharedGetMarkerPalette();

    if (group.length === 1) {
      // Single stroke — delegate to shared draw (handles edge cases)
      sharedDrawStroke(ctx, first, palette, isSelected, false, colors);
    } else {
      // Multiple sub-strokes from the same original — draw as one flat-alpha path.
      // Selection underline pass (drawn at full opacity beneath the marker color).
      if (isSelected) {
        ctx.save();
        ctx.strokeStyle = "rgba(0, 100, 255, 0.7)";
        ctx.lineWidth = (first.width || 2) + 4;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        for (const s of group) {
          ctx.moveTo(s.x[0], s.y[0]);
          for (let i = 1; i < s.x.length; i++) {
            ctx.lineTo(s.x[i], s.y[i]);
          }
        }
        ctx.stroke();
        ctx.restore();
      }

      const color = first.colorIndex !== undefined ? colors[first.colorIndex] : colors[0];

      ctx.save();
      ctx.globalAlpha = MARKER_ALPHA;
      ctx.strokeStyle = color;
      ctx.lineWidth = first.width || 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (const s of group) {
        ctx.moveTo(s.x[0], s.y[0]);
        for (let i = 1; i < s.x.length; i++) {
          ctx.lineTo(s.x[i], s.y[i]);
        }
      }
      ctx.stroke();
      ctx.restore();
    }
  }
}

/**
 * Geometry of the margin bar marking an approximately-located search hit.
 *
 * Anchored to the buffer's own left edge rather than the viewport's. The buffer
 * is a window of content wider than the viewport, repositioned only when
 * scrolling leaves its bounds; anchoring to the viewport would need a repaint on
 * every horizontal scroll, and a plain repaint leaves the buffer's painted
 * window where it was, exposing unpainted canvas. Anchoring to the buffer keeps
 * the bar inside the painted region with no extra redraw.
 *
 * Pure, and exported, so the rule survives a test without standing up a canvas.
 *
 * @param {{y: number, h: number}} rect - band bounds in content space
 * @param {{bufferLeft: number, zoom: number}} view
 * @returns {{x: number, y: number, w: number, h: number}} in content space
 */
export function approximateMarkerBar(rect, view) {
  return {
    x: view.bufferLeft,
    y: rect.y,
    // Divided by zoom so the on-screen thickness stays constant: without it the
    // bar balloons when zoomed in and vanishes when zoomed out.
    w: APPROX_MARKER_WIDTH / (view.zoom || 1),
    h: rect.h,
  };
}

export class CanvasRenderer {
  /**
   * @param {HTMLElement} viewportElement - Element to mount canvas into
   * @param {Object} options
   * @param {number} options.maxContentWidth - Maximum content width (default 1200)
   */
  constructor(viewportElement, options = {}) {
    this.viewportElement = viewportElement;
    this.maxContentWidth = options.maxContentWidth || 1200;

    // Canvas elements
    this.canvas = null;
    this.ctx = null;
    this.overlayCanvas = null;
    this.overlayCtx = null;

    // Buffer state.
    //
    // The buffer is sized in SCREEN pixels: it covers the visible viewport times
    // bufferMultiplier on each axis, and its bitmap dimensions never depend on
    // zoomScale. Sizing it in content space (screen / zoom) is what previously
    // made the bitmap grow without bound on zoom-out — past the browser's canvas
    // area cap Chrome silently drops the backing store and every later draw
    // becomes a no-op. Screen-space sizing makes that unreachable by
    // construction rather than by a clamp.
    //
    // bufferLeft/bufferTop are the buffer's origin in CONTENT coordinates;
    // bufferWidth/bufferHeight are its extent in CONTENT coordinates. Both axes
    // leapfrog symmetrically.
    this.bufferLeft = 0;
    this.bufferTop = 0;
    this.bufferWidth = 0;
    this.bufferHeight = 0;
    // How many viewports the buffer covers on each axis.
    //
    // Vertical gets the generous lead-in because scrolling is overwhelmingly
    // vertical: the slack above and below the viewport is what a scroll can
    // consume before the buffer has to be repositioned and every stroke and
    // image redrawn. Too little and a normal flick leapfrogs every few frames,
    // which reads as the content jumping.
    //
    // Horizontal gets much less: it only needs enough to cover a pan between
    // redraws, whereas vertical lead-in is what a scroll actually consumes.
    // Measured at dpr 3 / zoom 4 over a 60-frame flick on a 400x800 viewport:
    //
    //   4 x 1.5  -> 2 leapfrogs
    //   4 x 1.25 -> 2 leapfrogs  <- chosen
    //   3 x 1.5  -> 4 leapfrogs
    //
    // These are a PREFERRED lead-in, not a memory budget. The two multiply into
    // the bitmap area, which also grows with viewport area, so they cannot bound
    // the allocation by themselves — MAX_BITMAP_AREA does that, trimming the
    // vertical lead-in on large viewports where the full multiplier would not fit.
    this.bufferMultiplier = 4;
    this.bufferMultiplierX = 1.25;

    // Viewport state, in SCREEN pixels.
    this.screenViewportWidth = 0;
    this.screenViewportHeight = 0;

    // Zoom state
    this.zoomScale = 1.0;
    // The zoom the buffer bitmap was last drawn at. Equals zoomScale except
    // during a pinch, where the redraw is deferred and _slideCanvas scales the
    // stale bitmap by the ratio in the meantime.
    this.renderedZoom = 1.0;
    // Device pixels per CSS pixel for the buffer bitmap. The buffer is sized in
    // screen space, so it only ever needs the display's own pixel density —
    // there is no zoom term, and therefore no quadratic growth to cap.
    this.resolutionScale = 1.0;

    // Content data
    this.strokes = [];
    this.background = "none";
    this.spatialIndex = null;
    this.mediaManager = null; // Reference to MediaManager
    this.palette = null;
    this.markerPalette = null;
    this.activeStroke = null; // Stroke currently being drawn
    this.selectedStrokeIndices = new Set();
    this.activeStrokeId = null; // ID of the stroke currently being drawn incrementally
    this._activeStrokeColor = null; // Resolved colour of activeStrokeId (see drawDirectStroke)
    this.selectedMediaId = null; // ID of selected media item
    this.lastDrawnPointIndex = 0; // Index of the last point processed in the active stroke
    this.selectionBounds = null;
    this.lineSeparators = []; // Y positions (content coords) of detected line separators
    this.lineIndentLevels = []; // indent level per line band (0 = base, 1 = indented)
    this.highlightRects = []; // Search term highlights
    this.showA4PageBreaks = false; // Show A4 page break lines when no PDF is imported

    // Content bounds
    this.contentWidth = 0;
    this.contentHeight = 0;

    // Scroll state for overlay drawing
    this.contentScrollTop = 0;
    this.contentScrollLeft = 0;

    // Performance tracking
    this.lastRenderTime = 0;

    // Zoom debounce
    this.zoomRenderTimeout = null;
    this.zoomRenderDebounce = 150; // ms

    // Quality rendering debounce (for scroll performance)
    // During scroll, render in fast mode (no pressure). After scroll stops, re-render with full quality.
    this._qualityRenderTimeout = null;
    this._qualityRenderDebounce = 150; // ms after scroll stops
    this._lastRenderWasFastMode = false;

    // PDF Loading Semaphore
    this.activePdfLoads = 0;
    this.maxConcurrentPdfLoads = 2;
    this._pdfQueueCheckTimeout = null;

    // rAF handle for the spinner drawn over media placeholders while an image
    // insert is still processing. Null whenever no insert is in flight.
    this._pendingMediaRaf = null;

    // Reused buffer for the on-screen PDF cache keys handed to
    // setPinnedRenderKeys each repaint (see _drawMedia). Its contents are
    // consumed synchronously, so a single array can be refilled every frame.
    this._pinnedKeyScratch = [];

    // Invalidation token for in-flight async PDF renders. Bumped whenever the
    // render target changes in a way that makes a pending result obsolete
    // (zoom/resolution change, item memory release, theme-driven invalidation).
    // A render that resolves against a stale generation is discarded rather than
    // written to item.renderable: assigning a bitmap rendered for a superseded
    // scale left _drawPdfPage permanently seeing renderableScale !== resolutionScale,
    // so it re-requested the page every frame and the view stopped converging —
    // the "zoom gets stuck" symptom.
    this._renderGeneration = 0;

    // Track if initial draw has happened
    this._needsInitialDraw = true;

    // Initialize
    this._createCanvas();
  }

  /**
   * Create the canvas element
   * @private
   */
  _createCanvas() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "sliding-buffer-canvas";

    // The buffer deliberately does NOT request the `desynchronized` low-latency
    // hint. It saves roughly one frame of stylus latency, but it also promotes
    // the canvas onto its own compositing plane, where the element's CSS
    // background no longer shows through and any moment the bitmap is not fully
    // painted composites as solid BLACK rather than as the page colour.
    //
    // On Chrome for Android that turned every transient paint gap into a visible
    // failure — a black note, and later a black flicker while scrolling and
    // zooming — while Firefox, which ignores the hint, stayed readable through
    // the same states. One frame of latency is not worth a rendering mode where
    // ordinary races are catastrophic instead of invisible.
    this.ctx = this.canvas.getContext("2d");
    this.viewportElement.appendChild(this.canvas);

    // Create overlay canvas for UI (cursor, selection)
    this.overlayCanvas = document.createElement("canvas");
    this.overlayCanvas.className = "note-canvas__overlay";
    this.overlayCtx = this.overlayCanvas.getContext("2d");
    this.viewportElement.appendChild(this.overlayCanvas);
  }

  /**
   * Set the data to render
   * @param {Array} strokes - Array of stroke objects
   * @param {string} background - Background pattern type
   */
  setData(strokes, background) {
    this.strokes = strokes || [];
    this.background = background || "none";
    this.palette = sharedGetThemePalette();
    this.markerPalette = sharedGetMarkerPalette();
  }

  /**
   * Set selected media item
   * @param {string|null} id
   */
  setSelectedMedia(id) {
    this.selectedMediaId = id;
    this.forceRedraw();
  }

  /**
   * Set selected strokes and their bounding box
   * @param {Set<number>} selectedIndices
   * @param {Object|null} bounds - {minX, minY, maxX, maxY}
   */
  setSelectedStrokes(selectedIndices, bounds) {
    this.selectedStrokeIndices = selectedIndices;
    this.selectionBounds = bounds;
    if (!bounds) {
      this.lineSeparators = [];
      this.lineIndentLevels = [];
    }
    this.forceRedraw();
  }

  /**
   * Set detected line separator Y positions and per-line indent levels for debug visualization.
   * @param {number[]} separatorYs - Y positions in content coordinates
   * @param {number[]} indentLevels - indent level per line band (0 = base, 1 = indented)
   */
  setLineSeparators(separatorYs, indentLevels = []) {
    this.lineSeparators = separatorYs;
    this.lineIndentLevels = indentLevels;
    this.forceRedraw();
  }

  /**
   * Draw the marker for an approximately-located search hit.
   *
   * Deliberately a margin bar rather than a tint over the text: the location is
   * a band, not a word, and shading the content implies the match is somewhere
   * under the shading — which is only loosely true and makes the handwriting
   * harder to read.
   *
   * Coloured like an exact match, not like its band: band colours are internal
   * plumbing for the model and mean nothing to the user, so showing six different
   * highlight colours would imply a distinction that does not exist.
   *
   * @param {{y: number, h: number}} rect - band bounds in content space
   * @private
   */
  _drawApproximateMarker(rect) {
    const bar = approximateMarkerBar(rect, {
      bufferLeft: this.bufferLeft,
      zoom: this.zoomScale || 1,
    });

    this.ctx.save();
    this.ctx.fillStyle = HIGHLIGHT_STROKE_STYLE;
    this.ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
    this.ctx.restore();
  }

  /**
   * Set highlight rectangles
   * @param {Array<{x, y, w, h}>} rects
   */
  setHighlights(rects) {
    this.highlightRects = rects || [];
    this.forceRedraw();
  }

  /**
   * Set the spatial index for efficient queries
   * @param {SpatialIndex} index
   */
  setSpatialIndex(index) {
    this.spatialIndex = index;
  }

  /**
   * Set the media manager
   * @param {MediaManager} manager
   */
  setMediaManager(manager) {
    this.mediaManager = manager;
  }

  /**
   * Set the total content dimensions
   * @param {number} width
   * @param {number} height
   */
  setContentSize(width, height) {
    this.contentWidth = width;
    this.contentHeight = height;
  }

  /**
   * Resize the canvas for the given viewport dimensions
   * @param {number} width - Viewport width (screen pixels)
   * @param {number} height - Viewport height (screen pixels)
   */
  resize(width, height) {
    this.screenViewportWidth = Math.max(MIN_VIEWPORT_SIZE, width);
    this.screenViewportHeight = Math.max(MIN_VIEWPORT_SIZE, height);
    this._updateBufferExtent();

    // Resize overlay to match screen viewport exactly
    this.overlayCanvas.width = Math.max(1, Math.round(this.screenViewportWidth));
    this.overlayCanvas.height = Math.max(1, Math.round(this.screenViewportHeight));

    // Track if canvas bitmap dimensions actually changed (which clears the canvas)
    const oldWidth = this.canvas.width;
    const oldHeight = this.canvas.height;

    this._resizeCanvasBitmap();

    // If canvas was resized, it was cleared by the browser - mark that we need a redraw
    // The next render() call will trigger _repositionBuffer via _needsInitialDraw
    if (this.canvas.width !== oldWidth || this.canvas.height !== oldHeight) {
      this._needsInitialDraw = true;
    }
  }

  /**
   * Derive the buffer's content-space extent from the screen viewport.
   *
   * This is the single place buffer size is decided. The bitmap covers
   * bufferMultiplier screen viewports on each axis, so its pixel dimensions are
   * constant with respect to zoom; only the amount of CONTENT it spans changes
   * (a screen pixel is 1/zoom content pixels). Width is additionally capped at
   * the note width, so a narrow note never allocates beyond its own content.
   * @private
   */
  _updateBufferExtent() {
    const zoom = this.zoomScale || 1;
    const contentViewportWidth = this.screenViewportWidth / zoom;
    const contentViewportHeight = this.screenViewportHeight / zoom;
    // Must match what _resizeCanvasBitmap allocates at, or the extent and the
    // bitmap disagree about how much content a device pixel covers.
    const dpr = this._getEffectiveResolutionScale();

    // Cap width at the note's own width — a narrow note never needs a buffer
    // wider than its content, and capping here means no horizontal leapfrog is
    // needed at all until the note is genuinely wider than the buffer.
    //
    // Both terms are content-space, so the cap holds in SCREEN space too: the
    // bitmap is (bufferWidth * zoom * dpr) and the multiplier term contributes
    // exactly screenViewportWidth * bufferMultiplierX * dpr regardless of zoom.
    // Capping against maxContentWidth can only make it smaller, never larger.
    const requestedWidth = Math.min(
      this.maxContentWidth,
      contentViewportWidth * this.bufferMultiplierX,
    );
    const requestedHeight = Math.min(
      Math.max(this.contentHeight, contentViewportHeight),
      contentViewportHeight * this.bufferMultiplier,
    );

    // Clamp to the bitmap area budget.
    //
    // Height gives first, then width: a scroll consumes vertical lead-in, so
    // shortening it only costs more frequent leapfrogs, whereas width barely
    // exceeds what a pan needs. Blowing the cap, by contrast, is a correctness
    // failure — the backing store is dropped and the note composites black.
    //
    // Width has to be in scope rather than assumed safe: at high dpr the
    // note-width cap alone can exceed the budget (1920x1080 at dpr 3 / zoom 2
    // wants 7424 device px of width, which times a single viewport of height is
    // already ~25M px). Neither axis is trimmed below one viewport — when even
    // that floor does not fit, the floor wins and the buffer runs over, since
    // covering the visible region is correctness and the browser's own cap sits
    // well above this budget.
    //
    // The budget is applied to QUANTIZED extents, and each budget-derived extent
    // is floored to a whole quantum, because _quantizeExtent rounds up: sizing
    // against pre-rounding values leaves the real allocation over by up to a
    // quantum per axis, which at dpr 3 is most of a megapixel.
    const scale = zoom * dpr;
    const floorToQuantum = (devicePx) =>
      Math.max(
        BITMAP_SIZE_QUANTUM,
        Math.floor(devicePx / BITMAP_SIZE_QUANTUM) * BITMAP_SIZE_QUANTUM,
      ) / scale;

    let bufferWidth = this._quantizeExtent(requestedWidth, scale);

    // 1. Spend the budget on height first.
    const maxHeightDevicePx = MAX_BITMAP_AREA / (bufferWidth * scale);
    const cappedHeight = Math.max(
      contentViewportHeight,
      Math.min(requestedHeight, floorToQuantum(maxHeightDevicePx)),
    );

    // 2. If the floored height still leaves it over budget, the width is what is
    //    left to give — down to what is actually visible, never past it.
    //
    //    The floor is the visible width capped by the note's own width: past
    //    that cap there is no content to draw, so a wider buffer would be pure
    //    waste. Flooring at the raw viewport width instead would INFLATE the
    //    buffer on a zoomed-out large display, where one viewport spans several
    //    times the note width (3840 content px against a 1200px note).
    const minUsefulWidth = Math.min(contentViewportWidth, this.maxContentWidth);
    const heightDevicePx = this._quantizeExtent(cappedHeight, scale) * scale;
    if (bufferWidth * scale * heightDevicePx > MAX_BITMAP_AREA) {
      const maxWidthDevicePx = MAX_BITMAP_AREA / heightDevicePx;
      bufferWidth = this._quantizeExtent(
        Math.max(minUsefulWidth, Math.min(bufferWidth, floorToQuantum(maxWidthDevicePx))),
        scale,
      );
    }

    // Quantize HERE, not when the bitmap is allocated.
    //
    // Rounding the bitmap up to a whole number of quanta is what stops a
    // continuous pinch from reallocating megabytes per pointermove. But the
    // rounded bitmap covers slightly MORE content than requested, and
    // bufferTop/bufferLeft are centred against the extent. If the extent were
    // adjusted later (inside _resizeCanvasBitmap, which runs on a different
    // schedule than _repositionBuffer), the origin would already have been
    // computed against the pre-rounding value and the content would visibly
    // jump — most obviously on large contiguous objects like images, and worst
    // at high zoom where a fixed device-pixel quantum is many content pixels.
    // Deriving the final extent here keeps a single writer and guarantees the
    // origin is always centred against the extent that is actually drawn.
    this.bufferWidth = bufferWidth;
    this.bufferHeight = this._quantizeExtent(cappedHeight, scale);
  }

  /**
   * Round a content-space extent up so its device-pixel size is a whole number
   * of BITMAP_SIZE_QUANTUM.
   * @private
   * @param {number} contentExtent - Requested extent in content coordinates
   * @param {number} scale - Device pixels per content pixel (zoom * dpr)
   * @returns {number} Quantized extent in content coordinates
   */
  _quantizeExtent(contentExtent, scale) {
    const devicePixels = Math.max(
      BITMAP_SIZE_QUANTUM,
      Math.ceil((contentExtent * scale) / BITMAP_SIZE_QUANTUM) * BITMAP_SIZE_QUANTUM,
    );
    return devicePixels / scale;
  }

  /**
   * Visible viewport size in content coordinates. Derived rather than stored:
   * the buffer is sized in screen space, and this is the only place the zoom
   * division belongs.
   * @private
   * @returns {{width: number, height: number}}
   */
  _getContentViewport() {
    const zoom = this.zoomScale || 1;
    return {
      width: this.screenViewportWidth / zoom,
      height: this.screenViewportHeight / zoom,
    };
  }

  /**
   * Device pixels per CSS pixel to allocate the buffer at.
   *
   * Normally the display's own density. Reduced only when a single viewport at
   * full density would not fit in MAX_BITMAP_AREA on its own — which happens on
   * genuinely large, dense displays (a 4K viewport at dpr 2 needs ~33M device px
   * just to cover what is visible, well past the browser's canvas area cap).
   *
   * The buffer must cover the viewport, so the only remaining variable is how
   * many device pixels each CSS pixel gets. Trading sharpness for a canvas the
   * browser will actually back is strictly better than the alternative: past the
   * cap the backing store is dropped and the note composites solid black.
   * @private
   * @returns {number}
   */
  _getEffectiveResolutionScale() {
    const dpr = window.devicePixelRatio || 1;
    const viewportArea = this.screenViewportWidth * this.screenViewportHeight;
    if (viewportArea <= 0) return dpr;

    // Largest density at which one viewport still fits the budget.
    const maxScale = Math.sqrt(MAX_BITMAP_AREA / viewportArea);
    return Math.min(dpr, Math.max(1, maxScale));
  }

  /**
   * Calculate the X offset for centering the canvas when content is narrower than viewport
   * @private
   * @returns {number} The centering offset in screen pixels
   */
  _getCenteringOffset() {
    const scaledContentWidth = this.maxContentWidth * this.zoomScale;
    if (scaledContentWidth < this.screenViewportWidth) {
      return (this.screenViewportWidth - scaledContentWidth) / 2;
    }
    return 0;
  }

  /**
   * Resize the canvas bitmap based on current dimensions and zoom
   * @private
   */
  _resizeCanvasBitmap() {
    // The buffer spans bufferMultiplier screen viewports, so its bitmap is
    // simply that many screen pixels at the display's pixel density. No zoom
    // term: zooming changes how much CONTENT those pixels show, not how many
    // pixels there are. This is what keeps the allocation bounded — a phone's
    // buffer is a few megapixels at every zoom level, permanently inside the
    // browser's canvas area limit.
    const previousResolutionScale = this.resolutionScale;
    this.resolutionScale = this._getEffectiveResolutionScale();

    // A changed resolution obsoletes every PDF render still in flight: their
    // results would land with renderableScale != resolutionScale and trigger an
    // endless re-request loop. Bumping the generation makes those results drop.
    if (this.resolutionScale !== previousResolutionScale) {
      this._renderGeneration++;
    }

    // Bitmap covers the buffer's screen-space extent. bufferWidth/bufferHeight
    // are content-space, so multiply back by zoom to get screen pixels.
    //
    // Quantized up to a whole number of screen pixels per axis so a continuous
    // pinch does not reallocate a multi-megabyte bitmap on every pointermove.
    // Reallocation also discards the painted buffer, so this is a correctness
    // benefit as much as a performance one.
    // The extent was already quantized by _updateBufferExtent, so this is a
    // straight conversion — no rounding, and crucially no mutation of the
    // buffer extent. _updateBufferExtent is the single writer; anything that
    // adjusted the extent here would invalidate a bufferTop/bufferLeft already
    // centred against it and make the content jump.
    const zoom = this.zoomScale || 1;
    const bitmapWidth = Math.max(1, Math.round(this.bufferWidth * zoom * this.resolutionScale));
    const bitmapHeight = Math.max(1, Math.round(this.bufferHeight * zoom * this.resolutionScale));

    // Only resize if dimensions changed
    if (this.canvas.width !== bitmapWidth || this.canvas.height !== bitmapHeight) {
      this.canvas.width = bitmapWidth;
      this.canvas.height = bitmapHeight;

      // CSS size is derived back from the *rounded* bitmap so the mapping is
      // exactly resolutionScale on both axes and the compositor never resamples.
      this.canvas.style.width = `${bitmapWidth / this.resolutionScale}px`;
      this.canvas.style.height = `${bitmapHeight / this.resolutionScale}px`;
    }

    // Draw in content coordinates: scale by both the device density and the
    // zoom, so a content-space path lands on the right device pixels.
    const drawScale = this.resolutionScale * zoom;
    this.ctx.setTransform(drawScale, 0, 0, drawScale, 0, 0);
  }

  /**
   * Resolve the page background colour painted into the buffer bitmap.
   *
   * Reads the same CSS variable the canvas element used to rely on, so the
   * canvas keeps following the active theme — including Nextcloud's own
   * theming, which overrides these variables server-side. Falls back to the
   * theme's default only when the variable is unavailable (e.g. jsdom).
   * @private
   * @returns {string} A CSS colour string
   */
  _getPageBackgroundColor() {
    const fromCss = getComputedStyle(this.viewportElement).getPropertyValue("--bg-primary")?.trim();
    if (fromCss) return fromCss;
    return getTheme() === "dark" ? "#1e1e2e" : "#ffffff";
  }

  /**
   * Main render method - called on every scroll
   *
   * Viewport SIZE is deliberately not handled here. resize() is the single
   * writer, driven by VirtualScroller's ResizeObserver (and once at mount before
   * the first render). This method used to compare viewportHeight against the
   * stored size and re-run resize() itself — a second owner that fired
   * repeatedly mid-flick on mobile, where the URL bar shows and hides during a
   * scroll. Each one reallocated the bitmap and forced a full buffer repaint at
   * the worst possible moment, duplicating work the ResizeObserver was already
   * about to do.
   * @param {number} scrollTop - Current scroll position (in screen pixels)
   * @param {number} _viewportHeight - Unused; viewport size comes from resize().
   *   Kept so the existing positional call signature stays valid.
   * @param {number} scrollLeft - Current scroll left position (in screen pixels)
   * @param {Object} [activeStroke] - The stroke currently being drawn (optional)
   */
  render(scrollTop, _viewportHeight, scrollLeft = 0, activeStroke = null) {
    // Convert to content coordinates (account for zoom)
    const contentScrollTop = scrollTop / this.zoomScale;
    const contentScrollLeft = scrollLeft / this.zoomScale;

    this.contentScrollTop = contentScrollTop;
    this.contentScrollLeft = contentScrollLeft;

    // Update active stroke reference for redraws
    this.activeStroke = activeStroke;

    // Check if we need to leapfrog (reposition buffer)
    if (this._shouldLeapfrog(contentScrollTop, contentScrollLeft)) {
      this._repositionBuffer(contentScrollTop, true, contentScrollLeft);
    }
    // Always slide the canvas to match scroll position
    this._slideCanvas(contentScrollTop, scrollLeft);

    // If active stroke is marker, update its preview on overlay (to handle scroll/zoom)
    if (this.activeStroke && this.activeStroke.type === "marker") {
      this._drawMarkerPreview(this.activeStroke, false);
    }
  }

  /**
   * Draw a stroke directly to the canvas (for low latency)
   * Uses incremental drawing to avoid overdraw artifacts on the main canvas
   * @param {Object} stroke - Stroke data
   * @param {boolean} isFinished - Whether this is the final draw call for the stroke
   */
  drawDirectStroke(stroke, isFinished = false) {
    if (!this.ctx || !stroke) return;

    // Reset state if this is a new stroke
    if (this.activeStrokeId !== stroke.id) {
      this.activeStrokeId = stroke.id;
      this.lastDrawnPointIndex = 0;
      // The colour a stroke draws in depends only on its start point, the
      // theme, and PDF page layout — none of which change while a single
      // stroke is being drawn. Resolving it per pointer move meant walking
      // every media item and rebuilding a palette array at stylus sample rate.
      // Scoped to this stroke id, so it cannot outlive the stroke.
      this._activeStrokeColor = null;
    }

    // Special handling for markers: draw full path on overlay to avoid alpha accumulation
    if (stroke.type === "marker") {
      this._drawMarkerPreview(stroke, isFinished);
      return;
    }

    const pointCount = stroke.x.length;
    if (pointCount < 2) return;

    this.ctx.save();
    this.ctx.translate(-this.bufferLeft, -this.bufferTop);

    // Setup styles manually since we are drawing incrementally. Resolved once
    // per stroke (see the cache reset above), not once per pointer move.
    if (this._activeStrokeColor === null) {
      const uninvertedPdfBounds = this._getUninvertedPdfBounds();
      const colors = this._strokeNeedsLightPalette(stroke, uninvertedPdfBounds)
        ? sharedGetThemePalette("light")
        : this.palette || sharedGetThemePalette();
      this._activeStrokeColor =
        stroke.colorIndex !== undefined ? colors[stroke.colorIndex] : stroke.color || colors[0];
    }
    this.ctx.strokeStyle = this._activeStrokeColor;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";

    const baseWidth = stroke.width || 2;
    // Shared with the final render (drawStroke) so the live preview and the
    // committed stroke cannot drift apart.
    const getWidth = (p) => sharedGetPressureWidth(p, baseWidth);

    // Start from where we left off
    let i = this.lastDrawnPointIndex;

    // Handle the very first segment (P0 -> Mid(P0, P1))
    if (i === 0) {
      const midX = (stroke.x[0] + stroke.x[1]) / 2;
      const midY = (stroke.y[0] + stroke.y[1]) / 2;
      this.ctx.beginPath();
      this.ctx.lineWidth = getWidth(stroke.pressure[0]);
      this.ctx.moveTo(stroke.x[0], stroke.y[0]);
      this.ctx.lineTo(midX, midY);
      this.ctx.stroke();
      i = 1;
    }

    // Draw curves for new points: Mid(i-1, i) -> P(i) -> Mid(i, i+1)
    for (; i < pointCount - 1; i++) {
      const midPrevX = (stroke.x[i - 1] + stroke.x[i]) / 2;
      const midPrevY = (stroke.y[i - 1] + stroke.y[i]) / 2;
      const midNextX = (stroke.x[i] + stroke.x[i + 1]) / 2;
      const midNextY = (stroke.y[i] + stroke.y[i + 1]) / 2;

      this.ctx.beginPath();
      this.ctx.lineWidth = getWidth(stroke.pressure[i]);
      this.ctx.moveTo(midPrevX, midPrevY);
      this.ctx.quadraticCurveTo(stroke.x[i], stroke.y[i], midNextX, midNextY);
      this.ctx.stroke();
    }

    this.lastDrawnPointIndex = i;

    // Tail segment: Mid(last-1, last) -> P(last).
    //
    // The committed curve above stops at the midpoint between the last two
    // points, so the ink always trails the stylus by roughly half a sample.
    // Drawing the tail on every move (not just on the final call) closes that
    // gap. It is deliberately NOT committed - lastDrawnPointIndex stays put, so
    // the next move re-draws the same region from the same starting geometry.
    // Overdrawing is invisible here because pen strokes are opaque round-capped
    // lines; markers are translucent and would accumulate alpha, but they return
    // early above via _drawMarkerPreview and never reach this path.
    const last = pointCount - 1;
    const prev = last - 1;
    const midX = (stroke.x[prev] + stroke.x[last]) / 2;
    const midY = (stroke.y[prev] + stroke.y[last]) / 2;

    this.ctx.beginPath();
    this.ctx.lineWidth = getWidth(stroke.pressure[last]);
    this.ctx.moveTo(midX, midY);
    this.ctx.lineTo(stroke.x[last], stroke.y[last]);
    this.ctx.stroke();

    if (isFinished) {
      // Reset for next stroke
      this.activeStrokeId = null;
      this.lastDrawnPointIndex = 0;
    }

    this.ctx.restore();
  }

  /**
   * Draw marker preview on overlay canvas
   * @private
   */
  _drawMarkerPreview(stroke, isFinished) {
    // Ensure palette is ready
    if (!this.palette) {
      this.palette = sharedGetThemePalette();
      this.markerPalette = sharedGetMarkerPalette();
    }

    const uninvertedPdfBounds = this._getUninvertedPdfBounds();
    const needsLight = this._strokeNeedsLightPalette(stroke, uninvertedPdfBounds);
    const penPalette = needsLight ? sharedGetThemePalette("light") : this.palette;
    const markerColors = needsLight ? sharedGetMarkerPalette("light") : this.markerPalette;

    if (isFinished) {
      // Final draw: Commit to main canvas
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

      this.ctx.save();
      this.ctx.translate(-this.bufferLeft, -this.bufferTop);
      // Use sharedDrawStroke to ensure consistent rendering with final result
      sharedDrawStroke(this.ctx, stroke, penPalette, false, false, markerColors);
      this.ctx.restore();

      // Reset state
      this.activeStrokeId = null;
      this.lastDrawnPointIndex = 0;
    } else {
      // Preview draw: Draw full stroke on overlay
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

      const offsetX = this._getCenteringOffset();

      this.overlayCtx.save();
      this.overlayCtx.translate(offsetX, 0);
      this.overlayCtx.scale(this.zoomScale, this.zoomScale);
      this.overlayCtx.translate(-this.contentScrollLeft, -this.contentScrollTop);
      sharedDrawStroke(this.overlayCtx, stroke, penPalette, false, false, markerColors);
      this.overlayCtx.restore();
    }
  }

  /**
   * Draw the lasso trail on the overlay canvas
   * @param {Array<{x: number, y: number}>} points - Points in SCREEN coordinates,
   *   relative to the viewport element (as drawEraserCursor takes).
   */
  drawLassoTrail(points) {
    this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    if (points.length < 2) return;

    this.overlayCtx.beginPath();
    this.overlayCtx.strokeStyle = "rgba(0, 100, 255, 0.8)";
    this.overlayCtx.lineWidth = 2;
    this.overlayCtx.setLineDash([5, 5]);

    // `points` are in SCREEN coordinates, matching drawEraserCursor: the overlay
    // canvas bitmap is sized 1:1 with the screen viewport in resize() and carries
    // no CSS transform, so screen coordinates are drawn as-is.
    this.overlayCtx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      this.overlayCtx.lineTo(points[i].x, points[i].y);
    }
    this.overlayCtx.stroke();
    this.overlayCtx.setLineDash([]);
  }

  /**
   * Draw the eraser cursor on the overlay canvas
   * @param {number} x - Screen X coordinate
   * @param {number} y - Screen Y coordinate
   * @param {number} radius - Radius in screen pixels
   */
  drawEraserCursor(x, y, radius = 10, eraserMode = "stroke") {
    this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    this.overlayCtx.beginPath();
    this.overlayCtx.arc(x, y, radius, 0, Math.PI * 2);
    if (eraserMode === "part") {
      this.overlayCtx.setLineDash([4, 3]);
      this.overlayCtx.strokeStyle = "rgba(59, 130, 246, 0.7)";
    } else {
      this.overlayCtx.setLineDash([]);
      this.overlayCtx.strokeStyle = "rgba(255, 0, 0, 0.5)";
    }
    this.overlayCtx.lineWidth = 2;
    this.overlayCtx.stroke();
    this.overlayCtx.setLineDash([]);
  }

  /**
   * Draw the visual indicator for inserting vertical space
   * @param {{startY: number, currentY: number}} state
   */
  drawInsertSpaceIndicator(state) {
    this.clearOverlay();
    if (!state) return;

    const { startY, currentY } = state;

    const ctx = this.overlayCtx;
    ctx.save();

    // Transform from content space to screen space for drawing on overlay
    const centeringOffset = this._getCenteringOffset();
    ctx.translate(centeringOffset, 0);
    ctx.scale(this.zoomScale, this.zoomScale);
    ctx.translate(-this.contentScrollLeft, -this.contentScrollTop);

    const lineWidth = 1 / this.zoomScale; // Keep line crisp
    const arrowSize = 8 / this.zoomScale;

    // 1. Draw horizontal line
    ctx.beginPath();
    ctx.strokeStyle = "rgba(0, 100, 255, 0.8)";
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([5, 5]);
    ctx.moveTo(0, startY);
    ctx.lineTo(this.contentWidth, startY);
    ctx.stroke();
    ctx.setLineDash([]);

    // 2. Draw arrows (only if dragged)
    if (Math.abs(currentY - startY) >= 1) {
      const arrowX1 = this.contentWidth * 0.25;
      const arrowX2 = this.contentWidth * 0.75;
      const direction = currentY >= startY ? 1 : -1;

      const drawArrow = (x, y1, y2) => {
        ctx.beginPath();
        ctx.moveTo(x, y1);
        ctx.lineTo(x, y2);
        ctx.stroke();

        // Arrowhead
        ctx.beginPath();
        ctx.moveTo(x, y2);
        const baseOffset = arrowSize * direction;
        ctx.lineTo(x - arrowSize / 2, y2 - baseOffset);
        ctx.lineTo(x + arrowSize / 2, y2 - baseOffset);
        ctx.closePath();
        ctx.fillStyle = "rgba(0, 100, 255, 0.8)";
        ctx.fill();
      };

      drawArrow(arrowX1, startY, currentY);
      drawArrow(arrowX2, startY, currentY);
    }

    ctx.restore();
  }

  clearOverlay() {
    this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
  }

  /**
   * Check if scroll position requires a leapfrog (buffer reposition)
   * @private
   * @param {number} scrollTop - Scroll position in content coordinates
   * @returns {boolean}
   */
  _shouldLeapfrog(scrollTop, scrollLeft = this.contentScrollLeft) {
    // First render always needs a leapfrog
    if (this.bufferHeight === 0 || this._needsInitialDraw) return true;

    const viewport = this._getContentViewport();

    return (
      this._axisNeedsLeapfrog(
        scrollTop,
        this.bufferTop,
        this.bufferHeight,
        viewport.height,
        this.contentHeight,
      ) ||
      this._axisNeedsLeapfrog(
        scrollLeft,
        this.bufferLeft,
        this.bufferWidth,
        viewport.width,
        this.maxContentWidth,
      )
    );
  }

  /**
   * Whether one axis has scrolled outside the buffer's safe zone.
   *
   * Identical logic for X and Y — the buffer is sized in screen space on both
   * axes, so neither is a special case.
   * @private
   * @param {number} scroll - Scroll position on this axis (content coords)
   * @param {number} bufferStart - Buffer origin on this axis (content coords)
   * @param {number} bufferExtent - Buffer size on this axis (content coords)
   * @param {number} viewportExtent - Visible size on this axis (content coords)
   * @param {number} contentExtent - Total content size on this axis
   * @returns {boolean}
   */
  _axisNeedsLeapfrog(scroll, bufferStart, bufferExtent, viewportExtent, contentExtent) {
    // No slack means the buffer already spans everything reachable on this axis
    // (e.g. a 1200px-wide note in a wider window, where the width cap makes the
    // buffer narrower than the viewport). There is nothing to leapfrog toward,
    // and the degenerate safe zone below would otherwise collapse to a point —
    // leaving correctness resting on the content-bounds guards further down
    // rather than on this being genuinely a no-op.
    const slack = Math.max(0, bufferExtent - viewportExtent);
    if (slack <= 0) return false;

    // Safe zone sits a fraction of a viewport in from the buffer edges, capped
    // at the slack actually available so it can never invert.
    const safeMargin = Math.min(viewportExtent * 0.3, slack / 2);
    const safeStart = bufferStart + safeMargin;
    const safeEnd = bufferStart + bufferExtent - viewportExtent - safeMargin;

    // Respect content bounds: being hard against an edge is not a reason to
    // leapfrog, because there is nothing further to reveal.
    if (scroll < safeStart && bufferStart > 0) return true;

    const maxBufferStart = Math.max(0, contentExtent - bufferExtent);
    if (scroll > safeEnd && bufferStart < maxBufferStart - 1) return true; // -1 for float precision

    return false;
  }

  /**
   * Place the buffer on one axis so the visible region sits inside it, with the
   * available slack split evenly on both sides.
   * @private
   * @param {number} scroll - Scroll position on this axis (content coords)
   * @param {number} bufferExtent - Buffer size on this axis (content coords)
   * @param {number} viewportExtent - Visible size on this axis (content coords)
   * @param {number} contentExtent - Total content size on this axis
   * @returns {number} Buffer origin on this axis (content coords)
   */
  _centreBufferOnAxis(scroll, bufferExtent, viewportExtent, contentExtent) {
    const slack = Math.max(0, bufferExtent - viewportExtent);
    const start = Math.max(0, scroll - slack / 2);
    const maxStart = Math.max(0, contentExtent - bufferExtent);
    return Math.min(start, maxStart);
  }

  /**
   * Slide the canvas using CSS transform (no redraw)
   * @private
   * @param {number} scrollTop - Scroll position in content coordinates
   * @param {number} scrollLeft - Scroll left position in screen coordinates
   */
  _slideCanvas(scrollTop, scrollLeft = 0) {
    // Record the position the canvas is actually showing. render() also sets
    // this, but it is suppressed during a pinch, and the debounced zoom redraw
    // needs a live value to reposition the buffer against when it fires.
    const zoom = this.zoomScale || 1;
    this.contentScrollTop = scrollTop;
    this.contentScrollLeft = scrollLeft / zoom;

    // The bitmap was rendered at renderedZoom. Normally that equals the live
    // zoom and the residual is 1 — the canvas is placed at 1:1 and never
    // stretched, which is what removes the old directional distortion.
    //
    // During a pinch the redraw is deferred, so the bitmap still holds the
    // pre-gesture zoom and this residual scales it to match what the fingers
    // are doing. It is a single uniform factor applied to both axes at once, so
    // the image can never be broader in one direction than the other — the
    // distortion came from the two axes being rescaled at different times, not
    // from scaling as such.
    const renderedZoom = this.renderedZoom || zoom;
    const residual = zoom / renderedZoom;

    // Offsets are in SCREEN pixels and describe where the buffer's content
    // origin must land. They use the live zoom, because that is what the user
    // is currently seeing — the scroll position and the centering are both
    // properties of the live view, not of the stale bitmap.
    //
    // The scale (when there is one) pivots on the canvas's top-left via
    // transformOrigin 0 0, so it does not move that origin and the offsets stay
    // correct with or without it.
    const centeringOffset = this._getCenteringOffset();
    const screenOffsetY = (this.bufferTop - scrollTop) * zoom;
    const screenOffsetX = centeringOffset + this.bufferLeft * zoom - scrollLeft;

    this.canvas.style.transformOrigin = "0 0";
    this.canvas.style.transform =
      residual === 1
        ? `translate(${screenOffsetX}px, ${screenOffsetY}px)`
        : `translate(${screenOffsetX}px, ${screenOffsetY}px) scale(${residual})`;
  }

  /**
   * Reposition buffer and redraw (leapfrog)
   * @private
   * @param {number} scrollTop - Scroll position in content coordinates
   * @param {boolean} [fastMode=true] - Draw without pressure rendering. Correct for
   *   scrolling, where more frames are coming and the quality pass can trail behind.
   *   Pass false when this repaint settles an interaction (e.g. the end of a zoom):
   *   nothing further is queued, so the fast pass would only be discarded and
   *   redrawn at full quality 150ms later — two full buffer repaints of an
   *   identical state.
   */
  _repositionBuffer(scrollTop, fastMode = true, scrollLeft = this.contentScrollLeft) {
    // Clear initial draw flag
    this._needsInitialDraw = false;

    // Re-derive the extent first: zoom may have changed since the last
    // reposition, which changes how much content the fixed-size buffer spans.
    // Then bring the bitmap in line with it before anything is positioned or
    // drawn — _drawBuffer below sets renderedZoom, so the bitmap must actually
    // hold that zoom by the time it runs, or _slideCanvas will skip the residual
    // compensation the stale bitmap still needs.
    this._updateBufferExtent();
    this._resizeCanvasBitmap();

    const viewport = this._getContentViewport();
    this.bufferTop = this._centreBufferOnAxis(
      scrollTop,
      this.bufferHeight,
      viewport.height,
      this.contentHeight,
    );
    this.bufferLeft = this._centreBufferOnAxis(
      scrollLeft,
      this.bufferWidth,
      viewport.width,
      this.maxContentWidth,
    );

    // Redraw the buffer. Fast mode (no pressure) for scroll performance; full
    // quality when this repaint is already the settling one.
    this._drawBuffer(fastMode);
    // The bitmap now holds the live zoom, so _slideCanvas needs no compensation.
    this.renderedZoom = this.zoomScale;

    // Clean up off-screen resources (PDF bitmaps) to prevent OOM
    this._cleanupOffscreenResources();

    // Schedule high-quality re-render after scroll stops. Only meaningful after a
    // fast draw — _scheduleQualityRender re-checks _lastRenderWasFastMode when it
    // fires, but skipping the timer entirely avoids arming it for nothing.
    if (fastMode) {
      this._scheduleQualityRender();
    }
  }

  /**
   * Schedule a high-quality re-render after scroll/interaction stops
   * @private
   */
  _scheduleQualityRender() {
    if (this._qualityRenderTimeout) {
      clearTimeout(this._qualityRenderTimeout);
    }

    this._qualityRenderTimeout = setTimeout(() => {
      this._qualityRenderTimeout = null;
      // A pending PDF queue check will do its own full-quality redraw shortly;
      // skip this one rather than repaint the whole buffer twice.
      if (this._pdfQueueCheckTimeout) return;
      // Only re-render if last render was in fast mode
      if (this._lastRenderWasFastMode) {
        this._drawBuffer(false);
      }
    }, this._qualityRenderDebounce);
  }

  /**
   * Draw the entire buffer content
   * @private
   * @param {boolean} fastMode - Skip pressure rendering for scroll performance
   */
  _drawBuffer(fastMode = false) {
    const startTime = performance.now();

    // Clear canvas, then paint the page colour into the bitmap itself, rather
    // than relying on the CSS background-color of .sliding-buffer-canvas to show
    // through transparent pixels. Painting it here makes the buffer opaque and
    // independent of how the browser chooses to composite it.
    //
    // Deliberately BEFORE the bufferHeight guard below. The caller has typically
    // just run _resizeCanvasBitmap, and assigning canvas.width/height clears the
    // bitmap to transparent black; returning early without repainting would
    // leave that cleared bitmap on screen.
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = this._getPageBackgroundColor();
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();

    // Belt-and-braces: _quantizeExtent floors at one quantum, so a non-positive
    // buffer is unreachable. The background above is already painted, keeping the
    // canvas opaque. Recorded as a full pass — nothing was skipped for speed, so
    // a quality re-render would have nothing to improve on.
    if (this.bufferHeight <= 0) {
      this._lastRenderWasFastMode = false;
      this.lastRenderTime = performance.now() - startTime;
      return;
    }

    // Ensure palette is current
    if (!this.palette) {
      this.palette = sharedGetThemePalette();
      this.markerPalette = sharedGetMarkerPalette();
    }

    // Draw background for buffer region
    if (this.background && this.background !== "none") {
      this._drawBackground();
    }

    // Draw media items (images, PDF pages)
    if (this.mediaManager) {
      this._drawMedia(fastMode);
    }

    // Draw A4 page break lines for notes without an imported PDF
    if (this.showA4PageBreaks) {
      this._drawA4PageBreaks();
    }

    // Query spatial index for visible strokes
    const bufferBottom = this.bufferTop + this.bufferHeight;
    let strokeIndices;

    if (this.spatialIndex) {
      strokeIndices = this.spatialIndex.query(this.bufferTop, bufferBottom);
    } else {
      // Fallback: draw all strokes (inefficient)
      strokeIndices = this.strokes.map((_, i) => i);
    }

    // Tracks whether this repaint painted the in-progress stroke in full, so the
    // incremental cursor can be re-based below (see drawDirectStroke).
    let _activeRedrawnInFull = false;

    // Separate markers and pens to draw markers first (behind pens)
    const markers = [];
    const pens = [];

    for (const index of strokeIndices) {
      const stroke = this.strokes[index];
      if (stroke && !stroke._deleted && !stroke.isDeleted) {
        if (stroke.type === "marker") {
          markers.push(index);
        } else {
          pens.push(index);
        }
      }
    }

    // Draw strokes with offset for buffer position
    this.ctx.save();
    this.ctx.translate(-this.bufferLeft, -this.bufferTop);

    try {
      // Un-inverted (white) PDF page bounds — strokes starting on one of these
      // need the light palette even in dark theme, to stay visible against the
      // page's actual (white) color. Computed once per draw pass.
      const uninvertedPdfBounds = this._getUninvertedPdfBounds();
      const lightPalette = uninvertedPdfBounds.length > 0 ? sharedGetThemePalette("light") : null;
      const lightMarkerPalette =
        uninvertedPdfBounds.length > 0 ? sharedGetMarkerPalette("light") : null;

      // Helper to draw a list of pen indices (no grouping needed)
      const drawList = (indices) => {
        for (const index of indices) {
          const stroke = this.strokes[index];
          const isSelected = this.selectedStrokeIndices.has(index);
          const strokePalette = this._strokeNeedsLightPalette(stroke, uninvertedPdfBounds)
            ? lightPalette
            : this.palette;
          sharedDrawStroke(this.ctx, stroke, strokePalette, isSelected, fastMode);
        }
      };

      // Helper to draw marker indices, grouping sub-strokes that share a groupId
      // into one beginPath…stroke() call so their alpha doesn't stack.
      // Draw markers first (lower z-index), grouped by groupId to preserve flat alpha.
      const markerStrokes = markers.map((i) => this.strokes[i]);
      const selectedIds = new Set(
        [...this.selectedStrokeIndices].map((i) => this.strokes[i]?.id).filter(Boolean),
      );
      const getMarkerColorsForStroke = (stroke) =>
        this._strokeNeedsLightPalette(stroke, uninvertedPdfBounds)
          ? lightMarkerPalette
          : this.markerPalette || sharedGetMarkerPalette();
      drawMarkersGrouped(
        this.ctx,
        markerStrokes,
        this.palette,
        selectedIds,
        getMarkerColorsForStroke,
      );
      // Draw pens on top
      drawList(pens);

      // Draw active stroke on top if it exists (always full quality for responsiveness)
      if (this.activeStroke && this.activeStroke.type !== "marker") {
        // If active stroke is marker, it should technically be drawn before pens,
        // but for responsiveness we draw it on top during creation.
        // It will be sorted correctly once finished and added to the main list.
        const activePalette = this._strokeNeedsLightPalette(this.activeStroke, uninvertedPdfBounds)
          ? lightPalette
          : this.palette;
        sharedDrawStroke(this.ctx, this.activeStroke, activePalette, false, false);
        // This repaint just drew the active stroke in full, so the incremental
        // cursor drawDirectStroke() keeps must be re-based to match. Leaving it
        // where it was would make the next incremental call resume past the
        // points we just painted — harmless — but the real hazard is the
        // opposite case below.
        _activeRedrawnInFull = true;
      }

      // Draw highlights
      if (this.highlightRects.length > 0) {
        this.ctx.save();
        this.ctx.fillStyle = HIGHLIGHT_FILL_STYLE;
        this.ctx.strokeStyle = HIGHLIGHT_STROKE_STYLE;
        this.ctx.lineWidth = HIGHLIGHT_LINE_WIDTH;

        for (const rect of this.highlightRects) {
          // A region hit says "the word is somewhere in this band" — nothing
          // more. Drawing it as a bordered rect would claim a precision the
          // recognition does not have, so it renders as a soft tint instead.
          if (rect.region != null) {
            this._drawApproximateMarker(rect);
            continue;
          }

          this.ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
          this.ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
        }
        this.ctx.restore();
      }

      // Draw selection bounding box
      if (this.selectionBounds) {
        const { minX, minY, maxX, maxY } = this.selectionBounds;
        const width = maxX - minX;
        const height = maxY - minY;

        this.ctx.save();
        this.ctx.strokeStyle = "rgba(0, 100, 255, 0.6)";
        this.ctx.lineWidth = 1 / this.resolutionScale; // Keep line thin regardless of zoom
        this.ctx.setLineDash([5, 5]);
        this.ctx.strokeRect(minX, minY, width, height);

        // Draw detected line separators and indentation markers for debug visualization
        if (this.lineSeparators.length > 0 || this.lineIndentLevels.length > 0) {
          const overhang = 8 / this.zoomScale;
          const markerSize = 6 / this.zoomScale;

          // Separator lines
          this.ctx.strokeStyle = "rgba(255, 100, 0, 0.7)";
          this.ctx.lineWidth = 1.5 / this.resolutionScale;
          this.ctx.setLineDash([6, 4]);
          for (const sepY of this.lineSeparators) {
            this.ctx.beginPath();
            this.ctx.moveTo(minX - overhang, sepY);
            this.ctx.lineTo(maxX + overhang, sepY);
            this.ctx.stroke();
          }

          // Indentation markers: filled arrow on the left edge of each indented band
          if (this.lineIndentLevels.length > 0) {
            this.ctx.setLineDash([]);
            this.ctx.fillStyle = "rgba(255, 100, 0, 0.75)";
            // Band top/bottom boundaries (separators + selection edges)
            const bandTops = [minY, ...this.lineSeparators];
            const bandBottoms = [...this.lineSeparators, maxY];
            for (let i = 0; i < this.lineIndentLevels.length; i++) {
              if (this.lineIndentLevels[i] === 0) continue;
              const bandMidY = (bandTops[i] + bandBottoms[i]) / 2;
              const arrowX = minX - overhang;
              // Draw a right-pointing triangle
              this.ctx.beginPath();
              this.ctx.moveTo(arrowX, bandMidY - markerSize);
              this.ctx.lineTo(arrowX + markerSize * 1.2, bandMidY);
              this.ctx.lineTo(arrowX, bandMidY + markerSize);
              this.ctx.closePath();
              this.ctx.fill();
            }
          }
        }

        this.ctx.restore();

        // Draw resize handles using shared handle positions
        const handleSize = SELECTION_HANDLE_SIZE / this.zoomScale; // Constant screen size
        const half = handleSize / 2;
        this.ctx.save();
        this.ctx.fillStyle = "#ffffff";
        this.ctx.strokeStyle = "#3b82f6";
        this.ctx.lineWidth = 1 / this.resolutionScale;

        const handles = getSelectionHandles(this.selectionBounds, this.zoomScale);

        for (const { key, x: hx, y: hy } of handles) {
          if (key === "rotate") {
            // Draw rotation handle with stem
            this.ctx.beginPath();
            this.ctx.moveTo(hx, minY);
            this.ctx.lineTo(hx, hy);
            this.ctx.stroke();

            this.ctx.beginPath();
            this.ctx.arc(hx, hy, half, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.stroke();
          } else {
            // Draw square handle for resize
            this.ctx.fillRect(hx - half, hy - half, handleSize, handleSize);
            this.ctx.strokeRect(hx - half, hy - half, handleSize, handleSize);
          }
        }
        this.ctx.restore();
      }
    } finally {
      this.ctx.restore();
    }

    // A repaint clears the whole buffer canvas. drawDirectStroke() paints the
    // in-progress stroke incrementally, resuming from lastDrawnPointIndex — so
    // after a clear, every point below that cursor has been wiped and would
    // never be repainted, leaving the live stroke jagged with missing segments
    // until the finished stroke is committed and drawn from the spatial index.
    //
    // Re-base the cursor to match what is actually on the canvas now:
    //  - active stroke repainted in full  → cursor moves to its last segment
    //  - active stroke absent from this repaint → cursor resets so the next
    //    incremental call redraws the stroke from the beginning.
    if (this.activeStrokeId) {
      if (_activeRedrawnInFull) {
        this.lastDrawnPointIndex = Math.max(0, (this.activeStroke?.x.length ?? 1) - 1);
      } else {
        this.lastDrawnPointIndex = 0;
      }
    }

    this._lastRenderWasFastMode = fastMode;
    this.lastRenderTime = performance.now() - startTime;
  }

  /**
   * Draw media items onto the buffer
   * @private
   * @param {boolean} fastMode - Use faster rendering (lower quality)
   */
  /**
   * Media items overlapping a Y range, in original array order (z-order).
   *
   * Maintains an index sorted by item.y, cached against MediaManager.version, so
   * culling costs O(log n + visible) instead of a full scan of every item on
   * every repaint. Falls back to a linear filter for small lists, where the
   * bookkeeping would cost more than it saves.
   * @private
   * @returns {Array<Object>}
   */
  _getItemsOverlapping(items, top, bottom) {
    // Below this size a plain scan is cheaper than maintaining the index.
    if (items.length < 16) {
      return items.filter((item) => item.y + item.height >= top && item.y <= bottom);
    }

    const version = this.mediaManager.version ?? -1;
    if (!this._mediaYIndex || this._mediaYIndexVersion !== version) {
      // Store positions alongside items so the visible subset can be restored to
      // array order after the range query.
      const index = items.map((item, i) => ({ item, i }));
      index.sort((a, b) => a.item.y - b.item.y);
      let maxHeight = 0;
      for (const entry of index) {
        if (entry.item.height > maxHeight) maxHeight = entry.item.height;
      }
      this._mediaYIndex = index;
      this._mediaYIndexMaxHeight = maxHeight;
      this._mediaYIndexVersion = version;
    }

    const index = this._mediaYIndex;

    // First entry whose y could still reach `top`, bounded by the tallest item.
    const cutoff = top - this._mediaYIndexMaxHeight;
    let lo = 0;
    let hi = index.length - 1;
    let start = index.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (index[mid].item.y >= cutoff) {
        start = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    const hits = [];
    for (let i = start; i < index.length; i++) {
      const entry = index[i];
      // Sorted by y: everything beyond this point starts below the buffer.
      if (entry.item.y > bottom) break;
      if (entry.item.y + entry.item.height >= top) hits.push(entry);
    }

    hits.sort((a, b) => a.i - b.i); // restore z-order
    return hits.map((entry) => entry.item);
  }

  _drawMedia(fastMode = false) {
    const items = this.mediaManager.getItems();
    if (!items || items.length === 0) return;

    this.ctx.save();
    this.ctx.translate(-this.bufferLeft, -this.bufferTop);

    if (fastMode) {
      this.ctx.imageSmoothingEnabled = false;
    } else {
      this.ctx.imageSmoothingQuality = "high";
    }

    const bufferBottom = this.bufferTop + this.bufferHeight;

    // Draw order is array order (z-order), so the list itself must not be
    // reordered. Instead, an index sorted by y lets us visit only the items that
    // can overlap the buffer — a 400-page PDF previously paid a full scan per
    // repaint just to reject ~397 of them. The visible subset is re-sorted back
    // into array order to preserve z-order.
    const visible = this._getItemsOverlapping(items, this.bufferTop, bufferBottom);

    // Tell the render cache which bitmaps are on screen, so eviction can never
    // reclaim one that the very next frame needs. Without this, two visible
    // pages whose bitmaps do not both fit in the cache budget (which happens
    // past a certain zoom, since bitmap cost grows with scale squared) evict
    // each other in turn and re-render forever.
    //
    // Built into a reused array rather than filter().map(): this runs on every
    // repaint, including every frame of the pending-media animation loop, and
    // the two intermediate arrays were pure per-frame garbage. Must stay a
    // pre-pass — the pins have to be in place before the draw loop below can
    // trigger a render that evicts.
    const pinned = this._pinnedKeyScratch;
    pinned.length = 0;
    for (const item of visible) {
      if (item.type !== "pdf-page") continue;
      pinned.push(getRenderCacheKey(item, this.resolutionScale, { invertForDarkTheme: true }));
    }
    setPinnedRenderKeys(pinned);

    for (const item of visible) {
      if (item.type === "pdf-page") {
        this._drawPdfPage(item, fastMode);
        continue;
      }

      if (item.type === "image" && (item.fileId || item.pending)) {
        const img = item.fileId ? this.mediaManager.getImage(item.fileId) : null;
        this.ctx.save();

        // Apply rotation for both image and border
        if (item.rotation) {
          const cx = item.x + item.width / 2;
          const cy = item.y + item.height / 2;
          this.ctx.translate(cx, cy);
          this.ctx.rotate((item.rotation * Math.PI) / 180);
          this.ctx.translate(-cx, -cy);
        }

        if (img) {
          this.ctx.drawImage(img, item.x, item.y, item.width, item.height);
        } else if (item.pending) {
          // An insert is still processing (encode + store). Show a framed
          // placeholder with a spinner so the canvas reflects the pending work
          // immediately, rather than staying blank until the image is ready.
          this._drawPendingMediaPlaceholder(item);
        } else {
          // Draw placeholder while loading
          this.ctx.fillStyle = "rgba(200, 200, 200, 0.2)";
          this.ctx.fillRect(item.x, item.y, item.width, item.height);
        }

        // Draw selection border (within the same rotated context)
        if (item.id === this.selectedMediaId) {
          this.ctx.strokeStyle = "#3b82f6";
          this.ctx.lineWidth = 2;
          this.ctx.strokeRect(item.x, item.y, item.width, item.height);
        }
        this.ctx.restore(); // Restore from rotation transform

        // Draw handles (which are pre-rotated) if selected
        if (item.id === this.selectedMediaId) {
          // Draw handles
          const handles = getMediaHandles(item, this.zoomScale);
          const handleSize = MEDIA_HANDLE_SIZE / this.zoomScale;
          const half = handleSize / 2;

          this.ctx.fillStyle = "#ffffff";
          this.ctx.strokeStyle = "#3b82f6";
          this.ctx.lineWidth = 1 / this.resolutionScale;

          for (const h of handles) {
            this.ctx.beginPath();
            if (h.key === "rotate") {
              this.ctx.arc(h.x, h.y, half, 0, Math.PI * 2);
            } else {
              this.ctx.rect(h.x - half, h.y - half, handleSize, handleSize);
            }
            this.ctx.fill();
            this.ctx.stroke();
          }
        }
      }
    }

    this.ctx.restore();
  }

  /**
   * Draw the placeholder shown while an image insert is still processing.
   *
   * Called from _drawMedia, so ctx is already translated by -bufferTop and the
   * item's rotation is applied. Geometry is in content space.
   *
   * Line widths and the spinner radius are divided by zoomScale so the frame
   * and spinner keep a constant on-screen size at any zoom, matching how the
   * selection handles are sized.
   * @param {Object} item - The pending media item
   * @private
   */
  _drawPendingMediaPlaceholder(item) {
    const ctx = this.ctx;
    const { x, y, width, height } = item;

    // Neutral fill + dashed frame: reads as "something is coming here" without
    // looking like a failed image.
    ctx.fillStyle = "rgba(148, 163, 184, 0.18)";
    ctx.fillRect(x, y, width, height);

    ctx.save();
    ctx.strokeStyle = "rgba(100, 116, 139, 0.55)";
    ctx.lineWidth = 1.5 / this.zoomScale;
    ctx.setLineDash([6 / this.zoomScale, 4 / this.zoomScale]);
    ctx.strokeRect(x, y, width, height);
    ctx.restore();

    // Spinner: a rotating arc, sized to the placeholder but capped so it stays
    // reasonable for both a thumbnail-sized and a full-page insert.
    const cx = x + width / 2;
    const cy = y + height / 2;
    const maxRadius = Math.min(width, height) / 4;
    const radius = Math.min(maxRadius, 18 / this.zoomScale);
    if (radius <= 0) return;

    // Time-based so the rotation speed is independent of frame rate.
    const angle = (performance.now() / 1000) * Math.PI * 1.5;

    ctx.save();
    ctx.lineWidth = Math.max(2 / this.zoomScale, radius / 6);
    ctx.lineCap = "round";

    // Track
    ctx.strokeStyle = "rgba(100, 116, 139, 0.25)";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Rotating head
    ctx.strokeStyle = "#3b82f6";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, angle, angle + Math.PI * 0.6);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Whether any media item is a pending placeholder, i.e. the spinner must keep
   * animating. Cheap enough to call per frame: media lists are small and the
   * pending state exists only during an insert.
   * @returns {boolean}
   * @private
   */
  _hasPendingMedia() {
    if (!this.mediaManager) return false;
    return this.mediaManager.getItems().some((i) => i.pending);
  }

  /**
   * Start (or keep) the animation loop that repaints while a pending media
   * placeholder is on screen. Self-cancelling: the loop stops as soon as no
   * pending item remains, so it costs nothing outside an active insert.
   */
  startPendingMediaAnimation() {
    if (this._pendingMediaRaf !== null) return;

    const tick = () => {
      this._pendingMediaRaf = null;
      // destroy() nulls the canvas — a frame already queued must not repaint.
      if (!this.canvas || !this._hasPendingMedia()) return;
      // fastMode: the placeholder repaints continuously, and a full-quality
      // pass would re-render every visible stroke ~60x/second during an insert.
      this._drawBuffer(true);
      this._pendingMediaRaf = requestAnimationFrame(tick);
    };

    this._pendingMediaRaf = requestAnimationFrame(tick);
  }

  /** Stop the pending-placeholder animation loop, if running. */
  stopPendingMediaAnimation() {
    if (this._pendingMediaRaf !== null) {
      cancelAnimationFrame(this._pendingMediaRaf);
      this._pendingMediaRaf = null;
    }
  }

  /**
   * Draw a PDF page item
   * @private
   * Note: This method is called from _drawMedia which already has ctx.translate(0, -this.bufferTop) applied.
   * Do NOT apply another bufferTop translation here.
   */
  /**
   * Bounding boxes (content space) of visible PDF pages that are currently
   * rendered un-inverted, i.e. genuinely white — either because theme is
   * light (nothing is inverted) or because the "invert PDF pages in dark
   * mode" setting is off. Strokes starting inside these boxes need the light
   * palette to stay legible; strokes elsewhere use the live theme palette.
   * Recomputed once per draw pass, not per stroke.
   * @returns {Array<{x:number,y:number,width:number,height:number}>}
   * @private
   */
  _getUninvertedPdfBounds() {
    if (!this.mediaManager) return [];
    if (getTheme() === "dark" && getPdfInvertDarkMode()) return []; // pages are inverted — dark palette is fine everywhere

    // Cached: this used to rebuild an array of one object per PDF page on every
    // draw pass (and again per stroke start, and per marker preview frame). On a
    // scanned book that is hundreds of allocations per repaint, on the same path
    // that repaints while scrolling. Keyed on MediaManager.version so any
    // add/remove/reorder/geometry change rebuilds it.
    const version = this.mediaManager.version ?? -1;
    if (this._pdfBoundsCache && this._pdfBoundsCacheVersion === version) {
      return this._pdfBoundsCache;
    }

    const bounds = [];
    for (const item of this.mediaManager.getItems()) {
      if (item.type !== "pdf-page") continue;
      bounds.push({ x: item.x, y: item.y, width: item.width, height: item.height });
    }
    // Sorted by y so _strokeNeedsLightPalette can binary-search instead of
    // scanning every page for every stroke. Pages are normally already stacked
    // in ascending y, making this a no-op comparison pass.
    bounds.sort((a, b) => a.y - b.y);

    // Tallest page, used to bound the backward walk in the lookup below: no page
    // starting more than this far above a point can still contain it.
    let maxHeight = 0;
    for (const b of bounds) {
      if (b.height > maxHeight) maxHeight = b.height;
    }

    this._pdfBoundsCache = bounds;
    this._pdfBoundsMaxHeight = maxHeight;
    this._pdfBoundsCacheVersion = version;
    return bounds;
  }

  /**
   * Whether theme is dark and this stroke's start point falls on an
   * un-inverted (white) PDF page, so it needs the light palette instead of
   * the dark-mode one to stay visible.
   * @private
   */
  _strokeNeedsLightPalette(stroke, uninvertedPdfBounds) {
    if (getTheme() !== "dark" || uninvertedPdfBounds.length === 0) return false;
    if (!stroke.x || stroke.x.length === 0) return false;
    const px = stroke.x[0];
    const py = stroke.y[0];

    // Binary search for the last page starting at or above py, then walk back
    // over the few pages that could still contain the point. Pages are stacked
    // vertically and effectively non-overlapping, so this terminates almost
    // immediately — the previous linear .some() was O(pages) for every stroke,
    // i.e. O(strokes x pages) per repaint.
    let lo = 0;
    let hi = uninvertedPdfBounds.length - 1;
    let candidate = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (uninvertedPdfBounds[mid].y <= py) {
        candidate = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    // Walk back only as far as the tallest page could reach. Any page starting
    // above that cutoff ends before py and cannot contain it, whatever its own
    // height. Normally stops after one or two iterations.
    const cutoff = py - (this._pdfBoundsMaxHeight || 0);
    for (let i = candidate; i >= 0; i--) {
      const b = uninvertedPdfBounds[i];
      if (b.y < cutoff) break;
      if (px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height) return true;
    }
    return false;
  }

  /**
   * Draw a PDF page's rendered bitmap. In dark theme, item.renderable is
   * already the inverted bitmap (inverted once at render time in
   * getRenderedMedia/renderPdfPage) so the always-white PDF page reads as
   * dark and the dark-mode stroke palette stays legible on it — no per-frame
   * filter cost here.
   * @private
   */
  _drawPdfRenderable(item) {
    this.ctx.drawImage(item.renderable, item.x, item.y, item.width, item.height);
  }

  _drawPdfPage(item, _fastMode) {
    // 1. Try to draw existing renderable if it matches current scale
    if (
      item.renderable &&
      item.renderableScale === this.resolutionScale &&
      item.renderable.width > 0
    ) {
      this._drawPdfRenderable(item);
      // Draw page break and selection even for cached pages
      this._drawPdfPageBreak(item);
      if (item.id === this.selectedMediaId) {
        this.ctx.strokeStyle = "#3b82f6";
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(item.x, item.y, item.width, item.height);
      }
      return;
    }

    // 2. If we have an existing renderable but scale mismatch (e.g. zooming), draw it anyway as placeholder
    if (item.renderable && item.renderable.width > 0) {
      this._drawPdfRenderable(item);
    }

    // 3. Trigger load for correct scale if a slot is free and we aren't already
    //    loading. A page that wants a render but cannot get a slot yet is NOT an
    //    error — it is queued, and must still paint a placeholder below.
    const wantsLoad = !item.loading && !item.error;
    if (wantsLoad && this.activePdfLoads < this.maxConcurrentPdfLoads) {
      // Start loading regardless of fastMode to ensure pages eventually render
      // The forceRedraw() on completion will show them once loaded
      item.loading = true;
      this.activePdfLoads++;

      // Capture the scale and generation this render was requested for, so the
      // result can be matched against the state that is current when it lands.
      const requestedScale = this.resolutionScale;
      const requestedGeneration = this._renderGeneration;

      getRenderedMedia(item, requestedScale, { invertForDarkTheme: true })
        .then((renderable) => {
          item.loading = false;
          this.activePdfLoads--;

          // Discard superseded results. The bitmap itself is owned by the
          // mediaManager cache (which dedupes and disposes on eviction), so it
          // must NOT be closed here — a concurrent caller may legitimately be
          // using the very same object.
          const isCurrent =
            requestedGeneration === this._renderGeneration &&
            requestedScale === this.resolutionScale;

          // Only store if item is still within a reasonable range of the viewport
          // This prevents storing bitmaps for pages that were scrolled past quickly
          const inKeepZone = this._isItemInKeepZone(item);

          if (isCurrent && inKeepZone && renderable) {
            item.renderable = renderable;
            item.renderableScale = requestedScale;
            // A good render clears the failure history, so a page that recovers
            // gets a fresh retry budget if it later fails at a different scale.
            item.renderAttempts = 0;
            // Don't call forceRedraw directly - use debounced queue check instead
            // This prevents cascading redraws when many pages load in succession
          } else if (isCurrent && inKeepZone) {
            // Resolved with no bitmap. getRenderedMedia now throws on render
            // failure, so reaching here means the item type produced nothing at
            // all (not a transient fault) — a permanent error, unlike the
            // exceptions handled in .catch() below.
            item.error = true;
            // Debounced redraw will show error state
          }
          // Otherwise: stale generation/scale, or the item scrolled out of the
          // keep zone. Drop the reference and let the cache's LRU eviction free
          // it. The next draw re-requests at the then-current scale.

          // Schedule a debounced redraw to show loaded pages and pick up queued ones
          this._schedulePdfQueueCheck();
        })
        .catch((err) => {
          item.loading = false;
          this.activePdfLoads--;
          console.error(`[CanvasRenderer] Failed to render PDF page ${item.id}:`, err);

          // Mark as error so the draw below stops re-requesting immediately —
          // without this the page would retry on every single frame.
          item.error = true;

          // Most render failures are transient: the PDF binary may still be
          // downloading ("PDF file not found"), or a large page may have failed
          // to allocate under momentary memory pressure. Latching those
          // permanently is what left pages blank for the rest of the session, so
          // clear the flag after a backoff and let the next draw try again.
          // Bounded so a genuinely corrupt page settles into the error state
          // instead of retrying forever.
          item.renderAttempts = (item.renderAttempts || 0) + 1;
          if (item.renderAttempts <= MAX_PDF_RENDER_ATTEMPTS) {
            const backoffMs = PDF_RENDER_RETRY_BASE_MS * 2 ** (item.renderAttempts - 1);
            setTimeout(() => {
              item.error = false;
              this._schedulePdfQueueCheck();
            }, backoffMs);
          }
          this._schedulePdfQueueCheck();
        });
    }
    // If error, draw error placeholder
    else if (item.error) {
      this.ctx.fillStyle = "rgba(255, 0, 0, 0.05)";
      this.ctx.fillRect(item.x, item.y, item.width, item.height);
      this._drawErrorIndicator(item);
    }
    // Otherwise the page has no bitmap yet: either a load is in flight, or it is
    // waiting for a free slot. Both must paint the loading placeholder.
    //
    // This used to be `else if (item.loading && !item.renderable)`, which drew
    // nothing at all for a queued page — with maxConcurrentPdfLoads = 2, every
    // page beyond the first two had loading === false and error === false, so no
    // branch matched and the page rendered as a blank void with no indicator.
    else if (!item.renderable) {
      this.ctx.fillStyle = "rgba(200, 200, 200, 0.1)";
      this.ctx.fillRect(item.x, item.y, item.width, item.height);
      this._drawLoadingIndicator(item);
    }

    // Draw page break line at bottom of PDF page (dashed dark blue line)
    this._drawPdfPageBreak(item);

    // Draw selection border if selected
    if (item.id === this.selectedMediaId) {
      this.ctx.strokeStyle = "#3b82f6";
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(item.x, item.y, item.width, item.height);
    }
  }

  /**
   * Draw a loading indicator for a PDF page
   * @private
   */
  _drawLoadingIndicator(item) {
    const cx = item.x + item.width / 2;
    const cy = item.y + item.height / 2;

    this.ctx.save();

    // Pill background
    this.ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
    this.ctx.beginPath();
    if (this.ctx.roundRect) {
      this.ctx.roundRect(cx - 40, cy - 15, 80, 30, 15);
    } else {
      this.ctx.rect(cx - 40, cy - 15, 80, 30);
    }
    this.ctx.fill();

    // Text
    this.ctx.fillStyle = "#374151";
    this.ctx.font = "12px sans-serif";
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.fillText("Loading...", cx, cy);

    this.ctx.restore();
  }

  /**
   * Draw an error indicator for a PDF page
   * @private
   */
  _drawErrorIndicator(item) {
    const cx = item.x + item.width / 2;
    const cy = item.y + item.height / 2;

    this.ctx.save();

    // Pill background
    this.ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    this.ctx.beginPath();
    if (this.ctx.roundRect) {
      this.ctx.roundRect(cx - 50, cy - 15, 100, 30, 15);
    } else {
      this.ctx.rect(cx - 50, cy - 15, 100, 30);
    }
    this.ctx.fill();

    // Text
    this.ctx.fillStyle = "#ef4444"; // Red
    this.ctx.font = "12px sans-serif";
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.fillText("Error loading page", cx, cy);

    this.ctx.restore();
  }

  /**
   * Draw a dashed page break line at the bottom of a PDF page
   * @private
   */
  _drawPdfPageBreak(item) {
    const y = item.y + item.height;
    const lineWidth = 1 / this.resolutionScale; // Keep line crisp at any zoom

    this.ctx.save();
    this.ctx.strokeStyle = "#1e3a5f"; // Dark blue
    this.ctx.lineWidth = lineWidth;
    this.ctx.setLineDash([8, 4]); // Dashed pattern: 8px dash, 4px gap

    this.ctx.beginPath();
    this.ctx.moveTo(item.x, y);
    this.ctx.lineTo(item.x + item.width, y);
    this.ctx.stroke();

    this.ctx.restore();
  }

  /**
   * Draw A4 page break lines across the full content width.
   * Used when the note has no imported PDF so the user can see where pages will break on export.
   * Matches the A4 proportions used in pdfExport.js (CONTENT_WIDTH=1200, A4 72pt/inch).
   * @private
   */
  _drawA4PageBreaks() {
    // A4 page height in content space: same calculation as pdfExport.js Case B
    const A4_CONTENT_PAGE_H = 841.89 / (595.28 / 1200); // ≈ 1696.7 px

    const bufferBottom = this.bufferTop + this.bufferHeight;
    const lineWidth = 1 / this.resolutionScale;

    this.ctx.save();
    this.ctx.translate(-this.bufferLeft, -this.bufferTop);
    this.ctx.strokeStyle = "#1e3a5f";
    this.ctx.lineWidth = lineWidth;
    this.ctx.setLineDash([8, 4]);

    // Draw lines at the bottom of each page (i=1,2,…), skipping y=0 (top of note)
    const firstBreakIndex = Math.max(1, Math.ceil(this.bufferTop / A4_CONTENT_PAGE_H));
    for (let i = firstBreakIndex; ; i++) {
      const y = i * A4_CONTENT_PAGE_H;
      if (y > bufferBottom) break;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.contentWidth, y);
      this.ctx.stroke();
    }

    this.ctx.restore();
  }

  /**
   * Check if an item is within the "keep zone" (buffer + margin)
   * Used to determine if we should keep/store its bitmap
   * @private
   */
  _isItemInKeepZone(item) {
    // Keep zone = buffer +/- half a viewport, tracking the visible area so the
    // margin stays proportional to what the user can actually see.
    const margin = this._getContentViewport().height * 0.5;
    const keepTop = this.bufferTop - margin;
    const keepBottom = this.bufferTop + this.bufferHeight + margin;

    return item.y + item.height >= keepTop && item.y <= keepBottom;
  }

  /**
   * Clean up resources for items that have moved out of the keep zone
   * @private
   */
  _cleanupOffscreenResources() {
    if (!this.mediaManager) return;

    const items = this.mediaManager.getItems();

    for (const item of items) {
      if (item.type === "pdf-page" && item.renderable) {
        if (!this._isItemInKeepZone(item)) {
          this._releaseItemMemory(item);
        }
      }
    }
  }

  _releaseItemMemory(item) {
    // Invalidate any in-flight render for this item so its result is discarded
    // rather than written back onto the item we are about to release.
    this._renderGeneration++;

    // Hand ownership back to the cache, which disposes the backing store once
    // the entry is dropped and no longer reachable by any caller.
    //
    // The renderable is deliberately NOT zeroed here: the same canvas may still
    // be referenced by a concurrent snapshot render (thumbnails share this
    // global cache) or by an in-flight getRenderedMedia awaiting the same key.
    // Zeroing a canvas another path is about to drawImage() throws
    // InvalidStateError, and repeatedly orphaning full-page scanned bitmaps is
    // what exhausted memory on low-end Android.
    clearRenderCache(item.id);

    item.renderable = null;
    item.renderableScale = null;
    // Do NOT reset item.loading = false here.
    // If a load is pending, let it finish (and discard result).
    // Resetting it here would allow _drawPdfPage to trigger a duplicate load immediately,
    // causing a race condition and potential infinite load loop during rapid scrolling.
  }

  /**
   * Schedule a debounced redraw to pick up queued PDF pages and show loaded ones
   * This prevents immediate forceRedraw cascades while still ensuring
   * pages waiting for a load slot eventually get loaded
   * @private
   */
  _schedulePdfQueueCheck() {
    if (this._pdfQueueCheckTimeout) {
      clearTimeout(this._pdfQueueCheckTimeout);
    }
    this._pdfQueueCheckTimeout = setTimeout(() => {
      this._pdfQueueCheckTimeout = null;
      // This full-quality redraw satisfies any pending quality pass too — both
      // timers call _drawBuffer over the same buffer, and letting the other fire
      // afterwards would repaint every stroke and page a second time for nothing.
      if (this._qualityRenderTimeout) {
        clearTimeout(this._qualityRenderTimeout);
        this._qualityRenderTimeout = null;
      }
      // Redraw to show newly loaded pages and trigger loading for queued pages
      this.forceRedraw();
    }, 100); // Debounce to batch multiple load completions
  }

  /**
   * Draw background pattern for the buffer region
   * @private
   */
  _drawBackground() {
    // Save context state
    this.ctx.save();

    // Draw background pattern
    // The shared function draws from startY to height, so we need to offset
    this.ctx.translate(-this.bufferLeft, -this.bufferTop);

    sharedDrawBackgroundPattern(
      this.ctx,
      this.background,
      this.maxContentWidth,
      this.bufferTop + this.bufferHeight,
      this.bufferTop,
    );

    this.ctx.restore();
  }

  /**
   * Set zoom level
   * @param {number} scale - Zoom scale (1.0 = 100%)
   * @param {Object} options
   * @param {boolean} options.immediate - Skip debounce and render immediately
   * @param {number} options.scrollTop - Current scroll position for re-render
   * @param {number} options.scrollLeft - Current scroll left position
   * @param {number} options.viewportHeight - Current viewport height (screen pixels)
   */
  setZoom(scale, options = {}) {
    this.zoomScale = scale;

    const contentScrollTop = (options.scrollTop || 0) / scale;
    const screenScrollLeft = options.scrollLeft || 0;

    if (options.immediate) {
      // Settle. Cancel any pending debounced pass: this supersedes it, and
      // letting it fire afterwards would repeat the same full redraw.
      if (this.zoomRenderTimeout) {
        clearTimeout(this.zoomRenderTimeout);
        this.zoomRenderTimeout = null;
      }
      if (options.viewportHeight) {
        this.screenViewportHeight = Math.max(MIN_VIEWPORT_SIZE, options.viewportHeight);
      }
      if (options.scrollTop !== undefined) {
        // No further zoom frames are coming, so draw at full quality directly
        // instead of a fast pass plus a debounced quality repaint.
        // _repositionBuffer re-derives the extent, resizes the bitmap and sets
        // renderedZoom itself.
        this._repositionBuffer(contentScrollTop, false, screenScrollLeft / scale);
        this._cleanupOffscreenResources();
      } else {
        this._updateBufferExtent();
        this._resizeCanvasBitmap();
        this.renderedZoom = scale;
      }
    } else if (!this.zoomRenderTimeout) {
      // Mid-gesture. Reallocating the bitmap and redrawing every stroke per
      // pointermove is the bulk of the pinch cost on low-end devices, so defer
      // it: _slideCanvas below compensates visually in the meantime. The timer
      // reads live state when it fires, so it always settles on the final zoom
      // rather than a value captured 150ms ago.
      this.zoomRenderTimeout = setTimeout(() => {
        this.zoomRenderTimeout = null;
        this._repositionBuffer(this.contentScrollTop, false, this.contentScrollLeft);
        this._cleanupOffscreenResources();
        this._slideCanvas(this.contentScrollTop, this.contentScrollLeft * this.zoomScale);
      }, this.zoomRenderDebounce);
    }
    // else: a re-render is already pending and will pick up the live zoom.

    // Always update visual transform immediately
    this._slideCanvas(contentScrollTop, screenScrollLeft);
  }

  /**
   * Force a full redraw of the current buffer (high quality)
   */
  forceRedraw() {
    this.palette = sharedGetThemePalette();
    this._drawBuffer(false); // Always full quality on explicit redraw
  }

  /**
   * Release all cached PDF page renderables so they reload on next draw.
   * Needed on theme change: rendered PDF bitmaps are inverted for dark theme
   * (see mediaManager.getRenderedMedia), and that inversion is baked in at
   * render time rather than reapplied per-frame, so a live theme toggle
   * would otherwise keep showing pages rendered for the previous theme.
   */
  invalidatePdfRenderables() {
    // A theme switch also changes which palette an in-progress stroke draws
    // in, so drop the colour cached for it (see drawDirectStroke).
    this._activeStrokeColor = null;
    // Bump unconditionally: a page still loading when the theme flips has no
    // renderable yet, so the loop below would skip it and let it resolve with
    // the previous theme's inversion baked in.
    this._renderGeneration++;
    if (!this.mediaManager) return;
    for (const item of this.mediaManager.getItems()) {
      if (item.type === "pdf-page" && item.renderable) {
        this._releaseItemMemory(item);
      }
    }
  }

  /**
   * Render a full one-shot snapshot of the note (background + media + strokes)
   * into a target canvas context, e.g. for a thumbnail. Unlike the live render()
   * loop, this awaits each media item's bitmap before drawing rather than relying
   * on already-cached item.renderable — needed because a freshly constructed
   * renderer (as used for thumbnails) has nothing cached yet. Media is drawn
   * before strokes so z-order matches the editor.
   * @param {CanvasRenderingContext2D} targetCtx
   * @param {number} width - Target width
   * @param {number} height - Target height
   * @param {Object} [options]
   * @param {number} [options.maxPdfPages] - Cap how many pdf-page items are rendered
   *   (in document order), to keep load time reasonable for small previews. Default: unlimited.
   * @returns {Promise<{bgColor: string}>}
   */
  async renderSnapshot(targetCtx, width, height, options = {}) {
    const { maxPdfPages = Infinity } = options;
    // Calculate scale to fit content width into target width
    // We assume we want to capture the full width of the note
    const scale = width / this.maxContentWidth;
    const contentHeight = height / scale;

    targetCtx.save();

    // Fill background using the current theme color (prevents black on JPEG for transparent notes)
    const isDark = getTheme() === "dark";
    const bgColor = isDark ? "#1e1e2e" : "#ffffff";
    targetCtx.fillStyle = bgColor;
    targetCtx.fillRect(0, 0, width, height);

    targetCtx.scale(scale, scale);

    // Ensure palette is ready
    if (!this.palette) {
      this.palette = sharedGetThemePalette();
      this.markerPalette = sharedGetMarkerPalette();
    }

    // 1. Background
    if (this.background && this.background !== "none") {
      sharedDrawBackgroundPattern(
        targetCtx,
        this.background,
        this.maxContentWidth,
        contentHeight,
        0,
      );
    }

    // 2. Media — await each item's bitmap (PDF pages and images alike) since
    // nothing is pre-cached on a freshly constructed renderer.
    let visibleItems = this.mediaManager
      ? this.mediaManager
          .getItems()
          .filter((item) => !item.deleted && item.y <= contentHeight && item.y + item.height >= 0)
      : [];

    if (Number.isFinite(maxPdfPages)) {
      let pdfPageCount = 0;
      visibleItems = visibleItems.filter((item) => {
        if (item.type !== "pdf-page") return true;
        pdfPageCount++;
        return pdfPageCount <= maxPdfPages;
      });
    }

    await Promise.all(
      visibleItems.map(async (item) => {
        // A snapshot renders best-effort: a media item that fails is omitted
        // rather than failing the whole thumbnail. Logged, not silent, so the
        // failure is still diagnosable — getRenderedMedia no longer logs itself.
        const snapshotFailure = (err) => {
          console.warn(`[CanvasRenderer] Snapshot skipped media item ${item.id}:`, err);
          return null;
        };
        if (item.type === "pdf-page") {
          item.renderable = await getRenderedMedia(item, scale, {
            invertForDarkTheme: true,
          }).catch(snapshotFailure);
        } else if (item.type === "image" && item.fileId) {
          item.renderable = await getRenderedMedia(item, scale).catch(snapshotFailure);
        }
      }),
    );

    for (const item of visibleItems) {
      // Bitmaps are awaited above and drawn here a tick later, so an LRU
      // eviction in the shared render cache may have released one in between.
      // A zero-sized source makes drawImage throw InvalidStateError and would
      // abort the whole thumbnail, so skip rather than draw.
      if (!item.renderable?.width || !item.renderable.height) continue;
      targetCtx.save();
      if (item.rotation) {
        const cx = item.x + item.width / 2;
        const cy = item.y + item.height / 2;
        targetCtx.translate(cx, cy);
        targetCtx.rotate((item.rotation * Math.PI) / 180);
        targetCtx.translate(-cx, -cy);
      }
      targetCtx.drawImage(item.renderable, item.x, item.y, item.width, item.height);
      targetCtx.restore();
    }

    // 3. Strokes — same light-palette-on-white-PDF logic as the live editor.
    const uninvertedPdfBounds = this._getUninvertedPdfBounds();
    const lightPalette = uninvertedPdfBounds.length > 0 ? sharedGetThemePalette("light") : null;
    const lightMarkerPalette =
      uninvertedPdfBounds.length > 0 ? sharedGetMarkerPalette("light") : null;

    // Query spatial index for top region
    const strokeIndices = this.spatialIndex
      ? this.spatialIndex.query(0, contentHeight)
      : this.strokes.map((_, i) => i);

    const markers = [];
    const pens = [];

    for (const index of strokeIndices) {
      const stroke = this.strokes[index];
      if (stroke && !stroke._deleted && !stroke.isDeleted) {
        if (stroke.type === "marker") markers.push(stroke);
        else pens.push(stroke);
      }
    }

    // Draw markers (grouped by groupId to preserve flat alpha), then pens
    const getMarkerColorsForStroke = (stroke) =>
      this._strokeNeedsLightPalette(stroke, uninvertedPdfBounds)
        ? lightMarkerPalette
        : this.markerPalette || sharedGetMarkerPalette();
    drawMarkersGrouped(targetCtx, markers, this.palette, null, getMarkerColorsForStroke);
    for (const stroke of pens) {
      const strokePalette = this._strokeNeedsLightPalette(stroke, uninvertedPdfBounds)
        ? lightPalette
        : this.palette;
      sharedDrawStroke(targetCtx, stroke, strokePalette, false, false);
    }

    targetCtx.restore();
    return { bgColor };
  }

  /**
   * Clean up resources
   */
  destroy() {
    if (this.zoomRenderTimeout) {
      clearTimeout(this.zoomRenderTimeout);
      this.zoomRenderTimeout = null;
    }

    if (this._qualityRenderTimeout) {
      clearTimeout(this._qualityRenderTimeout);
    }

    if (this._pdfQueueCheckTimeout) {
      clearTimeout(this._pdfQueueCheckTimeout);
    }

    this.stopPendingMediaAnimation();

    // Release the on-screen pins: nothing of this renderer is visible any more,
    // and leaving them set would reserve cache budget for bitmaps no one draws.
    setPinnedRenderKeys([]);

    if (this.canvas?.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }

    if (this.overlayCanvas?.parentElement) {
      this.overlayCanvas.parentElement.removeChild(this.overlayCanvas);
    }

    this.canvas = null;
    this.ctx = null;
    this.strokes = [];
    this.spatialIndex = null;
  }
}
