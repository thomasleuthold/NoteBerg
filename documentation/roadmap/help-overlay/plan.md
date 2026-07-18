# Help Overlay — First-Use Guidance for the Note Editor

## Context

NoteBerg's first external QA report (PrimeTestLab, v0.5.34, July 15 2026) flagged that new users get no guidance when first using the canvas editor's tools (Text/Draw/Eraser/Lasso) — no explanation of tap targets, selection/focus behavior, or that saves are automatic. This is a real onboarding gap: the free-form canvas differs from standard mobile text editors and some behaviors (stylus auto-switch, part-eraser, image selection) are genuinely non-obvious.

Through discussion we scoped this to a **device-local, one-time guided tour per canvas mode/action** — one short, arrow-pointed step at a time rather than a wall of text — deliberately kept minimal to avoid regression risk and UI-state complexity, with a Settings-based reset so the tours aren't a permanent one-shot-forever risk (covers both accidental dismissal and QA/testing needs).

**Goal**: ship a consistent, step-by-step pointed tour — one short callout at a time, arrow pointing at the real control, Next/Previous/Skip — triggered at 8 first-use points below, plus a "Reset help guidance" Settings row, working identically on native Windows, native Android, and the Nextcloud (NC) web build.

**Non-goals**: no persisted/synced-across-devices state, no image/animation assets (part-eraser gesture is described in text only, per earlier decision).

## Triggers (8 total)

Each trigger starts a tour of 1 or more steps. Every step shows exactly one short text, positioned so it stays readable (not necessarily dead-center — see Key decisions), with an arrow pointing at the control it describes, and Next/Previous/Skip controls. A tour with only one step still uses this same component (arrow + single "Got it"-style final button instead of "Next"), so the look and feel is identical whether a trigger has 1 step or 7.

| # | Trigger | Steps (one control described per step) |
|---|---|---|
| 1 | First note opened ever | 7 steps: Pan → Draw → Text → Eraser → Lasso → Options (⋮) → Add (+) |
| 2 | Pan mode selected (first time) | 1 step: touch pans/zooms; an active stylus auto-switches to Draw while touch stays locked to pan |
| 3 | Draw mode selected (first time) | 1 step: normal pen vs marker/highlighter; mentions Text mode supports formatted text |
| 4 | Text mode selected (first time) | 1 step: formatted text insertion is supported |
| 5 | Eraser mode selected (first time) | 1 step: stroke eraser vs part eraser (erases only the touched part, not the whole stroke) vs highlighter-only toggle — no gesture animation |
| 6 | Lasso mode selected (first time) | 1 step: select strokes, then drag to move/resize |
| 7 | First image inserted | 1 step: long-press (touch) or hover-⋮ (mouse) to select an image afterward |
| 8 | "Mark as Task" used (first time) | 1 step: marked text becomes a checkable task |

Trigger 1's 7 steps point at the same 5 mode buttons used individually by triggers 2–6, plus the Options and Add buttons which have no other trigger. Completing or skipping trigger 1 does **not** mark triggers 2–6 as seen — they're independent flags, so a user who skips the trigger-1 tour still gets the single-step Draw/Eraser/etc. callouts the first time they actually select those modes. This is intentional: trigger 1 is a map of the toolbar, triggers 2–6 are just-in-time detail.

## Key decisions

**Storage: raw `localStorage`, one key per overlay ID.** This is the only mechanism proven to persist per-device identically on both native (Tauri webview) and the NC build — `getSetting`/`setSetting` is IndexedDB-backed on native but **in-memory-only** on `storage.webdav.js` (NC), so it would silently fail to persist there. Mirrors the existing pattern in `src/modules/storage.webdav.js:312-327` (`_INIT_KEY`) and `src/modules/theme.js:6-9,88-128`.

**UI: anchored popover with a live-tracked arrow, not a centered modal.** Superseded from an earlier centered-modal-only draft of this plan: consistency of look-and-feel across all 8 triggers, and clarity for the 7-step trigger-1 tour in particular, outweigh the added positioning complexity. Each step's callout is placed near its target control (e.g. `#nc-tool-draw`) with an arrow/pointer connecting the two, and repositions if the toolbar layout changes underneath it (resize, toolbar expand/collapse, orientation change). This is real added complexity versus a plain modal — see Regression risk below for how it's contained.

**Regression risk containment: a single full-app overlay layer, mounted only while a tour is active.** All tour UI (callout, arrow, Skip/Next/Previous) lives in one full-viewport layer appended to `document.body`, sitting above every other layer (canvas, toolbar, modals) via z-index. This layer is either **mounted** (a tour is currently running) or **entirely absent from the DOM** (no tour active — which is the state the app is in almost all the time, for almost all users, after their first few sessions). Concretely: `startHelpTour` creates and appends the layer element; finishing or skipping the tour removes it completely (not just hides it). No CSS or DOM node from this feature exists at all outside an active tour, so there is no per-frame cost, no stacking-context interaction, and no possible visual regression to any other screen when help mode isn't running. This is a stronger guarantee than "renders into its own layer" (previous draft of this decision) — it means the feature is provably inert, not just isolated, the rest of the time.

The layer still reads (never writes) target elements' `getBoundingClientRect()` to position the callout/arrow, recomputes on `resize`/`orientationchange` and on the toolbar's `isExpanded` change (`NoteToolbar.js`), and clamps itself on-screen on narrow viewports. Being read-only against toolbar/canvas DOM, and only existing while a tour is on-screen, means a bug in this positioning logic can at worst mis-place the tour's own arrow — it cannot corrupt drawing state or leak into normal app chrome.

**Single hook point for all 5 mode overlays.** The toolbar's `onModeChange` callback (`NoteCanvas.js:645-647`) is the one place every user-initiated mode change funnels through. Using it instead of editing 5 button handlers has a useful side effect: the stylus auto-switch-to-Draw (`NoteCanvas.js:1955`, `this._setMode("draw")` called directly) bypasses this callback entirely, so it correctly will **not** pop up the Draw overlay mid-stroke.

**Localization is the last step**, done once all English copy is finalized — avoids re-translating strings that are still being worded/adjusted across the build-out. All other phases use hardcoded English strings; the final phase moves them into i18n.

## Implementation

### 1. `src/modules/helpGuidance.js` (new)

Trigger 1 is a multi-step tour, so its flag needs to track "not started / on step N / completed" rather than a plain boolean — this lets a user who closes the app mid-tour resume (or at minimum, not silently lose the rest of the tour) rather than being treated as fully done after step 1. Triggers 2–8 stay single-step and use the plain seen/unseen boolean.

```js
const SEEN_PREFIX = "noteberg_help_seen_";
const STEP_PREFIX = "noteberg_help_step_";

export const HELP_IDS = Object.freeze({
  FIRST_NOTE: "first_note", // multi-step tour (7 steps)
  MODE_PAN: "mode_pan",
  MODE_DRAW: "mode_draw",
  MODE_TEXT: "mode_text",
  MODE_ERASER: "mode_eraser",
  MODE_LASSO: "mode_lasso",
  FIRST_IMAGE: "first_image",
  MARK_AS_TASK: "mark_as_task",
});

export function hasSeenHelp(id) {
  return localStorage.getItem(SEEN_PREFIX + id) === "1";
}

export function markHelpSeen(id) {
  localStorage.setItem(SEEN_PREFIX + id, "1");
  localStorage.removeItem(STEP_PREFIX + id);
}

// Multi-step tours only (currently just FIRST_NOTE). Returns 0 if never started.
export function getTourStep(id) {
  return Number(localStorage.getItem(STEP_PREFIX + id)) || 0;
}

export function setTourStep(id, stepIndex) {
  localStorage.setItem(STEP_PREFIX + id, String(stepIndex));
}

export function resetAllHelp() {
  for (const id of Object.values(HELP_IDS)) {
    localStorage.removeItem(SEEN_PREFIX + id);
    localStorage.removeItem(STEP_PREFIX + id);
  }
}
```

No dependencies on canvas/toolbar code — inert until called, zero regression surface by itself.

### 2. `src/components/HelpOverlay.js` (new) + CSS

A single tour component used by all 8 triggers, so a 1-step trigger (e.g. Lasso) and the 7-step trigger (first note) share identical visuals and interaction:

`startHelpTour(id, steps)` where `steps` is an array of `{ target: HTMLElement, title, body }` (length 1 for triggers 2–8, length 7 for trigger 1):
- If `hasSeenHelp(id)`, return immediately — no DOM work, nothing mounted (single synchronous `localStorage.getItem`, negligible cost at the hook points).
- Otherwise create and append the full-viewport overlay layer to `document.body` (see Regression risk containment above — this layer does not exist at any other time), then resume from `getTourStep(id)` (0 for a fresh start) and render one step at a time within it:
  - A small callout box (reusing `.modal-header`/`.modal-title`/`.modal-body` text styling from `src/styles/layout.css:699-799` for typography consistency, but its own positioning, computed per step) placed near `steps[i].target`, clamped to stay fully on-screen on narrow viewports.
  - An arrow/pointer element connecting the callout to `steps[i].target`, computed from `target.getBoundingClientRect()`.
  - Footer controls: "Skip" (always visible, ends the tour immediately, calls `markHelpSeen`, then removes the layer), "Previous" (hidden on step 0), "Next" (steps 0..length-2) or "Got it" (final step) — advancing calls `setTourStep(id, i + 1)` and re-renders the next step in the same layer, finishing calls `markHelpSeen(id)` then removes the layer.
  - Reposition on `resize`/`orientationchange` and when notified the toolbar's expand/collapse state changed (see Hook points) — these listeners are attached only while the layer is mounted, and removed along with it, so they add no cost when no tour is active.
  - No full-viewport dark scrim (unlike `.modal-overlay`) — the canvas stays visible/legible behind the callout since the arrow needs to reference it; a light backdrop or none at all, to be confirmed visually in Phase 1.
- ESC dismisses the whole tour (equivalent to Skip) for keyboard users; click-outside does **not** dismiss (unlike a modal), since a stray tap shouldn't cancel a multi-step tour the user is mid-way through — Skip is the explicit way out.

Write this as a new self-contained component rather than extending `showModal()`/`showAlertDialog()` in `modals.js` — those are fixed-centered, scrim-backed, Cancel/Confirm dialogs, structurally different from a positioned, steppable, arrow-pointing tour. Keeps `modals.js` untouched.

### 3. Hook points

| Trigger | File : location |
|---|---|
| 1. First note open | `src/components/NoteCanvas/index.js:57`, right after `await noteCanvasInstance.load(noteId, { searchQuery, taskId });` succeeds. (The second `load()` call site at line 110 is a live-update re-render of an *already-open* note, not a first open — correctly excluded, and safe regardless since the flag persists after the first trip.) Build the 7-step array from the toolbar's own stable DOM IDs — `#nc-tool-pan`, `#nc-tool-draw`, `#nc-tool-text`, `#nc-tool-eraser`, `#nc-tool-lasso`, plus the Options and Add button IDs (`NoteToolbar.js` `createBtn` calls, ~lines 209-272) — queried after the toolbar has rendered, so `startHelpTour` has real elements to anchor to on the first call. |
| 2–6. Mode overlays | `src/components/NoteCanvas/NoteCanvas.js:643-647` — the `onModeChange` callback passed to `new NoteToolbar(...)`. Add a `MODE_HELP_IDS` lookup (`pan`→`MODE_PAN`, `draw`→`MODE_DRAW`, etc.) and call `startHelpTour(helpId, [{ target: document.getElementById(\`nc-tool-${mode}\`), ... }])` there after `this._setMode(mode)`. |
| 7. First image inserted | `NoteCanvas.js`, `insertImage()` around line 810-812, after `insertedItems.length > 0` is confirmed (alongside the existing `historyManager?.push(new InsertMediaCommand(...))` call). Target is the inserted image element (or its selection-handle overlay) rather than a toolbar button. |
| 8. Mark as Task | `src/components/NoteCanvas/TextEditorLayer.js:334` inside the `tbwmarkastask` event handler (and the native fallback listener ~339-341 — factor both into one shared function so they funnel through a single call). Target is `.trumbowyg-markAsTask-button` (queryable at this point since the action already fired). This is an action-hook (fires on first actual use), consistent with triggers 2-7, not a "button became visible" hook. |

**Toolbar resize/expand notification**: `NoteToolbar.js` toggles `isExpanded` when switching between quick/full mode (constructor default `this.isExpanded = false`, ~line 177). If a tour step's target button moves as a result, the active `HelpOverlay` instance needs to reposition or close gracefully. Simplest approach for Phase 1: `HelpOverlay.js` exposes a `repositionActiveTour()` called from a `resize` listener it owns internally, and separately, `NoteToolbar` emits a lightweight custom event (e.g. `toolbarlayoutchange`) on expand/collapse that `HelpOverlay.js` listens for — a few-line addition to `NoteToolbar.js`, not a structural change to it.

### 4. Settings: "Reset help guidance" row

New dedicated section in `src/components/settingsMode.js`, inserted after the Logging section closes (line 322) and before Danger Zone opens (line 324) — not folded into Danger Zone, since resetting tips isn't destructive and shouldn't carry warning styling.

```html
<div class="settings-section">
  <h3>Help Guidance</h3>
  <div class="setting-item">
    <div class="setting-label">
      <span class="setting-name">Reset help guidance</span>
      <span class="setting-description">Show the first-use tips again next time you use each tool.</span>
    </div>
    <button id="reset-help-guidance-btn" class="btn-secondary">Reset</button>
  </div>
</div>
```

Handler follows the existing confirm→act→alert→re-render sequence (`settingsMode.js:786-816`), using `showConfirmDialog`/`showAlertDialog` (already imported at line 19) — not native `confirm()`/`alert()`:

```js
const resetHelpBtn = container.querySelector("#reset-help-guidance-btn");
resetHelpBtn?.addEventListener("click", async () => {
  const confirmed = await showConfirmDialog(
    "Reset help guidance",
    "This will show the first-use tips again the next time you use each tool.",
    "Reset",
    "btn-secondary",
  );
  if (!confirmed) return;
  resetAllHelp();
  await showAlertDialog("Done", "Help guidance has been reset.");
  await renderSettings(container);
});
```

Add `import { resetAllHelp } from "../modules/helpGuidance.js";` to `settingsMode.js`.

Since `settingsMode.js` is a single file shared by native and NC builds (NC divergence happens one layer down via the Vite alias on `storage.js`, not in this file), this row ships identically on all platforms with no duplication.

## Phased rollout

**Phase 0 — Foundation.** Add `helpGuidance.js` + unit tests (localStorage mock, per-ID isolation, reset-all clears exactly the known set). *Exit: module fully tested in isolation; no call sites wired; app behavior unchanged.*

**Phase 1 — Tour component.** Add `HelpOverlay.js` (`startHelpTour`, arrow/callout positioning, Next/Previous/Skip, resize/reposition handling) + CSS. English strings only (hardcoded), no i18n yet. Build and manually test against a synthetic multi-step array first (e.g. a temporary devtools-triggered 3-step tour over arbitrary DOM elements) so the stepping/positioning/resize logic is proven before any real trigger depends on it. Verify: renders near target, arrow tracks correctly, Next/Previous/Skip behave, resize/orientation repositions without drift, reads legibly on a narrow viewport, resuming mid-tour via `getTourStep` works after a simulated reload. *Exit: tour component works standalone against synthetic steps, not yet wired to any real trigger.*

**Phase 2 — Settings reset row.** Add the Settings section + handler. This can be exercised (and QA'd) even before real triggers exist. *Exit: button resets stored flags; verified on native + NC.*

**Phase 3 — Mode triggers (2–6).** Wire the `onModeChange` callback hook. *Exit: each of the 5 modes shows its overlay exactly once per device; stylus auto-switch confirmed NOT to trigger the Draw overlay; drawing/panning/erasing/lasso behavior verified unchanged (regression check).*

**Phase 4 — First-note-open trigger (1).** Wire `index.js:57`, building the 7-step array from the toolbar's `#nc-tool-*` / Options / Add DOM IDs. *Exit: the 7-step tour appears on the very first note ever opened on a device, steps through all 7 controls with working Next/Previous/Skip, resumes correctly if interrupted mid-tour (e.g. app closed on step 3, reopened — resumes at step 3 rather than restarting or being skipped), and does not appear on subsequent note opens once completed or skipped.*

**Phase 5 — First-image trigger (7).** Wire `insertImage()`. *Exit: overlay appears once after first successful image insert; not on PDF insert or later image inserts.*

**Phase 6 — Mark-as-Task trigger (8).** Wire `TextEditorLayer.js:334` (+ fallback listener). *Exit: overlay appears once on first "Mark as Task" use, independent of the Text-mode overlay from Phase 3.*

**Phase 7 — Localization.** Once all English copy from Phases 1–6 is final and stable, move strings into i18n. Add a new top-level `helpOverlay` namespace (sibling of `toolbar`/`settings`) to all 9 locale files under `src/i18n/locales/`:

```
helpOverlay.dismissBtn
helpOverlay.{firstNote,pan,draw,text,eraser,lasso,firstImage,markAsTask}.title
helpOverlay.{...}.body
```

`.title` keys are auto-treated as compact by `src/i18n/locales.test.js` (line 84, any key ending `.title`); `.body` keys are full sentences and should **not** be added to `COMPACT_UI_SECTIONS` — they fall under the default `MAX_RATIO`, appropriate for prose. `locales.test.js` enforces key parity across all locales, so a forgotten locale fails CI rather than silently degrading. Also localize the Settings row strings and swap `HelpOverlay.js`/hook-site calls from hardcoded strings to `t("helpOverlay.X.title")` / `.body`. *Exit: all locale files pass `locales.test.js`; spot-check German (has an existing precedent issue with accessibility labels per the QA report, so double-check `t()` is actually wired, not left hardcoded).*

**Suggested commit boundaries:** one commit per phase, each independently revertable/shippable — notably Phase 2 (Settings reset) is useful standalone infrastructure even before Phase 3+ triggers exist.

## Verification

- Phase 0: run the new unit tests for `helpGuidance.js`, including step-index resume/reset behavior for `FIRST_NOTE`.
- Phase 1: manual test against synthetic steps — arrow tracking, Next/Previous/Skip, resize/orientation repositioning, narrow-viewport font legibility and clamping, mid-tour resume after simulated reload; confirm via devtools that the overlay layer element is absent from the DOM entirely when no tour is active (not just hidden via CSS) — this is the core regression-risk guarantee and should be checked directly, not assumed.
- Phase 3 (regression check): exercise Pan/Draw/Text/Eraser/Lasso drawing behavior before/after — strokes, stylus-to-draw auto-switch mid-touch session, eraser modes — to confirm zero behavior change beyond the new tour, both while a tour is showing and (primarily) in the normal no-tour state.
- Phase 4 (regression check): resize/rotate the window mid-tour (step 2 or 3 of the 7) and confirm the callout/arrow track the correct button rather than drifting or pointing at a stale position.
- Each phase: manual pass on native Windows build; Android (touch + stylus if available) is the platform where the stylus-auto-switch exclusion (Phase 3) and touch-target arrow accuracy most need verifying; NC web build to confirm the shared Settings row and localStorage-based flags behave identically there.
- Phase 7: `locales.test.js` must pass for all 9 locales.
