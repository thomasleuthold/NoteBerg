/**
 * Taking a stored version of the open note into the editor, split so that the
 * heavy part runs off the main thread (review P4, 4.7; DESIGN §10.4b).
 *
 * The editor holds the note; storage (IndexedDB, or the server on the Nextcloud
 * app) holds a version that may have changed. The merge of the two used to run
 * on the main thread with the editor's whole note, which stalls writing for
 * 100 ms and more on a large note. Now:
 *
 *  1. editorView() (main thread, cheap): what the editor holds, compactly. Each
 *     stroke as its id and version, except the strokes it changed that storage
 *     has not confirmed yet, which go whole. Everything small goes as it is.
 *  2. computeTakeIn() (a worker, or inline): the editor's note is rebuilt from
 *     the view and the stored strokes, merged with the stored version exactly as
 *     before (noteMerge.js), and only what the editor must change comes back.
 *  3. The editor applies that delta (NoteCanvas._applyTakeIn).
 *
 * Rebuilding works because storage holds every stroke the editor holds unchanged:
 * the editor's saves are merged into storage, and a stroke it changed but storage
 * has not confirmed travels whole. A held stroke storage lacks without having
 * deleted it is reported as `missing`, and the editor saves it again.
 */

import { mergeNoteParts, SCALAR_FIELDS, storedMedia } from "./noteMerge.js";

const list = (value) => (Array.isArray(value) ? value : []);
const keyOf = (item) => item.id ?? JSON.stringify(item);

/**
 * What the editor holds, for computeTakeIn(). Main thread; O(strokes), no copies
 * of stroke data except the unconfirmed ones.
 * @param {object} data - the editor's note (noteData), stamped
 * @param {Iterable<object>} [unconfirmed] - strokes changed since storage last confirmed a save
 */
export function editorView(data, unconfirmed = []) {
  const held = [];
  const soft = [];
  for (const stroke of list(data.strokes)) {
    if (stroke._deleted) soft.push(keyOf(stroke));
    else held.push([keyOf(stroke), stroke.v ?? null]);
  }
  const view = {
    held,
    soft,
    changed: [...unconfirmed].filter((s) => s && !s._deleted),
    deletedStrokes: list(data.deletedStrokes),
    tombstones: data.tombstones,
    shifts: data.shifts,
    fieldVersions: data.fieldVersions,
    media: storedMedia(list(data.media)),
    deletedMedia: list(data.deletedMedia),
    tasks: list(data.tasks),
    deletedTasks: list(data.deletedTasks),
    recordings: list(data.recordings),
    deletedRecordings: list(data.deletedRecordings),
    content: data.content,
    modified: data.modified,
    version: data.version,
    recognition: data.recognition,
  };
  for (const field of SCALAR_FIELDS) view[field] = data[field];
  return view;
}

/** The ink of a stroke list as ids and versions, to tell whether two lists are the same. */
function inkOf(pairs, deleted) {
  return JSON.stringify([
    pairs.map(([id, v]) => `${id}@${v ?? ""}`).sort(),
    [...list(deleted)].sort(),
  ]);
}
const strokePairs = (strokes) => list(strokes).map((s) => [keyOf(s), s.v ?? null]);
const tasksOf = (tasks, deleted) => JSON.stringify([list(tasks), [...list(deleted)].sort()]);

/**
 * mergeNoteParts(), without merging the strokes when both sides hold exactly the
 * same ones (the common case of someone else only typing): merging thousands
 * of identical strokes, and replaying the insert spaces on each, gives the
 * stored list back. Every other part merges as always. Recognition comes out the
 * same too: it is chosen by whether a side's ink equals the merged ink, and
 * both sides' ink is then the same (empty here, the stored list in truth).
 */
function mergeParts(mine, stored, view, storedStrokes) {
  const sameStrokes =
    view.changed.length === 0 &&
    view.held.length === storedStrokes.length &&
    JSON.stringify(list(view.shifts)) === JSON.stringify(list(stored.shifts)) &&
    inkOf(view.held, view.deletedStrokes) ===
      inkOf(strokePairs(storedStrokes), stored.deletedStrokes);
  if (!sameStrokes) return mergeNoteParts(mine, stored);
  const merged = mergeNoteParts({ ...mine, strokes: [] }, { ...stored, strokes: [] });
  merged.parts.strokes = storedStrokes;
  return merged;
}

/**
 * Merge a stored version into what the editor holds, and say what changes.
 * Pure, and runs anywhere (worker or main thread).
 * @param {ReturnType<typeof editorView>} view
 * @param {object} stored - the note as stored (encrypted fields already decrypted)
 * @returns {object} the delta; see NoteCanvas._applyTakeIn
 */
export function computeTakeIn(view, stored) {
  const storedStrokes = list(stored.strokes);
  const storedById = new Map(storedStrokes.map((s) => [keyOf(s), s]));
  const changedById = new Map(view.changed.map((s) => [keyOf(s), s]));
  const storedDeleted = new Set(list(stored.deletedStrokes));

  // The editor's strokes, rebuilt
  const mineStrokes = [];
  const missing = [];
  for (const [id, v] of view.held) {
    const changed = changedById.get(id);
    if (changed) {
      mineStrokes.push(changed);
      continue;
    }
    const there = storedById.get(id);
    if (there) {
      // Storage has a newer version or the same: the editor's older copy would
      // lose the merge anyway, so its data is not needed
      mineStrokes.push(there.v === v ? there : { ...there, v });
    } else if (!storedDeleted.has(id)) {
      missing.push(id);
    }
  }
  const heldIds = new Set(view.held.map(([id]) => id));
  for (const [id, stroke] of changedById) if (!heldIds.has(id)) mineStrokes.push(stroke);

  const mine = { ...view, strokes: mineStrokes };
  const { parts } = mergeParts(mine, { ...stored, strokes: storedStrokes }, view, storedStrokes);

  // --- What changed for the editor's strokes ---
  const heldV = new Map(view.held);
  const soft = new Set(view.soft);
  const missingSet = new Set(missing);
  const added = [];
  const changed = [];
  let restored = false;
  const merged = new Set();
  for (const stroke of parts.strokes) {
    const id = keyOf(stroke);
    merged.add(id);
    if (!heldV.has(id)) {
      if (soft.has(id)) restored = true;
      added.push(stroke);
    } else if ((heldV.get(id) ?? null) !== (stroke.v ?? null)) {
      changed.push(stroke);
    }
  }
  const removed = view.held
    .map(([id]) => id)
    .filter((id) => !merged.has(id) && !missingSet.has(id));
  // Anything but strokes only arriving rebuilds the list, in the merged order
  // (strokes the editor holds but storage lacks stay, at the end)
  const rebuild = restored || removed.length > 0;
  const order = rebuild ? [...parts.strokes.map(keyOf), ...missing] : null;

  // What the editor holds that storage lacks: only then is there anything to write
  const mergedPairs = [...strokePairs(parts.strokes), ...missing.map((id) => [id, heldV.get(id)])];
  const strokesAhead =
    missing.length > 0 ||
    inkOf(mergedPairs, parts.deletedStrokes) !==
      inkOf(strokePairs(storedStrokes), stored.deletedStrokes);
  const tasksBefore = tasksOf(view.tasks, view.deletedTasks);
  const tasksAfter = tasksOf(parts.tasks, parts.deletedTasks);
  const shownRecordings = view.recordings.filter((r) => !r.deleted);

  return {
    strokes: { added, changed, removed, order, missing },
    strokesAhead,
    strokesChanged: rebuild || changed.length > 0,
    mediaChanged:
      JSON.stringify(parts.media) !== JSON.stringify(view.media) ||
      parts.pdfSource !== view.pdfSource,
    backgroundChanged: parts.background !== view.background,
    tasksChanged: tasksAfter !== tasksBefore,
    tasksAhead: tasksAfter !== tasksOf(stored.tasks, stored.deletedTasks),
    recordingsChanged: JSON.stringify(parts.recordings) !== JSON.stringify(shownRecordings),
    parts: {
      deletedStrokes: parts.deletedStrokes,
      media: parts.media,
      deletedMedia: parts.deletedMedia,
      tasks: parts.tasks,
      deletedTasks: parts.deletedTasks,
      recordings: parts.recordings,
      deletedRecordings: parts.deletedRecordings,
      tombstones: parts.tombstones,
      shifts: parts.shifts,
      fieldVersions: parts.fieldVersions,
      penPresets: parts.penPresets,
      pdfSource: parts.pdfSource,
      background: parts.background,
      title: parts.title,
      recognition: parts.recognition,
    },
    stored: {
      modified: stored.modified,
      lastSyncedEtag: stored.lastSyncedEtag,
      synced: stored.synced,
      deleted: stored.deleted,
      content: typeof stored.content === "string" ? stored.content : "",
      lastModifiedBy: stored.lastModifiedBy,
    },
  };
}
