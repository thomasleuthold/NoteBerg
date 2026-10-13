import { createQuickNote, readQuickNotes } from "./support/app.js";
import { expect, test } from "./support/fixtures.js";

// Runs in the "camera" project: Chromium's webcam is a generated video of a
// white sheet at an angle on a dark desk (fixtures/fakeCamera.js). Live corner
// detection, the perspective crop and the insert all run on those real frames.

async function openCamera(page) {
  await createQuickNote(page, "Scan");
  await page.click("#nc-tool-insert");
  await page.click('[data-action="insert-camera"]');
}

/** Mean luminance (0..255) of a stored image, decoded by the browser. */
function meanLuminance(page, fileId) {
  return page.evaluate(
    (id) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("NoteBerg");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result.transaction("files").objectStore("files").get(id);
          req.onerror = () => reject(req.error);
          req.onsuccess = async () => {
            open.result.close();
            const bitmap = await createImageBitmap(req.result.data);
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const ctx = canvas.getContext("2d");
            ctx.drawImage(bitmap, 0, 0);
            const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
            let sum = 0;
            for (let i = 0; i < data.length; i += 4) {
              sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            }
            resolve(sum / (data.length / 4));
          };
        };
      }),
    fileId,
  );
}

test("without camera permission, the user is told why nothing happens", async ({ page }) => {
  await openCamera(page);
  const dialog = page.locator("#modal-overlay:not(.modal-closing)");
  await expect(dialog).toContainText("Camera Unavailable");
  await expect(page.locator(".camera-modal")).toHaveCount(0);
});

test("document mode finds the sheet and inserts it cropped to the page", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["camera"]);
  await openCamera(page);

  const camera = page.locator(".camera-modal");
  await expect(camera).toBeVisible();
  await camera.locator(".camera-mode-doc").click();
  await expect(camera.locator(".camera-document-status")).toContainText("Document detected", {
    timeout: 15_000,
  });

  await camera.locator(".capture-btn").click();
  await page.locator(".crop-overlay .crop-apply-btn").click();

  await expect
    .poll(async () => {
      const [note] = await readQuickNotes(page);
      return (note?.media ?? []).filter((m) => m.type === "image" && !m.pending).length;
    })
    .toBe(1);
  const [{ media }] = await readQuickNotes(page);

  // The frame is mostly dark desk (luminance 50); the sheet is white (235).
  // An insert cropped to the detected sheet is almost all paper.
  expect(await meanLuminance(page, media[0].fileId)).toBeGreaterThan(200);
});
