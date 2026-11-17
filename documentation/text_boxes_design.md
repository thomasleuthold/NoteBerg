# Text boxes — Design

## Decision record

**Context.** Feedback asked for "any number of text boxes at different
locations on the sheet". A note had one flow of text from the top, which cannot
sit next to ink. Notes sync and merge as one HTML string, and clients older
than this feature stay in use (the Nextcloud app can lag for months).

**Decisions**

- **D1** **All text lives in boxes**: one `TextBox` component, one toolbar. The
  existing flow text is the **main box**, movable and resizable from v1, and
  wrapped into an ordinary box lazily on its first move or resize. No bulk
  migration (§2).
- **D2** Boxes are `.text-box` wrappers **inside `note.content`**
  (`data-box-id`, `data-x`, `data-y`, `data-w`; height is measured). No separate
  `textBoxes` field (§3).
- **D3** **One Trumbowyg instance, mounted on the active box only**; every other
  box is static HTML (§4.2).
- **D4** **A tap on empty page creates a box**, with mouse, pen or finger. A tap
  while a box is active only leaves it. A tap within 48 px below a box
  continues it (§5).
- **D5** Positions snap to the background's line or grid (24 px / 8 px on plain
  pages). A new box defaults to 400 px wide and shrinks to the room left,
  minimum 200 px (§5).
- **D6** A faint frame is always visible in the app, never in the thumbnail or
  the PDF export (§4.3).
- **D7** The **lasso never touches boxes**; boxes move by their handles (§5).
- **D8** Boxes are merged **by id**, text inside each box by the block merge
  (§6).
- **D9** Insert-space moves boxes below the split like strokes and media (§7).
- **D10** Boxes on PDF pages are supported; boxes anchored to a PDF page are
  not (§1).

**Consequences**

- Clicking on empty page below the text no longer continues the main text; it
  creates a box, except in the continue zone.
- Concurrent insert-space and box creation on two devices can leave the new
  box unshifted (§3.2); a box is easy to move.
- The merge needs box-aware rules and a property test (§6).
- Normalization of damaged or old-client HTML runs on every load (§3.1).

**Rejected alternatives**

- *Real migration of existing text into a box*: rewrites every note on open, a
  full re-upload and a changed merge base on every device at once.
- *Boxes in addition to flow text (two systems)*: two editors with different
  behaviour for toolbar, tasks, search and undo.
- *Separate `textBoxes` field*: old clients would drop it on merge, and every
  consumer of `content` would need changes (§3.2).
- *One Trumbowyg instance per box*: instances accumulate, per-instance
  workarounds run N times, the toolbar must swap panes.
- *One contenteditable with non-editable box islands*: Backspace merges boxes,
  selection crosses boxes, weak on Android IMEs.
- *Add Trumbowyg's image tools, or block image paste*: a second weaker set of
  image tools and base64 growth; or a capability removed with no replacement.
- *Two-step release, version gate, `formatVersion` bump*: extra release cycle,
  new sync metadata, or impossible because clients do not check it.
- *Inline position styles in the HTML*: Chromium copies inline style onto the
  next paragraph on Enter, and positioned children break caret placement in the
  old single editor.

## 1. Goal

- Any number of text boxes per note, each at its own position on the page.
- A box can be moved and its width changed; its height follows its text.
- Every box is a full rich-text editor (same formatting, lists, tables, tasks
  as the current text).
- The existing text toolbar acts on whichever box is active.
- Insert-space moves boxes below the split line, like strokes and media.
- Works the same on Windows, Android and the Nextcloud app, and syncs and
  merges like the current text.

Boxes on top of PDF pages are supported: in text mode the PDF text layer
ignores pointer input, so a tap on a PDF page creates a box there. (Found in
implementation: `PdfTextLayerManager.setMode` turns pointer input off on the
layers' container only, and each page layer turns it on again for itself, so
a tap on a PDF's text never reached the text layer; a text-mode rule in
`NoteCanvas.css` turns it off on the page layers too.) That makes typing onto
PDFs (forms, annotations) work. Boxes behave like strokes on a PDF page: in
content coordinates, moved by insert-space while the PDF page itself is not.

## 2. Main box without a migration

The existing flow text of a note is its **main box**: a box like any other,
movable and resizable from the first version on (making it movable later would
be a second UX break of the same kind). Until the user first moves or resizes
it, it is stored exactly as text is stored today (unwrapped HTML at the top
level of `note.content`); the first move or resize wraps it into an ordinary
box (§3.1). Existing notes are not rewritten on open, do not become dirty and
re-upload, and the text of a note nobody touches stays aligned with its ink.

## 3. Data model

### 3.1 Boxes live inside `note.content`

Boxes are wrapper elements in the same HTML string the note already has:

```html
<p>Main text, as today.</p>
<ul><li>…</li></ul>
<div class="text-box" data-box-id="tb_k3x9…" data-x="640" data-y="312" data-w="400">
  <p>Text of the box.</p>
</div>
<div class="text-box" data-box-id="tb_7hq2…" data-x="80" data-y="1440" data-w="320">
  <p>…</p>
</div>
```

- **Implicit main box** = every top-level node that is not a `.text-box`. No
  wrapper, no attributes, so a note without boxes is byte-for-byte today's
  format. Its geometry is implied: origin, full width, with today's padding
  (`15px 20px 20px 46px`). When it has no text it is not rendered at all.
  (Found in implementation: the single editor's text started 16 px down, not
  15: Trumbowyg's hidden textarea is a 1 px tall block above the editor. The
  static main box uses 16 px top padding and the editor's textarea is taken
  out of the flow, so legacy text stays exactly where it was relative to its
  ink: `MAIN_PADDING` in `textBoxes.js`.)
- **Wrapping on first move or resize.** The implicit main box becomes a
  `.text-box` with a new id and geometry computed so its text does not move:
  `x = 46 − boxPaddingLeft`, `y = 16 − boxPaddingTop`, `w` so the text column
  keeps its width (38, 12, 1150: `MAIN_BOX_GEOMETRY`). Only then is the drag or resize applied. One
  `TextChangeCommand` covers wrap and move, so undo restores the unwrapped
  form.
- **New text always goes into a wrapped box.** A new note has no implicit main
  box; the first click creates a box where it lands. The implicit form exists
  only for text written before this feature (and for writers that append to
  the unwrapped text, see MCP in §8).
- **Box geometry** in content pixels (the 1200 px wide content space strokes
  use), integers: `data-x`, `data-y` (top-left), `data-w` (width). No height
  is stored; it is measured.
- **Box id** `data-box-id`: random, like stroke ids. Used by the merge to
  match a box across versions.
- Positions are applied at render time (`style.left/top/width` set from the
  attributes, removed again by `getContent()`), never stored as inline style.
  Chromium copies a block's inline style onto the next paragraph on Enter (see
  the cross-device investigation), and keeping position out of `style` keeps
  the stored HTML plain.
- Boxes are top-level only. A `.text-box` found inside another one (paste,
  bad merge) is unwrapped into its parent on load. Pasted HTML that contains
  `.text-box` wrappers from another note has them stripped.
- **Normalization on load** (pure, in `textBoxes.js`; the result is saved only
  when the user next edits, so opening a note never makes it dirty):
  - *Text after a box belongs to that box.* Unwrapped top-level nodes that
    come after a `.text-box` in DOM order are moved into the box before them.
    This is where an old client puts text typed "at the end": its user saw
    that box's text last, so it is the continuation. Without this rule the
    text would count as implicit main text and be drawn at the origin, on
    top of a moved main box. Only unwrapped nodes before the first box are
    the implicit main box.
  - *Duplicate ids.* Two boxes with the same `data-box-id` (an old client's
    merge of a concurrent move and edit keeps both copies) are kept; the
    second gets a new id, so both are separate boxes from then on.
  - *Missing or invalid geometry* (old client damaged the attributes):
    the box is placed below the lowest content at the default width; its
    text is never dropped.
- **Notes without boxes take today's path.** Parsing, normalization,
  serialization and merge of a note with no `.text-box` must give
  byte-identical results to the current code. This is tested explicitly, so
  the feature cannot change any existing note that nobody edits with boxes.
- DOM order of boxes is their creation order and stays stable; moving a box
  only changes its attributes. Reordering on every move would make the merge
  see deletions and insertions instead of an edit.


## 4. Editor architecture

### 4.1 Components

Today `TextEditorLayer` owns one Trumbowyg instance and everything around it.
It is split in two:

- **`TextLayer`** (keeps `TextEditorLayer`'s public API, so `NoteCanvas`,
  `TextChangeCommand` and `liveText.js` change little): the container in the
  viewport (`top/left` + `scale()` positioning), the shared vertical toolbar,
  `getContent()` / `setContentSilently()` / `replaceContent()` over all boxes,
  debounced save and history, content height, search highlights, task
  checkboxes, the active box, and the **one** Trumbowyg instance (§4.2).
- **`TextBox`**: one per box including the main box. Its element, geometry,
  chrome (handles, frame), its HTML string, and its rendering as static HTML
  while it is not active.

`getContent()` serializes the main box's children, then each box's wrapper
(attributes from the model, inner HTML from the editor for the active box and
from the stored string for every other box), and runs the existing clean-up
(checkboxes, search marks, merge-hint labels) once over the result.
`setContentSilently(html)` parses, splits into main + boxes by `.text-box`, and
updates boxes by id (create, update, remove), so an undo or a live take-in
re-renders only boxes that changed.

### 4.2 One Trumbowyg instance, on the active box only (decided)

Only the active box has an editor. Activating a box mounts Trumbowyg on it;
leaving it destroys the instance and the box goes back to static, sanitized
HTML. At most one instance exists at any time.

Rationale:

- Since there is one instance at a time, as today, the existing workarounds in
  `TextEditorLayer` (button pane moved into the vertical toolbar, dropdown
  positioning patch, table-button proxy, mousedown focus guard, sprite
  injection and relocation, `<base>` removal) keep working nearly unchanged.
  They run on each mount instead of once per note.
- Memory and DOM do not grow with the number of boxes; opening a note with
  many boxes costs static HTML only.
- An inactive box is rendered the same way as in the thumbnail and the PDF
  export.

Rules that make D3 work:

- **No layout shift on activation.** Static and active rendering use the same
  CSS for the box, its padding and its content; Trumbowyg's wrapper
  (`.trumbowyg-box`, `.trumbowyg-editor`) gets no extra padding, margin or
  `min-height` inside a box. Tested: every line keeps its position (within
  0.5 px) when a box is activated and left again.
- **Mounting is not an edit.** Trumbowyg normalizes HTML on load. When a box
  is left without a `tbwchange` since activation, the box keeps its original
  HTML string; the editor's HTML is read back only after a real edit. So
  tapping into a box and out again never makes the note dirty or causes a
  merge. (Found in implementation: `tbwchange` also fires without a change,
  e.g. on keyup of an arrow key, so the editor's HTML counts as edited only
  when it differs from what it showed right after mounting. And Trumbowyg's
  `destroy()` does not restore the element: it leaves its `editor-box`
  wrapper holding the normalized HTML. The layer removes that and renders the
  stored string again.)
- **Mount and focus inside the tap.** Android shows the on-screen keyboard
  only for a focus made during the user's gesture. Trumbowyg init and
  `focus()` therefore run synchronously in the tap handler, never after an
  `await` or timer.
- **Caret where the user tapped.** The tap point is recorded before mounting;
  after mounting, the caret is placed with `caretPositionFromPoint` (with
  `caretRangeFromPoint` as fallback) at that point. In the continue zone
  (§5) it goes to the end of the box instead.
- **Toolbar without an active box** is a static, disabled copy of the
  button pane (same layout, no instance behind it), so the toolbar neither
  disappears nor jumps. Its tooltip says "Tap into a text, or on the page to
  start one", so the disabled state does not read as broken.
- **Mount cost** (about 20 buttons and the dropdowns built on every
  activation) is measured in spike S1 on a mid-range Android tablet; the
  budget is one frame (16 ms) between tap and caret.
- `TextTaskManager`, `SelectionFloatingBar`, paste handling and search work
  on the layer root with event delegation instead of on one editor element,
  so they cover static boxes and the active one alike.
- **Task orphan cleanup scans every box.** `cleanupOrphans` deletes tasks
  whose span is no longer in the editor DOM. It must search the whole layer
  (all boxes, static or active); searching only the active editor would
  delete every task that lives in another box.
- **Live take-in keeps the caret in its box.** When stored text is taken in
  (`replaceContent`), only boxes whose HTML changed are updated: a static box
  is re-rendered, the active box gets the new HTML in its editor with the
  caret mapped (`caretMapping.js`) within that box, never across boxes.
- **Saving cost.** Only the active box can change while typing; every other
  box contributes its stored string, so a keystroke does not serialize every
  box (pasted images are base64 and can be large).
- Undo/redo while a box is active: `setContentSilently` puts the active box's
  new HTML into its editor; other changed boxes are re-rendered statically.
  An undo that removes the active box leaves it first.

### 4.3 Layout and rendering

- The layer container keeps covering the full content area. The main box is
  in normal flow as today. Each other box is `position: absolute` inside the
  container.
- Box padding is small (`4px 8px`). (Found in implementation: no task
  gutter on boxes. Task checkboxes are inline in the line, so they need no
  gutter, and a gutter that appears with the first task would move the box's
  text when a task is marked.)
- Same font, size and 24 px line box as the main text. Inter is bundled, so
  the cross-device rules of `TEXT_LAYER_CROSS_DEVICE_OFFSET.md` apply
  unchanged. A side benefit: a different wrap on another device only shifts
  text inside that box, not everything below it on the page, which is the
  main pain of the flow text today.
- **Content height** = max(main box bottom, every box's `y + height`) plus
  the existing bottom margin. One `ResizeObserver` per box feeds
  `onHeightChange`.
- **Frame (decided: always visible in the app).** Every box, the implicit main
  box included, has a faint 1 px frame in every mode and in read-only view,
  from a theme token (light and dark, checked in every theme including TVA,
  and kept faint enough that a note with many boxes does not look like a
  form). The active box in text mode gets a stronger frame plus its handles.
- **The implicit main box hugs its text.** Its text still wraps at the full
  width as today, but its frame and its hit area cover only what its lines
  use: up to the widest line plus a 48 px margin. A tap to the right of that
  is empty page and creates a box, so on a legacy note a box can be placed
  beside the text without first narrowing the main box. Once the main box is
  wrapped (§3.1) it has an explicit width and behaves like any box. The frame is UI only: it is never part of
  the stored HTML and is not drawn in the PDF export or the thumbnail.
- Overlapping boxes: DOM order decides; the active box is raised while
  active. No stored z-order. A box that grows while typing covers what is
  below it (other boxes, ink); nothing is pushed down. Accepted, as in
  OneNote.
- Boxes are below the ink, like the main text (layer z-index unchanged).

## 5. Interaction

Text mode only; in every other mode boxes are visible and not interactive
(`pointer-events: none`, as the text layer today). Read-only (shared
viewer): no chrome, no editing.

- **Create (decided: OneNote style, every input).** In text mode, a tap on
  empty page (not on a box) creates an empty box there and focuses it, with
  mouse, pen or finger: no tool to pick first, and the app works on a
  tablet without pen or mouse. The tap point is the caret position (box
  `x`/`y` offset by its padding), snapped to the grid (below): across to the
  nearest grid line, down to the line of the row the tap is in.
- **A new box is not content until it holds text** (found in implementation).
  Until then it is left out of `note.content`, so a mistaken tap stores and
  syncs nothing; its first text is its creation, one undo step. The same rule
  makes a box emptied by deleting its text disappear from the content.
- **Pointer routing** (found in implementation). Mouse and pen activate a
  static box on press, so a drag from there selects text right away; touch
  activates on the tap (click), because a finger that moves pans. A press
  that drags creates nothing. While an image is selected (a pasted image is),
  every press belongs to the image: on it, it moves it; elsewhere it only
  deselects it, like the first tap that leaves a box.
- **Width near the right edge.** Default width 400 px. If that does not fit
  between the tap and the page edge (1200 px), the box takes the space that
  is left, down to 200 px; only if even 200 px does not fit is the box moved
  left so that it is 200 px wide and ends at the page edge.
- **Snap grid follows the background.** On ruled backgrounds `y` snaps to the
  line spacing (`ruled-narrow` 20 px, `ruled-medium` 30 px, `ruled-wide`
  40 px), on grid backgrounds `x` and `y` snap to the square size (20/30/40
  px), so boxes sit on the lines the user sees. On a plain background `y`
  snaps to the 24 px text line and `x` to 8 px. The spacing comes from the
  same table `drawBackgroundPattern` (`noteRenderer.js`) draws from, so the
  two cannot drift apart. The text's own line height in a box stays 24 px;
  matching it to ruled lines is a separate topic.
- **Tap vs pan vs zoom (touch).** Text mode already separates them
  (`_textModePanState` in `NoteCanvas`): a single touch that stays under the
  drag threshold until release is a tap and reaches the text layer (today it
  places the caret); one that moves past it is captured for panning; a second
  finger makes it a pinch. Creation hooks into the tap path only, so panning
  and zooming are unchanged. A touch that became a pan or pinch never creates
  a box, and neither does a tap that ends a momentum scroll.
- **Continue zone.** A tap on empty page within two line heights (48 px)
  below a box's last line, horizontally inside its column, does not create a
  box: it puts the caret at the end of that box (adding an empty paragraph if
  the tap is more than one line below). This keeps "tap below the text to
  keep typing" working and stops a note from falling apart into many
  one-paragraph boxes. Further down, a tap creates a new box. This holds for
  the active box too (D4): a tap in its own continue zone continues
  it instead of leaving it.
- **Tap on empty page while a box is active: leave first, every input.** That
  tap only leaves the active box (blur, on-screen keyboard closes, a
  now-empty box is removed); the next tap on empty page creates a box. Same
  rule for mouse, pen and finger on every platform: on a tablet, tapping
  beside the text is how users close the keyboard, and one rule everywhere
  is easier to learn than OneNote's desktop behaviour (which creates right
  away).
- **Edit:** click or tap into a box. That box becomes active; the toolbar
  targets it.
- **Move:** drag the handle bar shown on top of the active (or hovered) box.
  Handles sit outside the text area and are at least 24 px tall for pen and
  finger (handles too close to the text are hard to grab with a pen).
  Handle sizes are screen pixels, not content pixels: the layer is scaled
  with `transform: scale(zoom)`, so handles are counter-scaled by `1/zoom`
  and stay grabbable when zoomed out.
  Snapping to the background's grid (see above), so boxes line up with the
  page's lines and with each other. An axis the pointer has not moved along
  by half a grid step keeps its value (found in implementation: otherwise a
  straight drag down also shifts the text sideways onto the grid, e.g. the
  legacy main text at x 46 on an 8 px grid). Clamped to `0 ≤ x` and
  `x + w ≤ 1200`, `y ≥ 0`.
- **Resize:** drag the right-edge handle; width only, minimum 80 px, the
  right edge snapped like `x`. Height follows the text. (Found in testing on
  Android: a 12 px bar cannot be grabbed with a finger. The handle's grab
  area is 24 px, 40 px with a coarse pointer, centred on the edge, around a
  thinner visible bar.)
- **Delete:** in the box's options menu (⋮ at the right end of the move bar),
  or Delete/Backspace in an empty box. (Decided 2026-10-24: an × on the move
  bar was too easy to hit while grabbing the bar. The ⋮ only opens the menu;
  it holds Delete for now, later e.g. Copy or a box type such as a sticky
  note.) A box
  that is empty when it loses focus is removed (no stray empty boxes). The
  implicit main box is not "removed" when emptied; it simply has nothing to
  render.
- **Chrome:** the faint frame always (§4.3); stronger frame and handles on the
  active box, and on hover with a mouse, in text mode only.
- **Lasso (decided): strokes only.** The lasso never selects, moves or
  deletes boxes. Boxes are moved with their handles.
- **Keyboard:** Esc leaves the box (blur, toolbar disabled). No Tab
  navigation between boxes in v1.
- **Undo/redo:** every content change, move, resize, create and delete is a
  `TextChangeCommand` on the whole HTML, as today. Drag and resize push one
  command on release, not per pointer move.

## 6. Merge and sync

`note.content` stays one HTML string, so storage, sync, the NC app write
path, LiveText and the merge base need no changes. `textMerge.js` needs one:
**boxes are merged by id**, like media items, and the text in each box by
the existing block merge.

- The implicit main box (unwrapped text before the first box) is merged by
  the block merge as today.
- Boxes are matched by `data-box-id`:
  - on both sides: each geometry value (`data-x`, `data-y`, `data-w`) from
    the side that changed it relative to the base; if both changed it, the
    primary (later-modified) side wins, deterministically, as everywhere else
    in the merge. The inner HTML is merged by the block merge as a document of
    its own (paragraphs, lists, tables, conflict hints), so conflicts stay
    inside the box;
  - on one side only: new there (kept), or deleted on the other side. A
    deleted box goes unless this side changed it (delete vs edit keeps the
    edit, lossless).
- Order: the primary side's boxes in its order, then the other side's new
  ones.
- A side that wrapped the main box (first move or resize) holds the base's
  main text in a new box and has no main text left: the other side's edits of
  the main text are merged into that box instead of reappearing unwrapped at
  the origin.
- Ids an old client duplicated or lost get deterministic replacements in the
  merge (`id~2`), so both writers merging agree; a random new id is given only
  on load (§3.1).
- Without these rules, "A moved the box, B typed in it" counts as both sides
  editing the same block and produces two copies of the box, one with a
  conflict hint. That makes the rule part of the first version, not polish.
- Convergence and idempotency as today: `textMerge.boxes.property.test.js`
  plays random moves, resizes, edits, inserts and deletes of boxes and
  paragraphs on both sides and checks convergence, idempotency, losslessness
  and one box per id (checked over 1,000 seeds; 60 in the suite).

Old clients merge with the current block merge, which treats a box as an
opaque block. That is lossless (a concurrent move and edit gives two copies,
never a lost edit) and is fixed up by hand by the user.

## 7. Insert-space

Insert-space today shifts strokes and media whose top is below the split
(`ShiftContentCommand`) and leaves the text where it is.

- Boxes whose `y` is below the split move by the same distance. A box
  straddling the split stays, matching how strokes are selected (by their own
  top).
- The moved boxes' `data-y` changes go through the text layer (`moveBoxes(ids,
  dy)`), so they reach storage with the text save, and the stroke shift and
  the text change are one undo step. (Found in implementation: no composite
  needed; `ShiftContentCommand` records the box ids and moves them itself,
  both ways. Typing still waiting for its undo step is recorded first, so
  undoing it cannot move the boxes back under the shifted ink.)
- A wrapped main box is a box like any other (it starts near the top, so it
  usually straddles the split and stays). The implicit main box does not
  move, as today. Making flowing text follow insert-space is the separate
  design in `documentation/investigations/TEXT_LAYER_CROSS_DEVICE_OFFSET.md`
  ("keeping text and ink aligned"); boxes do not depend on it, and with
  boxes users have a way to get text that moves with the ink.

## 8. Everything else that reads `content`

| Consumer | Change |
|---|---|
| Search (`highlightSearchTerms`, overview search) | none for matching; highlighting walks the layer root, so it covers every box |
| Text tasks (`TextTaskManager`) | delegate on the layer root; "jump to task" scrolls to the span's position, which is now inside a positioned box |
| LiveText / conflict hints | none; hints stay inside the box they belong to (§6) |
| Thumbnail ghost (`noteRenderer.js`) | render boxes at their position (same CSS as the editor), no frame |
| PDF export (`pdfExport.js`) | render boxes at their position, no frame; best done together with "export uses the editor CSS" from the cross-device investigation |
| Conflict dialog previews (`modals.js`) | render boxes stacked with a small label, or positioned; stacked is enough |
| MCP bridge | reading: implicit main text, then boxes in reading order (by `y`, then `x`). Writing: appending text creates a new box below the lowest content instead of growing unwrapped text that might sit under a moved box. A tool to create and place a box later. |
| Overview preview text | main text first, then boxes in reading order |

As implemented (phase 5):

- **One stylesheet for every picture of the page.** Box layout and
  typography moved from the editor's CSS into `src/styles/textBoxes.css`,
  scoped to `.text-boxes`. The editor layer, the thumbnail ghost and the PDF
  export's iframe (inlined with `?inline`, plus the page's `@font-face` rules,
  so Inter) all use it, and `renderStaticTextBoxes` (`textBoxesDom.js`)
  builds the same elements the editor does. So the thumbnail and the export
  lay text out exactly as the note does. This also fixed two old problems:
  the export set text in Georgia with other spacing (cross-device
  investigation, finding 1), and thumbnails in Firefox collapsed empty lines
  (a `.text-editor br { display: block }` rule Chromium ignores and Firefox
  applies).
- **Task checkboxes in the thumbnail and the export** (asked for during phase
  5): text tasks get the checkbox the editor shows, done ones struck through;
  stroke tasks a checkbox left of their ink, from the position rule the
  editor's checkbox layer uses (`taskCheckboxes.js`). In the export they are
  drawn into the text layer, so they land on the right page of every kind
  (A4, imported PDF, overflow).
- **Conflict previews and MCP** show the HTML with its boxes in reading order,
  wrappers and positions kept (`inReadingOrder`).
- **MCP writing:** the bridge has no write tool, so there is nothing to append
  a box to; still "later".
- **Overview search** matches the note's words only (`searchableText`): with
  boxes, searching the raw HTML would have matched every box by its
  attributes ("400", "text").
- **Overview preview text:** the overview has no text excerpt of its own; the
  card is the thumbnail, and a text task's text is found by its id, wherever
  its box is.
| `hasContent` | unchanged (any text, in any box) |
| Backup/restore | none (content is opaque) |

## 9. Later

- Box style: background colour, a stronger border that also exports.
- Snap guides against other boxes and against ink.
- Concurrent insert-space replay for boxes (record shifts against box ids).
- MCP: create and position boxes.

## 10. Images in text mode

Independent of boxes; can ship before them (plan phase "I").

### 10.1 Today

- A clipboard image pasted into the text editor is downscaled to 800 px and
  inserted as a base64 `<img>` into `note.content`
  (`TextEditorLayer._insertCompressedImage`). Trumbowyg has no image tools
  loaded, so the image cannot be resized, moved, cropped or deleted other than
  by deleting it like a character.
- Base64 in `content` inflates the note JSON, every sync upload, the search
  scan and every undo snapshot (cross-device investigation, finding 4), and
  makes a large single block for the text merge.
- HTML pasted from a web page keeps its `<img src="https://…">`: the paste
  handler only intercepts clipboard items of type `image/*`, DOMPurify allows
  `img`, and `tagsToRemove` lists only `script` and `link`. The editor then
  loads remote images (tracking, privacy; on Nextcloud the CSP may block them
  and show broken images).
- Dropping an image file onto the editor is not handled by NoteBerg; what
  happens is up to the platform (Tauri's drag-drop handler, the browser).

### 10.2 Pasted images become page images (D11)

In text mode, a pasted or dropped image is inserted as a page image (`media`
item), the same as the "insert image" button produces.

Behaviour:

- **Paste.** The existing text-mode paste handler intercepts `image/*`
  clipboard items as today, but hands the files to the page-image insert path
  instead of inserting base64. `NoteCanvas._insertImage` is split: the part
  after file selection (placeholder, `processImageFile`, storage,
  `InsertMediaCommand`) becomes `insertImageFiles(files, at)`, called by the
  picker/camera path and by paste/drop.
- **Position.** At the caret: left edge of the active box (content `x` of the
  box's text column), top just below the caret's line (from the caret
  range's `getBoundingClientRect()`, converted to content coordinates). The
  existing default size and clamping of inserted images apply. Without a
  caret (no active box) the image goes to the viewport centre, as the button
  does.
- **Drop.** An image file dropped on the text layer in text mode goes the same
  way, positioned at the drop point. To verify first: whether Tauri's
  drag-drop handler (Windows), Android WebView and the NC browser deliver the
  `drop` event to the page at all. (Found in implementation: on Windows,
  Tauri's own drag-drop handling is on by default (`dragDropEnabled`), and
  then file drops do not reach the page. Not changed: turning it off makes a
  file dropped anywhere else navigate the window to it unless the app guards
  every drop. Drop is therefore expected to work in the Nextcloud app and to
  be unsupported on Windows; Android is checked by hand.)
- **Text stays text.** The caret stays where it was and the editor is not
  changed, so the paste does not create a text undo step; the insert is one
  `InsertMediaCommand`, undone like any image.
- **After the insert** the app stays in text mode (no automatic switch to
  pan or lasso); the image is selected, the same selection a long press
  makes (long press stays the way to select an image on every platform), so it
  can be moved right away, with a mouse too (§5, pointer routing).
- **Trade-off:** the image is not inline in the text, so it does
  not move down when lines are added above it. With text boxes this matches
  the page model: boxes and images are both placed objects.

### 10.3 Images inside pasted HTML

- `<img>` elements in pasted HTML are removed before Trumbowyg inserts the
  HTML (a `paste` handler on the layer root that sanitizes `text/html` with a
  profile forbidding `img`, then inserts the result itself). The rest of the
  formatting is kept as today.
- Not converting them into page images in v1: remote images would have to be
  fetched (CORS, CSP on Nextcloud, privacy of the fetch itself), and a web
  page's decorative images are rarely what the user wanted. A `data:` image
  in pasted HTML (copied from another note or app) can be converted like a
  clipboard image later if users ask for it.

### 10.4 Existing notes with base64 images

- Keep rendering them exactly as today: DOMPurify keeps them, the editor shows
  them, export and thumbnails include them. No automatic conversion: that
  would be a migration and is not proposed.
- In a text box, such an image is part of the box's content and its height.
  Boxes cap images at the box width (`img { max-width: 100% }`), so an
  800 px image in a 400 px box is shown at 400 px without changing the stored
  HTML.
- Possible later, only if asked for: a context action "Move image to page" on
  an existing inline image that turns it into a page image at its current
  position.
