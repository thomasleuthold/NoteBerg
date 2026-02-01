import * as pdfjsLib from "pdfjs-dist";
// Import worker as a URL to be handled by Vite
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs?url";
import { generateId, getFile, saveFile } from "./storage.js";

// Configure the worker source
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/**
 * Imports a PDF file, saves it to storage, and extracts page metadata.
 * @param {File} file - The PDF file object from input
 * @returns {Promise<{
 *   pdfId: string,
 *   pages: Array<{
 *     id: string,
 *     type: 'pdf-page',
 *     pdfId: string,
 *     pageIndex: number,
 *     width: number,
 *     height: number,
 *     x: number,
 *     y: number
 *   }>,
 *   totalHeight: number
 * }>}
 */
export async function importPdf(file) {
  // 1. Save the raw file to IndexedDB
  const pdfId = await saveFile(file);

  // 2. Load the PDF to get dimensions
  // We need to read the file as ArrayBuffer for pdf.js
  const arrayBuffer = await file.arrayBuffer();

  // Load the document
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdfDocument = await loadingTask.promise;

  const pages = [];
  let currentY = 0;

  // 3. Iterate through pages to build the vertical stack
  for (let i = 1; i <= pdfDocument.numPages; i++) {
    const page = await pdfDocument.getPage(i);
    const viewport = page.getViewport({ scale: 1.0 }); // Get dimensions at 100% scale

    pages.push({
      id: generateId(),
      type: "pdf-page",
      pdfId: pdfId,
      pageIndex: i, // pdf.js uses 1-based indexing
      width: viewport.width,
      height: viewport.height,
      x: 0,
      y: currentY,
    });

    // Stack pages vertically with zero gap (visual separator will be drawn by renderer)
    currentY += viewport.height;
  }

  return {
    pdfId,
    pages,
    totalHeight: currentY,
  };
}

// Cache for loaded PDF documents to avoid re-fetching/re-parsing
const documentCache = new Map();

/**
 * Retrieves a PDF document proxy, using cache if available.
 * @param {string} pdfId
 * @returns {Promise<import('pdfjs-dist').PDFDocumentProxy>}
 */
async function getPdfDocument(pdfId) {
  if (documentCache.has(pdfId)) {
    return documentCache.get(pdfId);
  }

  const loadingTaskPromise = (async () => {
    const blob = await getFile(pdfId);
    if (!blob) {
      throw new Error(`PDF file not found: ${pdfId}`);
    }
    const arrayBuffer = await blob.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    return loadingTask.promise;
  })();

  documentCache.set(pdfId, loadingTaskPromise);
  return loadingTaskPromise;
}

/**
 * Loads a specific page from a stored PDF ID
 * @param {string} pdfId - The ID of the stored PDF file
 * @param {number} pageIndex - 1-based page index
 * @returns {Promise<import('pdfjs-dist').PDFPageProxy>}
 */
export async function loadPdfPage(pdfId, pageIndex) {
  const pdfDoc = await getPdfDocument(pdfId);
  return pdfDoc.getPage(pageIndex);
}
