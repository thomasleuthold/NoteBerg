/**
 * src/modules/helpGuidance.test.js
 *
 * helpGuidance is a thin persistence layer over localStorage. The design
 * requirements it must satisfy:
 *  - flags persist per-device (localStorage, not IndexedDB) so they work
 *    identically on native + NC builds;
 *  - each help ID is isolated — seeing one tour never marks another as seen;
 *  - multi-step tours track a resumable step index that is cleared on completion;
 *  - reset clears exactly the known set of help IDs and nothing else.
 *
 * jsdom provides a real localStorage, so no mock is needed — we assert against
 * actual stored keys, which also proves the exact key names other code relies on.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  getTourStep,
  HELP_IDS,
  hasSeenHelp,
  markHelpSeen,
  resetAllHelp,
  setTourStep,
} from "./helpGuidance.js";

beforeEach(() => {
  localStorage.clear();
});

describe("hasSeenHelp / markHelpSeen", () => {
  it("reports unseen for a fresh ID", () => {
    expect(hasSeenHelp(HELP_IDS.MODE_DRAW)).toBe(false);
  });

  it("reports seen after marking", () => {
    markHelpSeen(HELP_IDS.MODE_DRAW);
    expect(hasSeenHelp(HELP_IDS.MODE_DRAW)).toBe(true);
  });

  it("persists to localStorage (per-device, survives module re-read)", () => {
    markHelpSeen(HELP_IDS.MODE_DRAW);
    // A raw localStorage entry is what makes this work on the NC build.
    expect(localStorage.getItem("noteberg_help_seen_mode_draw")).toBe("1");
  });

  it("keeps each ID isolated — marking one does not mark another", () => {
    markHelpSeen(HELP_IDS.MODE_DRAW);
    expect(hasSeenHelp(HELP_IDS.MODE_DRAW)).toBe(true);
    expect(hasSeenHelp(HELP_IDS.MODE_ERASER)).toBe(false);
    expect(hasSeenHelp(HELP_IDS.FIRST_NOTE)).toBe(false);
  });
});

describe("multi-step tour resume", () => {
  it("starts at step 0 when never started", () => {
    expect(getTourStep(HELP_IDS.FIRST_NOTE)).toBe(0);
  });

  it("returns the stored step so an interrupted tour resumes", () => {
    setTourStep(HELP_IDS.FIRST_NOTE, 3);
    expect(getTourStep(HELP_IDS.FIRST_NOTE)).toBe(3);
  });

  it("clears the step index once the tour is marked seen", () => {
    setTourStep(HELP_IDS.FIRST_NOTE, 3);
    markHelpSeen(HELP_IDS.FIRST_NOTE);
    expect(getTourStep(HELP_IDS.FIRST_NOTE)).toBe(0);
    expect(hasSeenHelp(HELP_IDS.FIRST_NOTE)).toBe(true);
  });

  it("tolerates a corrupt (non-numeric) stored step by falling back to 0", () => {
    localStorage.setItem("noteberg_help_step_first_note", "not-a-number");
    expect(getTourStep(HELP_IDS.FIRST_NOTE)).toBe(0);
  });
});

describe("resetAllHelp", () => {
  it("clears every known help flag and step", () => {
    for (const id of Object.values(HELP_IDS)) {
      markHelpSeen(id);
    }
    setTourStep(HELP_IDS.FIRST_NOTE, 2);

    resetAllHelp();

    for (const id of Object.values(HELP_IDS)) {
      expect(hasSeenHelp(id)).toBe(false);
    }
    expect(getTourStep(HELP_IDS.FIRST_NOTE)).toBe(0);
  });

  it("does not touch unrelated localStorage keys", () => {
    localStorage.setItem("theme", "dark");
    localStorage.setItem("noteberg_webdav_initialized", "1");
    markHelpSeen(HELP_IDS.MODE_LASSO);

    resetAllHelp();

    expect(localStorage.getItem("theme")).toBe("dark");
    expect(localStorage.getItem("noteberg_webdav_initialized")).toBe("1");
    expect(hasSeenHelp(HELP_IDS.MODE_LASSO)).toBe(false);
  });
});
