# PDF pages: implementation plan

Design: [DESIGN.md](DESIGN.md). Each phase ends green on `just fct` and is
checked on Windows, Android and the Nextcloud app before the next starts. No
phase writes a migration (existing notes are valid page lists, DESIGN §10).

Sizes are rough, for ordering only: S = 1-2 days, M = 3-5 days, L = 1-2 weeks.

## Status (2026-10-28)

Proposed, nothing implemented. Existing code was read first (DESIGN §3).
Revised twice the same day: reorder, blank pages and text boxes added;
deleting made permanent (no undo); spike, interactions, long PDFs and the
shared entry point added.

## Phasing and releases

```
0  multi-file safe + spike  (S + M)   <- everything depends on this
1  page layout primitive    (L)
2  dialog + delete          (M)       -> release A: delete
4  add pages from PDF       (M)       -> release A: + add from PDF
5  blank pages              (M)       -> release A: + blank pages
3  reorder                  (M)       -> release B (needs the spike to pass)
6  page format, plain notes (M)       independent, any time after 1
7  release notes, docs      (S)
```

Delete, insert and blank pages only need today's line shifts in the merge.
**Reorder is the only feature that needs the extended shift record**, so it
ships separately, after the spike (below) has shown the merge stays correct. If
the spike fails, release A ships without reorder and reorder waits for a better
merge design.

The Android share target
([android_share_target](../android_share_target/PLAN.md)) is smaller and
independent; it needs phase 0 here only for its "add to a note that already
has a PDF" case (phase 4, `addPdfPages`).

## Phase 0: multi-file safety and merge spike

Removes the single-file assumptions listed in DESIGN §3, pins today's
behaviour with tests before anything can create a second file, and answers the
questions that decide the design.

Multi-file safety (M):

- `pdfExport.js` case A: order page items by `y`, load each source once,
  `copyPages` per item. Test: single untouched file gives the same page
  count, sizes and drawn content as before; a two-file fixture gives pages
  in item order.
- Confirm `pdfInkAnnotations.js` works per output page (no file assumption).
- Navigator labels: ordinal by position, not `pageIndex`.
- Outline: map entries by `fileId` as well as `pageIndex`; show the outline of
  the first file only until a use for more appears.
- Check every other reader of `pdfSource`/`pdf-page`: `extractPdfText`
  consumers, recognition rasterizer, `liveTakeIn`/`liveSyncPlan`, backup,
  `storage.js` copy-note (`copyFile(pdfSource)` must also copy the other
  blobs of a copied note), `storage.webdav.js`, task checkbox layer, search
  position code (nothing may cache absolute `y`).
- Decide and write down the rules of DESIGN §4.3: AI recognition queue
  (recommended: refuse page operations while it runs), live take-in of a
  changed page list into an open note, read-only and shared notes.
- Test fixtures: multi-page PDFs with mixed sizes and orientations (A4, Letter,
  landscape), a PDF with a CropBox and one with `/Rotate`.

Merge spike (S, throwaway code, findings written into DESIGN §9):

- **S1 Range moves.** In the `mergeReplicas` fixture, write the extended shift
  record `{v, moves: [{from, to, delta}]}` and its replay in `normalize`.
  Property test in the style of `noteMerge.property.test.js`: two and three
  replicas, any merge order, same result; reorder / delete / insert against
  concurrent ink and text boxes; page items that "never move" stay consistent.
- **S2 Page `y` merge.** Two replicas change the page list at once; what do the
  stamped `y` values do? Does the result overlap or gap? Is a repair needed?
- **S3 Text.** A box moved or removed by a layout change merges three-way with
  a concurrent edit of the same box and of the text around it
  (`textMerge`, text boxes DESIGN §6).

Exit: DESIGN §9 states the verified merge behaviour. If S1 fails, reorder is
removed from release A and re-planned.

## Phase 1: page layout primitive (pure code and model, no dialog) (L)

The core of the feature. Everything later only builds a new page list.

- `src/modules/pdfPageLayout.js` (pure, no DOM): `planPageLayout(oldPages,
  newPages, content)` returns, for strokes, images, text boxes and
  recognition words: moves (`id -> dy`) and deletions; the re-stacked page
  `y` values; the new `pdfSource`. Rules of DESIGN §4 (content owned by the
  page containing its anchor; overflow below the last page; main box
  untouched). Page lookup by binary search. The stroke anchor is a function
  (DESIGN §4.2): test top, centre and first point on realistic samples (a text
  line over a page edge, an underline, a margin note) and pick one.
- `TextLayer`: `boxesTopIn(top, bottom)` (all boxes with their `y`),
  `shiftBoxes(Map<id, dy>)` (one save), `removeBoxes(ids)`. No restore: delete
  is permanent. Active box committed first.
- `PageLayoutCommand` for the reversible changes (reorder, insert): one undo
  step, built on the mechanics of `ShiftContentCommand` (strokes, boxes, bands,
  `strokesChanged`, forced save).
- `deletePages(ids)`: the planner's deletions, tombstones, `pdfSource`, then
  `historyManager.clear()` (DESIGN §4). No command.
- Merge: record the change in `note.shifts`. Delete and insert use today's line
  form. Reorder uses the extended record if the spike passed.
- `addPdfPages(noteCanvas, file, pageSelection, target)` (DESIGN §5.2): the
  single entry for first import and added pages; the toolbar import becomes a
  call to it.

Tests (unit): delete first/middle/last/all pages; insert at start/middle/end;
reorder up/down/multi-select block; content inside / on the edge /
straddling / below the last page; text boxes in each of those positions; the
implicit main box stays; recognition bands move; undo/redo round trips for
reorder and insert; delete clears the history; `pdfSource` bookkeeping.

Exit: operations work from a test harness on a real `NoteCanvas` in jsdom, and
a note with ink and text boxes survives any sequence of reorder and insert plus
undo.

## Phase 2: Pages dialog and delete (M)

- `src/components/pdfPagesDialog.js` (+ tests), opened from the PDF button
  menu (`_showPdfOptions`): thumbnail grid, selection, delete with the
  confirmation that counts strokes, images and text boxes and says it cannot
  be undone.
- Thumbnail renderer: lazy, one or two at a time, cancelled on close, uses
  `loadPdfPage`. Grid virtualized for long PDFs (DESIGN §10). Reuse the
  page-bitmap budget logic (`clampPdfScaleToBudget`).
- Disabled for read-only notes; refused with a message while AI recognition
  runs; reacts to a live take-in changing the page list (updates or closes).
- Last page deleted: behaves like "Delete PDF".
- i18n in all 9 locales (`canvas.pdf.*`), help text.
- e2e (`media.e2e.js`): import a 3-page PDF, ink and a text box on each page,
  delete the middle page: content of page 3 is now on page 2, the box on page
  2 is gone, export has 2 pages, undo is empty.
- A 400-page PDF opens the dialog without a frame stall on the mid-range
  Android tablet (manual test).

## Phase 4: add pages from another PDF (M)

- Picker (existing `_pickPdfFile`) then the page-selection dialog (shares the
  thumbnail grid with phase 2), calling `addPdfPages`.
- Target selection: start, end, after selected/current page.
- `insertPdf` refusal message changes: a note with a PDF offers "Add pages"
  instead.
- Save through `_saveMediaChanges`; progress dialog as in import.
- e2e: add pages 2 and 4 of a second PDF after page 1 with ink and a box
  below: they move down by the added height; undo reverses it; sync keeps
  both blobs; export contains the original pages of both.
- Android: large source file, thumbnails stay lazy (manual test 4.4).

## Phase 5: blank pages (M)

- Item shape `blank: true`, `format` (DESIGN §6); guards in render, text
  layer, export copy, sync collectors; excluded from the white-paper stroke
  palette bounds.
- Insert dialog: format proposed from the neighbour page, size and
  orientation changeable; target as in phase 4.
- Rendering: outline plus the note's background pattern; dark theme follows
  the canvas.
- Export: `addPage` in the format's point size, background pattern, ink and
  text drawn as on other pages.
- Navigator label; thumbnail as an empty sheet.
- Tests: insert between pages, at start and end, in all four formats;
  reorder and delete with blank pages; export page sizes; a note with only
  blank pages left behaves as "PDF deleted" (DESIGN §5.3).
- Old client behaviour (empty area, export fails) checked by hand once.

## Phase 3: reorder (M, release B, after the spike passed)

- Drag in the grid (mouse; long-press on touch) with auto-scroll, plus "Move
  to start / end / before..." buttons. Multi-selection moves as a block.
- Uses the phase 1 primitive; no new model code beyond the page permutation.
- Navigator and outline follow the new order.
- e2e: reorder with ink and a text box on every page; every item stays with
  its page; undo restores; sync round trip to the Nextcloud mock keeps the
  order; a second replica that drew on a page meanwhile ends up with its ink
  on the right page.
- Android: long-press drag in a long document; the buttons as the fallback.

## Phase 6: page format for notes without a PDF (M)

- `pageGeometry.js`: page size per format; `pageHeight(contentWidth, format)`.
  The blank-page dialog uses the same function.
- Consumers: `CanvasRenderer._drawA4PageBreaks` (drop the hard-coded
  numbers), `pdfExport` case B, `pageRasterizer`, tests for each.
- Note field `pageFormat` (absent = A4 portrait): `noteMerge.SCALAR_FIELDS`,
  `noteFileOps`, `storage.webdav.js` schema, `liveTakeIn` fields.
- Setting UI (location: DESIGN Q6), shown only while the note has no PDF.
- Tests: merge of the field, export slice heights for Letter and landscape,
  recognition bands align with the break lines.

## Phase 7: release (S)

- `CHANGELOG.md` entry (stamp by hand, see release convention), README
  feature list, `play-release-notes.txt`, help content (`helpContent.js`);
  state that deleted pages stay inside the stored file (DESIGN §5.5).
- `documentation/manual_test.md`: Android thumbnails, touch selection and
  long-press drag, the Windows save dialog with a multi-file export, an old
  client opening a note with added and blank pages, a 400-page PDF.
- Update `architecture_design.md`, `sync_architecture.md` and
  `notebook_sharing_design.md` §10.7 (shift records).
- Mark DESIGN.md "Implemented" and note what implementing changed.

## Risks

- **Merge under concurrent page edits.** The extended shift record touches the
  most delicate code in the app (element-level merge, three or more replicas
  agreeing). Mitigation: the phase 0 spike decides before any UI exists; the
  release split (A without reorder) keeps the rest unblocked.
- **Content silently on the wrong page** after a reorder is the worst failure
  of this feature. Every reorder test places ink, an image and a text box on
  each page; the stroke-anchor rule is chosen on real handwriting samples.
- **Irreversible delete.** Mitigation: the confirmation states the counts and
  that it cannot be undone; the undo history is cleared so no step can refer
  to removed content; deletion syncs through tombstones like other deletions.
- **Deleted pages remain in the source file** (DESIGN §5.5): documented, in
  the changelog; purging is a later decision (DESIGN Q8).
- **Text box handling** (new `TextLayer` methods) must keep the byte-identical
  guarantee for notes without boxes (text boxes DESIGN §3.1) and not make a
  note dirty on open.
- **Running recognition and live sync** changing the page list under an open
  dialog or queue: rules in DESIGN §4.3, tested in phase 2.
- **Memory on Android** with large PDFs: thumbnails and export both load
  documents. Mitigation: lazy serial thumbnails, one source loaded at a time
  in export.
- **Old clients** export multi-file and blank-page notes wrongly (DESIGN §9);
  changelog note.
- **Scope creep** towards rotate, blank pages in plain notes (DESIGN D6),
  duplicating a page, purging deleted pages: each is its own item after this
  plan.
