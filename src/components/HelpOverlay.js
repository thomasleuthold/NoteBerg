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
const TAIL_HALF = 13; // half the tail's base width, px
const TAIL_LENGTH = 15; // how far the tail pokes out from the callout body, px
const BUBBLE_RADIUS = 12; // corner radius, px — matches --radius-lg (0.75rem @ 16px root)
const SVG_NS = "http://www.w3.org/2000/svg";

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

  // The callout is one continuous speech-bubble shape: an SVG path (rounded
  // body + a triangular tail on one edge) painted behind a plain content div.
  // One path == one stroke, so the tail is never visually separate from the
  // box (see buildBubblePath).
  const callout = document.createElement("div");
  callout.className = "help-overlay__callout";

  const bubbleBg = document.createElementNS(SVG_NS, "svg");
  bubbleBg.setAttribute("class", "help-overlay__bubble-bg");
  const bubblePath = document.createElementNS(SVG_NS, "path");
  bubbleBg.appendChild(bubblePath);
  callout.appendChild(bubbleBg);

  const content = document.createElement("div");
  content.className = "help-overlay__content";
  callout.appendChild(content);

  layer.appendChild(callout);

  const state = { id, steps, index, layer, callout, bubbleBg, bubblePath, content, labels };
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
  const { steps, index, content, labels } = state;
  const step = steps[index];
  const total = steps.length;
  const isLast = index === total - 1;

  content.innerHTML = "";

  const title = document.createElement("h3");
  title.className = "help-overlay__title";
  title.textContent = step.title;
  content.appendChild(title);

  const body = document.createElement("p");
  body.className = "help-overlay__body";
  body.textContent = step.body;
  content.appendChild(body);

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

  content.appendChild(footer);

  positionStep(state);
}

function goTo(state, nextIndex) {
  state.index = nextIndex;
  setTourStep(state.id, nextIndex);
  renderStep(state);
}

/**
 * Position the callout near the current step's target and point its tail at
 * it. Read-only against the target element. Falls back to a centered callout
 * with no tail if the target is missing or off-screen.
 */
function positionStep(state) {
  const { steps, index, callout, content } = state;
  const target = steps[index]?.target;

  // `content` (not `callout`) carries the visible padding/box — the callout
  // wrapper is sized to match it exactly, so it's the right box to measure.
  const cw = content.offsetWidth;
  const ch = content.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const clampLeft = (left) => Math.max(VIEWPORT_MARGIN, Math.min(left, vw - cw - VIEWPORT_MARGIN));
  const clampTop = (top) => Math.max(VIEWPORT_MARGIN, Math.min(top, vh - ch - VIEWPORT_MARGIN));

  const rect =
    target && typeof target.getBoundingClientRect === "function"
      ? target.getBoundingClientRect()
      : null;

  // No usable target → center the callout, plain rounded-rect (no tail).
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    callout.style.left = `${clampLeft((vw - cw) / 2)}px`;
    callout.style.top = `${clampTop((vh - ch) / 2)}px`;
    setBubblePath(state, cw, ch, null);
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

  // The tail sits on the edge facing the target: callout below → tail on top
  // edge (points up), etc. Its position along that edge tracks the target's
  // center, clamped so the tail's base stays clear of the rounded corners.
  const side = { below: "top", above: "bottom", right: "left", left: "right" }[placement];
  let tailPos;
  if (side === "top" || side === "bottom") {
    tailPos = Math.max(
      BUBBLE_RADIUS + TAIL_HALF,
      Math.min(targetCX - left, cw - BUBBLE_RADIUS - TAIL_HALF),
    );
  } else {
    tailPos = Math.max(
      BUBBLE_RADIUS + TAIL_HALF,
      Math.min(targetCY - top, ch - BUBBLE_RADIUS - TAIL_HALF),
    );
  }

  setBubblePath(state, cw, ch, { side, tailPos });
}

/** Build the single continuous speech-bubble outline and apply it to the SVG. */
function setBubblePath(state, cw, ch, tail) {
  const { bubbleBg, bubblePath } = state;
  const pad = TAIL_LENGTH; // extra SVG canvas so the tail can poke outside the body rect
  bubbleBg.setAttribute("width", cw + pad * 2);
  bubbleBg.setAttribute("height", ch + pad * 2);
  bubbleBg.style.left = `${-pad}px`;
  bubbleBg.style.top = `${-pad}px`;
  // Body rect drawn at a (pad, pad) offset within the padded SVG canvas.
  bubblePath.setAttribute("d", buildBubblePath(cw, ch, BUBBLE_RADIUS, pad, tail));
}

/**
 * Build an SVG path for a rounded rect of size cw x ch, offset by `off` into
 * the SVG canvas, with one edge optionally interrupted by a triangular tail
 * (`{side, tailPos}`, tailPos measured along that edge from the rect's own
 * top/left corner). Returns one continuous closed path — body and tail are
 * literally the same outline, so there is no seam where they meet.
 */
function buildBubblePath(cw, ch, r, off, tail) {
  const x0 = off;
  const y0 = off;
  const x1 = off + cw;
  const y1 = off + ch;

  // Each corner is a simple 90° arc; edges are built as line commands, with
  // the tail (if it's on that edge) spliced in as two extra points.
  const edge = (side, from, to) => {
    if (!tail || tail.side !== side) return `L ${to.x} ${to.y}`;
    const t = off + tail.tailPos;
    if (side === "top" || side === "bottom") {
      const apex = side === "top" ? y0 - TAIL_LENGTH : y1 + TAIL_LENGTH;
      const dir = from.x < to.x ? 1 : -1;
      return (
        `L ${t - dir * TAIL_HALF} ${from.y} ` +
        `L ${t} ${apex} ` +
        `L ${t + dir * TAIL_HALF} ${from.y} ` +
        `L ${to.x} ${to.y}`
      );
    }
    const apex = side === "left" ? x0 - TAIL_LENGTH : x1 + TAIL_LENGTH;
    const dir = from.y < to.y ? 1 : -1;
    return (
      `L ${from.x} ${t - dir * TAIL_HALF} ` +
      `L ${apex} ${t} ` +
      `L ${from.x} ${t + dir * TAIL_HALF} ` +
      `L ${to.x} ${to.y}`
    );
  };

  return [
    `M ${x0 + r} ${y0}`,
    edge("top", { x: x0 + r, y: y0 }, { x: x1 - r, y: y0 }),
    `A ${r} ${r} 0 0 1 ${x1} ${y0 + r}`,
    edge("right", { x: x1, y: y0 + r }, { x: x1, y: y1 - r }),
    `A ${r} ${r} 0 0 1 ${x1 - r} ${y1}`,
    edge("bottom", { x: x1 - r, y: y1 }, { x: x0 + r, y: y1 }),
    `A ${r} ${r} 0 0 1 ${x0} ${y1 - r}`,
    edge("left", { x: x0, y: y1 - r }, { x: x0, y: y0 + r }),
    `A ${r} ${r} 0 0 1 ${x0 + r} ${y0}`,
    "Z",
  ].join(" ");
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
