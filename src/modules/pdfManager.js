import * as pdfjsLib from "pdfjs-dist";
// Inline the worker source as a blob URL so no HTTP request is made.
// ?url gets intercepted by SSO proxies (e.g. Yunohost); ?worker emits a separate
// asset that Vite wraps in a blob-of-blob which breaks Tauri's script-src CSP.
// ?raw inlines everything at build time; the Tauri CSP allows blob: in script-src.
import pdfjsWorkerSrc from "pdfjs-dist/build/pdf.worker.mjs?raw";
import { generateId, getFile, saveFile } from "./storage.js";

// Scanned PDFs need WASM decoders: JBig2/CCITT Fax and JPEG2000 (JPX).
// wasmUrl must be a directory prefix (trailing slash) — PDF.js appends the
// filename itself ("jbig2.wasm", "openjpeg.wasm", ...). The files live in
// public/pdfjs-wasm/ so they're copied verbatim (no hash) and reachable at a
// stable URL, and must be kept in step with the pdfjs-dist version on upgrade
// (source: node_modules/pdfjs-dist/wasm/).
//
// Both the .wasm decoders AND their *_nowasm_fallback.js counterparts are
// vendored. Missing a fallback is NOT safe: pdf.js reacts to an undecodable
// image by logging "getOperatorList - ignoring XObject" and returning an empty
// operator list, so the page renders as valid blank white with no exception for
// callers to catch. On a scanned book — where the JBig2/JPX image IS the page —
// that means silently blank pages. WasmImage#instantiateWasm falls back to
// #getJsModule() when the .wasm cannot be fetched, so the .js is the last line
// of defence whenever the wasm URL is unreachable (packaging slip, SSO proxy,
// CDN rule). The JBig2 fallback is additionally inlined into the worker at build
// time (see inlinePdfjsJbig2FallbackPlugin in vite.config.js) because its
// dynamic import() is blocked by the NC/Android CSP; the openjpeg one is not
// inlined, so it still relies on that import succeeding.
//
// Deliberately NOT vendored:
// - quickjs-eval.{js,wasm}: PDF form JavaScript, never referenced by the worker
//   build we ship.
// - qcms_bg.wasm: ICC colour correction. Fetched from wasmUrl (the same option
//   set below), so vendoring it alone would enable ICC — it is omitted because
//   it changes rendering of ICC-profiled PDFs, not because it is unreachable.
//   CMYK is a separate switch again: it needs the distinct iccUrl option, which
//   points at a different file (CGATS001Compat-v2-micro.icc).
// Resolved against this module's own URL rather than import.meta.env.BASE_URL:
// the NC build uses a relative base, and BASE_URL ('./') would resolve against
// the document URL, which differs per route. import.meta.url is always correct.
// public/ assets land next to the js/ output dir, hence the '../' hop.
const pdfWasmDirUrl = new URL("../pdfjs-wasm/", import.meta.url).href;

const _workerBlob = new Blob([pdfjsWorkerSrc], { type: "text/javascript" });
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(_workerBlob);

/**
 * Imports a PDF file, saves it to storage, and extracts page metadata.
 * @param {File} file - The PDF file object from input
 * @returns {Promise<{
 *   fileId: string,
 *   pages: Array<{
 *     id: string,
 *     type: 'pdf-page',
 *     fileId: string,
 *     pageIndex: number,
 *     width: number,
 *     height: number,
 *     x: number,
 *     y: number
 *   }>,
 *   totalHeight: number
 * }>}
 */
export async function importPdf(file, onProgress) {
  // 1. Save the raw file to IndexedDB
  const fileId = await saveFile(file);
  onProgress?.("upload", 1, 1);

  // 2. Load the PDF to get dimensions
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer, wasmUrl: pdfWasmDirUrl });
  const pdfDocument = await loadingTask.promise;

  const pages = [];
  let currentY = 0;

  // 3. Iterate through pages to build the vertical stack
  for (let i = 1; i <= pdfDocument.numPages; i++) {
    const page = await pdfDocument.getPage(i);
    const viewport = page.getViewport({ scale: 1.0 });

    pages.push({
      id: generateId(),
      type: "pdf-page",
      fileId: fileId,
      pageIndex: i,
      width: viewport.width,
      height: viewport.height,
      x: 0,
      y: currentY,
    });

    currentY += viewport.height;
    onProgress?.("pages", i, pdfDocument.numPages);
  }

  return {
    fileId,
    pages,
    totalHeight: currentY,
  };
}

// Cache for loaded PDF documents to avoid re-fetching/re-parsing
const documentCache = new Map();

/**
 * Retrieves a PDF document proxy, using cache if available.
 * @param {string} fileId
 * @returns {Promise<import('pdfjs-dist').PDFDocumentProxy>}
 */
async function getPdfDocument(fileId) {
  if (documentCache.has(fileId)) {
    return documentCache.get(fileId);
  }

  const loadingTaskPromise = (async () => {
    const blob = await getFile(fileId);
    if (!blob) {
      throw new Error(`PDF file not found: ${fileId}`);
    }
    const arrayBuffer = await blob.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer, wasmUrl: pdfWasmDirUrl });
    return loadingTask.promise;
  })();

  documentCache.set(fileId, loadingTaskPromise);
  // Remove failed entries so callers can retry (e.g. after sync completes)
  loadingTaskPromise.catch(() => documentCache.delete(fileId));
  return loadingTaskPromise;
}

/**
 * Loads a specific page from a stored PDF ID
 * @param {string} fileId - The ID of the stored PDF file
 * @param {number} pageIndex - 1-based page index
 * @returns {Promise<import('pdfjs-dist').PDFPageProxy>}
 */
export async function loadPdfPage(fileId, pageIndex) {
  const pdfDoc = await getPdfDocument(fileId);
  return pdfDoc.getPage(pageIndex);
}

/**
 * Extract all text from a stored PDF file.
 * @param {string} fileId - The ID of the stored PDF file
 * @returns {Promise<string>} - Combined text from all pages
 */
/**
 * Get the outline (table of contents) of a stored PDF.
 * @param {string} fileId - The ID of the stored PDF file
 * @returns {Promise<Array<{title: string, pageIndex: number, destY: number|null}>>} Flattened outline entries with 1-based page indices and optional Y position in PDF coords (top-down from page top)
 */
export async function getPdfOutline(fileId) {
  try {
    const pdfDoc = await getPdfDocument(fileId);
    const outline = await pdfDoc.getOutline();
    if (!outline || outline.length === 0) return [];

    const results = [];

    async function flatten(items) {
      for (const item of items) {
        if (item.dest) {
          let dest = item.dest;
          // dest can be a string (named destination) or an array
          if (typeof dest === "string") {
            dest = await pdfDoc.getDestination(dest);
          }
          if (dest && Array.isArray(dest)) {
            const pageIndex = await pdfDoc.getPageIndex(dest[0]);
            // dest format: [pageRef, {name}, left, top, zoom]
            // top is Y in PDF coords (from bottom), null means page top
            const destTop = dest.length > 3 ? dest[3] : null;
            results.push({
              title: item.title,
              pageIndex: pageIndex + 1,
              destY: destTop,
            });
          }
        }
        if (item.items && item.items.length > 0) {
          await flatten(item.items);
        }
      }
    }

    await flatten(outline);
    return results;
  } catch (_err) {
    return [];
  }
}

export async function extractPdfText(fileId) {
  try {
    const pdfDoc = await getPdfDocument(fileId);
    const parts = [];
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const content = await page.getTextContent({ normalizeWhitespace: true });
      const pageText = content.items.map((item) => item.str).join(" ");
      if (pageText.trim()) parts.push(pageText);
    }
    return parts.join("\n");
  } catch (_err) {
    return "";
  }
}
