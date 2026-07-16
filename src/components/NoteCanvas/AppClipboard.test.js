/**
 * src/components/NoteCanvas/AppClipboard.test.js
 * AppClipboard is a stateful singleton; each test resets it via
 * vi.resetModules() + dynamic import so state doesn't leak between tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let AppClipboard;

beforeEach(async () => {
  vi.resetModules();
  ({ AppClipboard } = await import("./AppClipboard.js"));
  navigator.clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("initial state", () => {
  it("is empty before anything is copied", () => {
    expect(AppClipboard.isEmpty()).toBe(true);
    expect(AppClipboard.paste()).toBeNull();
  });
});

describe("copy / paste round trip", () => {
  it("stores and returns strokes with bounds", () => {
    const strokes = [{ id: "s1" }];
    const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    AppClipboard.copy("strokes", strokes, bounds);

    expect(AppClipboard.isEmpty()).toBe(false);
    expect(AppClipboard.paste()).toEqual({ type: "strokes", data: strokes, bounds });
  });

  it("stores and returns an image descriptor", () => {
    const image = { fileId: "f1", width: 100, height: 50 };
    AppClipboard.copy("image", image);
    expect(AppClipboard.paste()).toEqual({ type: "image", data: image, bounds: null });
  });

  it("overwrites previous content on a new copy", () => {
    AppClipboard.copy("strokes", [{ id: "s1" }], { minX: 0, minY: 0, maxX: 1, maxY: 1 });
    AppClipboard.copy("image", { fileId: "f2" });
    expect(AppClipboard.paste()).toEqual({ type: "image", data: { fileId: "f2" }, bounds: null });
  });
});

describe("copying text", () => {
  it("writes the plain-text version to the system clipboard", () => {
    AppClipboard.copy("text", "<p>Hello <b>world</b></p>");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Hello world");
  });

  it("stores the original HTML in the in-app clipboard, not the plain text", () => {
    AppClipboard.copy("text", "<p>Hello <b>world</b></p>");
    expect(AppClipboard.paste().data).toBe("<p>Hello <b>world</b></p>");
  });

  it("does not throw when the system clipboard write is rejected", async () => {
    navigator.clipboard.writeText = vi.fn().mockRejectedValue(new Error("not focused"));
    expect(() => AppClipboard.copy("text", "<p>hi</p>")).not.toThrow();
    // Let the rejection's .catch() handler run so it doesn't surface as an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not write to the system clipboard for non-text types", () => {
    AppClipboard.copy("strokes", [{ id: "s1" }], { minX: 0, minY: 0, maxX: 1, maxY: 1 });
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
});

describe("canPasteInMode", () => {
  it("returns false when clipboard is empty, regardless of mode", () => {
    expect(AppClipboard.canPasteInMode("draw")).toBe(false);
    expect(AppClipboard.canPasteInMode("text")).toBe(false);
  });

  it("in text mode, allows pasting text or image but not strokes", () => {
    AppClipboard.copy("text", "<p>hi</p>");
    expect(AppClipboard.canPasteInMode("text")).toBe(true);

    AppClipboard.copy("image", { fileId: "f1" });
    expect(AppClipboard.canPasteInMode("text")).toBe(true);

    AppClipboard.copy("strokes", [{ id: "s1" }], { minX: 0, minY: 0, maxX: 1, maxY: 1 });
    expect(AppClipboard.canPasteInMode("text")).toBe(false);
  });

  it("in canvas modes (pan/draw/eraser/lasso), allows strokes or image but not text", () => {
    AppClipboard.copy("strokes", [{ id: "s1" }], { minX: 0, minY: 0, maxX: 1, maxY: 1 });
    for (const mode of ["pan", "draw", "eraser", "lasso"]) {
      expect(AppClipboard.canPasteInMode(mode)).toBe(true);
    }

    AppClipboard.copy("image", { fileId: "f1" });
    expect(AppClipboard.canPasteInMode("draw")).toBe(true);

    AppClipboard.copy("text", "<p>hi</p>");
    expect(AppClipboard.canPasteInMode("draw")).toBe(false);
  });
});
