# PDF pages: design

Status: **Proposed** (2026-10-28, revised the same day: reordering, blank
pages and text boxes added), not started. Plan: [PLAN.md](PLAN.md).

Origin: feedback asking to "embed any number of PDFs, position them like
images, select individual pages when importing, zoom them like images". Most of
that does not fit this app (§2). What does fit is below.

## Decision record

**Context.** Feedback asked for several PDFs per note, positioned and zoomed
like images, with page selection on import. The app's page model (ink, text
boxes, page breaks and recognition bands all assume a vertical stack of pages
from Y=0 at full width) does not allow free placement. What users need is to
edit the page list of a document.

**Decisions**

- **D1** A note keeps **one PDF document**: a stack of pages at full content
  width. The **page list is the document** and the PDF files are its sources;
  sources are kept untouched and export builds the result from them. PDFs are
  not merged into one rewritten file.
- **D2** No free positioning or zoom of PDFs; the first import stays one click
  with all pages.
- **D3** Delete, reorder, insert-from-PDF and insert-blank are **one primitive**,
  a change of page layout, applied by one planner (§4). Everything on a page
  (ink, images, text boxes, recognition words) moves with it.
- **D4** **Delete is permanent**: confirmation naming what goes with the pages,
  no undo, undo history cleared afterwards. Deleted pages stay inside the
  stored source file (known limitation, §5.5).
- **D5** **Add pages from another PDF** with page selection, at start, end or
  after a page, through the single function `addPdfPages` (shared with the
  Android share target). "After a page" means after the selected thumbnail, or
  the page in view when opened from the toolbar.
- **D6** **Blank pages** are `pdf-page` items without a source file, with a
  per-page format, and only in notes that have a PDF in this release.
- **D7** Notes without a PDF get a `pageFormat` field (Letter, landscape);
  absent means A4 portrait, so no migration.
- **D8** The implicit (unwrapped) main text box is never moved or deleted by
  page operations.
- **D9** Page operations are refused with a message while AI recognition runs.

**Consequences**

- The planner needs an owner rule for strokes crossing a page edge (§4.2) and
  a merge rule for reorders made while another device draws (§9, Q4).
- Old clients show added pages but export them wrongly and fail on blank pages
  (§6, §9); acceptable for a pre-release feature, noted in the changelog.
- Source files grow no smaller when pages are deleted (§5.5).

**Rejected alternatives**

- *Several independent PDFs placed on a page*: breaks the page model (D2).
- *Merging into one rewritten PDF after each edit*: rewrite and re-upload per
  edit, loses original bytes.
- *Undo for delete*: needs snapshots of removed ink, boxes and recognition.
- *Blank pages in notes without a PDF*: creates paged notes with no source
  file and changes what a plain note is.
- *Wrapping the main text box into page 1*: "delete page 1" would delete the
  note's legacy text.
- *Re-stacking pages on load to repair overlaps*: would move pages without
  their ink; only if real notes show the problem (§9).

Open items: Q4, Q6, Q7, Q8 (§11).

## 1. Goal

- A note still has **one PDF document**: its pages are shown one after the
  other at full content width, as today. No free positioning or zooming of PDFs.
- The document can be **edited as a list of pages**:
  - **delete** pages, permanently, after a confirmation (no undo, §4.4);
  - **reorder** pages;
  - **add pages from another PDF**, choosing which of its pages, at the start,
    at the end, or after a chosen page;
  - **insert blank pages** anywhere (start, end, between pages), in A4 or
    Letter, portrait or landscape.
- **Everything on a page moves with it**: ink, images, text boxes and
  recognition results. Deleting a page deletes what is on it; reordering and
  inserting keep the rest aligned with its page (§4).
- Every imported PDF file is **kept untouched**. Export builds the result from
  the kept files, so text, vectors and links of the original pages survive and
  the ink is drawn on top.
- Notes without a PDF can use **Letter** as well as A4, and **landscape** as
  well as portrait, for page-break lines, export and recognition bands (§8).

Not goals: several independent PDFs placed on one page, moving or resizing a
PDF page, per-page zoom, rotating a page, editing PDF content, form filling.

## 2. What we do not take from the request, and why

| Request | Decision |
|---|---|
| Embed any number of PDFs | Only through "add pages from another PDF" (the result is still one stacked document). |
| Position PDFs like images | No. A PDF page is the page background; ink, text boxes and the page-break model assume pages start at content Y=0 and fill the width. |
| Select pages when importing | Only for **added** pages (§5.2). The first import stays one click, all pages. |
| Zoom PDFs like images | No. The whole canvas already zooms. |

## 3. What exists today (found in the code, 2026-10-28)

This matters because it changes the design from the first sketch.

- **The data model is already per page and per file.** A PDF is a list of
  media items `{id, type: "pdf-page", fileId, pageIndex, x, y, width, height}`
  in `note.media`. `fileId` names the PDF blob, `pageIndex` is 1-based inside
  that blob. Items sharing a `fileId` share one blob. Rendering
  (`mediaManager.renderPdfPage`, `PdfTextLayerManager`) reads `fileId` and
  `pageIndex` from the item, never from `note.pdfSource`.
- **Sync already handles several blobs.** `syncNoteMedia` and
  `downloadNoteMedia` collect unique `fileId`s from the items; orphan cleanup
  keeps the `fileId`s that items reference. `note.pdfSource` is one extra
  reference that is only needed for notes older than the items.
- **Page size is per page and already automatic.** `importPdf` takes each
  page's own viewport; `NoteCanvas.insertPdf` scales every page to
  `maxContentWidth` (1200) and keeps its aspect ratio. A landscape page is
  simply shorter, a Letter page slightly shorter than A4. Mixed sizes work.
- **Export already starts from the original.** `exportNoteToPdf` (case A)
  loads the stored PDF with pdf-lib, copies its pages and draws background,
  text, ink and images on them.
- **Insert-space shifts content below a line** (strokes by `minY`, media by
  `y`, text boxes by `data-y`, recognition bands by `yRange.top`) as one undo
  step: `ShiftContentCommand`. It deliberately skips PDF pages and the implicit
  (unwrapped) main text box.
- **The merge knows shifts only as lines.** `note.shifts` holds
  `{v, y, delta}`; `noteMerge.normalize` replays them on elements that had not
  seen them ("everything whose top is below `y` moves by `delta`"), and it
  states that **PDF pages never move**. A page's own `y` is an ordinary
  per-element field (last stamp wins).
- **Text boxes** are `.text-box` wrappers in `note.content` with `data-x`,
  `data-y`, `data-w`; the height is measured, not stored. `TextLayer` offers
  `boxIdsBelow(y)` and `moveBoxes(ids, dy)` (one shared `dy`, clamped at 0)
  and `_deleteBox(box)`; `TextChangeCommand` records text edits.

Where it is **single-file by assumption** and must change:

| Place | Assumption |
|---|---|
| `pdfExport.js` case A | one source file (`note.pdfSource \|\| pdfPages[0].fileId`); output page `i` is source page `i`; items sorted by `pageIndex` |
| `NoteCanvas` navigator subjects | label `Page ${p.pageIndex}` (the number in its own file, not the position) |
| `NoteCanvas` outline mapping | `pdfPages.find(p => p.pageIndex === entry.pageIndex)`, outline read from one file |
| `NoteCanvas.deletePdf`, `InsertMediaCommand`, `DeleteMediaCommand` | one `pdfSource`, whole PDF at once |
| `insertPdf` | refuses a second PDF |
| `storage.js` copy-note | copies `pdfSource` only |

**Consequence for the design:** we do not merge PDFs into one rewritten file.
The page list is the document; the files are its sources. This is simpler and
cheaper than the first sketch (rewrite one PDF after each edit and re-upload
it), and it keeps every original byte-for-byte.

## 4. One primitive: a change of page layout

Delete, insert, reorder and blank pages are the same operation. Take the page
list before and after:

```
before: P1 P2 P3 P4          after (move P3 first, delete P2, add B after P1):
                             P3 P1 B P4
```

Each page that exists in both lists has an **old range** `[y0, y1)` and a
**new range**. Content belongs to the page whose old range contains its top.
Then:

| Content | Rule |
|---|---|
| on a page that still exists | moves by `newY - oldY` of that page |
| on a deleted page | deleted |
| below the last old page (overflow area) | moves by the net height change, so it stays attached to the end |
| above the first page (negative `y`) | stays |
| the implicit (unwrapped) main text box | stays, never deleted (as in insert-space) |

"Content" and its "top":

| Content | Top |
|---|---|
| strokes | `minY` |
| images and other non-page media | `y` |
| text boxes | `data-y` |
| recognition words | `yRange.top` (bands move with the ink they describe) |

So one planner (`planPageLayout(oldPages, newPages, content)`) produces the
list of moves and deletions, and every user-facing operation only builds the
`newPages` list:

- delete: leave the pages out;
- reorder: permute them;
- add from PDF / blank: put new page items in.

A new page item has no old range, so nothing moves into it. The pages' own
`y` values are then re-stacked contiguously from 0 in the new order.

One command (`PageLayoutCommand`) applies and undoes a change that **only
moves or adds**: reorder, insert from PDF, insert blank. It moves pages,
strokes, images, text boxes, recognition bands and updates `pdfSource`; undo
replays the inverse moves (and removes the pages the change added). It is one
undo step, like insert-space.

**Deleting is the exception: it is permanent** (decided 2026-10-28). The
planner deletes content on the removed pages, and the editor then clears the
undo history (`HistoryManager.clear()`, which exists), because earlier steps
(strokes drawn on a deleted page, a box typed there) would otherwise refer to
things that are gone. This also means a delete needs no snapshot of what it
removes and no restore code anywhere.

### 4.1 Text boxes

Text boxes live inside the text, not in a list of their own, so they need
their own handling; the rules above apply to them like to any other content,
with these specifics:

- **Assignment** by the box's `data-y` (its top). A box that starts on page 2
  and is taller than the page belongs to page 2 only; after a reorder it can
  overlap the page that now follows. Strokes behave the same way. Accepted:
  rare, visible, fixable by moving the box.
- **Move:** each box gets its own `dy`. `TextLayer.moveBoxes(ids, dy)` takes
  one shared `dy`, so a batch form is added, `shiftBoxes(Map<id, dy>)`:
  one DOM pass, one `getContent()`, one save, as `moveBoxes` does. A box is
  never clamped differently from its page: pages start at 0, so moved boxes
  stay at or below 0.
- **Delete:** boxes on a deleted page are removed from the text
  (`removeBoxes(ids)`), permanently; no HTML is kept for undo (§4, §4.4).
- **Selection:** `boxesTopIn(top, bottom)` returns `{id, y}` for the boxes
  whose top is in a range; the planner needs all boxes at once, not "below
  `y`".
- **Active box:** a box being edited is committed first (`flushHistory`,
  deactivate) so pending typing becomes its own undo step before the layout
  change, as insert-space does.
- **Implicit main box:** never moved and never deleted by page operations,
  exactly like insert-space. It is the flowing text of the note, not content
  of a page. (If the user wants it to follow page 1, they move it once; that
  wraps it into a normal box.) The confirmation text does not count it.
- **Merge:** a box moved by a page operation is an ordinary edit of the box
  (`data-y`), and a removed box is a removed `.text-box`. Phase 1 pins with
  tests that the three-way text merge handles "box moved/removed here, box
  edited there" (text boxes DESIGN §6) when the move comes from a page
  operation.
- **Everything else that reads boxes** is unchanged: thumbnails and export
  read `content` after the operation.

### 4.2 Which page owns a stroke (to be tested)

The rule "the page containing its top" is insert-space's rule, where the user
picks the line. For page operations it is risky: handwriting often runs over a
page edge, and a line whose top is a few pixels above the boundary would move
or be deleted with the previous page. Candidates: the top (`minY`), the
bounding-box centre, or the first point (where the stroke started). Phase 1
tests each against realistic samples (a line of text across a page edge, a
long underline, a margin note) and picks one; the planner takes the rule as a
function so it can change without touching the rest. Images and text boxes use
their top (their position is a deliberate placement).

### 4.3 Interactions with other features

To be checked in phase 0 and covered by tests; each needs a stated rule:

- **AI recognition queue:** it rasterizes all bands up front and its page
  indices shift under edits. Rule (D9): page operations are refused with a
  message while the queue runs. Recognized
  words move with their ink (their `yRange` is shifted by the planner).
- **Live sync of the open note:** another device can change the page list while
  the note is open here. The canvas must accept pages appearing, vanishing or
  moving in a take-in (the media list changes, strokes follow through the
  recorded shift), and an open Pages dialog must update or close.
- **Read-only notes and shared notebooks:** page operations are disabled for a
  read-only note, as the PDF delete already is.
- **Task checkboxes and search positions:** they are derived from text and
  recognition and move with them; verify that nothing caches absolute `y`.
- **Navigator and outline:** follow the page order (phase 0 fixes the labels).

### 4.4 Confirmation and counts

Delete asks before it runs, and states what goes with the pages: strokes,
images, text boxes (not the main text), "nothing else" when the pages are
empty, and that **it cannot be undone**. After it, the undo history is cleared
(§4). Reorder, add and blank-page insertion do not ask; they are undoable and
destroy nothing.

## 5. Behaviour

### 5.1 Pages dialog

The existing PDF button (top of the first page) menu gets "Pages". It opens a
modal with a grid of page thumbnails in document order, numbered by position:

- selection of one or more pages (tap, shift/ctrl on desktop);
- **Delete** the selection;
- **Move**: drag the selection to a gap between thumbnails (mouse drag, touch
  long-press drag); plus "Move to start / end / before..." for touch and
  keyboard, since a drag across a long document is unreliable on a phone.
  Several selected pages move as a block and keep their order;
- **Add pages**: "From PDF..." (§5.2) and "Blank page..." (§6), both at the
  chosen target: start, end, or after the selected page (page in view when
  nothing is selected).

Thumbnails are rendered lazily (visible ones only), one or two at a time, at
about 160 px width, through the cached pdf.js document that rendering already
uses. They are not stored. A blank page is drawn as an empty sheet in its own
proportions.

### 5.2 Adding pages from another PDF

1. The user picks a PDF file (the same picker as import).
2. A second dialog shows that file's pages as thumbnails with checkboxes
   (all selected by default, "select all / none", range select).
3. Target as in §5.1.
4. The file is saved as a blob (same `saveFile` as import), the chosen pages
   become new `pdf-page` items scaled to the content width, and the layout
   change (§4) puts them in place.

If the note has no PDF yet, the first import is unchanged: no dialog, all
pages.

**One entry point.** Steps 4 onward live in a single function,
`addPdfPages(noteCanvas, file, pageSelection, target)` (`pageSelection` =
list of 1-based pages, or all; `target` = start, end or after a page id). The
Pages dialog calls it, and so does the Android share target
([android_share_target](../android_share_target/DESIGN.md), "add to a note
that already has a PDF", which uses target = end and all pages). The first
import is the same function with an empty note.

### 5.3 Deleting pages

As §4, with the confirmation of §4.4. `note.pdfSource` points at the file of
the first remaining page that has one. If no page is left the note is treated
as if the PDF had been deleted (`pdfSource` cleared, A4 break lines back), so
blank pages left alone do not make a "PDF note" with no PDF.

### 5.4 Unused files

A source file whose pages are all deleted is no longer referenced. Existing
orphan cleanup in `_saveMediaChanges` and the sync cleanup remove it, as for
a deleted image. Since delete is permanent there is no undo to wait for. (An
undo of an *insert* removes pages it added; the blob of a file that insert
brought stays until the note is saved, then orphan cleanup collects it.)

### 5.5 Deleted pages stay inside the source file (known limitation)

Deleting a page removes it from the note's page list, not from the stored PDF:
the source file still holds every page it had, and so do sync, backups and
shared copies. Export is not affected (it copies only the listed pages). For a
user who deletes a confidential page and then shares the note or a backup, the
page is still recoverable from the file. This is accepted for the first
version, and the confirmation does not claim otherwise. A later step could
rewrite a source file without its unused pages (pdf-lib), at the cost of a new
blob, a re-upload and remapping `pageIndex` of the remaining pages; it is
easier now than with undo, because nothing refers to the deleted pages
(Q8).

## 6. Blank pages

A blank page is a page item with no source file:

```js
{ id, type: "pdf-page", blank: true, fileId: null, pageIndex: null,
  format: { size: "a4" | "letter", orientation: "portrait" | "landscape" },
  x: 0, y, width: 1200, height }   // height from the format's aspect ratio
```

It stays a `pdf-page` so that everything that already treats pages as pages
keeps working: it never moves in the merge, insert-space skips it, it is part
of the stack, it appears in the navigator. The places that need a file are
guarded instead: rendering (`renderPdfPage`), the text layer, export's
`copyPages`, and the sync collectors (they already skip items without
`fileId`).

- **Appearance.** Nothing is rendered but the page's outline and the note's
  background pattern behind it; it follows the theme like the canvas, so it
  is not inverted and is excluded from `_getUninvertedPdfBounds` (strokes on
  it use the normal palette, not the white-paper one).
- **Format.** The insert dialog proposes the format of the neighbouring page
  (auto-detected from its aspect ratio: Letter or A4, portrait or landscape),
  falling back to the note's `pageFormat` (§8), and lets the user change both
  size and orientation. This is the "manual setting" for notes with a PDF; it
  is per page, because PDFs are mixed.
- **Export.** `pdfDoc.addPage([w, h])` in the format's point size, then the
  same drawing as for a copied page, including the background pattern
  (`drawBackgroundPatternOnPage` already works per page).
- **Where.** Only in a note that has a PDF in this release. A paged note
  made of blank pages alone is a different feature (D6).
- **Count.** A blank page counts as a page for the navigator, thumbnails and
  export; it has no text layer and no outline entry.
- **Old clients** try to render the item as a PDF page, fail, and retry three
  times (`MAX_PDF_RENDER_ATTEMPTS`) leaving the area empty. Export on an old
  client breaks for such notes (§9).

## 7. Export

Case A of `exportNoteToPdf` is generalised, not rewritten:

- order the page items by `y` (not `pageIndex`);
- load each distinct source file once with pdf-lib;
- for each item: `copyPages(source, [item.pageIndex - 1])`, or for a blank
  page `addPage([w, h])`;
- everything after that (drawing ink, text, images on page `i`, overflow
  pages) stays as it is, because it already works from the output page and
  its item.

A note with one file and untouched pages produces the same PDF as today
(a test pins this). Annotations (`pdfInkAnnotations.js`) work per output page
and need no change; to be confirmed in phase 0.

## 8. Letter and landscape for notes without a PDF

A PDF's pages need nothing (§3), and blank pages carry their own format (§6).
The A4 constants matter for notes without a PDF, where the "page" is virtual:
`pageGeometry.js` (A4 aspect), the dashed break lines
(`CanvasRenderer._drawA4PageBreaks`, which hard-codes 841.89 / (595.28 / 1200)
instead of using `pageGeometry`), `pdfExport` case B and the recognition page
bands (`pageRasterizer`).

Proposal: a note field `pageFormat`, `{size: "a4" | "letter", orientation:
"portrait" | "landscape"}`, absent meaning A4 portrait, so no migration. One
function in `pageGeometry.js` returns the page size in points for a format;
all consumers, and the blank-page insert dialog, call it and no longer carry
their own numbers. The field is a scalar in `noteMerge.SCALAR_FIELDS`, in
`noteFileOps` and in the Nextcloud app's note schema, so it syncs and merges
like `background`.

The setting applies only while the note has no PDF; with a PDF the pages
decide. Changing the format of a note with ink does not move the ink: only the
break lines, export slices and recognition bands change. That is the same as
today's behaviour when ink crosses a break line, and is stated in the
setting's help text.

## 9. Merge and sync

Elements merge by per-element version; this design must not weaken that.

- **Page items** merge by `id` like all media; removal is by `deletedMedia`
  and tombstones. A reorder changes the `y` of several page items, each its
  own stamped edit.
- **Concurrent ink during a layout change.** A device that draws on a page
  while another device deletes, inserts or reorders pages has not seen the
  move. Today's recorded shifts are lines ("below `y`, move by `delta`") and
  cover a delete or an insert exactly: `{y: end of deleted range, delta:
  -height}`, `{y: insertion point, delta: +height}`. They cannot express a
  reorder, which moves one block up and another down.
  Proposal: extend the shift record with an optional list of **range moves**
  evaluated simultaneously against the pre-move `y`:
  `{v, moves: [{from, to, delta}, ...]}`, with the existing `{y, delta}` as
  the special case `to = infinity`. `normalize` replays both forms; old
  clients ignore a record without `y`/`delta` (their comparison is false), so
  they merge as they do today, minus the correction. The merge tests use the
  existing `mergeReplicas` fixture (Q4).
  **Not verified yet.** This rests on a reading of `normalize`, which promises
  that the result depends only on the element's edit and the set of shifts,
  never on the order they arrive in. Whether that holds with simultaneous
  range moves, with page items that "never move", and with `seen` stamps is
  what the phase 0 spike must show (property test in `noteMerge.property.test.js`
  style) before anything is built on it. If it does not hold, reorder is
  released later than delete, insert and blank pages, which only need line
  shifts (PLAN, phasing).
- **Ink drawn on a page that another device deleted** survives the merge (the
  deleting device never saw it) and lands on whatever took the page's place.
  Rare; the user sees it and can erase or move it. Not worth a rule.
- **Overlapping `y` of pages** (two devices change the page list at once, each
  stamping different page items) is possible because the stack is positions,
  not a list. Phase 0 reads the media merge; a repair that re-stacks pages
  on load would move pages without moving their ink, so it is not proposed
  unless real notes show the problem.
- Added blobs travel through the existing media upload and download. A note
  with several blobs needs all of them before every page renders; pages whose
  blob is still missing already retry.
- **Old clients** show added PDF pages (rendering is per item) but export them
  wrongly (single-file export) and fail on blank pages as in §6. "Delete PDF"
  on an old client removes only the `pdfSource` file. Acceptable for a
  pre-release feature; noted in the changelog.
- The Nextcloud app uses WebDAV directly (`storage.webdav.js`), not
  `nextcloudSync.js`. It stores the same note JSON and blobs; the page
  operations live in `NoteCanvas`, so they run in both. Only `pageFormat`
  and the extended shift record need schema entries there.

## 10. Platform notes

- **Android:** thumbnails must be lazy and serial (memory); the dialogs must
  work at phone width and with touch selection and long-press drag. Export of
  a note with several large source files loads them one after the other, not
  all at once.
- **Windows / Nextcloud app:** same code, mouse selection (shift/ctrl) and
  drag.
- **Long PDFs (400 pages):** the thumbnail grid is virtualized (only rows near
  the viewport exist in the DOM), the planner finds a content item's page by
  binary search over the page ranges (as `_strokeNeedsLightPalette` already
  does for page bounds), and a layout change invalidates the renderer's
  per-version page caches once, not per page. A drag target is a gap between
  thumbnails, so the grid auto-scrolls while dragging; the move buttons remain
  the reliable route.
- **Dark mode:** PDF thumbnails are shown un-inverted (white pages), as the
  dialog is a chooser, not the canvas; blank pages in the grid are white.
- No migration is needed: existing notes are already valid page lists.

## 11. Open items

Numbers are stable; resolved questions moved into the decision record.

- **Q4 Range moves in recorded shifts (§9).** Implement in phase 1 with merge
  tests so reorder stays correct under concurrent drawing; verified by the
  phase 0 spike first. Fallback: reorder ships after delete, insert and blank
  pages, and ink drawn elsewhere during a reorder may land on the wrong page.
- **Q6 Where the page-format setting lives.** No note-properties dialog exists;
  candidates are the PDF/page button area or the note's options.
- **Q7 Which page owns a stroke** (§4.2): top, centre or first point, decided
  by a test on realistic samples in phase 1. A stroke or box extending into
  the next page moves with its own page and can overlap after a reorder.
- **Q8 Purging deleted pages from the source file** (§5.5). Not in this
  release; decide later whether a "Remove unused pages from the file" action
  is wanted.
