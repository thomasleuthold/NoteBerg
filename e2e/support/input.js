/**
 * Pen and multi-touch input through Chromium's own input pipeline (CDP).
 *
 * Playwright's `page.mouse` only produces a mouse. These go through the same
 * path a real digitiser or touchscreen does, so the app sees genuine
 * PointerEvents with `pointerType` "pen"/"touch", pen pressure, and the
 * touch events that accompany a touch, in the browser's own order.
 *
 * Points are fractions (0..1) of the note viewport, as in app.js drawStroke().
 */

async function viewportMapper(page) {
  const box = await page.locator(".virtual-scroll-container__viewport").boundingBox();
  return ([fx, fy]) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
}

/**
 * Draw with a pen. `points` are [fx, fy, pressure] (pressure 0..1).
 * @param {import("@playwright/test").Page} page
 */
export async function penStroke(page, points) {
  const cdp = await page.context().newCDPSession(page);
  const at = await viewportMapper(page);
  const send = (type, [fx, fy, force]) =>
    cdp.send("Input.dispatchMouseEvent", {
      type,
      ...at([fx, fy]),
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: 1,
      pointerType: "pen",
      force,
    });
  const [first, ...rest] = points;
  await send("mousePressed", first);
  for (const p of rest) await send("mouseMoved", p);
  await send("mouseReleased", points[points.length - 1]);
  await cdp.detach();
}

/**
 * Touch gesture. `frames` is a list of touch-point lists, one list per step,
 * each point [fx, fy]. A finger appears when a frame has more points than the
 * previous one and lifts when it has fewer; all lift after the last frame.
 * @param {import("@playwright/test").Page} page
 */
export async function touchGesture(page, frames) {
  const cdp = await page.context().newCDPSession(page);
  const at = await viewportMapper(page);
  const points = (frame) => frame.map((p, id) => ({ ...at(p), id }));

  // CDP takes the full list of active points each time and generates one
  // event per finger that pressed, moved or lifted since the previous call.
  const [first, ...rest] = frames;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(first) });
  for (const frame of rest) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(frame) });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** Width of the scroll area the note content occupies; scales with zoom. */
export function contentWidth(page) {
  return page.evaluate(() =>
    Number.parseFloat(
      getComputedStyle(document.querySelector(".virtual-scroll-container__phantom")).width,
    ),
  );
}
