/**
 * src/modules/pdfManager.test.js
 * Covers the real logic in pdfManager.js: vertical page-stack layout math,
 * document-proxy caching (incl. eviction on failure), outline flattening
 * with named-destination resolution, and text-extraction error fallback.
 * pdfjs-dist itself is mocked — we're testing our orchestration, not the
 * PDF parser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makePage(width, height, overrides = {}) {
  return {
    getViewport: vi.fn(() => ({ width, height })),
    getTextContent: vi.fn().mockResolvedValue({ items: [] }),
    ...overrides,
  };
}

function makePdfDocument({ numPages = 1, pages = [], outline = null, destinations = {} } = {}) {
  const pageMap = new Map(pages.map((p, i) => [i + 1, p]));
  return {
    numPages,
    getPage: vi.fn((i) => Promise.resolve(pageMap.get(i) ?? makePage(100, 100))),
    getOutline: vi.fn().mockResolvedValue(outline),
    getDestination: vi.fn((name) => Promise.resolve(destinations[name] ?? null)),
    getPageIndex: vi.fn((ref) => Promise.resolve(ref?.pageIndex ?? 0)),
  };
}

const getDocument = vi.fn();
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: (...args) => getDocument(...args),
}));

const generateId = vi.fn();
const getFile = vi.fn();
const saveFile = vi.fn();
vi.mock("./storage.js", () => ({
  generateId: (...args) => generateId(...args),
  getFile: (...args) => getFile(...args),
  saveFile: (...args) => saveFile(...args),
}));

let pdfManager;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn(() => "blob:mock");
  let idCounter = 0;
  generateId.mockImplementation(() => `id-${++idCounter}`);
  pdfManager = await import("./pdfManager.js");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("importPdf", () => {
  it("saves the file, builds a vertical page stack, and reports progress", async () => {
    const file = { arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)) };
    saveFile.mockResolvedValue("file-1");
    const pdfDoc = makePdfDocument({
      numPages: 2,
      pages: [makePage(600, 800), makePage(600, 400)],
    });
    getDocument.mockReturnValue({ promise: Promise.resolve(pdfDoc) });

    const onProgress = vi.fn();
    const result = await pdfManager.importPdf(file, onProgress);

    expect(result.fileId).toBe("file-1");
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]).toMatchObject({ pageIndex: 1, x: 0, y: 0, width: 600, height: 800 });
    expect(result.pages[1]).toMatchObject({ pageIndex: 2, x: 0, y: 800, width: 600, height: 400 });
    expect(result.totalHeight).toBe(1200);
    expect(onProgress).toHaveBeenCalledWith("upload", 1, 1);
    expect(onProgress).toHaveBeenCalledWith("pages", 1, 2);
    expect(onProgress).toHaveBeenCalledWith("pages", 2, 2);
  });

  it("assigns each page a unique id and type pdf-page", async () => {
    const file = { arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)) };
    saveFile.mockResolvedValue("file-1");
    const pdfDoc = makePdfDocument({
      numPages: 2,
      pages: [makePage(100, 100), makePage(100, 100)],
    });
    getDocument.mockReturnValue({ promise: Promise.resolve(pdfDoc) });

    const result = await pdfManager.importPdf(file);
    expect(result.pages[0].id).not.toBe(result.pages[1].id);
    expect(result.pages.every((p) => p.type === "pdf-page")).toBe(true);
  });
});

describe("loadPdfPage / document caching", () => {
  it("loads a page via a cached document proxy fetched from storage", async () => {
    const blob = { arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)) };
    getFile.mockResolvedValue(blob);
    const page = makePage(100, 100);
    const pdfDoc = makePdfDocument({ numPages: 1, pages: [page] });
    getDocument.mockReturnValue({ promise: Promise.resolve(pdfDoc) });

    const result = await pdfManager.loadPdfPage("file-1", 1);
    expect(result).toBe(page);
  });

  it("reuses the cached document on a second call instead of refetching", async () => {
    getFile.mockResolvedValue({ arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)) });
    const pdfDoc = makePdfDocument({ numPages: 1, pages: [makePage(100, 100)] });
    getDocument.mockReturnValue({ promise: Promise.resolve(pdfDoc) });

    await pdfManager.loadPdfPage("file-1", 1);
    await pdfManager.loadPdfPage("file-1", 1);

    expect(getFile).toHaveBeenCalledTimes(1);
    expect(getDocument).toHaveBeenCalledTimes(1);
  });

  it("throws when the underlying file is missing from storage", async () => {
    getFile.mockResolvedValue(null);
    await expect(pdfManager.loadPdfPage("missing-file", 1)).rejects.toThrow(
      "PDF file not found: missing-file",
    );
  });

  it("evicts a failed load from the cache so a retry can succeed", async () => {
    getFile.mockResolvedValueOnce(null); // first call fails
    await expect(pdfManager.loadPdfPage("file-1", 1)).rejects.toThrow();

    // Let the rejection's .catch() handler (which evicts the cache entry) run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    getFile.mockResolvedValue({ arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)) });
    const pdfDoc = makePdfDocument({ numPages: 1, pages: [makePage(100, 100)] });
    getDocument.mockReturnValue({ promise: Promise.resolve(pdfDoc) });

    const page = await pdfManager.loadPdfPage("file-1", 1);
    expect(page).toBeDefined();
    expect(getFile).toHaveBeenCalledTimes(2);
  });
});

describe("getPdfOutline", () => {
  beforeEach(() => {
    getFile.mockResolvedValue({ arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)) });
  });

  it("returns an empty array when the PDF has no outline", async () => {
    const pdfDoc = makePdfDocument({ outline: [] });
    getDocument.mockReturnValue({ promise: Promise.resolve(pdfDoc) });
    expect(await pdfManager.getPdfOutline("file-1")).toEqual([]);
  });

  it("flattens a nested outline with array destinations", async () => {
    const outline = [
      {
        title: "Chapter 1",
        dest: [{ pageIndex: 0 }, { name: "XYZ" }, 0, 700, 0],
        items: [{ title: "Section 1.1", dest: [{ pageIndex: 1 }, { name: "XYZ" }, 0, 500, 0] }],
      },
    ];
    const pdfDoc = makePdfDocument({ outline });
    getDocument.mockReturnValue({ promise: Promise.resolve(pdfDoc) });

    const result = await pdfManager.getPdfOutline("file-1");

    expect(result).toEqual([
      { title: "Chapter 1", pageIndex: 1, destY: 700 },
      { title: "Section 1.1", pageIndex: 2, destY: 500 },
    ]);
  });

  it("resolves named (string) destinations before flattening", async () => {
    const outline = [{ title: "Named", dest: "namedDest" }];
    const pdfDoc = makePdfDocument({
      outline,
      destinations: { namedDest: [{ pageIndex: 3 }, { name: "XYZ" }, 0, null, 0] },
    });
    getDocument.mockReturnValue({ promise: Promise.resolve(pdfDoc) });

    const result = await pdfManager.getPdfOutline("file-1");
    expect(result).toEqual([{ title: "Named", pageIndex: 4, destY: null }]);
  });

  it("skips items whose destination cannot be resolved", async () => {
    const outline = [{ title: "Broken", dest: "missingDest" }];
    const pdfDoc = makePdfDocument({ outline, destinations: {} });
    getDocument.mockReturnValue({ promise: Promise.resolve(pdfDoc) });

    expect(await pdfManager.getPdfOutline("file-1")).toEqual([]);
  });

  it("returns an empty array instead of throwing when outline extraction fails", async () => {
    getDocument.mockReturnValue({ promise: Promise.reject(new Error("corrupt pdf")) });
    expect(await pdfManager.getPdfOutline("file-1")).toEqual([]);
  });
});

describe("extractPdfText", () => {
  beforeEach(() => {
    getFile.mockResolvedValue({ arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)) });
  });

  it("joins non-empty page text with newlines", async () => {
    const page1 = makePage(100, 100, {
      getTextContent: vi.fn().mockResolvedValue({ items: [{ str: "Hello" }, { str: "World" }] }),
    });
    const page2 = makePage(100, 100, {
      getTextContent: vi.fn().mockResolvedValue({ items: [{ str: "Second" }, { str: "page" }] }),
    });
    const pdfDoc = makePdfDocument({ numPages: 2, pages: [page1, page2] });
    getDocument.mockReturnValue({ promise: Promise.resolve(pdfDoc) });

    const text = await pdfManager.extractPdfText("file-1");
    expect(text).toBe("Hello World\nSecond page");
  });

  it("skips pages whose extracted text is only whitespace", async () => {
    const blankPage = makePage(100, 100, {
      getTextContent: vi.fn().mockResolvedValue({ items: [{ str: "   " }] }),
    });
    const realPage = makePage(100, 100, {
      getTextContent: vi.fn().mockResolvedValue({ items: [{ str: "Content" }] }),
    });
    const pdfDoc = makePdfDocument({ numPages: 2, pages: [blankPage, realPage] });
    getDocument.mockReturnValue({ promise: Promise.resolve(pdfDoc) });

    expect(await pdfManager.extractPdfText("file-1")).toBe("Content");
  });

  it("returns an empty string instead of throwing when extraction fails", async () => {
    getDocument.mockReturnValue({ promise: Promise.reject(new Error("corrupt pdf")) });
    expect(await pdfManager.extractPdfText("file-1")).toBe("");
  });
});
