/**
 * A fake webcam feed for Chromium's --use-file-for-fake-video-capture.
 *
 * One synthetic frame, looped: a white sheet of paper seen at an angle (a
 * perspective quadrilateral) on a dark desk. Written as raw Y4M (YUV 4:2:0),
 * which Chromium reads without any codec, so no binary fixture is committed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FRAME = { width: 640, height: 480 };

/** Sheet corners in frame pixels, clockwise from top-left: deliberately not a rectangle. */
export const SHEET = [
  [170, 70],
  [480, 95],
  [505, 420],
  [140, 400],
];

const DESK_Y = 50;
const PAPER_Y = 235;

function inside([x, y], polygon) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function frameBytes() {
  const { width, height } = FRAME;
  const luma = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      luma[y * width + x] = inside([x + 0.5, y + 0.5], SHEET) ? PAPER_Y : DESK_Y;
    }
  }
  // Neutral chroma: a grey desk and white paper.
  const chroma = Buffer.alloc((width / 2) * (height / 2), 128);
  return Buffer.concat([Buffer.from("FRAME\n"), luma, chroma, chroma]);
}

/** Write the feed (once per run) and return its path. */
export function fakeCameraFile() {
  const file = path.join(os.tmpdir(), "noteberg-e2e-document.y4m");
  if (!fs.existsSync(file)) {
    const header = `YUV4MPEG2 W${FRAME.width} H${FRAME.height} F30:1 Ip A1:1 C420jpeg\n`;
    const frame = frameBytes();
    fs.writeFileSync(file, Buffer.concat([Buffer.from(header), frame, frame]));
  }
  return file;
}
