/**
 * Test media built at run time, so no binary fixtures live in the repo.
 *
 * Each file is one flat colour per page/image: a test can then tell from the
 * canvas pixels alone which page or image is on screen, without OCR or
 * reference screenshots.
 */
import { PDFDocument, rgb } from "pdf-lib";

/** A4 in PDF points. */
export const A4 = { width: 595.28, height: 841.89 };

/**
 * A PDF with one A4 page per colour, each page filled edge to edge.
 * @param {Array<[number, number, number]>} colours - 0..255 RGB per page
 * @returns {Promise<{name: string, mimeType: string, buffer: Buffer}>}
 */
export async function colourPdf(colours, name = "pages.pdf") {
  const doc = await PDFDocument.create();
  for (const [r, g, b] of colours) {
    const page = doc.addPage([A4.width, A4.height]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: A4.width,
      height: A4.height,
      color: rgb(r / 255, g / 255, b / 255),
    });
  }
  return { name, mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) };
}

/**
 * A flat-colour PNG, encoded by the browser's own canvas.
 * @param {import("@playwright/test").Page} page - any page; used only to encode
 * @returns {Promise<{name: string, mimeType: string, buffer: Buffer}>}
 */
export async function colourPng(page, [r, g, b], { width = 400, height = 300 } = {}) {
  const base64 = await page.evaluate(
    ({ r, g, b, width, height }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(0, 0, width, height);
      return canvas.toDataURL("image/png").split(",")[1];
    },
    { r, g, b, width, height },
  );
  return { name: "photo.png", mimeType: "image/png", buffer: Buffer.from(base64, "base64") };
}
