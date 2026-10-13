# Text layer shifts relative to ink between devices

**Status: investigated, not yet fixed.** Two concrete, fixable causes were
found; one is a native Android WebView setting, the other is the Nextcloud
build not shipping the app font. Display DPI on Windows was tested and is
**not** a cause. This document records the evidence and the proposed fixes so
the investigation does not have to be repeated.

## Symptom

Text entered in text mode is laid out by the browser (Trumbowyg contenteditable
in `TextEditorLayer`), while strokes are stored in absolute content
coordinates on a 1200 px wide canvas. On some devices the text renders at a
slightly different size and position than on the device where it was written,
so strokes drawn in relation to the text (underlines, marker highlights)
land in the wrong place. The offset grows further down the page.

## How the text layer is positioned today

- Content width is a constant 1200 CSS px on every platform
  (`maxContentWidth`, never overridden by a caller).
- `.trumbowyg-editor`: `padding: 15px 20px 20px 46px`, `font-size: 16px`,
  `line-height: 1.5` (integer 24 px line boxes), `p { margin: 0; min-height: 1.5em }`.
- Zoom is applied as `transform: scale()` on the container, so layout always
  happens at zoom 1 in CSS px. Scroll is applied via `top`/`left`.
- The Inter font is bundled (`src/styles/fonts.css`, latin + latin-ext subset)
  **for Tauri builds only**. `src/main.js` skips the import for the Nextcloud
  build (commit 7f3b3e9: "NC uses its own font stack and rejects bundled
  variable fonts").
- `html { text-size-adjust: 100% }` is set (commit 7d7f662), which disables
  Android font boosting but nothing else.
- Earlier fixes: 703f528 (bundle Inter), 7d7f662 (text-size-adjust),
  1886730 (top/left instead of translate, border-box height for the
  ResizeObserver).

## Measurement: DPI on Windows is not the cause

The editor's exact CSS (1200 px, same padding, font sizes, line heights) was
rendered in headless Edge 153 (same Chromium as WebView2) at device scale
factors 1, 1.25, 1.5 and 2, once with the bundled Inter woff2 and once with
the fallback stack (Segoe UI). Widths and offsets were read with
`getBoundingClientRect()`.

Same font, different scale factor (Inter):

| element | DSF 1 | DSF 1.25 | DSF 1.5 | DSF 2 |
|---|---|---|---|---|
| short latin line, width | 408.875 | 408.875 | 408.875 | 408.867 |
| bold line, width | 430.141 | 430.138 | 430.135 | 430.133 |
| h1 span, top | 131.0 | 131.0 | 131.0 | 131.5 |
| 12-line paragraph, height | 288 | 288 | 288 | 288 |
| last paragraph, top | 595 | 595 | 595 | 595 |

Maximum difference across scale factors: 0.5 px, no wrap changes. So on the
same engine with the same font, Windows display scaling (100 %, 125 %, 150 %,
200 %) does not move text. Chromium lays out in CSS px with subpixel glyph
advances independent of the device scale factor.

Same scale factor, different font (DSF 1):

| element | Inter | Segoe UI fallback | delta |
|---|---|---|---|
| short latin line, width | 408.9 | 407.8 | -1.1 px |
| bold line, width | 430.1 | 435.8 | +5.6 px |
| h1 span, width | 516.8 | 524.3 | +7.5 px |
| h1 glyph box, height | 39 | 43 | +4 px |
| list item, width | 136.9 | 135.7 | -1.2 px |

The font is the variable that moves things: bold and headings differ by
several pixels per line, and a long line that wraps one word earlier or later
shifts everything below it by a full 24 px line.

The measurement page and PDFs are in the session scratchpad, not the repo;
the numbers above are the complete result.

## Cause 1 (native Android): WebView applies the system font size

Android's WebView multiplies every CSS font size by the system
"Font size" accessibility setting unless the host app pins
`WebSettings.textZoom = 100`. Tauri/wry does not set it: the generated
`RustWebView.kt` configures JavaScript, DOM storage and similar, but no
`textZoom`. `text-size-adjust: 100%` does not affect text zoom (it only
disables font boosting).

With a system font scale of, say, 1.15, the editor's 16 px becomes 18.4 px,
and because `line-height: 1.5`, `min-height: 1.5em`, heading `em` sizes and
list margins all derive from the font size, the whole text block grows by 15 %
vertically and horizontally while strokes stay put. That matches the reported
"slightly different size, offset grows down the page" exactly. Two tablets
with different font-size settings will disagree with each other and with
Windows.

**Fix:** `MainActivity.kt` already extends `TauriActivity`, whose base
`WryActivity` exposes `open fun onWebViewCreate(webView: WebView)`. Override it
and set `webView.settings.textZoom = 100`. This file is project-owned (it
already carries the audio-focus code), so the change survives regeneration.

**Verify first:** on an affected tablet, temporarily change
Settings > Display > Font size and reopen a note. If the text layer changes
size while the strokes do not, this is confirmed.

Sources:
[Android WebSettings.TextSize](https://developer.android.com/reference/android/webkit/WebSettings.TextSize),
[flutter_webview_plugin #895](https://github.com/fluttercommunity/flutter_webview_plugin/issues/895),
[AndroidWebViewScaleTest](https://github.com/binarynate/AndroidWebViewScaleTest).

## Cause 2 (Nextcloud build): no bundled font

The NC bundle (`css/noteberg-styles.css`) contains no `@font-face`; the
`--font-family` stack starts with "Inter" but falls through to Segoe UI on
Windows, Roboto on Android and Helvetica on macOS unless Inter happens to be
installed. Every NC client therefore lays text out with a different font than
the native apps, and NC-on-Windows differs from NC-on-Android. The measured
width deltas above (up to 7.5 px per heading line, 5.6 px per bold line)
apply directly, and any changed wrap point costs 24 px for the rest of the
page.

**Fix:** ship the Inter woff2 in the NC build as well. The files already land
in `assets/` (left over from the earlier WIP build), the NC default CSP allows
`font-src 'self'`, and `templates/index.php` loads the stylesheet through
`Util::addStyle`, so a relative `url(../assets/Inter-latin-ext.woff2)` in the
emitted CSS resolves. Commit 7f3b3e9 removed it because NC "rejects bundled
variable fonts"; re-check what actually failed. If it was the app-store
scanner or CSP objecting to the variable font, switch to static Inter Regular /
Bold / Italic woff2 files (four files, similar total size) rather than dropping
the font.

## Cause 3 (all platforms): glyphs outside the bundled subset

The bundled Inter covers latin and latin-ext only. Greek, Cyrillic, CJK
(the app ships ja, ko and zh locales) and emoji fall back to the OS font: Yu
Gothic / Microsoft YaHei / Segoe UI Emoji on Windows, Noto Sans CJK / Noto
Color Emoji on Android. Their advances differ, so any line containing such
characters may wrap differently per device. A single emoji in a heading is
enough.

**Options:** add Inter's Cyrillic and Greek subsets (cheap, ~30 KB each).
CJK and emoji fonts are megabytes; accept the limitation and document it, or
pin a fixed advance for emoji via `font-variant-emoji: text` and a bundled
monochrome set if it ever matters.

## Cause 4 (NC first load): font swap after strokes exist

`font-display: swap` lets the page lay out with the fallback font until the
webfont arrives. On the native builds this is instant; on NC the first load
fetches over the network. If the ResizeObserver height or a user's first
strokes are taken against the fallback layout, they are wrong once the font
swaps in. Use `font-display: block` (text invisible up to 3 s, then swap) or
`<link rel="preload" as="font">`, and await `document.fonts.ready` before the
first `onHeightChange` measurement.

## Ruled out

- **Windows display scaling** (DPI, 125 % / 150 %): measured, no effect.
- **Windows "Text size" accessibility slider:** WebView2 applies it as a page
  zoom factor (everything scales, `devicePixelRatio` changes), so CSS px stay
  consistent between text and canvas. Not a misalignment source.
  Source: [WebView2Feedback #3699](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3699).
- **Chrome for Android "Default zoom"** (NC in the browser): current Chrome
  scales the whole layout, same as above. Older builds had a text-only
  "Text scaling" slider that behaves like Cause 1; nothing the page can do
  about that beyond `text-size-adjust`, which is already set.
- **Browser Ctrl+/- zoom:** blocked in `main.js`, and would be page zoom anyway.
- **Content width:** constant 1200 px on every platform.
- **Paragraph margins and fractional line heights:** already normalized
  (`p { margin: 0 }`, 24 px integer line boxes).

## Recommended order of work

1. **Diagnose on the real devices before changing code.** Run this in the
   devtools console of each device with the same note open:

   ```js
   (() => {
     const ed = document.querySelector(".trumbowyg-editor");
     const s = document.createElement("span");
     s.textContent = "The quick brown fox jumps over the lazy dog 0123456789";
     s.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
     ed.appendChild(s);
     const r = s.getBoundingClientRect();
     s.remove();
     const z = document.querySelector(".note-canvas__text-editor-layer").getBoundingClientRect().width / 1200;
     console.log({ dpr: devicePixelRatio, inter: document.fonts.check('16px "Inter"'),
       probeWidth: r.width / z, probeHeight: r.height / z, ua: navigator.userAgent });
   })();
   ```

   Expected with Inter and no text zoom: `probeWidth` about 408.9 and
   `probeHeight` about 19.2 to 20 (the same 24 px line box). A width ratio of
   1.1 to 1.3 with `inter: true` means text zoom (Cause 1). `inter: false`
   means the font is missing (Cause 2). Everything equal but still shifted
   points at Cause 3 or 4.

2. **Android:** set `textZoom = 100` in `MainActivity.onWebViewCreate`.
   One line, no data migration, no effect on notes written on Windows.

3. **Nextcloud:** bundle Inter (static files if variable fonts are the
   problem), `font-display: block`, await `document.fonts.ready` before the
   first height measurement.

4. **Add a permanent self-check** in `TextEditorLayer.init()`: measure the
   probe once after `document.fonts.ready` and log (or show once in settings)
   when the ratio deviates from 1 by more than 2 %. That catches any future
   environment we have not seen (a new browser, a changed OS setting) instead
   of letting the misalignment silently reach the user's notes.

5. **Optional hardening:** if a residual scale is detected and cannot be
   removed at the source (NC in a browser with a text-only zoom), compensate by
   setting `font-size: calc(16px / ratio)` on `.trumbowyg-editor`. Because all
   vertical metrics are `em`-relative, this cancels a uniform text zoom. It
   does not fix a different font, which is why 2 and 3 come first.

## What would not help

- Sorting out the canvas `devicePixelRatio` handling: strokes already render
  in CSS px and the measurements show the DOM side is DPR-stable too.
- Storing per-device layout offsets or anchoring strokes to DOM nodes: far
  more complex than removing the two environmental variables that actually
  differ, and still broken for a different font.

## Further findings in text mode

Collected while reading the text-mode code for the investigation above.
Ordered by impact.

1. **PDF export uses a different text layout than the editor.**
   `pdfExport.js` renders the note HTML in Georgia serif, `line-height: 1.6`,
   padding `20px 20px 20px 60px`, while the editor uses Inter, `line-height:
   1.5`, padding `15px 20px 20px 46px`. Strokes are then drawn at their
   content coordinates, so every exported note shows the text-versus-ink
   offset of this document, only larger. Fix: reuse the editor's CSS verbatim
   (a shared constant or a shared stylesheet string) and embed the Inter
   `@font-face` in the export iframe so html2canvas lays out the same way.

2. **Text and ink do not move together.** Insert-space shifts strokes and
   media but not text; editing text reflows the text but not the ink below.
   Design in the next section.

3. **Undo loses the caret.** `TextChangeCommand` swaps the whole HTML, so
   after undo the selection is gone and the caret jumps. Store the range
   (node path plus offsets) with each command and restore it in `_apply`.

4. **Pasted images are base64 inside the note HTML.** They inflate the note
   JSON, every sync upload, the search scan over `content`, and every undo
   snapshot after the paste. Store them in the media store like stroke-layer
   images and reference them by id.

5. **Font coverage.** Only latin and latin-ext are bundled while ja, ko and
   zh locales ship. Add the Cyrillic and Greek subsets; document that CJK
   uses system fonts.

6. **Document language is hardcoded.** `index.html` sets `lang="en"`, so
   spellcheck and hyphenation in the editor follow English regardless of the
   UI locale. Set it from the i18n locale at startup.

7. **Inline colors versus dark mode.** The foreColor and backColor plugins
   write fixed inline colors; black text chosen in light mode is invisible
   in dark mode. Restrict the palette to theme-aware values or map it
   through CSS variables.

8. **Dead or fragile code.** `src/utils/markdown.js` has no importers and its
   regexes are unsafe (the italic pattern eats bold markers, list items are
   emitted without a wrapping `<ul>`). Remove it or replace it with a real
   converter if markdown paste is planned.

9. **Polish.** The custom indent step is 8 px while list indentation is
   32 px, so indented paragraphs and lists never line up. No link button, no
   code block. Search strips tags but does not decode entities, so a search
   for `&` misses `&amp;`.

## Design: keeping text and ink aligned when content shifts

### The problem

Ink is stored in absolute content coordinates; text is laid out by the
browser. Anything that changes the vertical extent of text above a stroke
breaks the association between the two:

- **Insert-space** moves ink and media below the split line by the dragged
  distance, but the text stays. The user gets a gap in the ink and no gap in
  the text.
- **Typing** a new line, deleting a paragraph, pasting an image, or changing a
  paragraph to a heading moves every text line below the edit by some amount,
  and the ink stays.

A naive fix for the first case, "insert as many empty paragraphs as fit into
the dragged distance", fails because the dragged distance is arbitrary and
the text is not: a paragraph line is 24 px, an `h1` is 48 px plus 16 px
margins, a list item is 28 px with collapsed margins, an image is whatever
height it has. Inserting paragraphs to cover 37 px of drag either leaves the
text 13 px short of the ink or overshoots by 11 px, and the next annotation
the user draws is misaligned on every other device as well.

### Principle: the text layer is the source of truth for vertical space

Both directions become one rule: **ink below a split line moves by exactly the
amount the text below that line actually moved**, measured from the DOM, not
computed from the drag distance or from a line-height constant. The DOM
measurement automatically accounts for margins, headings, list spacing,
tables and images, and it is the same measurement on every device because
the layout is (after the fixes above) identical.

### Insert-space with text present

1. **Snap the split line to the text.** While the user drags, convert the
   pointer Y to a position in the editor with `caretPositionFromPoint` (screen
   coordinates, so multiply content Y by the current zoom and add the layer
   offset) and find the nearest boundary between two line boxes: for a
   paragraph, the bottom of the line box containing the point (from
   `Range.getClientRects()` of the block); for a table, list, image or other
   atomic block, the bottom edge of that block. Draw the insert-space
   indicator at that snapped Y instead of the raw pointer Y. The snapped Y is
   the split line for **both** layers, so ink between the raw pointer and the
   snapped line stays with the text line it sits on.

2. **Quantize the preview.** While dragging, round the requested distance to
   a multiple of 24 px (the paragraph line box) for the on-screen indicator,
   so the user sees what they will get. Inside a list, quantize to the list
   item height instead (measure one `li` at drag start). Never let the
   preview promise a distance the text cannot produce.

3. **Insert into the text.** On release, insert `n = round(distance / 24)`
   empty paragraphs (`<p><br></p>`) at the split. If the split is inside a
   wrapped paragraph, first split that paragraph at the soft line break: the
   second half starts with the word that already began the next line, and
   because the available width is unchanged, every following line wraps at
   the same places as before. Use the editor's own paragraph insertion
   (Trumbowyg `execCmd("insertParagraph")` on a collapsed range at the
   boundary) so inline formatting spans are split correctly. Inside a list,
   insert empty `li` elements instead. Inside a table cell, refuse: treat the
   whole table as atomic and use its bottom edge as the split.

4. **Measure the real delta.** Before inserting, record `top` of the first
   root-level block at or below the split. After inserting and a forced
   layout, read it again. `delta = after - before`. Because `p { margin: 0 }`,
   inserting between paragraphs gives exactly `24n`, but next to a heading or
   between two lists the collapsed margins change and the delta differs.
   The measurement catches that without special cases.

5. **Shift the ink by the measured delta**, not by the drag distance:
   `ShiftContentCommand(delta, strokesBelowSplit, mediaBelowSplit, splitY)`.
   Recognition bands already follow via `startY`.

6. **One undo step.** Wrap the `TextChangeCommand` and the
   `ShiftContentCommand` in a composite command so undo restores both layers
   together. The history manager already supports pairing (MarkTaskCommand
   does this), so this is a small addition.

7. **No text below the split, or the note has no text:** current behaviour
   (unquantized shift) is correct and unchanged.

### Editing text with ink below

The symmetric case, and the one users hit without noticing: they add a line
in a paragraph above an annotated diagram and the underline slides off its
word.

1. **Snapshot block positions.** After every content change (the existing
   debounced `tbwchange` handler), store for each root-level block of the
   editor its `top` and `bottom` in content coordinates, keyed by the element
   (a `WeakMap`), plus the caret's block.

2. **On the next change, diff.** Walk the root-level blocks. Find the first
   block that existed before and whose `top` moved: that is the shift point,
   and `delta = newTop - oldTop`. Everything from that block down moved by the
   same delta if the edit was local (one edit site), which is the only case
   worth automating. If two or more blocks moved by different amounts (a
   paste with several images, a global reformat), do nothing and leave the
   ink alone.

3. **Shift ink whose `minY` is at or below the old top of that block** by
   `delta`. Ink that overlaps the edited block itself (an underline on the
   line being typed) is deliberately not moved: it belongs to text that did
   not move as a whole.

4. **Undo pairing** as above: the `TextChangeCommand` for that debounce window
   and the `ShiftContentCommand` become one composite step.

5. **Make it visible and optional.** A short toast ("Ink below moved 24 px
   with the text, Ctrl+Z to undo") the first few times, and a setting
   "Move ink with text edits" that defaults to on. Users who annotate a fixed
   printout of text (PDF pages are already excluded from shifting) will want
   it off.

### Why the 24 px grid still matters

Measuring the delta makes the shift correct on the editing device. Keeping
paragraph line boxes at an integer 24 px, `p { margin: 0 }`, and quantizing
insert-space to line multiples keeps the delta an integer too, so it is
identical on every device once the font and text zoom differences are
removed. Fractional shifts (an image of height 137.5 px) are fine within one
device but are exactly where two Chromium versions can round differently;
`img { height: auto }` already yields integer heights for pasted images
because the paste path rescales them to integer pixel dimensions.

### Not proposed

- Anchoring individual strokes to DOM nodes (OneNote-style). It would make
  ink survive arbitrary reflow, but requires a stroke-to-node mapping in the
  data model, migration of existing notes, and breaks as soon as the anchor
  node is deleted. The measured-delta approach covers the common editing
  cases with no data model change.
- Spacer elements with an explicit pixel height (`<div style="height:37px">`)
  to allow unquantized insert-space. Chromium clones the block's inline style
  onto the new paragraph when Enter is pressed inside it, so spacers multiply
  under normal typing; `contenteditable="false"` spacers avoid that but are
  awkward to delete and do not survive export to other editors. Quantizing
  to real paragraphs is simpler and keeps the HTML plain.
