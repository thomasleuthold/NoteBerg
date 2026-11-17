/**
 * The text of an open note, kept in step with what is stored.
 *
 * While a note is open, someone else can change its text: a sync downloads a
 * collaborator's (or another device's) version, or the Nextcloud app merges one
 * in on save. Without this the editor would keep showing its own text, and its
 * next save would write that over the other version.
 *
 * Two rules do the work:
 *  - Every save says which stored text it replaces (`expected`). The storage side
 *    refuses a save whose expectation no longer holds, and the refusal leads to
 *    reconcile(), so a save never overwrites text this editor has not seen.
 *  - reconcile() reads the stored text and, when someone else changed it, merges
 *    it three-way with the editor's text (textMerge.js) and shows the result.
 *    The base is the text the editor and storage last agreed on: the editor's
 *    newest save that storage accepted (or the last reconcile). That is what a
 *    sync uploaded and a collaborator's version builds on, and it is in the
 *    editor's own form, so the editor's normalization never reads as an edit.
 *
 * Storage access is injected; NoteCanvas supplies the build's (the native
 * storage worker, or WebDAV on the Nextcloud app build).
 */

import { mergeContent } from "../../modules/textMerge.js";

/**
 * @typedef {object} StoredText
 * @property {string} content - the stored HTML
 * @property {string} [author] - who stored it last (labels a conflicting block)
 */

export class LiveText {
  /**
   * @param {object} io
   * @param {string} io.initial - the stored text the editor was loaded with, as stored
   * @param {(html: string, expected: string) => Promise<"saved"|"stale"|"failed">} io.write -
   *   store `html` if the stored text is still `expected`; "stale" when refused
   *   because it is not
   * @param {(expected: string) => Promise<StoredText|null>} io.read - the stored text,
   *   read after every write issued so far; null when it cannot be read (a locked app)
   * @param {() => string} io.getEditorText
   * @param {(html: string) => void} io.setEditorText
   * @param {(texts: {baseline: string, editorText: string, remote: string, author?: string})
   *   => Promise<string|null>} [io.mergeText] - the three-way merge off the main
   *   thread (a worker); without it the merge runs here
   */
  constructor({ initial, write, read, getEditorText, setEditorText, mergeText }) {
    this._write = write;
    this._read = read;
    this._mergeText = mergeText ?? null;
    this._getEditorText = getEditorText;
    this._setEditorText = setEditorText;
    /** What storage holds as far as this editor knows: the last text loaded or sent. */
    this.expected = initial ?? "";
    /** The text editor and storage last agreed on, in the editor's form: the merge base. */
    this.baseline = getEditorText();
    // Saves are numbered so a late acknowledgement never moves the base backwards
    this._seq = 0;
    this._baselineSeq = 0;
    this._running = null;
    this._again = false;
    this._closed = false;
  }

  /** The user changed the text: store it, unless storage moved on meanwhile. */
  save(html) {
    if (this._closed) return;
    const expected = this.expected;
    this.expected = html;
    const seq = ++this._seq;
    Promise.resolve(this._write(html, expected)).then(
      (outcome) => {
        if (outcome === "saved") this._agreeOn(html, seq);
        else if (outcome === "stale") this.reconcile();
        // Storage still holds what it held: say so, unless a newer save has been issued
        else if (outcome === "failed" && seq === this._seq) this.expected = expected;
      },
      () => {},
    );
  }

  /** Storage holds `html` (save number `seq`), and the editor's text descends from it. */
  _agreeOn(html, seq) {
    if (seq <= this._baselineSeq) return;
    this._baselineSeq = seq;
    this.baseline = html;
  }

  /**
   * Take in text someone else stored. Safe to call often: concurrent calls share
   * one run, and a call arriving during a run makes it look once more.
   * @returns {Promise<void>}
   */
  reconcile() {
    if (this._closed) return Promise.resolve();
    if (this._running) {
      this._again = true;
      return this._running;
    }
    this._running = this._run().finally(() => {
      this._running = null;
    });
    return this._running;
  }

  /** The note is closing: nothing more is read or written. */
  close() {
    this._closed = true;
  }

  /** What the editor shows and builds on now, for a merge computed elsewhere (applyMerged). */
  snapshot() {
    return { baseline: this.baseline, editorText: this._getEditorText(), expected: this.expected };
  }

  /**
   * Take in text merged elsewhere (the Nextcloud app's note-file worker): the
   * stored `remote` and, when both sides changed, `merged` (else the stored text
   * is what the editor shows). Synchronous, like takeIn().
   * @returns {boolean} false when it could not be taken in now: a reconcile is
   *   under way, or the editor's text changed since `editorText` was read (the
   *   merge no longer fits it); nothing was changed then
   */
  applyMerged({ remote, merged, editorText }) {
    if (this._closed || this._running) return false;
    if (typeof remote !== "string" || remote === this.expected) return true;
    if (this._getEditorText() !== editorText) return false;
    this._apply(remote, editorText, merged ?? remote);
    return true;
  }

  /** Whether takeIn() would take text in now. */
  get canTakeIn() {
    return !this._closed && !this._running;
  }

  /**
   * Take in text read by the caller (the Nextcloud build's live update reads the
   * whole note once, for its strokes and its text). Synchronous, so the caller can
   * move its own tracking in the same step.
   * @param {StoredText} stored
   * @returns {boolean} false when it could not be taken in now (a reconcile is
   *   under way, or the note is closing); nothing was changed then
   */
  takeIn(stored) {
    if (this._closed || this._running) return false;
    this._takeIn(stored);
    return true;
  }

  async _run() {
    do {
      this._again = false;
      const expected = this.expected;
      const stored = await this._read(expected);
      if (this._closed) return;
      await this._takeInMerging(stored, expected);
    } while (this._again && !this._closed);
  }

  /**
   * _takeIn(), with a merge of both sides' changes done by `mergeText` (off the
   * main thread). Applied only if the editor's text did not change meanwhile;
   * otherwise it is read and merged again.
   */
  async _takeInMerging(stored, expected) {
    if (typeof stored?.content !== "string") return;
    const remote = stored.content;
    if (remote === expected || remote === this.expected) return;
    const editorText = this._getEditorText();
    // Only one side changed: nothing to merge, and nothing heavy to do
    if (!this._mergeText || editorText === this.baseline || remote === editorText) {
      this._takeIn(stored, expected);
      return;
    }
    const merged = await this._mergeText({
      baseline: this.baseline,
      editorText,
      remote,
      author: stored.author,
    });
    if (this._closed) return;
    if (typeof merged !== "string" || this._getEditorText() !== editorText) {
      this._again = true;
      return;
    }
    this._apply(remote, editorText, merged);
  }

  /** Merge stored text into the editor; `expected` is what storage held when it was read. */
  _takeIn(stored, expected = this.expected) {
    if (typeof stored?.content !== "string") return;

    const remote = stored.content;
    // Only our own writes since: nothing to take in. (The second test covers a
    // read that already includes a save issued while it was under way.)
    if (remote === expected || remote === this.expected) return;

    const editorText = this._getEditorText();
    // The editor's version is the newer one; the stored version's block goes
    // right after it, marked, when both changed the same block
    const merged = mergeContent(this.baseline, editorText, remote, {
      localModified: 1,
      remoteModified: 0,
      remoteAuthor: stored.author,
    });
    this._apply(remote, editorText, merged);
  }

  /** Show `merged` (the stored `remote` merged with `editorText`) and agree on what is stored. */
  _apply(remote, editorText, merged) {
    const edited = editorText !== this.baseline;
    if (merged !== editorText) this._setEditorText(merged);
    const shown = this._getEditorText();
    this.expected = remote;
    if (!edited || merged === remote) {
      // The editor now shows exactly what is stored
      this._agreeOn(shown, ++this._seq);
    } else {
      // Until the merge is stored, the stored version is all the two share: a
      // later version from the other side builds on it, not on our merge
      this._agreeOn(remote, ++this._seq);
      this.save(shown);
    }
  }
}
