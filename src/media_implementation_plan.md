# Media, Markdown, and PDF Implementation Plan

## 1. Architecture Decisions & Answers

### Q1: Should we combine Markdown and Images (e.g., Milkdown)?
**Decision:** **No, keep them separate layers.**
*   **Reasoning:** `oneJournal` is primarily an "Infinite Canvas" tool. Libraries like Milkdown or Tiptap treat the document as a linear flow of blocks. While great for typing, they make free-form handwriting and arbitrary image placement (e.g., annotating *over* an image) difficult to manage.
*   **Approach:**
    1.  **Text Layer (Bottom):** A background layer for Markdown text (linear flow).
    2.  **Media Layer (Middle):** Free-floating images/PDF pages positioned via absolute coordinates.
    3.  **Stroke Layer (Top):** The existing canvas for handwriting.

### Q2: How to align the infinite canvas with page-wise PDF?
**Decision:** **Vertical Stack Layout.**
*   **Reasoning:** The `VirtualScroller` and `SpatialIndex` are already optimized for the Y-axis.
*   **Approach:**
    *   When a PDF is imported, render pages as individual "Media Items" stacked vertically with a fixed gap (e.g., 20px).
    *   The `contentHeight` of the `NoteCanvas` becomes `(PageHeight + Gap) * PageCount`.
    *   Strokes are recorded in absolute Y coordinates. The `SpatialIndex` naturally handles this, associating strokes with the visual location of the PDF page.

### Q3: Combine PDF and Markdown?
**Decision:** **Unified Note Type (Dynamic Background).**
*   **Reasoning:** Users should not be forced to choose a note "mode" upfront.
*   **Approach:**
    *   **Default:** Background renders Grid/Lines/Dots.
    *   **With PDF:** Background renders PDF pages (stacked vertically).
    *   **Implementation:** The `CanvasRenderer` checks for an attached PDF. If present, it replaces the grid background with the PDF page rendering. All other tools (pen, highlighter, images) work identically on top.

### Q4: How to handle large files (Storage/Memory)?
**Decision:** **Binary Storage (Blobs), NOT Base64.**
*   **Reasoning:** Base64 adds ~33% overhead. Storing a 150MB PDF as a string (~200MB) in memory/IndexedDB is inefficient and causes browser crashes.
*   **Approach:**
    *   **Storage:** Store files as `Blob` or `ArrayBuffer` directly in IndexedDB.
    *   **Runtime:** Use `URL.createObjectURL(blob)` to generate a temporary URL for rendering. This avoids keeping the entire file data in the JavaScript heap.
    *   **PDF.js:** Configure to read from the Blob URL or ArrayBuffer range.

### Q5: What format for Synchronization?
**Decision:** **Detached Binary Files.**
*   **Reasoning:** Embedding 150MB+ files as Base64 in JSON causes OOM crashes and inefficient sync (re-uploading huge files on small edits).
*   **Approach:**
    *   **Note JSON:** Contains metadata reference: `{ type: "pdf", fileId: "uuid", filename: "doc.pdf" }`.
    *   **WebDAV:** Upload binary files to a `_media` or `resources` subfolder.
    *   **Protocol:** Sync logic checks `fileId` references. If the file is missing locally/remotely, it transfers the raw binary file separately.

### Q6: Backward Compatibility?
**Decision:** **No Backward Compatibility.**
*   **Reasoning:** The old Base64 media storage is inefficient. We will not migrate old images.
*   **Action:** Remove `mediaVersion` field. Old notes with Base64 images will either lose images or need manual re-import. The code will assume the new binary reference format.

---

## 2. Implementation Phases

### Phase 1: Media Support (Images) in `NoteCanvas`
*Goal: Re-implement the image support from the old editor into the new virtualized architecture.*

1.  **Data Model Update:**
    *   Ensure `NoteData` structure supports `media: [{ id, type: 'image', x, y, width, height, fileId }]`.
2.  **`MediaManager` Module:**
    *   Create `src/components/NoteCanvas/MediaManager.js`.
    *   Responsibilities: Load images, manage selection state, handle drag/resize logic.
3.  **`CanvasRenderer` Update:**
    *   Add a `drawMedia()` pass.
    *   **Optimization:** Only draw images that intersect with the current `VirtualScroller` viewport (culling).
4.  **Input Handling:**
    *   Update `InputHandler` to detect clicks on media items vs. empty canvas.
    *   Implement "Image Mode" vs "Draw Mode" logic (similar to old editor but cleaner).

### Phase 2: Markdown Text Layer
*Goal: Add the text editing capability behind the canvas.*

1.  **DOM Structure:**
    *   Place a `div.text-layer` *behind* the `canvas` in `NoteCanvas.js`.
    *   Use `contenteditable` or a lightweight wrapper (e.g., simple Markdown parser).
2.  **Synchronization:**
    *   When text height changes, update `VirtualScroller.setContentSize`.
    *   **Challenge:** If text pushes content down, strokes drawn *below* the text need to move.
    *   **Solution (MVP):** Text layer is static background (like lined paper). If user inserts new lines, strokes *do not* move automatically (standard whiteboard behavior).
    *   **Solution (Advanced):** "Insert Space" tool that shifts both text and strokes.

### Phase 3: PDF Import & Rendering
*Goal: Import PDF and render pages as background.*

1.  **Dependencies:**
    *   `pdf.js` (Mozilla) for rendering PDF pages to Images/Canvas in the browser.
2.  **Import Logic:**
    *   User selects PDF.
    *   App reads file as `ArrayBuffer` or `Blob`.
    *   Stores raw data in IndexedDB (separate "Files" store or within Note if supported).
    *   Populates `media` array with pages: `{ type: 'pdf-page', pageIndex: 0, x: 0, y: 0, ... }`.
3.  **Rendering:**
    *   `MediaManager` uses `pdf.js` to render the specific page into the viewport when visible.
    *   Use a cache to prevent re-rendering PDF pages on every scroll frame.

### Phase 4: PDF Export (High Fidelity)
*Goal: Export annotations on top of original PDF vector data.*

1.  **Dependencies:**
    *   `pdf-lib` (for modifying existing PDFs).
2.  **Export Logic (Document Note):**
    *   Load original PDF bytes using `pdf-lib`.
    *   Iterate through `NoteData.strokes`.
    *   Map stroke coordinates (relative to the PDF page in the vertical stack) to PDF Page coordinates.
    *   Draw strokes as SVG paths or vector lines onto the PDF pages using `pdf-lib` primitives.
    *   **Result:** A true PDF where original text is selectable and handwriting is vector data.
3.  **Export Logic (Canvas Note):**
    *   Use `jspdf`.
    *   Take snapshots of the canvas (raster) or convert strokes to PDF vectors.
    *   Paginate based on A4 dimensions.

---

## 3. Technical Stack & Libraries

| Feature | Library | Purpose |
| :--- | :--- | :--- |
| **PDF Rendering** | `pdfjs-dist` | Rendering PDF pages to canvas for viewing. |
| **PDF Manipulation** | `pdf-lib` | Loading original PDF and injecting vector strokes for export. |
| **Markdown** | `marked` | Converting Markdown to HTML for the text layer. |
| **Export** | `jspdf` | Generating new PDFs from scratch (Canvas Notes). |

## 4. Data Structure Changes

**`Note` Object:**
```javascript
{
  id: "uuid",
  content: "# Markdown...",
  pdfSource: "blob_id_reference", // Reference to binary data in DB
  media: [
    {
      id: "uuid",
      type: "image" | "pdf-page",
      x: 0, y: 0, w: 500, h: 800,
      fileId: "uuid_of_file", // Reference to binary data in 'files' store
      pageIndex: 0 // For PDF pages
    }
  ],
  strokes: [...]
}
