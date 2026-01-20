# Note View Performance Refactoring Plan

## Objective
Refactor the note rendering engine to support "infinite" vertical scrolling, high-performance zooming, and low-latency drawing by moving away from a single massive canvas bitmap to a virtualized viewport architecture.

## Architecture Overview

### Core Concepts
1.  **Virtual Viewport**: The canvas element size matches the screen (plus a buffer), not the document.
2.  **Sliding Buffer**: A vertical buffer (e.g., 3x screen height) slides as the user scrolls, minimizing expensive redraws.
3.  **Spatial Indexing**: A 1D Y-Axis Bucket system to efficiently query which strokes to render.
4.  **Component Separation**: Breaking `notebookEditor.js` into specialized modules.

### New Module Structure
We will create a new directory `src/components/NoteCanvas/` to house the new engine.

-   `NoteCanvas.js`: Main entry point, manages lifecycle and coordinates modules.
-   `VirtualScroller.js`: Manages the "phantom" scroll height and scroll events.
-   `CanvasRenderer.js`: Manages the HTML5 Canvas elements, contexts, and transforms.
-   `SpatialIndex.js`: Data structure for efficient stroke querying.
-   `InputHandler.js`: Manages pointer events (raw input -> stroke data).
-   `StrokeManager.js`: Manages stroke data, history (undo/redo), and persistence.

---

## Phase 1: Performant Rendering (Read-Only)

**Goal**: Render existing notes with smooth scrolling (60fps) and instant zooming, regardless of note length. No editing capabilities yet.

### 1.1 Data Structure & Indexing (`SpatialIndex.js`)
-   **Task**: Implement a class to index strokes by Y-coordinate.
-   **Logic**:
    -   Divide document into fixed-height buckets (e.g., 1000px).
    -   Map: `BucketID -> Array<StrokeIndex>`.
    -   `query(visibleRect)`: Returns all strokes in overlapping buckets.
    -   **Benefit**: `O(1)` lookup for visible strokes instead of `O(N)` iteration.

### 1.2 Virtual Scroller (`VirtualScroller.js`)
-   **Task**: Decouple the scrollbar from the canvas.
-   **Logic**:
    -   Create a container `div` with `overflow-y: auto`.
    -   Inside, place a "phantom" `div` with height = `max(contentHeight, minHeight)`.
    -   Listen to `scroll` events to drive the canvas rendering.

### 1.3 Viewport Rendering Engine (`CanvasRenderer.js`)
-   **Task**: Implement the Sliding Buffer strategy.
-   **Logic**:
    -   **Static Canvas**: Sized to `window.innerHeight * 3`.
    -   **Render Loop**:
        1.  On scroll, translate the canvas visually using CSS `transform: translateY(...)`.
        2.  If scroll exceeds buffer threshold, reset transform, reposition canvas `top`, and redraw the bitmap (The "Leapfrog" technique).
    -   **Zoom**:
        1.  Update `transform: scale(...)` on the canvas for instant preview.
        2.  Debounce a full re-render at the new resolution.
        3.  Adjust the "phantom" div height based on zoom level.

### 1.4 Integration
-   **Task**: Replace the rendering logic in a copy of the editor or a new route.
-   **Deliverable**: A viewer that can load a large JSON of strokes and scroll/zoom smoothly.

---

## Phase 2: Low-Latency Drawing (Write)

**Goal**: Implement drawing with minimal latency and prevent "jank" caused by background tasks (saving/baking).

### 2.1 Input Handling (`InputHandler.js`)
-   **Task**: Capture raw pointer events.
-   **Logic**:
    -   Use `pointerdown`, `pointermove`, `pointerup`.
    -   Apply `getCoalescedEvents()` for higher precision curves.
    -   Map screen coordinates -> Document coordinates (accounting for scroll & zoom).

### 2.2 The Dynamic Layer
-   **Task**: Render the stroke currently being drawn.
-   **Logic**:
    -   Use a separate `dynamicCanvas` (transparent, matches viewport size).
    -   Clear and redraw only the new segment (or the whole active stroke) every frame.
    -   **Optimization**: Do not touch the heavy `staticCanvas` while drawing.

### 2.3 Asynchronous "Baking" & Persistence
-   **Problem**: Merging the dynamic stroke into the static canvas and saving to IndexedDB can cause a frame drop, interrupting the *next* stroke if the user draws fast.
-   **Solution**:
    1.  **Stroke Queue**: When `pointerup` occurs, push the stroke to a "Pending Queue".
    2.  **Visual Commit**: Draw the stroke onto the `staticCanvas` immediately (fast operation).
    3.  **Lazy Save**:
        -   Offload `JSON.stringify` and IndexedDB writes to a **Web Worker**.
        -   Or, debounce the save heavily (e.g., 5 seconds) and only save when the user is idle.
    4.  **Safety**: If the user starts drawing again while "Baking", defer the bake.

---

## Phase 3: Manipulation & Tools

**Goal**: Re-implement Eraser, Selection, and Transformation using the new Spatial Index.

### 3.1 Eraser
-   **Task**: Efficiently find strokes to erase.
-   **Logic**:
    -   Use `SpatialIndex` to find strokes near the eraser point.
    -   Perform precise intersection tests only on those candidates.
    -   Update the Index when a stroke is modified/deleted.

### 3.2 Lasso Selection
-   **Task**: Select strokes within a polygon.
-   **Logic**:
    -   Query `SpatialIndex` for strokes within the Lasso Bounding Box.
    -   Perform point-in-polygon tests.
    -   Render selection highlight on an `overlayCanvas`.

### 3.3 Transformation
-   **Task**: Move/Resize/Rotate.
-   **Logic**:
    -   Update stroke coordinates.
    -   **Crucial**: Remove old bounds from `SpatialIndex` and re-insert with new bounds.
    -   Trigger a re-render of the affected buffer regions.

---

## Phase 4: Backgrounds

**Goal**: Render infinite backgrounds (grids, lines) efficiently.

### 4.1 Pattern Rendering
-   **Task**: Draw background patterns on the `staticCanvas`.
-   **Logic**:
    -   Since `staticCanvas` is a sliding buffer, we only draw the background for the visible slice + buffer.
    -   Use `context.translate` and modulo arithmetic to align grid lines correctly regardless of scroll position.
    -   *Optimization*: Use a separate `backgroundCanvas` or CSS background patterns if possible to avoid redrawing lines on every buffer shift.

---

## Phase 5: Images & Media

**Goal**: Handle images within the virtualized coordinate system.

### 5.1 Media Indexing
-   **Task**: Track image positions.
-   **Logic**:
    -   Add images to the `SpatialIndex` (or a separate `MediaIndex`).
    -   Virtualization: Only create `<img>` elements or draw to canvas for images currently in the viewport.

### 5.2 Media Rendering
-   **Task**: Draw images.
-   **Logic**:
    -   Draw images onto the `staticCanvas` (layered below strokes) OR manage them as DOM elements floating over the canvas (better for accessibility and browser-native handling, but complex for Z-indexing with strokes).
    -   *Decision*: Drawing to canvas is usually more performant for zooming/panning in sync with strokes.