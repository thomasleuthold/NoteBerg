/**
 * src/components/NoteCanvas/liveText.test.js
 * An open note's text while someone else changes the stored copy (a sync
 * downloads a collaborator's version): the editor takes the other version in,
 * merged with its own edits, and never writes over text it has not seen.
 *
 * The store models the native storage worker: requests are handled in the order
 * they are sent, and a save whose expected text no longer matches is refused and
 * reported — which is what makes the editor reconcile.
 */

import { describe, expect, it } from "vitest";
import { LiveText } from "./liveText.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(initial, { beforeWrite = () => {} } = {}) {
  const store = { content: initial, author: "bob", writes: [], refused: 0 };
  const editor = { text: initial, set: 0 };
  let live;
  const queue = []; // the worker's message queue, processed in order
  const run = async () => {
    while (queue.length) await queue.shift()();
  };
  live = new LiveText({
    initial,
    write: (html, expected) =>
      new Promise((resolve) => {
        queue.push(async () => {
          beforeWrite(html);
          if (store.content !== expected) {
            store.refused++;
            resolve("stale");
            return;
          }
          store.content = html;
          store.writes.push(html);
          resolve("saved");
        });
        run();
      }),
    read: () =>
      new Promise((resolve) => {
        queue.push(async () => resolve({ content: store.content, author: store.author }));
        run();
      }),
    getEditorText: () => editor.text,
    setEditorText: (html) => {
      editor.text = html;
      editor.set++;
    },
  });
  /** The user edits; the editor's debounced save follows. */
  const type = (html) => {
    editor.text = html;
    live.save(html);
  };
  /** Someone else's version lands in storage (a sync download). */
  const download = (html, author = "bob") => {
    store.content = html;
    store.author = author;
  };
  return { live, store, editor, type, download };
}

describe("text someone else stored while the note is open", () => {
  it("is shown when the user has not edited", async () => {
    const t = setup("<p>a</p><p>b</p>");
    t.download("<p>a</p><p>b by bob</p>");

    await t.live.reconcile();

    expect(t.editor.text).toBe("<p>a</p><p>b by bob</p>");
    expect(t.store.writes).toEqual([]); // nothing of the user's to store
  });

  it("is merged with the user's own edits, and the merge is stored", async () => {
    const t = setup("<p>a</p><p>b</p>");
    t.type("<p>a by me</p><p>b</p>");
    await flush();
    t.download("<p>a by me</p><p>b by bob</p>"); // bob merged in what we had uploaded
    t.type("<p>a by me, more</p><p>b</p>"); // still typing on the old version

    await flush();
    await t.live.reconcile();

    expect(t.editor.text).toBe("<p>a by me, more</p><p>b by bob</p>");
    expect(t.store.content).toBe("<p>a by me, more</p><p>b by bob</p>");
  });

  it("is never overwritten by a save made before the editor saw it", async () => {
    const t = setup("<p>a</p>");
    t.download("<p>a</p><p>from bob</p>");

    t.type("<p>a, edited</p>");
    await flush();

    // The save was refused rather than writing over bob's paragraph…
    expect(t.store.refused).toBe(1);
    // …and the refusal brought bob's text in, with the edit kept
    await t.live.reconcile();
    expect(t.editor.text).toBe("<p>a, edited</p><p>from bob</p>");
    expect(t.store.content).toBe("<p>a, edited</p><p>from bob</p>");
  });

  it("keeps the user's edits when another version lands before the merge is stored", async () => {
    let t;
    let landed = false;
    t = setup("<p>a</p>", {
      // Just as the merged text is about to be stored, a second version from bob arrives
      beforeWrite: (html) => {
        if (!landed && html.includes("b1")) {
          landed = true;
          t.download("<p>a</p><p>b1</p><p>b2</p>");
        }
      },
    });
    t.download("<p>a</p><p>b1</p>");
    t.type("<p>a, mine</p>"); // refused: storage moved on

    await flush();
    await t.live.reconcile();
    await flush();
    await t.live.reconcile();

    expect(t.editor.text).toBe("<p>a, mine</p><p>b1</p><p>b2</p>");
    expect(t.store.content).toBe("<p>a, mine</p><p>b1</p><p>b2</p>");
  });

  it("keeps both versions of a paragraph both changed, marking bob's", async () => {
    const t = setup("<p>a</p>");
    t.download("<p>a, bob's</p>", "bob"); // neither has seen the other's edit
    t.type("<p>a, mine</p>"); // refused: storage moved on

    await flush();
    await t.live.reconcile();

    expect(t.editor.text).toContain("a, mine");
    expect(t.editor.text).toContain("a, bob's");
    expect(t.editor.text).toContain('data-by="bob"');
  });
});

describe("the editor's own writes", () => {
  it("are never taken for someone else's", async () => {
    const t = setup("<p>a</p>");
    t.type("<p>ab</p>");
    t.type("<p>abc</p>");

    await t.live.reconcile();

    expect(t.editor.set).toBe(0);
    expect(t.store.content).toBe("<p>abc</p>");
    expect(t.store.refused).toBe(0);
  });

  it("go on being stored after a reconcile", async () => {
    const t = setup("<p>a</p>");
    t.download("<p>a</p><p>b</p>");
    await t.live.reconcile();

    t.type("<p>a</p><p>b</p><p>c</p>");
    await flush();

    expect(t.store.content).toBe("<p>a</p><p>b</p><p>c</p>");
    expect(t.store.refused).toBe(0);
  });
});

describe("a write that failed", () => {
  function failing(outcomes) {
    const expectations = [];
    const live = new LiveText({
      initial: "<p>a</p>",
      write: async (_html, expected) => {
        expectations.push(expected);
        return outcomes.shift();
      },
      read: async () => null,
      getEditorText: () => "<p>a</p>",
      setEditorText: () => {},
    });
    return { live, expectations };
  }

  it("leaves the next save expecting the text storage still holds", async () => {
    const { live, expectations } = failing(["failed", "saved"]);
    live.save("<p>ab</p>");
    await flush();
    live.save("<p>abc</p>");
    await flush();

    // Without the roll-back the second save expected "<p>ab</p>", which storage
    // never got, was refused as stale, and sent the editor into a reconcile
    expect(expectations).toEqual(["<p>a</p>", "<p>a</p>"]);
  });

  it("keeps the expectation of a newer save issued meanwhile", async () => {
    const { live, expectations } = failing(["failed", "saved", "saved"]);
    live.save("<p>ab</p>");
    live.save("<p>abc</p>");
    await flush();
    live.save("<p>abcd</p>");
    await flush();

    expect(expectations.at(-1)).toBe("<p>abc</p>");
  });
});

describe("reconciling", () => {
  it("does nothing when the stored text cannot be read (a locked app)", async () => {
    let read = 0;
    const editor = { text: "<p>a</p>" };
    const live = new LiveText({
      initial: "<p>a</p>",
      write: () => {},
      read: async () => {
        read++;
        return null;
      },
      getEditorText: () => editor.text,
      setEditorText: (html) => {
        editor.text = html;
      },
    });
    await live.reconcile();
    expect(read).toBe(1);
    expect(editor.text).toBe("<p>a</p>");
  });

  it("shares one run between overlapping calls, and looks once more for a call made during it", async () => {
    let reads = 0;
    let release;
    const live = new LiveText({
      initial: "",
      write: () => {},
      read: () => {
        reads++;
        return reads === 1 ? new Promise((r) => (release = r)) : Promise.resolve(null);
      },
      getEditorText: () => "",
      setEditorText: () => {},
    });
    const first = live.reconcile();
    const second = live.reconcile();
    expect(second).toBe(first);
    release(null);
    await first;
    expect(reads).toBe(2);
  });

  it("stops once the note is closed", async () => {
    const t = setup("<p>a</p>");
    t.live.close();
    t.download("<p>b</p>");
    await t.live.reconcile();
    t.live.save("<p>c</p>");
    await flush();
    expect(t.editor.text).toBe("<p>a</p>");
    expect(t.store.writes).toEqual([]);
  });
});
