/**
 * HelpOverlay — first-use guided tour, one anchored callout at a time.
 *
 * A single component used by all help triggers, so a 1-step callout and the
 * 7-step first-note tour share identical visuals and interaction.
 *
 * Regression-risk containment (see plan): all tour UI lives in one full-viewport
 * layer appended to <body> and sitting above every other layer via z-index. The
 * layer is either MOUNTED (a tour is running) or ENTIRELY ABSENT from the DOM.
 * `startHelpTour` creates and appends it; finishing/skipping removes it
 * completely. No DOM node or listener from this feature exists outside an active
 * tour, so it cannot affect drawing/toolbar/NC chrome the rest of the time. The
 * layer only ever READS target elements' getBoundingClientRect() to position
 * itself — it never writes to them — so a positioning bug can at worst misplace
 * this tour's own arrow.
 */

import "./HelpOverlay.css";
import { getTourStep, hasSeenHelp, markHelpSeen, setTourStep } from "../modules/helpGuidance.js";

// Only one tour can be on screen at a time.
let activeTour = null;

const CALLOUT_GAP = 16; // px between target and callout
const VIEWPORT_MARGIN = 12; // keep callout this far from the viewport edge
const ARROW_HALF = 7; // half the arrow square's side (matches CSS 14px)

/**
 * Start (or resume) a help tour.
 *
 * @param {string} id one of HELP_IDS
 * @param {Array<{target: HTMLElement|null, title: string, body: string}>} steps
 * @param {object} [opts]
 * @param {string} [opts.dismissLabel] label for the final button (default "Got it")
 * @param {string} [opts.nextLabel]
 * @param {string} [opts.prevLabel]
 * @param {string} [opts.skipLabel]
 * @param {(current:number,total:number)=>string} [opts.progressLabel]
 */
export function startHelpTour(id, steps, opts = {}) {
  // Already seen on this device → nothing mounted, single localStorage read.
  if (hasSeenHelp(id)) return;
  // Never stack tours; if one is already running, ignore the new request.
  if (activeTour) return;
  if (!Array.isArray(steps) || steps.length === 0) return;

  const labels = {
    dismiss: opts.dismissLabel || "Got it",
    next: opts.nextLabel || "Next",
    prev: opts.prevLabel || "Back",
    skip: opts.skipLabel || "Skip",
    progress: opts.progressLabel || ((cur, total) => `${cur} / ${total}`),
  };

  // Resume from the stored step for multi-step tours; clamp in case the tour
  // definition shrank since the step was saved.
  const index = Math.min(getTourStep(id), steps.length - 1);

  const layer = document.createElement("div");
  layer.className = "help-overlay";

  const backdrop = document.createElement("div");
  backdrop.className = "help-overlay__backdrop";
  layer.appendChild(backdrop);

  const arrow = document.createElement("div");
  arrow.className = "help-overlay__arrow";
  layer.appendChild(arrow);

  const callout = document.createElement("div");
  callout.className = "help-overlay__callout";
  layer.appendChild(callout);

  const state = { id, steps, index, layer, callout, arrow, labels };
  activeTour = state;

  const onResize = () => positionStep(state);
  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      finish(state); // ESC == Skip
    }
  };
  state._onResize = onResize;
  state._onKeyDown = onKeyDown;

  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);
  // Toolbar dialogs/animation can shift the target after mount; a couple of
  // deferred re-positions catch that without a persistent rAF loop.
  window.addEventListener("keydown", onKeyDown, true);

  document.body.appendChild(layer);
  renderStep(state);

  // Re-measure once layout has settled (fonts, toolbar transitions).
  requestAnimationFrame(() => positionStep(state));
  setTimeout(() => positionStep(state), 250);
}

/** Whether a tour is currently on screen. */
export function isHelpTourActive() {
  return activeTour !== null;
}

/** Reposition the active tour, e.g. after an external layout change. */
export function repositionActiveTour() {
  if (activeTour) positionStep(activeTour);
}

function renderStep(state) {
  const { steps, index, callout, labels } = state;
  const step = steps[index];
  const total = steps.length;
  const isLast = index === total - 1;

  callout.innerHTML = "";

  const title = document.createElement("h3");
  title.className = "help-overlay__title";
  title.textContent = step.title;
  callout.appendChild(title);

  const body = document.createElement("p");
  body.className = "help-overlay__body";
  body.textContent = step.body;
  callout.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "help-overlay__footer";

  if (total > 1) {
    const progress = document.createElement("span");
    progress.className = "help-overlay__progress";
    progress.textContent = labels.progress(index + 1, total);
    footer.appendChild(progress);
  }

  // Skip — always available, ends the whole tour.
  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = "help-overlay__btn help-overlay__btn--skip";
  skipBtn.textContent = labels.skip;
  skipBtn.addEventListener("click", () => finish(state));
  footer.appendChild(skipBtn);

  // Back — hidden on the first step.
  if (index > 0) {
    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "help-overlay__btn";
    prevBtn.textContent = labels.prev;
    prevBtn.addEventListener("click", () => goTo(state, index - 1));
    footer.appendChild(prevBtn);
  }

  // Next / Got it.
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "help-overlay__btn help-overlay__btn--primary";
  nextBtn.textContent = isLast ? labels.dismiss : labels.next;
  nextBtn.addEventListener("click", () => {
    if (isLast) finish(state);
    else goTo(state, index + 1);
  });
  footer.appendChild(nextBtn);

  callout.appendChild(footer);

  positionStep(state);
}

function goTo(state, nextIndex) {
  state.index = nextIndex;
  setTourStep(state.id, nextIndex);
  renderStep(state);
}

/**
 * Position the callout near the current step's target and point the arrow at it.
 * Read-only against the target element. Falls back to a centered callout with a
 * hidden arrow if the target is missing or off-screen.
 */
function positionStep(state) {
  const { steps, index, callout, arrow } = state;
  const target = steps[index]?.target;

  const cw = callout.offsetWidth;
  const ch = callout.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const clampLeft = (left) => Math.max(VIEWPORT_MARGIN, Math.min(left, vw - cw - VIEWPORT_MARGIN));
  const clampTop = (top) => Math.max(VIEWPORT_MARGIN, Math.min(top, vh - ch - VIEWPORT_MARGIN));

  const rect =
    target && typeof target.getBoundingClientRect === "function"
      ? target.getBoundingClientRect()
      : null;

  // No usable target → center the callout, hide the arrow.
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    callout.style.left = `${clampLeft((vw - cw) / 2)}px`;
    callout.style.top = `${clampTop((vh - ch) / 2)}px`;
    arrow.style.display = "none";
    return;
  }

  const targetCX = rect.left + rect.width / 2;
  const targetCY = rect.top + rect.height / 2;

  // Choose the side with the most room: below, above, right, or left.
  const spaceBelow = vh - rect.bottom;
  const spaceAbove = rect.top;
  const spaceRight = vw - rect.right;
  const spaceLeft = rect.left;

  let placement;
  if (spaceBelow >= ch + CALLOUT_GAP + VIEWPORT_MARGIN) placement = "below";
  else if (spaceAbove >= ch + CALLOUT_GAP + VIEWPORT_MARGIN) placement = "above";
  else if (spaceRight >= cw + CALLOUT_GAP + VIEWPORT_MARGIN) placement = "right";
  else if (spaceLeft >= cw + CALLOUT_GAP + VIEWPORT_MARGIN) placement = "left";
  else placement = spaceBelow >= spaceAbove ? "below" : "above";

  let left;
  let top;

  if (placement === "below" || placement === "above") {
    left = clampLeft(targetCX - cw / 2);
    top = placement === "below" ? rect.bottom + CALLOUT_GAP : rect.top - CALLOUT_GAP - ch;
    top = clampTop(top);
  } else {
    top = clampTop(targetCY - ch / 2);
    left = placement === "right" ? rect.right + CALLOUT_GAP : rect.left - CALLOUT_GAP - cw;
    left = clampLeft(left);
  }

  callout.style.left = `${left}px`;
  callout.style.top = `${top}px`;

  positionArrow(arrow, placement, { left, top, cw, ch }, { targetCX, targetCY });
}

function positionArrow(arrow, placement, callout, target) {
  arrow.style.display = "block";
  const { left, top, cw, ch } = callout;
  const { targetCX, targetCY } = target;

  let ax;
  let ay;

  if (placement === "below" || placement === "above") {
    // Arrow sits on the callout edge facing the target, aligned to target's X,
    // but clamped to stay within the callout's horizontal span.
    ax = Math.max(left + ARROW_HALF + 4, Math.min(targetCX, left + cw - ARROW_HALF - 4));
    ay = placement === "below" ? top : top + ch;
  } else {
    ay = Math.max(top + ARROW_HALF + 4, Math.min(targetCY, top + ch - ARROW_HALF - 4));
    ax = placement === "right" ? left : left + cw;
  }

  arrow.style.left = `${ax - ARROW_HALF}px`;
  arrow.style.top = `${ay - ARROW_HALF}px`;
}

/** End the tour: mark seen, remove all DOM + listeners. Idempotent. */
function finish(state) {
  if (activeTour !== state) return;
  markHelpSeen(state.id);
  window.removeEventListener("resize", state._onResize);
  window.removeEventListener("orientationchange", state._onResize);
  window.removeEventListener("keydown", state._onKeyDown, true);
  state.layer.remove();
  activeTour = null;
}
