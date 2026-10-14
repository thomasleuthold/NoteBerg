/**
 * documentDetector.js - Pure JavaScript Document Boundary & Corner Detection
 *
 * Employs Otsu segmentation, morphological closing, connected component analysis,
 * convex hull extraction, boundary gradient verification, and maximum-area
 * quadrilateral fitting to recognize document borders and return its 4 corners (TL, TR, BR, BL).
 *
 * Runs with zero external dependencies and 100% compatibility across Nextcloud (strict CSP),
 * Android WebView, and Windows desktop.
 */

/**
 * Detect the 4 corners of a document in an image.
 *
 * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap} source
 * @param {object} [options]
 * @param {number} [options.maxDim=280] - Maximum dimension for downsampled processing
 * @param {number} [options.minAreaFraction=0.08] - Minimum fraction of image area for a valid document
 * @param {number} [options.maxAreaFraction=0.92] - Maximum fraction of image area for a valid document
 * @returns {Promise<{tl: {x: number, y: number}, tr: {x: number, y: number}, br: {x: number, y: number}, bl: {x: number, y: number}}|null>}
 */
export async function detectDocumentCorners(source, options = {}) {
  if (!source) return null;

  // An image still loading is waited for. A *complete* image with no width is
  // broken (failed decode, or no src at all): its load/error events have
  // already fired and never will again, so waiting would hang forever.
  // Listeners are added, not assigned, so the caller's own onload/onerror
  // handlers are left intact.
  if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement) {
    if (!source.complete) {
      await new Promise((resolve) => {
        source.addEventListener("load", resolve, { once: true });
        source.addEventListener("error", resolve, { once: true });
      });
    }
    if (!source.naturalWidth) return null;
  }

  const origW = source.naturalWidth || source.videoWidth || source.width || 0;
  const origH = source.naturalHeight || source.videoHeight || source.height || 0;
  if (origW <= 20 || origH <= 20) return null;

  const { maxDim = 280, minAreaFraction = 0.08, maxAreaFraction = 0.92 } = options;

  // 1. Downsample onto an offscreen canvas for fast execution (<5ms)
  const scale = Math.min(1, maxDim / Math.max(origW, origH));
  const w = Math.max(20, Math.round(origW * scale));
  const h = Math.max(20, Math.round(origH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  try {
    ctx.drawImage(source, 0, 0, w, h);
  } catch (_e) {
    return null;
  }

  const imgData = ctx.getImageData(0, 0, w, h);
  const pixels = imgData.data;
  const totalPixels = w * h;

  // 2. Grayscale conversion (Luminance) and Paper Whiteness Metric (Chroma penalty)
  const gray = new Uint8Array(totalPixels);
  const paperMetric = new Uint8Array(totalPixels);
  let minVal = 255;
  let maxVal = 0;
  for (let i = 0; i < totalPixels; i++) {
    const p = i * 4;
    const r = pixels[p];
    const g = pixels[p + 1];
    const b = pixels[p + 2];
    const luma = (r * 299 + g * 587 + b * 114 + 500) / 1000;
    const gVal = luma | 0;
    gray[i] = gVal;
    if (gVal < minVal) minVal = gVal;
    if (gVal > maxVal) maxVal = gVal;

    // Chroma penalty: white paper is desaturated (low chroma), while wooden floors,
    // desks, and carpets have warm color saturation.
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const chroma = maxC - minC;
    paperMetric[i] = Math.max(0, Math.min(255, gVal - chroma * 1.0)) | 0;
  }

  // Reject uniform or low-contrast images (e.g. blank canvas, camera covered)
  if (maxVal - minVal < 25) {
    return null;
  }

  // 3. Compute Sobel edge gradient magnitude map
  const mag = computeSobel(gray, w, h);

  // 4. Compute Otsu thresholds
  const otsuGray = computeOtsu(gray, totalPixels);
  const otsuPaper = computeOtsu(paperMetric, totalPixels);

  // 5. Test candidate segmentations
  // Prioritize paper metric across a spectrum of offsets (separating paper from bright wooden/colored
  // floors and high-frequency patterned tiles), standard and elevated grayscale (for low-contrast,
  // high-exposure, and desaturated backgrounds), and dark documents on light surfaces.
  const segmentations = [];
  for (const delta of [0, 15, 30, 45]) {
    const th = otsuPaper + delta;
    if (th < maxVal - 5 && th <= 245) {
      segmentations.push({ channel: paperMetric, thresh: th, polarity: "bright" });
    }
  }
  for (const delta of [0, 20, 35, 50]) {
    const th = otsuGray + delta;
    if (th < maxVal - 5 && th <= 245) {
      segmentations.push({ channel: gray, thresh: th, polarity: "bright" });
    }
  }
  segmentations.push({ channel: gray, thresh: otsuGray, polarity: "dark" });

  let bestCandidate = null;
  let bestScore = -1;

  for (const seg of segmentations) {
    const binary = createBinary(seg.channel, totalPixels, seg.polarity, seg.thresh);

    // Morphological closing (3x3 dilation + erosion) to fuse text and paper grain
    const closed = morphologicalClose(binary, w, h, 3);

    // Find connected components and evaluate candidate documents
    const candidate = findBestComponentQuad(closed, w, h, mag, minAreaFraction, maxAreaFraction);
    if (candidate && candidate.score > bestScore) {
      bestScore = candidate.score;
      bestCandidate = candidate;
    }
  }

  // findBestComponentQuad already rejects quads with weak boundary gradients
  if (!bestCandidate) {
    return null;
  }

  // 6. Order corners clockwise: TL, TR, BR, BL
  const ordered = orderCorners(bestCandidate.quad);

  // 7. Rescale coordinates back to original image dimensions
  const invScaleX = origW / w;
  const invScaleY = origH / h;

  return {
    tl: {
      x: Math.max(0, Math.min(origW, Math.round(ordered.tl.x * invScaleX))),
      y: Math.max(0, Math.min(origH, Math.round(ordered.tl.y * invScaleY))),
    },
    tr: {
      x: Math.max(0, Math.min(origW, Math.round(ordered.tr.x * invScaleX))),
      y: Math.max(0, Math.min(origH, Math.round(ordered.tr.y * invScaleY))),
    },
    br: {
      x: Math.max(0, Math.min(origW, Math.round(ordered.br.x * invScaleX))),
      y: Math.max(0, Math.min(origH, Math.round(ordered.br.y * invScaleY))),
    },
    bl: {
      x: Math.max(0, Math.min(origW, Math.round(ordered.bl.x * invScaleX))),
      y: Math.max(0, Math.min(origH, Math.round(ordered.bl.y * invScaleY))),
    },
  };
}

/**
 * Compute Sobel gradient magnitude map
 */
function computeSobel(gray, w, h) {
  const mag = new Uint16Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    const yPrev = (y - 1) * w;
    const yCurr = y * w;
    const yNext = (y + 1) * w;

    for (let x = 1; x < w - 1; x++) {
      const p00 = gray[yPrev + x - 1];
      const p02 = gray[yPrev + x + 1];
      const p10 = gray[yCurr + x - 1];
      const p12 = gray[yCurr + x + 1];
      const p20 = gray[yNext + x - 1];
      const p22 = gray[yNext + x + 1];

      const gx = -p00 + p02 - 2 * p10 + 2 * p12 - p20 + p22;

      const p01 = gray[yPrev + x];
      const p21 = gray[yNext + x];

      const gy = -p00 - 2 * p01 - p02 + p20 + 2 * p21 + p22;

      mag[yCurr + x] = Math.abs(gx) + Math.abs(gy);
    }
  }

  return mag;
}

/**
 * Compute Otsu's binarization threshold
 */
function computeOtsu(gray, total) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < total; i++) {
    hist[gray[i]]++;
  }

  let sumTotal = 0;
  for (let t = 0; t < 256; t++) {
    sumTotal += t * hist[t];
  }

  let weightBg = 0;
  let sumBg = 0;
  let maxVariance = 0;
  let bestThresh = 128;

  for (let t = 0; t < 256; t++) {
    weightBg += hist[t];
    if (weightBg === 0) continue;
    const weightFg = total - weightBg;
    if (weightFg === 0) break;

    sumBg += t * hist[t];
    const meanBg = sumBg / weightBg;
    const meanFg = (sumTotal - sumBg) / weightFg;

    const diff = meanBg - meanFg;
    const variance = weightBg * weightFg * diff * diff;
    if (variance > maxVariance) {
      maxVariance = variance;
      bestThresh = t;
    }
  }

  return bestThresh;
}

/**
 * Create binary mask based on threshold and polarity
 */
function createBinary(channel, total, polarity, thresh) {
  const binary = new Uint8Array(total);
  if (polarity === "dark") {
    for (let i = 0; i < total; i++) {
      if (channel[i] <= thresh) binary[i] = 1;
    }
  } else {
    for (let i = 0; i < total; i++) {
      if (channel[i] > thresh) binary[i] = 1;
    }
  }
  return binary;
}

/**
 * Fast separable morphological closing (Dilation 3x3 then Erosion 3x3)
 */
function morphologicalClose(binary, w, h, iterations = 2) {
  const cur = new Uint8Array(binary);
  const temp = new Uint8Array(w * h);

  for (let it = 0; it < iterations; it++) {
    // 3x3 Dilation (horizontal then vertical)
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const x0 = x > 0 ? cur[row + x - 1] : 0;
        const x1 = cur[row + x];
        const x2 = x < w - 1 ? cur[row + x + 1] : 0;
        temp[row + x] = x0 | x1 | x2;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        const y0 = y > 0 ? temp[(y - 1) * w + x] : 0;
        const y1 = temp[y * w + x];
        const y2 = y < h - 1 ? temp[(y + 1) * w + x] : 0;
        cur[y * w + x] = y0 | y1 | y2;
      }
    }
  }

  for (let it = 0; it < iterations; it++) {
    // 3x3 Erosion (horizontal then vertical)
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const x0 = x > 0 ? cur[row + x - 1] : 0;
        const x1 = cur[row + x];
        const x2 = x < w - 1 ? cur[row + x + 1] : 0;
        temp[row + x] = x0 & x1 & x2;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        const y0 = y > 0 ? temp[(y - 1) * w + x] : 0;
        const y1 = temp[y * w + x];
        const y2 = y < h - 1 ? temp[(y + 1) * w + x] : 0;
        cur[y * w + x] = y0 & y1 & y2;
      }
    }
  }

  return cur;
}

/**
 * Find connected components and score quadrilateral document candidates
 */
function findBestComponentQuad(binary, w, h, mag, minAreaFraction, maxAreaFraction) {
  const totalArea = w * h;
  const visited = new Uint8Array(totalArea);

  // Reusable queues for BFS flood-fill
  const queueX = new Int16Array(totalArea);
  const queueY = new Int16Array(totalArea);

  let bestQuad = null;
  let bestScore = -1;

  for (let y = 0; y < h; y++) {
    const rowOffset = y * w;
    for (let x = 0; x < w; x++) {
      const idx = rowOffset + x;
      if (binary[idx] === 1 && visited[idx] === 0) {
        let head = 0;
        let tail = 0;
        queueX[tail] = x;
        queueY[tail] = y;
        tail++;
        visited[idx] = 1;

        let touchesLeft = false;
        let touchesRight = false;
        let touchesTop = false;
        let touchesBottom = false;

        const compPixels = [];

        while (head < tail) {
          const cx = queueX[head];
          const cy = queueY[head];
          head++;
          compPixels.push({ x: cx, y: cy });

          if (cx <= 1) touchesLeft = true;
          if (cx >= w - 2) touchesRight = true;
          if (cy <= 1) touchesTop = true;
          if (cy >= h - 2) touchesBottom = true;

          // 4-connected neighbors
          const nx0 = cx - 1,
            ny0 = cy;
          const nx1 = cx + 1,
            ny1 = cy;
          const nx2 = cx,
            ny2 = cy - 1;
          const nx3 = cx,
            ny3 = cy + 1;

          if (nx0 >= 0 && binary[ny0 * w + nx0] === 1 && visited[ny0 * w + nx0] === 0) {
            visited[ny0 * w + nx0] = 1;
            queueX[tail] = nx0;
            queueY[tail] = ny0;
            tail++;
          }
          if (nx1 < w && binary[ny1 * w + nx1] === 1 && visited[ny1 * w + nx1] === 0) {
            visited[ny1 * w + nx1] = 1;
            queueX[tail] = nx1;
            queueY[tail] = ny1;
            tail++;
          }
          if (ny2 >= 0 && binary[ny2 * w + nx2] === 1 && visited[ny2 * w + nx2] === 0) {
            visited[ny2 * w + nx2] = 1;
            queueX[tail] = nx2;
            queueY[tail] = ny2;
            tail++;
          }
          if (ny3 < h && binary[ny3 * w + nx3] === 1 && visited[ny3 * w + nx3] === 0) {
            visited[ny3 * w + nx3] = 1;
            queueX[tail] = nx3;
            queueY[tail] = ny3;
            tail++;
          }
        }

        const compSize = compPixels.length;
        const areaFrac = compSize / totalArea;
        if (areaFrac < minAreaFraction || areaFrac > maxAreaFraction) continue;

        // If component touches 3 or more frame borders, it is the background/table frame, not the document
        const touchCount =
          (touchesLeft ? 1 : 0) +
          (touchesRight ? 1 : 0) +
          (touchesTop ? 1 : 0) +
          (touchesBottom ? 1 : 0);
        if (touchCount >= 3) continue;

        // Extract component boundary pixels
        const boundary = [];
        for (let i = 0; i < compSize; i++) {
          const px = compPixels[i].x;
          const py = compPixels[i].y;
          if (
            px === 0 ||
            px === w - 1 ||
            py === 0 ||
            py === h - 1 ||
            binary[py * w + px - 1] === 0 ||
            binary[py * w + px + 1] === 0 ||
            binary[(py - 1) * w + px] === 0 ||
            binary[(py + 1) * w + px] === 0
          ) {
            boundary.push({ x: px, y: py });
          }
        }

        if (boundary.length < 4) continue;

        // Compute 2D convex hull of boundary pixels
        const hull = convexHull(boundary);
        if (hull.length < 4) continue;

        const hullArea = polygonArea(hull);
        const solidity = compSize / Math.max(1, hullArea);
        // Documents with text/drawings typically have solidity >= 0.65
        if (solidity < 0.65) continue;

        // Find the 4 vertices of the convex hull that maximize the quadrilateral area
        const quad = findMaxAreaQuad(hull);
        if (!quad || quad.length !== 4) continue;

        const qArea = polygonArea(quad);
        if (qArea < totalArea * minAreaFraction || qArea > totalArea * maxAreaFraction) continue;
        if (!isConvexQuad(quad) || !isPlausibleDocumentQuad(quad)) continue;
        if (isImageFrameBorder(quad, w, h)) continue;

        // Measure average edge gradient magnitude along the quad's perimeter
        const avgGrad = evalBoundaryGradient(quad, mag, w, h);
        if (avgGrad < 15) continue;

        // Score: heavily rewards crisp, high-contrast document borders over oversized background blobs
        const score = Math.sqrt(qArea) * solidity * avgGrad ** 1.5;
        if (score > bestScore) {
          bestScore = score;
          bestQuad = quad;
        }
      }
    }
  }

  return bestQuad ? { quad: bestQuad, score: bestScore } : null;
}

/**
 * Check if a quad's corners or edges align with the outer image frame boundary
 */
function isImageFrameBorder(quad, w, h) {
  const mx = w * 0.045;
  const my = h * 0.045;

  let marginHits = 0;
  for (const pt of quad) {
    if (pt.x <= mx || pt.x >= w - mx || pt.y <= my || pt.y >= h - my) {
      marginHits++;
    }
  }
  if (marginHits >= 3) return true;

  // Check if an entire edge lies along a frame border (document clipped by camera frame)
  for (let i = 0; i < 4; i++) {
    const p1 = quad[i];
    const p2 = quad[(i + 1) % 4];
    if (
      (p1.x <= mx && p2.x <= mx) ||
      (p1.x >= w - mx && p2.x >= w - mx) ||
      (p1.y <= my && p2.y <= my) ||
      (p1.y >= h - my && p2.y >= h - my)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Measure average edge gradient magnitude along the 4 edges of the quadrilateral
 */
function evalBoundaryGradient(quad, mag, w, h) {
  let totalGrad = 0;
  let samples = 0;

  for (let i = 0; i < 4; i++) {
    const p1 = quad[i];
    const p2 = quad[(i + 1) % 4];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(2, Math.round(dist));

    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const x = Math.round(p1.x + dx * t);
      const y = Math.round(p1.y + dy * t);
      if (x >= 0 && x < w && y >= 0 && y < h) {
        totalGrad += mag[y * w + x];
        samples++;
      }
    }
  }

  return samples > 0 ? totalGrad / samples : 0;
}

/**
 * Find the 4 vertices in the convex hull that maximize the quadrilateral area
 */
function findMaxAreaQuad(hull) {
  let pts = hull;
  if (pts.length > 20) {
    pts = simplifyRdpClosed(pts, 2.0);
  }
  const n = pts.length;
  if (n < 4) return null;
  if (n === 4) return pts;

  let maxArea = 0;
  let bestQuad = null;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        for (let l = k + 1; l < n; l++) {
          const q = [pts[i], pts[j], pts[k], pts[l]];
          const a = polygonArea(q);
          if (a > maxArea) {
            maxArea = a;
            bestQuad = q;
          }
        }
      }
    }
  }

  return bestQuad;
}

/**
 * Andrew's Monotone Chain 2D Convex Hull
 */
function convexHull(points) {
  if (points.length <= 3) return points.slice();

  // Deduplicate and sort points by X, then Y
  const pts = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const unique = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x !== unique[unique.length - 1].x || pts[i].y !== unique[unique.length - 1].y) {
      unique.push(pts[i]);
    }
  }
  if (unique.length <= 3) return unique;

  function cross(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }

  const lower = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const p = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Closed polygon RDP simplification
 */
function simplifyRdpClosed(poly, epsilon) {
  if (poly.length <= 4) return poly;
  const closed = poly.concat([poly[0]]);
  const simplified = rdp(closed, epsilon);
  if (
    simplified.length > 1 &&
    simplified[0].x === simplified[simplified.length - 1].x &&
    simplified[0].y === simplified[simplified.length - 1].y
  ) {
    simplified.pop();
  }
  return simplified.length >= 4 ? simplified : poly;
}

function rdp(pts, epsilon) {
  if (pts.length < 3) return pts;
  let maxD = 0;
  let idx = 0;
  const p1 = pts[0];
  const p2 = pts[pts.length - 1];

  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointToLineDistance(pts[i], p1, p2);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }

  if (maxD > epsilon) {
    const r1 = rdp(pts.slice(0, idx + 1), epsilon);
    const r2 = rdp(pts.slice(idx), epsilon);
    return r1.slice(0, -1).concat(r2);
  }
  return [p1, p2];
}

function pointToLineDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
}

/**
 * Polygon Area via Shoelace Formula
 */
function polygonArea(pts) {
  const n = pts.length;
  if (n < 3) return 0;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(area) * 0.5;
}

/**
 * Check if a quadrilateral is strictly convex
 */
function isConvexQuad(quad) {
  if (quad.length !== 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const p1 = quad[i];
    const p2 = quad[(i + 1) % 4];
    const p3 = quad[(i + 2) % 4];
    const cross = (p2.x - p1.x) * (p3.y - p2.y) - (p2.y - p1.y) * (p3.x - p2.x);
    if (cross !== 0) {
      const currentSign = cross > 0 ? 1 : -1;
      if (sign === 0) {
        sign = currentSign;
      } else if (sign !== currentSign) {
        return false;
      }
    }
  }
  return sign !== 0;
}

/**
 * Verify a quad is a plausible photographed rectangle: internal angles are
 * reasonable for document perspective (between 40° and 140°) and opposite
 * sides do not differ in length beyond what perspective can explain.
 */
function isPlausibleDocumentQuad(quad) {
  if (quad.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const prev = quad[(i + 3) % 4];
    const curr = quad[i];
    const next = quad[(i + 1) % 4];

    const v1x = prev.x - curr.x;
    const v1y = prev.y - curr.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;

    const mag1 = Math.hypot(v1x, v1y);
    const mag2 = Math.hypot(v2x, v2y);
    if (mag1 === 0 || mag2 === 0) return false;

    const cosTheta = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (mag1 * mag2)));
    const angleDeg = (Math.acos(cosTheta) * 180) / Math.PI;

    if (angleDeg < 40 || angleDeg > 140) {
      return false;
    }
  }

  // Perspective consistency: opposite sides of a rectangular document
  // should not have extreme length disparities (e.g., > 1.85:1)
  const d0 = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
  const d1 = Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y);
  const d2 = Math.hypot(quad[3].x - quad[2].x, quad[3].y - quad[2].y);
  const d3 = Math.hypot(quad[0].x - quad[3].x, quad[0].y - quad[3].y);

  if (d0 === 0 || d1 === 0 || d2 === 0 || d3 === 0) return false;

  const ratio02 = Math.max(d0, d2) / Math.min(d0, d2);
  const ratio13 = Math.max(d1, d3) / Math.min(d1, d3);
  if (ratio02 > 1.85 || ratio13 > 1.85) return false;

  return true;
}

/**
 * Order corners clockwise starting from Top-Left: TL, TR, BR, BL
 */
function orderCorners(quad) {
  // Center of mass
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;

  // Sort clockwise by polar angle around center
  const cw = quad.slice().sort((a, b) => {
    return Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx);
  });

  // Top-Left corner minimizes x + y
  let tlIdx = 0;
  let minSum = cw[0].x + cw[0].y;
  for (let i = 1; i < 4; i++) {
    const sum = cw[i].x + cw[i].y;
    if (sum < minSum) {
      minSum = sum;
      tlIdx = i;
    }
  }

  return {
    tl: cw[tlIdx],
    tr: cw[(tlIdx + 1) % 4],
    br: cw[(tlIdx + 2) % 4],
    bl: cw[(tlIdx + 3) % 4],
  };
}
