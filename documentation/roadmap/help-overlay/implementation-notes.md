# Help Overlay — Implementation Notes

Status: Phases 0–6 implemented (English strings hardcoded). **Phase 7 (localization) intentionally not started** — to be done once the English copy is final.

## Files added
- `src/modules/helpGuidance.js` — localStorage-backed seen/step flags. `+ helpGuidance.test.js`.
- `src/components/HelpOverlay.js` — the tour component (`startHelpTour`, positioning, Next/Back/Skip, ESC). `+ HelpOverlay.css`, `+ HelpOverlay.test.js`.
- `src/components/helpContent.js` — all tour copy in one place (single-file swap for Phase 7 localization).

## Files touched (hook points)
- `src/components/settingsMode.js` — "Help Guidance → Reset" section (placed high, right after Appearance) + handler.
- `src/components/NoteCanvas/index.js` — first-note 7-step tour after first `load()`.
- `src/components/NoteCanvas/NoteCanvas.js` — mode triggers via `onModeChange` (`_maybeShowModeHelp`); first-image trigger in `insertImage()`.
- `src/components/NoteCanvas/TextEditorLayer.js` — mark-as-task trigger (both listeners funnel through one handler).

## Deviations from plan (deliberate)
1. **No `toolbarlayoutchange` event added to `NoteToolbar.js`.** Investigation showed `NoteToolbar.isExpanded` only controls the *pen settings dialog*, not the layout/position of the mode buttons — the toolbar buttons never reflow. So the plan's concern about targets moving on expand/collapse doesn't arise. `HelpOverlay` repositions on `resize`/`orientationchange` plus two deferred re-measures (rAF + 250ms) after mount, which covers font/transition settling. **Net: `NoteToolbar.js` is untouched → zero regression risk there.**
2. **First-image target = the Insert button (`#nc-tool-insert`), not the image element.** Images are drawn on the canvas and have no per-image DOM node to anchor to; the MediaOverlay handle only exists while an image is *selected*. Anchoring to Insert (where images come from) with body text explaining how to re-select is robust and read-only. Falls back to a centered callout if the button isn't found.

## Regression safety (verified)
- Stylus auto-switch to Draw calls `_setMode("draw")` **directly** (NoteCanvas.js ~1993), bypassing `onModeChange` → the Draw overlay never pops mid-stroke. Confirmed unchanged.
- The overlay layer is **entirely absent from the DOM** whenever no tour runs (asserted in `HelpOverlay.test.js`). No CSS/DOM/listener cost otherwise.
- All 846 existing native tests + 20 NC tests still pass. Native + NC builds compile.

## How to manually verify (per platform: Windows, Android, NC web)

Reset flags first via **Settings → Help Guidance → Reset**, or in devtools console:
```js
// clear all help flags
Object.keys(localStorage).filter(k => k.startsWith('noteberg_help_')).forEach(k => localStorage.removeItem(k));
```

Then:
- **Trigger 1 (first note):** open a note → 7-step tour (Pan→Draw→Text→Eraser→Lasso→Options→Insert). Test Next/Back/Skip. Close app mid-tour (e.g. on step 3) and reopen → resumes at step 3.
- **Triggers 2–6 (modes):** with trigger 1 skipped/done, tap each of Pan/Draw/Text/Eraser/Lasso the first time → one callout each, once only.
- **Trigger 7 (image):** insert an image → callout once. Not on PDF, not on later inserts.
- **Trigger 8 (task):** mark text as task → callout once, independent of the Text-mode callout.
- **Regression:** draw/pan/erase/lasso before & after; stylus auto-switch mid-touch must NOT show the Draw callout; resize/rotate mid-tour and confirm the arrow tracks the right button.
```
```
