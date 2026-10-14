/** Interaction helpers shared by e2e specs. Each wraps one user-level action. */

/** Create a quick note through the overview UI and wait for the editor. */
export async function createQuickNote(page, title) {
  await page.click("#new-quick-note-btn");
  await page.fill("#note-title", title);
  await page.click("#modal-overlay .modal-confirm");
  await page.locator(".note-canvas__overlay").waitFor();
}

/**
 * Drag a stroke across the editor viewport with the pen tool.
 * `points` are fractions (0..1) of the viewport, so tests are resolution-independent.
 */
export async function drawStroke(page, points) {
  const box = await page.locator(".virtual-scroll-container__viewport").boundingBox();
  const at = ([fx, fy]) => [box.x + box.width * fx, box.y + box.height * fy];

  const [first, ...rest] = points.map(at);
  await page.mouse.move(...first);
  await page.mouse.down();
  for (const p of rest) await page.mouse.move(...p, { steps: 4 });
  await page.mouse.up();
}

/** Reload the page and wait until the app has booted again. */
export async function reloadApp(page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__noteberg?.initialized === true);
}

/** Open a note from the overview by its title and wait for the editor. */
export async function openNote(page, title) {
  await page.locator(".note-card", { hasText: title }).first().click();
  await page.locator(".note-canvas__overlay").waitFor();
}

/**
 * Pick `files` through one of the note's Insert menu entries
 * (`insert-image` | `insert-pdf`). The app opens a plain file input, so the
 * file chooser is answered the way the OS picker would answer it.
 */
export async function insertFromMenu(page, action, files) {
  await page.click("#nc-tool-insert");
  const chooser = page.waitForEvent("filechooser");
  await page.click(`[data-action="${action}"]`);
  await (await chooser).setFiles(files);
}

/**
 * Count the pixels of the note's drawing canvas within `tolerance` of `rgb`.
 * The canvas holds everything drawn on the page: strokes, images, PDF pages.
 */
export function countCanvasPixels(page, [r, g, b], tolerance = 24) {
  return page.evaluate(
    ({ r, g, b, tolerance }) => {
      const canvas = document.querySelector(".sliding-buffer-canvas");
      const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          Math.abs(data[i] - r) <= tolerance &&
          Math.abs(data[i + 1] - g) <= tolerance &&
          Math.abs(data[i + 2] - b) <= tolerance
        ) {
          n++;
        }
      }
      return n;
    },
    { r, g, b, tolerance },
  );
}

/** Scroll the note editor vertically by `dy` CSS pixels, as a mouse wheel does. */
export async function scrollNote(page, dy) {
  const box = await page.locator(".virtual-scroll-container__viewport").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, dy);
}

// ── Settings / backup flows ───────────────────────────────────────────────────

/** Open Settings on its Backup section. Backup/restore refuse to run with a note open. */
export async function openBackupSettings(page) {
  await page.click("#nav-overview");
  await page.click("#nav-settings");
  await page.click('.settings-nav__item[data-target="backup"]');
}

export async function closeSettings(page) {
  await page.click(".settings-dialog__close");
  await page.locator(".settings-dialog").waitFor({ state: "detached" });
}

/** Click the confirm button of the dialog currently on top (skips one that is fading out). */
export function confirmDialog(page) {
  return page.locator("#modal-overlay:not(.modal-closing) .modal-confirm").click();
}

/**
 * Restore the archive the fake Rust backend currently serves, through the UI.
 * Handles the no-conflict flow: confirm, then dismiss the completion dialog.
 */
export async function restoreFromSettings(page) {
  await openBackupSettings(page);
  await page.click("#backup-restore-btn");
  await confirmDialog(page); // "restore N notes?" / mode dialog's Continue
  await confirmDialog(page); // completion dialog's OK
  await closeSettings(page);
}

// ── IndexedDB (black-box) ─────────────────────────────────────────────────────

/** Every record of an object store in the app's IndexedDB. */
export function readStore(page, storeName) {
  return page.evaluate(
    (store) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("NoteBerg");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction(store).objectStore(store).getAll();
          req.onsuccess = () => {
            db.close();
            resolve(req.result);
          };
          req.onerror = () => reject(req.error);
        };
      }),
    storeName,
  );
}

/** Keys of an object store (for the `files` blob store, whose values are not serialisable). */
export function readKeys(page, storeName) {
  return page.evaluate(
    (store) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("NoteBerg");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction(store).objectStore(store).getAllKeys();
          req.onsuccess = () => {
            db.close();
            resolve(req.result);
          };
          req.onerror = () => reject(req.error);
        };
      }),
    storeName,
  );
}

/** All notes (index record merged with its content record), deleted ones included. */
export async function readNotes(page) {
  const [indexes, contents] = await Promise.all([
    readStore(page, "notes"),
    readStore(page, "noteContent"),
  ]);
  const byId = new Map(contents.map((c) => [c.id, c]));
  return indexes.map((n) => ({ ...n, ...byId.get(n.id) }));
}

/** Live (not deleted, not purged) quick notes. */
export async function readQuickNotes(page) {
  return (await readNotes(page)).filter((n) => !n.notebookId && !n.deleted && !n.purged);
}
