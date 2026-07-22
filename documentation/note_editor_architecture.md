# Note Editor Architecture

Covers the internals of `src/components/NoteCanvas/` — stroke recording, canvas rendering, undo/redo, media, text editing, and the handoff to storage. For the broader app (sync, platforms, security) see [architecture_design.md](architecture_design.md); for sync specifically see [sync_architecture.md](sync_architecture.md).

---

## Overview & Composition

`index.js` is the module entry point (not part of the class hierarchy): it wires window-level events (`rendernotebook`, `navigate`, `datachange`) to create/destroy a single module-level `NoteCanvas` instance, and re-exports `NoteCanvas`, `CanvasRenderer`, `SpatialIndex`, `VirtualScroller`.

`NoteCanvas.js` (~4900 lines) is a single orchestrator **class**, instantiated once per opened note (`new NoteCanvas(container)` then `await instance.load(noteId, options)`). The constructor only sets up state fields; all DOM/module construction happens in `load()`, which builds the toolbar and scroller DOM, then instantiates every subordinate module in dependency order:

1. `VirtualScroller` (scroll virtualization), then `SpatialIndex` (viewport-sized).
2. `MediaManager`, `MediaOverlay`, `SelectionOverlay`, `TaskCheckboxLayer`, `PdfTextLayerManager`, `CanvasRenderer` — wired together via setters (`setSpatialIndex`, `setMediaManager`).
3. `StrokeManager` (owns the `StorageWorker`).
4. `HistoryManager` (`setNoteCanvas(this)` gives commands a back-reference to the orchestrator).
5. `TextEditorLayer` (Trumbowyg), with callbacks into `NoteCanvas` (`onContentChange`, `onHeightChange`, `onTaskCreate`, `onTaskToggle`) and the shared `historyManager`.
6. `InputHandler`, given a `contextProvider` (closures for zoom/scroll/rect/offset) and stroke callbacks bound to `NoteCanvas`.
7. `NoteToolbar`, with a callback bag for mode changes, pen presets, undo/redo, eraser settings, background/export/delete.
8. Later: `NoteNavigator`, `SoundDialog` / `RecordingManager`.

There's no central event bus — every module takes DOM element(s) plus a callbacks object in its constructor and calls back into `NoteCanvas` methods; `NoteCanvas` calls into the modules' public methods in turn (`renderer.forceRedraw()`, `spatialIndex.insert()`, `mediaManager.addItem()`, …). Plain ES classes throughout, no UI framework — DOM is built with `document.createElement`. `jquerySetup.js` exists solely to put `jQuery` on `window` before Trumbowyg's UMD wrapper self-registers.

`NoteCanvas.js` also exports free functions used by `CanvasRenderer` for selection-handle geometry (`getSelectionHandles()`, `getMediaHandles()`, handle-size constants) — a two-way import between the two files.

---

## Stroke Recording Pipeline

**`InputHandler.js`** is a thin, renderer-agnostic pointer adapter. It attaches `pointerdown/move/up/cancel` on the viewport, converts client coordinates to content coordinates via the injected `contextProvider` (accounting for zoom, scroll, viewport rect, centering offset), and forwards three callbacks: `onStrokeStart({x, y, pressure, pointerType, pointerId, clientX, clientY, target})`, `onStrokeMove(points[])`, `onStrokeEnd()`. On move it reads `event.getCoalescedEvents()` (falling back to `[event]`) so high-frequency stylus samples aren't dropped. It calls `setPointerCapture`/`releasePointerCapture` and `preventDefault()` to suppress scrolling while drawing. It has **no knowledge of strokes, tools, or storage** — `NoteCanvas._onStrokeStart/_onStrokeMove/_onStrokeEnd` decide what a pointer session means (draw / erase / lasso / media-drag / transform / insert-space) based on the current `mode`.

**Stroke shape**, constructed in `StrokeManager.startStroke()`:
```javascript
{
  id: generateId(),
  x: [x0, x1, ...],
  y: [y0, y1, ...],
  pressure: [p0, p1, ...],
  time: [t0, t1, ...],        // Date.now() per point — NOT event.timeStamp
  colorIndex: 0,
  width: 2,
  pointerType: "pen" | "mouse" | "touch",
  type: "pen" | "marker",
}
```
This matches the `x[]/y[]/pressure[]/time[]` parallel-array format documented in architecture_design.md. Note that `time` is wall-clock `Date.now()` captured when each point is added — `InputHandler`'s `event.timeStamp` is not what gets persisted.

**`StrokeManager.js`** owns the live stroke list (`this.strokes`, shared by reference with `noteData.strokes`) and the in-progress stroke (`this.currentStroke`). `endStroke()` pushes the finished stroke, marks dirty, and calls `_save()`, which filters out soft-deleted strokes (`_deleted`) and posts `SAVE_STROKES` to the worker — **once per completed stroke**, not on a timer. The encryption key (from `getEncryptionKey()` if `isAppUnlocked()`) rides along in the message; in the Nextcloud build the worker is disabled entirely and `_save()` only marks dirty, with the actual WebDAV write happening via `forceSave()`/`destroy()`.

**`strokeLineDetection.js`** is unrelated to live input — it's a post-hoc analysis used by lasso selection → "mark as task"/line-grouping. `detectStrokeLines()` builds a vertical density histogram (3px bins, smoothed) over selected strokes' Y-extents, finds low-density valleys as line separators, and groups stroke indices into line groups; `detectLineIndentation()` flags indentation (>25px offset vs. previous line). Used to visualize/split lasso selections into logical handwritten lines, not part of the input pipeline itself.

---

## Canvas Layers & Rendering

Inside the `VirtualScroller`'s sticky `viewport` div, the stack (bottom to top) is:

1. `.note-canvas__text-editor-layer` — `TextEditorLayer` container (Trumbowyg), lowest z-index so ink visually overlays typed text.
2. `<canvas class="sliding-buffer-canvas">` — the main content canvas (strokes + media).
3. `<canvas class="note-canvas__overlay">` — ephemeral UI: eraser cursor, lasso trail, marker preview while drawing, insert-space indicator.
4. `.note-canvas__text-layers` — `PdfTextLayerManager`'s container, one invisible text layer per visible PDF page.
5. `.note-canvas__task-checkbox-layer` — `TaskCheckboxLayer`'s positioned DOM checkboxes for stroke-type tasks.
6. `MediaOverlay` / `SelectionOverlay` elements — floating "⋮" buttons and dropdowns, absolutely positioned per selection.

So there are **two actual `<canvas>` elements** (main + overlay), not the six conceptual "layers" a naive reading of "canvas layers" might suggest — the rest are DOM overlays. This is a hybrid canvas+DOM architecture.

**Rendering strategy — sliding-buffer ("leapfrog"), not full-immediate-mode redraw.** `CanvasRenderer` keeps a canvas bitmap sized to `viewportHeight × 3` (a buffer taller than the screen). Scrolling repositions the canvas via CSS transform without redrawing, as long as scroll stays within a "safe zone" inside the buffer. Only when scroll nears the buffer edge does `_repositionBuffer()` trigger a full repaint of the new buffer window — the "leapfrog" named in the file. Within a repaint, all strokes/media intersecting the buffer's Y-range are queried via `SpatialIndex` and redrawn — immediate-mode for that window, but routine scrolling is essentially free.

The renderer also splits **fast vs. quality rendering**: during active scroll it skips full pressure-width variation, then re-renders at full quality 150ms after scroll settles (`_qualityRenderDebounce`); zoom changes are similarly debounced 150ms (`zoomRenderDebounce`) before the expensive full-quality re-render. Actively-drawn strokes use `drawDirectStroke()`, an incremental quadratic-curve renderer that draws only the new segment since `lastDrawnPointIndex` — no whole-buffer invalidation per point. Marker/highlighter strokes are special-cased (`drawMarkersGrouped`) to draw all sub-strokes of one highlighter gesture as a single flat-alpha path (grouped by `groupId`), avoiding alpha-stacking artifacts.

**`SpatialIndex.js`** is a Y-axis bucket index (bucket height ≈ viewport height) mapping bucket → set of stroke indices, plus a per-stroke bounds map for precise AABB checks. `build()` does a full rebuild; `insert()`/`remove()` do incremental single-stroke updates (used by undo/redo commands); `query(top, bottom)` returns candidate indices for a Y range — this is **viewport culling for rendering**, not point-level hit-testing. It also exposes `getContentBounds()` for the note's total content height at load.

**`VirtualScroller.js`** is the scroll-virtualization mechanism, not a pagination UI: a "phantom" div sized to `contentWidth/Height × zoomScale` gives native scrollbar dimensions, while the sticky `viewport` div is where canvases/overlays actually mount. `onScroll`/`onViewportResize` notify `NoteCanvas`, which calls `renderer.render(scrollTop, height, scrollLeft, activeStroke)` and updates the other layers. It also owns `setZoom(scale, fixedPoint)` (zoom-to-point) and `getViewportBounds()` in content coordinates.

---

## History / Undo-Redo

**`HistoryManager.js`** is a textbook command-pattern stack: `undoStack`/`redoStack` arrays, `push(command)` (clears redo stack, caps at `maxHistory = 50`, calling `cmd.cleanup?.()` on evicted entries), `undo()`/`redo()` (pop, call `command.undo(noteCanvas)`/`redo(noteCanvas)`, push onto the other stack), `canUndo()`/`canRedo()`, `clear()` (used when a live sync update invalidates history), and an `onStateChange` callback wired to the toolbar's undo/redo button state. Undo/redo is disabled while actively drawing (checked via `inputHandler.isDrawing`).

Commands share no formal base class — each is a small ES class exposing `redo(noteCanvas)`, `undo(noteCanvas)`, `cleanup()`, reaching directly into `noteCanvas.noteData`, `.spatialIndex`, `.strokeManager`, `.mediaManager`, `.renderer`. Nearly every command's `redo()`/`undo()` ends the same way: flip a `*Changed` flag, call the relevant save method, `renderer.forceRedraw()` — **undo/redo is itself a save-triggering mutation**, not an in-memory-only flip.

| Command | Purpose |
|---|---|
| `DrawStrokeCommand` | Soft-delete/restore one newly drawn stroke (toggles `_deleted` + `deletedStrokes` tombstone) |
| `EraseStrokesCommand` | Batches whole-stroke erasures (eraser "stroke" mode) into one undo step |
| `EraseStrokePartsCommand` | Partial erase: replaces a stroke with N sub-strokes covering the un-erased segments |
| `TransformStrokesCommand` | Move/resize/rotate a lasso selection; stores per-stroke initial/final coordinate arrays |
| `PasteStrokesCommand` | Undo/redo for a batch of pasted strokes already appended to `noteData.strokes` |
| `ShiftContentCommand` | "Insert space" tool — shifts strokes/media below a Y threshold by a delta |
| `InsertMediaCommand` | Inserting image(s) or a batch of PDF pages; undo soft-deletes via `deletedMedia` |
| `DeleteMediaCommand` | Deleting media (including whole-PDF deletes); undo restores from stored copies |
| `TransformMediaCommand` | Move/resize/rotate one media item; has a `hasChanges()` guard to skip no-ops |
| `ReorderMediaCommand` | Z-order changes; stores `originalIndex` to splice back on undo |
| `CropImageCommand` | Cropping produces a new `fileId`; stores both original and cropped `{fileId, width, height}` |
| `MarkTaskCommand` | Creating/removing tasks; undo tombstones the task id so sync won't resurrect it |
| `TextChangeCommand` | Before/after HTML snapshots for Trumbowyg text undo/redo |

---

## Media Overlay

**`MediaManager.js`** is the data/loading layer: holds `mediaItems` (images + PDF pages, `{id, type, x, y, width, height, fileId, rotation}`), an image cache (`fileId → HTMLImageElement`) and blob-URL cache, lazily loading blobs from `storage.js`'s `getFile()` on demand — only for `type === "image"` (PDF pages render through the PDF manager separately). `hitTest(x, y)` rotates the test point into the item's local (unrotated) space before an AABB check, which is what `NoteCanvas` uses to select/drag media. CRUD methods mutate the shared array in place; `removeItem` revokes blob URLs.

**`MediaOverlay.js`** is pure UI: a floating "⋮" button + dropdown (Select/Crop/Send to Front/Send to Back/Delete), tracking `"selected"` vs. `"hover"` mode. `updatePosition()` rotates all four corners of the (possibly rotated) bounding box to find the visual top-right corner, then converts to screen coordinates. All clicks call back into `NoteCanvas`, which invokes `MediaManager`/`HistoryManager`/the media save pipeline.

Move/resize/rotate itself happens in `NoteCanvas` pointer handlers using the rotation-aware `getMediaHandles()` helper; on pointer-up, `TransformMediaCommand` captures before/after state and triggers the save.

**`ImageCropper.js`** is a self-contained modal (`show(image) → Promise<Blob|null>`) supporting both simple rectangular crop and a **perspective-correction mode** (4 draggable corner handles, using the `perspective-transform` package) with an optional lighting-normalization pass. The cropped/warped result is saved as a *new* file; `CropImageCommand` keeps the original so undo can restore it.

**`PdfTextLayerManager.js`** provides text selection over PDF pages rendered as media items (`type: "pdf-page"`) — it doesn't touch visual rendering. For each visible page (± one viewport buffer) it lazily creates an invisible PDF.js `TextLayer` positioned exactly over the rendered page image, enabling native text selection/copy. Layer creation is debounced per page (100ms) and serialized through an internal queue to avoid thrashing during fast scroll; a capped text-content cache (50 entries) avoids re-fetching PDF.js text repeatedly.

---

## Text Editing

**`TextEditorLayer.js`** wraps a Trumbowyg WYSIWYG editor in a `contenteditable` div, absolutely positioned via `top`/`left` (not `transform: translate`, so native scroll-to-caret works) with a separate `transform: scale(zoom)` for zoom. Toolbar: formatting, font size, bold/italic/underline/strikethrough, colors, line height, indent/outdent, lists, mark-as-task, table, remove format. Two custom Trumbowyg plugins:
- **`indentCustom`** — replaces the deprecated `execCommand('indent')` with manual 8px `margin-left` steps across block elements intersecting the selection.
- **`markAsTask`** — delegates to `TextTaskManager.toggleTaskOnSelection()`.

Content changes drive two independent debounces: `_debounceSave()` (500ms) calls `onContentChange(html)` → `NoteCanvas._onTextContentChange()` → `SAVE_CONTENT`; `_debounceHistoryPush()` (300ms) snapshots before/after HTML into a `TextChangeCommand`. Text edits are grouped into ~300ms-idle undo chunks independently of the 500ms save debounce. `forceSave()` (called from `NoteCanvas.destroy()`) flushes both immediately. Untrusted/synced HTML is run through `sanitizeNoteHtml()` before being set into the live editor DOM.

**`TaskCheckboxLayer.js`** handles **stroke-type tasks** only: one DOM checkbox + an invisible clickable bounding box per task, positioned from the live (non-deleted) strokes' computed bounding box — geometry is re-derived from strokes on every `update()`, not stored. Checkbox clicks call `onToggle(taskId, checked)`; clicking the box calls `onTaskClick(taskId)` (re-selects/highlights the task's strokes).

**`TextTaskManager.js`** handles **text-type tasks** — `<span class="task-text" data-task-id="...">`-wrapped segments in the Trumbowyg HTML, plus injected `.task-text-checkbox` elements (stripped from persisted HTML before save). `toggleTaskOnSelection()` operates per `<br>`-delimited line within a block: it expands list containers into leaf `<li>` blocks first (so a whole list is never wrapped in one span), plans add/remove operations per block *before* mutating any DOM (DOM mutation would skew subsequent Range checks), and toggles by convention: if every selected line already has a task, remove from all; otherwise add to lines lacking one. `normalizeBareLines()` (shared with `TextEditorLayer`) wraps bare inline text directly under the editor root into `<div>`s first, since contenteditable doesn't guarantee every line has a block wrapper.

---

## Selection & Clipboard

**Lasso** (`mode === "lasso"`): `NoteCanvas._onStrokeStart` either hits an existing selection's resize/rotate handle, hits inside the selection (move), clicks outside (clear), or starts a fresh lasso — points accumulate in `lassoPoints` and draw as a dashed trail on the **overlay canvas**. On stroke end, the polygon is resolved against `SpatialIndex`-queried candidates, a bounding box is computed, and `renderer.setSelectedStrokes()` plus `SelectionOverlay` are shown.

**`SelectionOverlay.js`** is a floating "⋮" button anchored top-right of the selection bounds, with Copy / Mark as Task / Remove Task / Delete — structurally mirroring `MediaOverlay` (same CSS classes, same outside-click dismissal).

**`SelectionFloatingBar.js`** is the text-selection analog inside Trumbowyg: Cut/Copy/(Paste) centered above the current `Range`, triggered by right-click or a 500ms touch long-press (10px move-cancel threshold). A long-press with no selection shows Paste-only; one that produces a word-selection shows Cut/Copy/Paste on the subsequent pointer-up.

**`ContextFloatingMenu.js`** is a small reusable floating-menu primitive (list of `{label, icon, action}`, auto-repositions to stay in viewport, auto-dismisses on outside pointerdown) — used for the canvas-level long-press Paste menu and similar transient menus.

**`AppClipboard.js`** is a module-level singleton holding exactly one item across note navigations: `{type: "strokes"|"text"|"image", data, bounds}`. Text copies also write plain text to the real OS clipboard via `navigator.clipboard.writeText()`; strokes/image copies are in-app-only. `canPasteInMode(mode)` gates what's pasteable given the current canvas mode.

---

## Recording & Sound

**`RecordingManager.js`** holds `recordings: [{id, fileId, name, duration, created, deleted}]` and `deletedRecordings` (same soft-delete/tombstone pattern used elsewhere), with no UI of its own. `startRecording()` branches on native presence (`window.__TAURI_INTERNALS__`): native (notably Android, where WebView `getUserMedia` is unreliable) invokes a Tauri command via a lazily-imported `invoke()`, translating native error strings to standard `NotAllowedError`/`NotFoundError` so error handling stays uniform; otherwise it uses `MediaRecorder`/`getUserMedia({audio: true})` with a live `AnalyserNode` for amplitude metering. Persistence goes through an `onSave` callback wired to `strokeManager.saveRecordings()` → `SAVE_RECORDINGS`.

**`SoundDialog.js`** is the UI counterpart: a mic-icon trigger plus a dialog listing recordings, sharing one persistent `<audio>` element across dialog open/close (so playback survives closing the dialog), with per-recording playback-position memory. The "New recording" button is rendered **only when native** — see [architecture_design.md](architecture_design.md#audio-recording) for why this means Nextcloud has no recording path at all, import/playback only.

Both are instantiated late in `NoteCanvas.load()` and destroyed in `NoteCanvas.destroy()`.

---

## Navigator

**`NoteNavigator.js`** is a collapsible jump/navigation widget (not a visual minimap), fixed at the upper-right of the note view. It manages "subjects" — categories of navigable points: search matches, PDF pages, PDF chapters/bookmarks, highlighter strokes, tasks — each holding `{y, label}` items. `setSubjects()` can auto-select a subject (e.g. jump straight to "task" when opened via a task deep-link). UI: tap to cycle subject, prev/next arrows with wraparound, a "3/12" position readout. Navigating calls `onNavigate(y, subjectKey, item)`, which `NoteCanvas` wires to `VirtualScroller.scrollTo()`.

---

## Storage Handoff

`StorageWorker.js` runs on one dedicated Web Worker, instantiated once inside `StrokeManager`'s constructor and **reused** by `MediaManager`/`NoteCanvas` (they post through `strokeManager.worker` rather than spawning their own) so all IndexedDB writes are strictly serialized. The worker chains incoming messages onto a `Promise` queue (`messageQueue = messageQueue.then(() => processMessage(e))`) to prevent read-modify-write races.

| Message | Triggered by | Notes |
|---|---|---|
| `SAVE_STROKES` | `StrokeManager._save()` on every completed stroke (`endStroke()`), or `forceSave()` | Gesture-granular — no artificial timer |
| `SAVE_MEDIA` | `StrokeManager.saveMedia()`, called from `NoteCanvas`'s coalescing `_saveMediaChanges()`/`_runMediaSave()` | See coalescing note below |
| `SAVE_PRESETS` | `StrokeManager.savePresets()`, from the toolbar's preset callback | Does not bump `modified`/`version`/`synced` — rides along with the next real save |
| `SAVE_TASKS` | `NoteCanvas._saveTasks()`, posting directly via `strokeManager.worker` | Encrypts both `tasks` and `deletedTasks` |
| `SAVE_CONTENT` | `NoteCanvas._onTextContentChange()`, posting directly | Fires after `TextEditorLayer`'s own 500ms debounce already collapsed keystrokes |
| `SAVE_RECORDINGS` | `RecordingManager`'s `onSave` callback via `StrokeManager.saveRecordings()` | Handles notes with no `noteContent` row yet (audio-only notes) |
| `CLOSE` | `StrokeManager.destroy()`, last in `NoteCanvas.destroy()`'s cleanup order | Queues `self.close()` behind pending writes rather than closing immediately |

**Coalescing, not just debouncing, for media:** `_saveMediaChanges()` starts an async runner if none is active, or — if one is already in flight — just flags `_mediaSaveDirty = true` and returns the existing promise. N rapid media edits collapse into "one in-flight save + at most one trailing pass," explicitly to avoid concurrent WebDAV PUTs to the same file (423 Locked) and premature media cleanup deletions.

**Encryption** is applied uniformly at the worker boundary: every save path fetches the current AES key if the app is unlocked (`isAppUnlocked()`/`getEncryptionKey()`) and passes it in the postMessage payload; the worker calls `encryptObject(data, key)` only if the note's persisted `index.encrypted` flag is true, otherwise data is stored as plaintext JSON. If a note is encrypted but no key is available (app locked), the worker **drops the save and logs an error** rather than persisting plaintext or blocking — the in-memory edit exists but is not saved until the app is unlocked and the action repeated.
