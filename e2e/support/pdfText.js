/**
 * The text a PDF viewer finds in a PDF (what it selects, searches and copies),
 * read with pdf.js in Node: per page, each text item with its position in
 * PDF points (origin bottom left).
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from "pdf-lib";

const require = createRequire(import.meta.url);

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Array<Array<{str: string, x: number, y: number}>>>}
 */
export async function pdfTextItems(bytes) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ).href;
  // A copy: pdf.js takes over (detaches) the buffer it is given
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const { items } = await page.getTextContent();
    pages.push(
      items
        .filter((item) => item.str.trim() !== "")
        .map((item) => ({ str: item.str, x: item.transform[4], y: item.transform[5] })),
    );
  }
  await doc.cleanup?.();
  return pages;
}

/**
 * Text a PDF draws visibly: the text-showing operators (Tj, TJ, ', ") on each
 * page that run while the text rendering mode is not 3 (invisible), with the
 * mode tracked through q/Q. An exported note's own text layer must add none.
 * @param {Uint8Array} bytes
 * @returns {Promise<number[]>} per page, the number of visible text operators
 */
export async function visibleTextOperators(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
    const source = streams
      .filter((stream) => stream instanceof PDFRawStream)
      .map((stream) => new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode()))
      .join("\n");
    let mode = 0;
    const saved = [];
    let visible = 0;
    // Operators, ignoring strings' contents: (...) and <...> are skipped
    const tokens = source.match(/\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>|\[|\]|[^\s()<>[\]]+/g) ?? [];
    let last = [];
    for (const token of tokens) {
      if (token === "q") saved.push(mode);
      else if (token === "Q") mode = saved.pop() ?? 0;
      else if (token === "Tr") mode = Number(last.at(-1));
      else if (["Tj", "TJ", "'", '"'].includes(token) && mode !== 3) visible++;
      last = /^[A-Za-z'"*]+$/.test(token) ? [] : [...last, token];
    }
    return visible;
  });
}
