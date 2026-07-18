/**
 * src/components/HelpOverlay.test.js
 *
 * The overlay's core design guarantees, exercised against real jsdom DOM:
 *  - the `.help-overlay` layer exists ONLY while a tour runs (mounted on start,
 *    entirely removed on finish/skip) — this is the regression-risk containment;
 *  - an already-seen tour mounts nothing at all;
 *  - stepping (Next/Back) walks the steps and persists a resumable index;
 *  - Skip/final-button/ESC all end the tour and mark it seen.
 *
 * We stub the CSS import (jsdom can't parse it) and getBoundingClientRect (jsdom
 * returns zeros), so positioning math runs without throwing; exact pixel
 * placement is a visual concern verified manually per the plan, not asserted here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./HelpOverlay.css", () => ({}));

import { HELP_IDS, hasSeenHelp, markHelpSeen } from "../modules/helpGuidance.js";
import { isHelpTourActive, startHelpTour } from "./HelpOverlay.js";

function makeTarget() {
  const el = document.createElement("button");
  el.getBoundingClientRect = () => ({
    left: 100,
    top: 100,
    right: 140,
    bottom: 140,
    width: 40,
    height: 40,
  });
  document.body.appendChild(el);
  return el;
}

function layer() {
  return document.querySelector(".help-overlay");
}
function callout() {
  return document.querySelector(".help-overlay__callout");
}
function buttonByText(text) {
  return [...document.querySelectorAll(".help-overlay__btn")].find((b) => b.textContent === text);
}

beforeEach(() => {
  // End any tour left running by a prior test (clears the module's in-memory
  // activeTour guard the same way a real ESC/Skip would), then reset storage/DOM.
  if (isHelpTourActive()) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  }
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("mount / unmount containment", () => {
  it("no layer exists before a tour starts", () => {
    expect(layer()).toBeNull();
    expect(isHelpTourActive()).toBe(false);
  });

  it("mounts exactly one layer while a tour runs", () => {
    startHelpTour(HELP_IDS.MODE_DRAW, [
      { target: makeTarget(), title: "Draw", body: "Draw stuff" },
    ]);
    expect(document.querySelectorAll(".help-overlay").length).toBe(1);
    expect(isHelpTourActive()).toBe(true);
  });

  it("removes the layer entirely on finish (not just hides it)", () => {
    startHelpTour(HELP_IDS.MODE_DRAW, [
      { target: makeTarget(), title: "Draw", body: "Draw stuff" },
    ]);
    buttonByText("Got it").click();
    expect(layer()).toBeNull();
    expect(isHelpTourActive()).toBe(false);
  });

  it("mounts nothing for an already-seen tour", () => {
    markHelpSeen(HELP_IDS.MODE_DRAW);
    startHelpTour(HELP_IDS.MODE_DRAW, [
      { target: makeTarget(), title: "Draw", body: "Draw stuff" },
    ]);
    expect(layer()).toBeNull();
    expect(isHelpTourActive()).toBe(false);
  });

  it("does not stack a second tour over an active one", () => {
    startHelpTour(HELP_IDS.MODE_DRAW, [{ target: makeTarget(), title: "Draw", body: "b" }]);
    startHelpTour(HELP_IDS.MODE_ERASER, [{ target: makeTarget(), title: "Eraser", body: "b" }]);
    expect(document.querySelectorAll(".help-overlay").length).toBe(1);
  });
});

describe("single-step tour", () => {
  it("shows the final button (not Next) and marks seen on dismiss", () => {
    startHelpTour(HELP_IDS.MODE_LASSO, [{ target: makeTarget(), title: "Lasso", body: "Select" }]);
    expect(buttonByText("Next")).toBeUndefined();
    expect(buttonByText("Back")).toBeUndefined();
    buttonByText("Got it").click();
    expect(hasSeenHelp(HELP_IDS.MODE_LASSO)).toBe(true);
  });
});

describe("multi-step tour", () => {
  const steps = () => [
    { target: makeTarget(), title: "One", body: "b1" },
    { target: makeTarget(), title: "Two", body: "b2" },
    { target: makeTarget(), title: "Three", body: "b3" },
  ];

  it("walks forward with Next and shows progress", () => {
    startHelpTour(HELP_IDS.FIRST_NOTE, steps());
    expect(callout().textContent).toContain("One");
    expect(callout().textContent).toContain("1 / 3");
    // First step has no Back.
    expect(buttonByText("Back")).toBeUndefined();

    buttonByText("Next").click();
    expect(callout().textContent).toContain("Two");
    expect(buttonByText("Back")).toBeDefined();

    buttonByText("Next").click();
    expect(callout().textContent).toContain("Three");
    // Last step: final button, no Next.
    expect(buttonByText("Next")).toBeUndefined();
    expect(buttonByText("Got it")).toBeDefined();
  });

  it("goes back with Back", () => {
    startHelpTour(HELP_IDS.FIRST_NOTE, steps());
    buttonByText("Next").click();
    buttonByText("Back").click();
    expect(callout().textContent).toContain("One");
  });

  it("persists the step so a re-start resumes mid-tour", async () => {
    startHelpTour(HELP_IDS.FIRST_NOTE, steps());
    buttonByText("Next").click(); // now on step 1 (index 1); index persisted
    // Simulate app close mid-tour: tear down without marking seen, and reset the
    // module so its in-memory activeTour guard clears (as a page reload would).
    document.querySelector(".help-overlay").remove();
    vi.resetModules();
    const fresh = await import("./HelpOverlay.js");

    fresh.startHelpTour(HELP_IDS.FIRST_NOTE, steps());
    // Resumes at step 2 ("Two"), not back at step 1.
    expect(callout().textContent).toContain("Two");
    expect(callout().textContent).toContain("2 / 3");
  });

  it("Skip ends the whole tour and marks it seen", () => {
    startHelpTour(HELP_IDS.FIRST_NOTE, steps());
    buttonByText("Next").click();
    buttonByText("Skip").click();
    expect(layer()).toBeNull();
    expect(hasSeenHelp(HELP_IDS.FIRST_NOTE)).toBe(true);
  });
});

describe("keyboard", () => {
  it("ESC ends the tour like Skip", () => {
    startHelpTour(HELP_IDS.MODE_TEXT, [{ target: makeTarget(), title: "Text", body: "b" }]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(layer()).toBeNull();
    expect(hasSeenHelp(HELP_IDS.MODE_TEXT)).toBe(true);
  });
});

describe("missing target", () => {
  it("still renders (centered) when target is null", () => {
    startHelpTour(HELP_IDS.MODE_PAN, [{ target: null, title: "Pan", body: "b" }]);
    expect(callout()).not.toBeNull();
    expect(callout().textContent).toContain("Pan");
  });
});
