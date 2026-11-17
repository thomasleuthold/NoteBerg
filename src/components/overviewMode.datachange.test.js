// src/components/overviewMode.datachange.test.js
// A sync saves its notes one by one and each save announces `datachange`. The
// overview redraws once per burst (not once per note), and a long burst still
// redraws now and then.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../i18n/index.js", () => ({ t: (key) => key }));
vi.mock("../modules/pdfManager.js", () => ({ extractPdfText: vi.fn() }));
vi.mock("../modules/router.js", () => ({ navigateTo: vi.fn() }));
vi.mock("../modules/displayPrefs.js", () => ({ getCardSize: () => "medium" }));
vi.mock("../utils/icons.js", () => ({ getIcon: vi.fn(() => "") }));
vi.mock("../utils/noteRenderer.js", () => ({
  drawStroke: vi.fn(),
  getStrokeBounds: vi.fn(),
  getThemePalette: vi.fn(),
  renderNotePreview: vi.fn(),
  renderNoteSnapshot: vi.fn(),
}));
const getAllNotebooks = vi.fn(async () => []);
vi.mock("../modules/storage.js", () => ({
  copyNote: vi.fn(),
  deleteNote: vi.fn(),
  deleteNotebook: vi.fn(),
  getAllNotebooks: () => getAllNotebooks(),
  getAllNotes: vi.fn(async () => []),
  getDeletedNotebooks: vi.fn(async () => []),
  getDeletedNotes: vi.fn(async () => []),
  getNote: vi.fn(async () => null),
  getNoteIndex: vi.fn(async () => null),
  getNotebook: vi.fn(async () => null),
  getNotesByNotebook: vi.fn(async () => []),
  getQuickNotes: vi.fn(async () => []),
  getSetting: vi.fn(),
  moveNote: vi.fn(),
  purgeNote: vi.fn(),
  purgeNotebook: vi.fn(),
  restoreNote: vi.fn(),
  restoreNotebook: vi.fn(),
}));
vi.mock("./modals.js", () => ({
  showAlertDialog: vi.fn(),
  showConfirmDialog: vi.fn(),
  showEditNotebookModal: vi.fn(),
  showEditNoteModal: vi.fn(),
  showMoveCopyDialog: vi.fn(),
}));
vi.mock("../modules/sharing/availability.js", () => ({
  isSharingAvailable: vi.fn(async () => false),
}));
vi.mock("../modules/sharing/ownerShares.js", () => ({
  ensureOwnerShares: vi.fn(async () => false),
  getRecipientCount: vi.fn(() => 0),
}));
vi.mock("./shareDialog.js", () => ({ showShareDialog: vi.fn() }));
vi.mock("../modules/sharing/shareActions.js", () => ({
  discardStrandedChanges: vi.fn(),
  dismissEndedShare: vi.fn(),
  hasUnsyncedChanges: vi.fn(async () => false),
  leaveSharedNotebook: vi.fn(),
  acceptInvitation: vi.fn(),
  declineInvitation: vi.fn(),
}));

const announce = () => window.dispatchEvent(new CustomEvent("datachange"));
// Lets the render that a due timer started run to its end
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeAll(async () => {
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  const container = document.createElement("div");
  container.id = "overview-content";
  // jsdom has no layout: "visible" is a non-null offsetParent
  Object.defineProperty(container, "offsetParent", { get: () => document.body });
  document.body.appendChild(container);
  const { initOverview } = await import("./overviewMode.js");
  initOverview();
});

beforeEach(() => {
  vi.useFakeTimers();
  getAllNotebooks.mockClear();
});

afterEach(async () => {
  await vi.runAllTimersAsync();
  vi.useRealTimers();
});

describe("the overview on a burst of data changes", () => {
  it("redraws once, after the burst has quieted down", async () => {
    for (let i = 0; i < 20; i++) {
      announce();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(getAllNotebooks).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    await settle();
    expect(getAllNotebooks).toHaveBeenCalledTimes(1);
  });

  it("still redraws during a burst that does not stop", async () => {
    for (let i = 0; i < 50; i++) {
      announce();
      await vi.advanceTimersByTimeAsync(200);
    }
    // 10 s of one change every 200 ms: a redraw at least every 3 s
    expect(getAllNotebooks.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(getAllNotebooks.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("redraws a single change as soon as the wait is over", async () => {
    announce();
    await vi.advanceTimersByTimeAsync(499);
    expect(getAllNotebooks).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(getAllNotebooks).toHaveBeenCalledTimes(1);
  });
});
