/**
 * Three-way block merge of a note's HTML text (DESIGN §10.3 B).
 *
 * Pure: no storage, no network. Needs an HTML parser (DOMParser), which every
 * place that merges notes (main thread, vitest/jsdom) provides; without one the
 * merge degrades to keeping both versions whole, which is still lossless.
 *
 * Blocks are the top-level children of the editor HTML. `ul`/`ol` are split so
 * each `li` is its own block, and contiguous bare inline nodes form one
 * pseudo-block. A table both sides changed is merged one level deeper, by rows
 * and cells (see "Tables" below). Text boxes are merged by id, and the text in
 * each by the same block merge (see "Text boxes"). Blocks are aligned with
 * diff3 over their normalized HTML and resolved per hunk:
 *
 *   one side changed           -> take that side
 *   identical change           -> take it
 *   deleted vs edited          -> keep the edit (lossless)
 *   both edited the same block -> keep both, the later-modified one in place and
 *                                 the other right after it, marked by a hint span
 *
 * Convergence: both users merge independently, so the result never depends on
 * which side is "local" — the primary side is derived from the notes' own
 * `modified` (tie: content hash) and the hint carries a deterministic id.
 * Idempotency: hint spans are ignored when comparing blocks and a side whose
 * blocks are all present in the other side's hunk simply yields to it, so
 * merging an already-merged result against its own input adds nothing.
 */

import { escapeHtml } from "../utils/escapeHtml.js";
import { htmlParser, parseHtmlBody } from "./htmlParser.js";
import { mayHaveBoxes, parseContent, serializeContent } from "./textBoxes.js";

// The parser is shared with textBoxes.js; set it here as before
export { useHtmlParser } from "./htmlParser.js";

export const MERGE_HINT_CLASS = "merge-hint";

const WRAPPER_TAGS = new Set(["UL", "OL"]);
// Elements a closing-tag insertion would break (hint goes in a trailing div instead)
const NO_INLINE_APPEND = new Set([
  "TABLE",
  "UL",
  "OL",
  "HR",
  "IMG",
  "VIDEO",
  "AUDIO",
  "CANVAS",
  "SVG",
  "FIGURE",
  "DETAILS",
]);
// Above this many LCS cells the alignment is skipped; blocks are then treated as
// unmatched, which only produces more (still lossless) conflicts.
const MAX_LCS_CELLS = 25_000_000;

/** cyrb53 — small deterministic 53-bit string hash, hex encoded. */
function hash(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

function normalizeHtml(html) {
  return html.replace(/\s+/g, " ").trim();
}

/** Outer HTML of a node with merge-hint spans removed, whitespace normalized. */
function nodeKey(node) {
  if (node.nodeType === 3) return normalizeHtml(node.textContent);
  if (node.nodeType !== 1) return "";
  const clone = node.cloneNode(true);
  for (const hint of clone.querySelectorAll(`.${MERGE_HINT_CLASS}`)) hint.remove();
  return normalizeHtml(clone.outerHTML);
}

function nodeHtml(node) {
  return node.nodeType === 3 ? escapeText(node.textContent) : node.outerHTML;
}

function escapeText(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shellOf(list) {
  const clone = list.cloneNode(false);
  return clone.outerHTML.replace(/<\/[^>]+>$/, "");
}

/**
 * Split editor HTML into blocks: { key, html, wrap?, wrapTag? }.
 * `wrap` is the opening tag of the surrounding list for `li` blocks.
 */
export function segmentBlocks(html) {
  const doc = parseHtmlBody(html);
  const blocks = [];
  let run = [];

  const flushRun = () => {
    if (run.length === 0) return;
    const key = run.map(nodeKey).join("");
    const text = run.map(nodeHtml).join("");
    run = [];
    // Whitespace-only runs between blocks carry nothing
    if (normalizeHtml(key) === "") return;
    blocks.push({ key: normalizeHtml(key), html: text });
  };

  for (const node of doc.body.childNodes) {
    if (node.nodeType === 1 && WRAPPER_TAGS.has(node.tagName)) {
      flushRun();
      const wrap = shellOf(node);
      const wrapTag = node.tagName.toLowerCase();
      const items = [...node.children];
      if (items.length === 0) {
        blocks.push({ key: nodeKey(node), html: node.outerHTML });
        continue;
      }
      for (const item of items) {
        blocks.push({ key: `${wrapTag}>${nodeKey(item)}`, html: item.outerHTML, wrap, wrapTag });
      }
    } else if (node.nodeType === 1 && !isInline(node)) {
      flushRun();
      blocks.push({ key: nodeKey(node), html: node.outerHTML });
    } else {
      run.push(node);
    }
  }
  flushRun();
  return blocks;
}

const INLINE_TAGS = new Set([
  "A",
  "B",
  "BR",
  "CODE",
  "EM",
  "I",
  "MARK",
  "S",
  "SMALL",
  "SPAN",
  "STRIKE",
  "STRONG",
  "SUB",
  "SUP",
  "U",
  "FONT",
]);
function isInline(node) {
  return INLINE_TAGS.has(node.tagName);
}

/** Rebuild HTML from blocks; consecutive li blocks sharing a list shell are re-wrapped. */
function renderBlocks(blocks) {
  let out = "";
  let open = null;
  for (const b of blocks) {
    if (open && open.wrap !== b.wrap) {
      out += `</${open.wrapTag}>`;
      open = null;
    }
    if (b.wrap && !open) {
      out += b.wrap;
      open = b;
    }
    out += b.html;
  }
  if (open) out += `</${open.wrapTag}>`;
  return out;
}

// ─── Alignment ────────────────────────────────────────────────────────────────

/** Map base index -> other index for a longest common subsequence of keys. */
function lcsMatches(baseKeys, otherKeys) {
  const matches = new Map();
  let start = 0;
  while (
    start < baseKeys.length &&
    start < otherKeys.length &&
    baseKeys[start] === otherKeys[start]
  ) {
    matches.set(start, start);
    start++;
  }
  let endB = baseKeys.length;
  let endO = otherKeys.length;
  while (endB > start && endO > start && baseKeys[endB - 1] === otherKeys[endO - 1]) {
    endB--;
    endO--;
    matches.set(endB, endO);
  }
  const n = endB - start;
  const m = endO - start;
  if (n === 0 || m === 0 || n * m > MAX_LCS_CELLS) return matches;

  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        baseKeys[start + i] === otherKeys[start + j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (baseKeys[start + i] === otherKeys[start + j]) {
      matches.set(start + i, start + j);
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
    else j++;
  }
  return matches;
}

/** Split three block lists into [{base, a, b, stable}] regions between common anchors. */
function alignThreeWay(base, a, b) {
  const matchA = lcsMatches(
    base.map((x) => x.key),
    a.map((x) => x.key),
  );
  const matchB = lcsMatches(
    base.map((x) => x.key),
    b.map((x) => x.key),
  );
  const regions = [];
  let bi = 0;
  let ai = 0;
  let ci = 0;
  const push = (region) => {
    if (region.base.length || region.a.length || region.b.length) regions.push(region);
  };
  for (let k = 0; k < base.length; k++) {
    if (!matchA.has(k) || !matchB.has(k)) continue;
    const ka = matchA.get(k);
    const kb = matchB.get(k);
    // A later base index can only anchor if its matches are past the cursors
    if (ka < ai || kb < ci) continue;
    push({ base: base.slice(bi, k), a: a.slice(ai, ka), b: b.slice(ci, kb), stable: false });
    push({ base: [base[k]], a: [a[ka]], b: [b[kb]], stable: true });
    bi = k + 1;
    ai = ka + 1;
    ci = kb + 1;
  }
  push({ base: base.slice(bi), a: a.slice(ai), b: b.slice(ci), stable: false });
  return regions;
}

// ─── Resolution ───────────────────────────────────────────────────────────────

const keysOf = (seg) => seg.map((x) => x.key);
const sameKeys = (x, y) => x.length === y.length && x.every((b, i) => b.key === y[i].key);
const isSubset = (small, big) => {
  if (small.length === 0) return false;
  const set = new Set(keysOf(big));
  return small.every((b) => set.has(b.key));
};

function hintSpan(conflictId, by) {
  return `<span class="${MERGE_HINT_CLASS}" contenteditable="false" data-conflict="${conflictId}"${
    by ? ` data-by="${escapeHtml(by)}"` : ""
  }></span>`;
}

function withHint(block, conflictId, by) {
  const hint = hintSpan(conflictId, by);
  const tag = block.html.match(/^<([a-zA-Z0-9]+)/)?.[1]?.toUpperCase();
  if (!tag) return { ...block, html: block.html + hint };
  // A table row: the hint goes into its last cell
  if (tag === "TR") {
    return { ...block, html: block.html.replace(/<\/t[dh]>(?![\s\S]*<\/t[dh]>)/i, `${hint}$&`) };
  }
  if (NO_INLINE_APPEND.has(tag)) return { ...block, html: `${block.html}<div>${hint}</div>` };
  return { ...block, html: block.html.replace(/<\/[^>]+>\s*$/, `${hint}$&`) };
}

/**
 * @param {{ primary: "a"|"b", authors: {a?: string, b?: string}, level?: "row" }} ctx -
 *   `level: "row"` while resolving the rows of a table
 */
function resolveRegion(region, hasBase, ctx) {
  const { base, a, b } = region;
  if (region.stable) {
    // Same block on all sides; if only one copy carries a conflict hint keep that one
    const hinted = (seg) => seg[0].html.includes(MERGE_HINT_CLASS);
    if (hinted(a) !== hinted(b)) return hinted(a) ? a : b;
    return ctx.primary === "a" ? a : b;
  }
  if (sameKeys(a, base)) return b;
  if (sameKeys(b, base)) return a;
  if (sameKeys(a, b)) return ctx.primary === "a" ? a : b;
  const primary = ctx.primary === "a" ? a : b;
  const other = ctx.primary === "a" ? b : a;

  // Delete vs edit, or an insert against nothing: nothing to arbitrate. What
  // the other side holds unchanged from the base was deleted here, and goes
  if (a.length === 0 || b.length === 0) {
    const baseKeys = new Set(keysOf(base));
    return (a.length === 0 ? b : a).filter((block) => !baseKeys.has(block.key));
  }

  if (ctx.level === "row") {
    // A row both sides changed: merged cell by cell when its cells line up
    if (base.length === 1 && a.length === 1 && b.length === 1) {
      const row = mergeRow(base[0], a[0], b[0], ctx);
      if (row) return [row];
    }
  } else if (a.length === 1 && b.length === 1 && isTableBlock(a[0]) && isTableBlock(b[0])) {
    // A table both sides changed: merged by rows and cells instead of kept twice
    const baseTable = base.length === 1 && isTableBlock(base[0]) ? base[0] : null;
    if (baseTable || (!hasBase && base.length === 0)) {
      const table = mergeTable(baseTable, a[0], b[0], ctx);
      if (table) return [table];
    }
  }

  // A side already contained in the other (an earlier merge result): yield to
  // it, without the base blocks it still holds unchanged that the contained side
  // deleted (merged against the result of a deletion, they would come back)
  const aInB = isSubset(a, b);
  const bInA = isSubset(b, a);
  if (aInB !== bInA) {
    const [big, small] = aInB ? [b, a] : [a, b];
    // A conflict result keeps both versions on purpose, base blocks included
    if (big.some((block) => block.html.includes(MERGE_HINT_CLASS))) return big;
    const baseKeys = new Set(keysOf(base));
    const smallKeys = new Set(keysOf(small));
    return big.filter((block) => !baseKeys.has(block.key) || smallKeys.has(block.key));
  }
  if (aInB && bInA) return primary;

  // One side only added blocks around the untouched base blocks while the other edited
  // those very blocks in place (two people typing in the same document): apply the edits
  // to the blocks that are still there instead of keeping the old versions beside them
  const viaInsert = base.length > 0 && (editInPlace(base, b, a) ?? editInPlace(base, a, b));
  if (viaInsert) return viaInsert;

  // One side only deleted blocks: apply the deletions to whatever the other side
  // did (a deleted block the other side edited stays, as for delete vs edit)
  const viaDelete = base.length > 0 && (deleteBeside(base, a, b) ?? deleteBeside(base, b, a));
  if (viaDelete) return viaDelete;

  // Changes of the two sides that touch different base blocks: apply both
  // (a single block both replaced is resolved below, never split again)
  const oneBlock = base.length === 1 && a.length === 1 && b.length === 1;
  const viaHunks =
    hasBase && base.length > 0 && !oneBlock && !ctx.noHunks && mergeHunks(base, a, b, ctx);
  if (viaHunks) return viaHunks;

  // Independent inserts at the same place (both sides have a baseline)
  if (hasBase && base.length === 0) return [...primary, ...other];

  // Same number of blocks on all three sides: resolve block by block
  if (base.length > 1 && base.length === a.length && a.length === b.length) {
    return base.flatMap((bb, i) =>
      resolveRegion({ base: [bb], a: [a[i]], b: [b[i]], stable: false }, hasBase, ctx),
    );
  }

  return conflict(primary, other, ctx);
}

/**
 * `inserted` holds every base block in order plus others; `edited` has the base's
 * length. Returns `inserted` with each base block replaced by its edited counterpart,
 * or null when the shapes do not fit.
 */
function editInPlace(base, inserted, edited) {
  if (edited.length !== base.length || inserted.length <= base.length) return null;
  const keys = keysOf(inserted);
  // `edited` holding a block `inserted` added is not an in-place edit of the
  // base (an earlier merge result containing that insert): not this shape
  const baseKeys = new Set(keysOf(base));
  const added = new Set(keys.filter((key) => !baseKeys.has(key)));
  if (edited.some((block) => added.has(block.key))) return null;
  const positions = [];
  let from = 0;
  for (const block of base) {
    const at = keys.indexOf(block.key, from);
    if (at < 0) return null;
    positions.push(at);
    from = at + 1;
  }
  const out = [...inserted];
  positions.forEach((at, i) => {
    out[at] = edited[i];
  });
  return out;
}

/**
 * `deleted` is the base with some blocks removed and nothing else changed.
 * Returns `edited` without the base blocks `deleted` removed, wherever `edited`
 * still holds them unchanged (an edited one stays, as for delete vs edit), or
 * null when `deleted` is not such a pure deletion.
 */
function deleteBeside(base, deleted, edited) {
  if (deleted.length >= base.length) return null;
  const kept = new Set();
  let from = 0;
  for (const block of deleted) {
    let at = from;
    while (at < base.length && base[at].key !== block.key) at++;
    if (at === base.length) return null;
    kept.add(at);
    from = at + 1;
  }
  const drop = new Set();
  for (const [at, i] of lcsMatches(keysOf(base), keysOf(edited))) {
    if (!kept.has(at)) drop.add(i);
  }
  return edited.filter((_, i) => !drop.has(i));
}

/**
 * What one side changed in a region, as replacements of base ranges in base
 * order: [{start, end, blocks}] (start === end: blocks inserted there).
 */
function hunksOf(base, side) {
  const hunks = [];
  let bi = 0;
  let si = 0;
  const matches = [...lcsMatches(keysOf(base), keysOf(side)).entries()].sort((x, y) => x[0] - y[0]);
  for (const [at, i] of matches) {
    if (at > bi || i > si) hunks.push({ start: bi, end: at, blocks: side.slice(si, i) });
    bi = at + 1;
    si = i + 1;
  }
  if (bi < base.length || si < side.length) {
    hunks.push({ start: bi, end: base.length, blocks: side.slice(si) });
  }
  return { hunks: hunks.flatMap((h) => splitAtPairs(base, h)), matches: new Map(matches) };
}

/**
 * Whether `big` already holds `small`: the same block, or a table row whose
 * cells hold every version `small` has (an earlier merge of that row); with
 * `was`, the row `small` changed, its cells left as they were need not be held.
 */
function holdsBlock(big, small, was = null) {
  if (big.key === small.key) return true;
  if (!big.cells || !small.cells || big.cells.length !== small.cells.length) return false;
  return small.cells.every(
    (cell, i) =>
      (was?.cells && was.cells[i]?.key === cell.key) ||
      big.cells[i].versions.includes(cell.versions[0]),
  );
}

/**
 * Whether a new block is evidently a changed version of a base block: a table
 * of a table, a table row of a row it shares a cell with (in the same column).
 */
function sameThing(old, now) {
  if (old.cells && now.cells) return old.cells.some((cell, i) => now.cells[i]?.key === cell.key);
  return isTableBlock(old) && isTableBlock(now);
}

/**
 * A change replacing several blocks is split where a new block is evidently a
 * changed version of a base block (sameThing), in order: that pair becomes a
 * change of its own and meets the other side's change of the same table or
 * row, which then merges by rows or cells; the blocks around it change on
 * their own (a deletion next to an edit is then just a deletion).
 */
function splitAtPairs(base, hunk) {
  const olds = base.slice(hunk.start, hunk.end);
  const nows = hunk.blocks;
  if (olds.length + nows.length <= 2) return [hunk];
  // Longest run of pairs in order
  const n = olds.length;
  const m = nows.length;
  const best = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      best[i][j] = sameThing(olds[i], nows[j])
        ? best[i + 1][j + 1] + 1
        : Math.max(best[i + 1][j], best[i][j + 1]);
    }
  }
  if (best[0][0] === 0) return [hunk];
  const out = [];
  let i = 0;
  let j = 0;
  let fromI = 0;
  let fromJ = 0;
  const flush = (toI, toJ) => {
    if (toI > fromI || toJ > fromJ) {
      out.push({
        start: hunk.start + fromI,
        end: hunk.start + toI,
        blocks: nows.slice(fromJ, toJ),
      });
    }
  };
  while (i < n && j < m) {
    if (sameThing(olds[i], nows[j]) && best[i][j] === best[i + 1][j + 1] + 1) {
      flush(i, j);
      out.push({ start: hunk.start + i, end: hunk.start + i + 1, blocks: [nows[j]] });
      i++;
      j++;
      fromI = i;
      fromJ = j;
    } else if (best[i + 1][j] >= best[i][j + 1]) i++;
    else j++;
  }
  flush(n, m);
  return out;
}

/**
 * Apply both sides' changes when they touch different base blocks (diff3).
 * Inserts at the same place keep both, the primary's first; both sides
 * replacing the same single block resolve that block on its own (a table both
 * changed is merged there). Returns null when changes overlap otherwise.
 */
function mergeHunks(base, a, b, ctx) {
  const ha = hunksOf(base, a);
  const hb = hunksOf(base, b);
  const isInsert = (h) => h.start === h.end;
  const single = (h) => h.end - h.start === 1 && h.blocks.length === 1;
  // A change whose blocks are all in the other side's overlapping change was
  // applied there already (an earlier merge result): it yields to that one
  const within = (x, y) => {
    if (x.blocks.length === 0) return false;
    // The base block a one-block change replaced: what it left unchanged need not be held
    const was = single(x) ? base[x.start] : null;
    return x.blocks.every((block) => y.blocks.some((o) => holdsBlock(o, block, was)));
  };
  // A deletion around an edit or insert of the other side: delete the rest,
  // keep that (as for delete vs edit)
  const splitDeletions = (side, other) => {
    for (let again = true; again; ) {
      again = false;
      for (const d of side.hunks) {
        if (d.blocks.length > 0 || isInsert(d)) continue;
        const e = other.hunks.find((h) =>
          isInsert(h)
            ? d.start < h.start && h.start < d.end
            : d.start <= h.start && h.end <= d.end && (h.start > d.start || h.end < d.end),
        );
        if (!e) continue;
        const parts = [
          { start: d.start, end: e.start, blocks: [] },
          { start: isInsert(e) ? e.start : e.end, end: d.end, blocks: [] },
        ].filter((h) => h.end > h.start);
        side.hunks.splice(side.hunks.indexOf(d), 1, ...parts);
        again = true;
        break;
      }
    }
  };
  splitDeletions(ha, hb);
  splitDeletions(hb, ha);
  const yielded = new Set();
  for (const x of ha.hunks) {
    for (const y of hb.hunks) {
      if (isInsert(x) && isInsert(y)) continue;
      // An insert at either edge of the other's change touches it
      const touches =
        (isInsert(x) && (x.start === y.start || x.start === y.end)) ||
        (isInsert(y) && (y.start === x.start || y.start === x.end));
      if (touches) {
        const insert = isInsert(x) ? x : y;
        if (within(insert, insert === x ? y : x)) {
          yielded.add(insert);
          continue;
        }
      }
      const overlaps = isInsert(x)
        ? y.start < x.start && x.start < y.end
        : isInsert(y)
          ? x.start < y.start && y.start < x.end
          : x.start < y.end && y.start < x.end;
      if (!overlaps) continue;
      // A pure deletion inside the other's change: both deleting is one
      // deletion, and against an edit the edit stays (as for delete vs edit)
      const deletionIn = (d, h) =>
        d.blocks.length === 0 && d.start >= h.start && d.end <= h.end && !isInsert(d);
      if (deletionIn(x, y) !== deletionIn(y, x)) {
        yielded.add(deletionIn(x, y) ? x : y);
        continue;
      }
      // Covered: blocks and base range both inside the other's change
      const covered = (h, o) => within(h, o) && h.start >= o.start && h.end <= o.end;
      if (covered(x, y) !== covered(y, x)) {
        yielded.add(covered(x, y) ? x : y);
        continue;
      }
      if (within(x, y) !== within(y, x)) {
        yielded.add(within(x, y) ? x : y);
        continue;
      }
      // The same base range changed on both sides: resolved on its own below
      if (x.start === y.start && x.end === y.end) continue;
      return null;
    }
  }
  for (const side of [ha, hb]) side.hunks = side.hunks.filter((h) => !yielded.has(h));
  const [primary, other] = ctx.primary === "a" ? [ha, hb] : [hb, ha];
  const out = [];
  const insertsAt = (side, p) => side.hunks.filter((h) => isInsert(h) && h.start === p);
  const replacingAt = (side, p) => side.hunks.find((h) => !isInsert(h) && h.start === p);
  for (let p = 0; p <= base.length; ) {
    const ins = [...insertsAt(primary, p), ...insertsAt(other, p)].flatMap((h) => h.blocks);
    for (const block of ins)
      if (!out.some((o) => o.key === block.key && ins.includes(o))) out.push(block);
    if (p === base.length) break;
    const rp = replacingAt(primary, p);
    const ro = replacingAt(other, p);
    if (rp && ro) {
      if (sameKeys(rp.blocks, ro.blocks)) out.push(...rp.blocks);
      else {
        // Only this range: whatever happens to it, the rest still merges
        const [ra, rb] = ctx.primary === "a" ? [rp, ro] : [ro, rp];
        const region = { base: base.slice(p, rp.end), a: ra.blocks, b: rb.blocks, stable: false };
        out.push(...resolveRegion(region, true, { ...ctx, noHunks: true }));
      }
      p = rp.end;
    } else if (rp || ro) {
      out.push(...(rp ?? ro).blocks);
      p = (rp ?? ro).end;
    } else {
      // Untouched by both: the primary's copy
      const i = primary.matches.get(p);
      out.push((ctx.primary === "a" ? a : b)[i] ?? base[p]);
      p++;
    }
  }
  return out;
}

function conflict(primarySeg, otherSeg, ctx) {
  const id = hash(
    [keysOf(primarySeg).join("\n"), keysOf(otherSeg).join("\n")].sort().join("\u0000"),
  );
  const by = ctx.primary === "a" ? ctx.authors.b : ctx.authors.a;
  const [first, ...rest] = otherSeg;
  return [...primarySeg, withHint(first, id, by), ...rest];
}

/**
 * Drop a conflict block that repeats the one right before it (two simultaneous
 * merges each keeping the same duplicate). Only an exact repeat goes: the same
 * conflict id elsewhere is the same edit in another place (two rows or
 * paragraphs edited alike), and dropping that would lose it.
 */
function dedupeConflicts(blocks) {
  const idsOf = (b) => [...b.html.matchAll(/data-conflict="([^"]+)"/g)].map((m) => m[1]).join(" ");
  return blocks.filter((b, i) => {
    const ids = idsOf(b);
    if (ids === "" || i === 0) return true;
    const prev = blocks[i - 1];
    return !(prev.key === b.key && idsOf(prev) === ids);
  });
}

// ─── Tables ───────────────────────────────────────────────────────────────────
// A table is one block, so any two concurrent changes to it used to conflict
// and keep the whole table twice. When both sides changed the same table it is
// merged one level deeper instead, by the same rules: its rows are aligned and
// resolved like blocks, and a row both sides changed is merged cell by cell.
// Only a cell both sides changed differently is a conflict: it keeps both
// texts, the other side's in a marked part of the cell. Rows and cells compare
// by content, not attributes (an editor restyling a table changes nothing).
// Tables whose shape cannot be lined up safely keep the old behaviour (both
// whole): columns added or removed, merged cells, nested tables.

const SECTION_TAGS = new Set(["THEAD", "TBODY", "TFOOT"]);

const isTableBlock = (block) => !block.wrap && /^<table[\s>]/i.test(block.html);

/** Normalized HTML inside an element, merge hints removed. */
function innerKey(element) {
  const clone = element.cloneNode(true);
  for (const hint of clone.querySelectorAll(`.${MERGE_HINT_CLASS}`)) hint.remove();
  return normalizeHtml(clone.innerHTML);
}

/**
 * The versions a cell holds: its own content and, after a cell conflict, the
 * other side's (a child div holding a merge hint). Lets a later merge see that
 * a version is already in the cell rather than conflicting with it again.
 */
function cellVersions(cell) {
  const clone = cell.cloneNode(true);
  const versions = [];
  for (const child of [...clone.children]) {
    if (child.tagName === "DIV" && child.querySelector(`.${MERGE_HINT_CLASS}`)) {
      versions.push(innerKey(child));
      child.remove();
    }
  }
  versions.unshift(innerKey(clone));
  return versions;
}

/** A table as rows of cells, or null when its shape is not one this merge handles. */
function parseTable(html) {
  const doc = parseHtmlBody(html);
  const table = doc.body.firstElementChild;
  if (!table || table.tagName !== "TABLE" || doc.body.children.length !== 1) return null;
  if (table.querySelector("table")) return null;
  for (const cell of table.querySelectorAll("[colspan], [rowspan]")) {
    if (Number(cell.getAttribute("colspan") ?? 1) > 1) return null;
    if (Number(cell.getAttribute("rowspan") ?? 1) > 1) return null;
  }
  const rows = [];
  for (const tr of table.querySelectorAll("tr")) {
    const section = SECTION_TAGS.has(tr.parentElement.tagName) ? tr.parentElement.tagName : "TBODY";
    const cells = [];
    for (const cell of tr.children) {
      if (cell.tagName !== "TD" && cell.tagName !== "TH") return null;
      cells.push({
        key: `${cell.tagName}:${innerKey(cell)}`,
        html: cell.outerHTML,
        inner: cell.innerHTML,
        tag: cell.tagName.toLowerCase(),
        shell: shellOf(cell),
        versions: cellVersions(cell),
      });
    }
    rows.push({
      key: `${section}|${cells.map((c) => c.key).join("\u0001")}`,
      html: tr.outerHTML,
      section,
      shell: shellOf(tr),
      cells,
    });
  }
  // Every row as wide as every other: a table this merge can line up by column
  const widths = new Set(rows.map((row) => row.cells.length));
  if (widths.size > 1) return null;
  const sectionShells = {};
  let extras = "";
  for (const child of table.children) {
    if (SECTION_TAGS.has(child.tagName)) sectionShells[child.tagName] ??= shellOf(child);
    else if (child.tagName !== "TR") extras += child.outerHTML; // caption, colgroup
  }
  // A table without rows (both sides deleted different ones) has no width to compare
  return {
    shell: shellOf(table),
    extras,
    sectionShells,
    rows,
    width: rows[0]?.cells.length ?? null,
  };
}

/** A cell both sides changed: one version, or both when they truly differ. */
function mergeCell(base, a, b, ctx) {
  if (a.key === base?.key) return b.html;
  if (b.key === base?.key) return a.html;
  const primary = ctx.primary === "a" ? a : b;
  const other = ctx.primary === "a" ? b : a;
  if (a.key === b.key) return primary.html;
  // One side already holds the other's version (an earlier merge of this cell)
  // or the other emptied it (delete vs edit keeps the edit)
  const holds = (x, y) => x.versions.includes(y.versions[0]) || y.versions[0] === "";
  if (holds(a, b) !== holds(b, a)) return holds(a, b) ? a.html : b.html;
  if (holds(a, b)) return primary.html;
  const id = hash([primary.key, other.key].sort().join("\u0000"));
  const by = ctx.primary === "a" ? ctx.authors.b : ctx.authors.a;
  return `${primary.shell}${primary.inner}<div>${other.inner}${hintSpan(id, by)}</div></${primary.tag}>`;
}

/** A row both sides changed, merged cell by cell; null when the cells do not line up. */
function mergeRow(base, a, b, ctx) {
  if (!base.cells || a.section !== b.section) return null;
  const width = base.cells.length;
  if (a.cells.length !== width || b.cells.length !== width) return null;
  const primary = ctx.primary === "a" ? a : b;
  const cells = base.cells.map((cell, i) => mergeCell(cell, a.cells[i], b.cells[i], ctx));
  const html = `${primary.shell}${cells.join("")}</tr>`;
  return { key: normalizeHtml(html), html, section: primary.section };
}

function renderTable(table, sectionShells, rows) {
  let out = table.shell + table.extras;
  let open = null;
  for (const row of rows) {
    if (row.section !== open) {
      if (open) out += `</${open.toLowerCase()}>`;
      open = row.section;
      out += sectionShells[open] ?? `<${open.toLowerCase()}>`;
    }
    out += row.html;
  }
  if (open) out += `</${open.toLowerCase()}>`;
  return `${out}</table>`;
}

/**
 * Merge a table both sides changed. `base` is null without a baseline; the two
 * tables are then merged only when they share a row (two tables created
 * independently are not one table).
 * @returns {{key: string, html: string}|null} null to keep both tables whole
 */
function mergeTable(base, a, b, ctx) {
  const ta = parseTable(a.html);
  const tb = parseTable(b.html);
  const t0 = base ? parseTable(base.html) : null;
  if (!ta || !tb || (base && !t0)) return null;
  // A column added or removed: rows cannot be lined up cell by cell
  const widths = new Set([ta.width, tb.width, t0?.width].filter((w) => typeof w === "number"));
  if (widths.size > 1) return null;

  let regions;
  if (t0) {
    regions = alignThreeWay(t0.rows, ta.rows, tb.rows);
  } else {
    const shared = lcsMatches(keysOf(ta.rows), keysOf(tb.rows));
    if (shared.size === 0) return null;
    const common = [...shared.keys()].sort((x, y) => x - y).map((i) => ta.rows[i]);
    regions = alignThreeWay(common, ta.rows, tb.rows);
  }
  const rowCtx = { primary: ctx.primary, authors: ctx.authors, level: "row" };
  const rows = dedupeConflicts(regions.flatMap((r) => resolveRegion(r, Boolean(t0), rowCtx)));
  const [primary, other] = ctx.primary === "a" ? [ta, tb] : [tb, ta];
  const html = renderTable(primary, { ...other.sectionShells, ...primary.sectionShells }, rows);
  return { key: normalizeHtml(html), html };
}

// ─── Text boxes ───────────────────────────────────────────────────────────────
// Boxes (textBoxes.js) are placed objects with ids, like media: their order in
// the HTML means nothing. So they are not blocks of the flow merge (a box
// deleted next to an edited paragraph would make the whole stretch conflict)
// but merged by id (text boxes DESIGN §6): each geometry value is taken from
// the side that changed it (both changed it: the primary side), the inner HTML
// is merged by the block merge as a document of its own, a box deleted on one
// side goes unless the other side changed it, and a new box from either side
// stays. The implicit main box (the unwrapped text before the first box) is
// merged by the flow merge as before.

const BOX_FIELDS = ["x", "y", "w"];

/**
 * A side's main text and boxes by id. Ids an old client duplicated (or lost)
 * get deterministic replacements, so both writers merging agree on them.
 */
function splitBoxes(html) {
  let unnamed = 0;
  const parsed = parseContent(html, {
    newId: (id) => (id ? `${id}~2` : `tb_unnamed_${++unnamed}`),
  });
  return { main: parsed.main, boxes: new Map(parsed.boxes.map((box) => [box.id, box])) };
}

const sameBoxContent = (x, y) =>
  BOX_FIELDS.every((f) => x[f] === y[f]) && normalizeHtml(x.html) === normalizeHtml(y.html);

/** One box both sides have; `base` is null when both added it. */
function mergeBox(base, a, b, ctx) {
  const primary = ctx.primary === "a" ? a : b;
  const merged = { id: a.id };
  for (const f of BOX_FIELDS) {
    if (base && a[f] === base[f]) merged[f] = b[f];
    else if (base && b[f] === base[f]) merged[f] = a[f];
    else merged[f] = primary[f];
  }
  // The inner HTML is a whole document of its own: none of the outer level's flags
  const innerCtx = { primary: ctx.primary, authors: ctx.authors };
  merged.html = mergeHtml(base ? base.html : null, a.html, b.html, innerCtx);
  return merged;
}

/**
 * A side that wrapped the implicit main box (its first move or resize) holds
 * the base's main text in a new box and has no main text left. Its main text
 * is then that box: the other side's edits of the main text are merged into it
 * instead of reappearing unwrapped at the origin.
 * @returns {string|null} the id of that box
 */
function wrappedMainId(base, side) {
  if (!base || base.main.trim() === "" || side.main.trim() !== "") return null;
  for (const [id, box] of side.boxes) {
    if (!base.boxes.has(id) && normalizeHtml(box.html) === normalizeHtml(base.main)) return id;
  }
  return null;
}

function mergeWithBoxes(base, l, r, ctx) {
  const b0 = typeof base === "string" ? splitBoxes(base) : null;
  const a = splitBoxes(l);
  const b = splitBoxes(r);

  // Main text first; a wrap on one side takes the other side's main text in
  let main;
  const wrapA = wrappedMainId(b0, a);
  const wrapB = wrapA ? null : wrappedMainId(b0, b);
  if (wrapA || wrapB) {
    const [wrapper, other, id] = wrapA ? [a, b, wrapA] : [b, a, wrapB];
    const box = wrapper.boxes.get(id);
    const inner = wrapA
      ? mergeHtml(b0.main, box.html, other.main, { primary: ctx.primary, authors: ctx.authors })
      : mergeHtml(b0.main, other.main, box.html, { primary: ctx.primary, authors: ctx.authors });
    wrapper.boxes.set(id, { ...box, html: inner });
    main = "";
  } else {
    main = mergeHtml(b0 ? b0.main : null, a.main, b.main, ctx);
  }

  // Boxes by id, in the primary side's order, then the other side's new ones
  const [first, second] = ctx.primary === "a" ? [a, b] : [b, a];
  const ids = [...first.boxes.keys()];
  for (const id of second.boxes.keys()) if (!first.boxes.has(id)) ids.push(id);
  const boxes = [];
  for (const id of ids) {
    const was = b0?.boxes.get(id) ?? null;
    const inA = a.boxes.get(id);
    const inB = b.boxes.get(id);
    if (inA && inB) {
      boxes.push(mergeBox(was, inA, inB, ctx));
      continue;
    }
    // On one side only: new there, or deleted on the other side. A deleted box
    // goes unless this side changed it meanwhile (delete vs edit keeps the edit).
    const kept = inA ?? inB;
    if (was && sameBoxContent(was, kept)) continue;
    boxes.push(kept);
  }
  return serializeContent({ main, boxes });
}

/** Lossless last resort: both versions whole, the other one marked. */
function keepBoth(primaryHtml, otherHtml, by) {
  const id = hash([primaryHtml, otherHtml].sort().join("\u0000"));
  return primaryHtml + withHint({ html: `<div>${otherHtml}</div>` }, id, by).html;
}

/**
 * The block merge of two versions of some HTML (a note's, or a box's inner HTML)
 * with the primary side already chosen.
 * @param {string|null} base - null when there is no baseline
 */
function mergeHtml(base, l, r, ctx) {
  if (l === r) return l;
  const hasBase = typeof base === "string";
  if (hasBase && base === l) return r;
  if (hasBase && base === r) return l;
  const a = segmentBlocks(l);
  const b = segmentBlocks(r);
  let regions;
  if (hasBase) {
    regions = alignThreeWay(segmentBlocks(base), a, b);
  } else {
    // No baseline: the blocks both sides share act as the anchors
    const commonKeys = lcsMatches(keysOf(a), keysOf(b));
    const common = [...commonKeys.keys()].sort((x, y) => x - y).map((i) => a[i]);
    regions = alignThreeWay(common, a, b);
  }
  const merged = regions.flatMap((region) => resolveRegion(region, hasBase, ctx));
  return renderBlocks(dedupeConflicts(merged));
}

/**
 * Merge two versions of a note's HTML.
 *
 * @param {string|null|undefined} base - last state known on both sides; omit when unknown
 * @param {string} local
 * @param {string} remote
 * @param {{localModified?: number, remoteModified?: number, localAuthor?: string, remoteAuthor?: string}} [opts]
 * @returns {string}
 */
export function mergeContent(base, local, remote, opts = {}) {
  const l = local ?? "";
  const r = remote ?? "";
  if (l === r) return l;
  const hasBase = typeof base === "string";
  if (hasBase && base === l) return r;
  if (hasBase && base === r) return l;

  const { localModified = 0, remoteModified = 0, localAuthor, remoteAuthor } = opts;
  let primary;
  if (localModified !== remoteModified) primary = localModified > remoteModified ? "a" : "b";
  else primary = hash(normalizeHtml(l)) <= hash(normalizeHtml(r)) ? "a" : "b";
  const authors = { a: localAuthor, b: remoteAuthor };

  try {
    if (!htmlParser()) throw new Error("no HTML parser");
    const ctx = { primary, authors };
    // Notes without boxes take the merge as it was, unchanged
    if ([base, l, r].some(mayHaveBoxes)) return mergeWithBoxes(base, l, r, ctx);
    return mergeHtml(base, l, r, ctx);
  } catch (e) {
    console.warn("[textMerge] Block merge failed, keeping both versions:", e);
    return primary === "a" ? keepBoth(l, r, authors.b) : keepBoth(r, l, authors.a);
  }
}
