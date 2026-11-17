/**
 * Conflict hints in the text editor (DESIGN §10.3 B).
 *
 * When two versions of a block collided, the merge keeps both and marks the
 * duplicate with `<span class="merge-hint" data-conflict data-by>`. Only the
 * attributes are stored; at render time the span shows a warning triangle whose
 * localized conflict message appears on hover or touch, and is emptied again
 * before the HTML is saved so stored text never carries a translation and
 * exported/plain HTML degrades to the duplicate block.
 */

import { t } from "../../i18n/index.js";
import { MERGE_HINT_CLASS } from "../../modules/textMerge.js";

const HINT_SELECTOR = `.${MERGE_HINT_CLASS}`;
export const MERGE_HINT_SELECTOR = HINT_SELECTOR;
const OPEN_CLASS = `${MERGE_HINT_CLASS}--open`;
export const MERGE_HINT_ICON = "⚠";

const wiredRoots = new WeakSet();

// The one hint that is open, and the one document listener that closes it on a
// tap anywhere else (added once, however many hints are opened)
let openHint = null;
let outsideWired = false;

function onOutsidePointerDown(event) {
  if (!openHint || event.target.closest?.(HINT_SELECTOR) === openHint) return;
  openHint.classList.remove(OPEN_CLASS);
  openHint = null;
}

function closeOpenHints(scope = document) {
  for (const open of scope.querySelectorAll?.(`.${OPEN_CLASS}`) ?? []) {
    open.classList.remove(OPEN_CLASS);
  }
}

function wireHintTouch(root) {
  if (wiredRoots.has(root)) return;
  wiredRoots.add(root);

  root.addEventListener("pointerdown", (event) => {
    const hint = event.target.closest?.(HINT_SELECTOR);
    if (!hint || !root.contains(hint)) {
      closeOpenHints(root);
      openHint = null;
      return;
    }
    event.stopPropagation();
    const willOpen = !hint.classList.contains(OPEN_CLASS);
    closeOpenHints(root);
    openHint = null;
    if (willOpen) {
      hint.classList.add(OPEN_CLASS);
      openHint = hint;
      if (!outsideWired) {
        outsideWired = true;
        document.addEventListener("pointerdown", onOutsidePointerDown);
      }
    }
  });
}

/** Fill every hint under `root` with a warning icon and its hover/touch message. */
export function renderMergeHints(root) {
  if (!root) return;
  wireHintTouch(root);
  for (const hint of root.querySelectorAll(HINT_SELECTOR)) {
    // Sanitizing can drop the attribute; the hint must never become typeable text
    hint.setAttribute("contenteditable", "false");
    const author = hint.getAttribute("data-by");
    const message = author ? t("canvas.mergeHint", { user: author }) : t("canvas.mergeHintUnknown");
    hint.textContent = MERGE_HINT_ICON;
    hint.setAttribute("data-hint", message);
    hint.setAttribute("aria-label", message);
    hint.setAttribute("role", "img");
  }
}

/** Empty every hint under `root` — the form that is stored and exported. */
export function stripMergeHintLabels(root) {
  if (!root) return;
  for (const hint of root.querySelectorAll(HINT_SELECTOR)) {
    hint.textContent = "";
    hint.classList.remove(OPEN_CLASS);
    hint.removeAttribute("data-hint");
    hint.removeAttribute("aria-label");
    hint.removeAttribute("role");
  }
}
