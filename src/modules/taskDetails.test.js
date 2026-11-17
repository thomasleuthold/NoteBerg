import { describe, expect, it } from "vitest";
import {
  buildTextLines,
  createStrokeDetailsIndex,
  deriveSuggestedTitle,
  deriveTaskDetails,
  strokeDetailsFor,
  textDetailsFor,
} from "./taskDetails.js";

const task = (id, text) => `<span class="task-text" data-task-id="${id}">${text}</span>`;

describe("textDetailsFor: indentation and structure", () => {
  const indent = (n, html) => `<div style="margin-left: ${n * 8}px">${html}</div>`;

  it("an indented run below the headline is its detail, until indentation returns", () => {
    const lines = buildTextLines(
      `<div>${task("a", "Head")}</div>${indent(1, "d1")}${indent(2, "d2")}${indent(1, "d3")}<div>next paragraph</div>`,
    );
    expect(textDetailsFor(lines, "a", 10)).toEqual(["d1", "d2", "d3"]);
  });

  it("a blank line inside an indented run does not end it, a trailing one does", () => {
    const lines = buildTextLines(
      `<div>${task("a", "Head")}</div>${indent(1, "d1")}<div><br></div>${indent(1, "d2")}<div><br></div><div>other</div>`,
    );
    expect(textDetailsFor(lines, "a", 10)).toEqual(["d1", "d2"]);
  });

  it("indentation is relative to the headline", () => {
    const lines = buildTextLines(
      `${indent(2, task("a", "Head"))}${indent(3, "d1")}${indent(2, "peer")}`,
    );
    expect(textDetailsFor(lines, "a", 10)).toEqual(["d1"]);
  });

  it("without indentation the following lines are only maybe-details, and an outdent ends them", () => {
    const lines = buildTextLines(
      `${indent(1, task("a", "Head"))}${indent(1, "d1")}<div>outdented</div>`,
    );
    expect(textDetailsFor(lines, "a", 10)).toEqual(["d1"]);
  });

  it("nested lists count as indentation; peer list items are not details", () => {
    const nested = buildTextLines(
      `<ul><li>${task("a", "Head")}<ul><li>sub 1</li><li>sub 2</li></ul></li><li>peer</li></ul>`,
    );
    expect(textDetailsFor(nested, "a", 10)).toEqual(["sub 1", "sub 2"]);

    const peers = buildTextLines(`<ul><li>${task("a", "Head")}</li><li>peer</li></ul>`);
    expect(textDetailsFor(peers, "a", 10)).toEqual([]);
  });

  it("a task on the next line means there is no detail", () => {
    const lines = buildTextLines(`<div>${task("a", "One")}</div><div>${task("b", "Two")}</div>`);
    expect(textDetailsFor(lines, "a")).toEqual([]);
  });
});

describe("textDetailsFor", () => {
  it("returns the lines after the headline, split by <br>", () => {
    const lines = buildTextLines(
      `<div>${task("a", "Call Bob")}<br>about the offer<br>by Friday</div>`,
    );
    expect(textDetailsFor(lines, "a")).toEqual(["about the offer", "by Friday"]);
  });

  it("reads following blocks and list items", () => {
    const lines = buildTextLines(
      `<div>${task("a", "Plan trip")}</div><div>flights</div><ul><li>hotel</li><li>car</li></ul>`,
    );
    expect(textDetailsFor(lines, "a")).toEqual(["flights", "hotel", "car"]);
  });

  it("stops at a blank line", () => {
    const lines = buildTextLines(
      `<div>${task("a", "Head")}<br>detail<br><br>unrelated paragraph</div>`,
    );
    expect(textDetailsFor(lines, "a")).toEqual(["detail"]);
  });

  it("stops at the next task", () => {
    const lines = buildTextLines(
      `<div>${task("a", "One")}<br>detail</div><div>${task("b", "Two")}<br>more</div>`,
    );
    expect(textDetailsFor(lines, "a")).toEqual(["detail"]);
    expect(textDetailsFor(lines, "b")).toEqual(["more"]);
  });

  it("limits the number of lines", () => {
    const lines = buildTextLines(`<div>${task("a", "H")}<br>1<br>2<br>3<br>4<br>5</div>`);
    expect(textDetailsFor(lines, "a")).toEqual(["1", "2", "3"]);
    expect(textDetailsFor(lines, "a", 1)).toEqual(["1"]);
  });

  it("ignores injected checkboxes and returns nothing for an unknown task", () => {
    const lines = buildTextLines(
      `<div><span class="task-text-checkbox">x</span>${task("a", "H")}<br>d</div>`,
    );
    expect(textDetailsFor(lines, "a")).toEqual(["d"]);
    expect(textDetailsFor(lines, "missing")).toEqual([]);
    expect(buildTextLines("")).toEqual([]);
  });
});

// A stroke is a horizontal bar at height y, from x0 to x1.
const bar = (id, y, x0 = 100, x1 = 300) => ({ id, x: [x0, x1], y: [y, y + 20], width: 2 });

describe("strokeDetailsFor", () => {
  const strokes = [
    bar("h", 100), // headline, 100..120
    bar("d1", 135), // detail lines
    bar("d2", 165),
    bar("far", 400), // separated by a large gap
  ];

  it("takes the ink below the headline up to the first large gap", () => {
    const index = createStrokeDetailsIndex(strokes, [{ id: "t", strokeIds: ["h"] }]);
    expect(strokeDetailsFor(index, "t").map((s) => s.id)).toEqual(["d1", "d2"]);
  });

  it("stops at the next task and never includes task ink", () => {
    const index = createStrokeDetailsIndex(strokes, [
      { id: "t", strokeIds: ["h"] },
      { id: "u", strokeIds: ["d2"] },
    ]);
    expect(strokeDetailsFor(index, "t").map((s) => s.id)).toEqual(["d1"]);
  });

  it("ignores ink above the headline, deleted ink, and other columns", () => {
    const index = createStrokeDetailsIndex(
      [
        bar("above", 40),
        bar("h", 100),
        { ...bar("gone", 135), _deleted: true },
        bar("right-column", 135, 2000, 2200),
        bar("d1", 135),
      ],
      [{ id: "t", strokeIds: ["h"] }],
    );
    expect(strokeDetailsFor(index, "t").map((s) => s.id)).toEqual(["d1"]);
  });

  it("caps how far below the headline the detail reaches", () => {
    const many = [bar("h", 100)];
    for (let i = 0; i < 20; i++) many.push(bar(`d${i}`, 135 + i * 30));
    const index = createStrokeDetailsIndex(many, [{ id: "t", strokeIds: ["h"] }]);
    const out = strokeDetailsFor(index, "t");
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(20);
  });

  it("returns nothing when the task has no live ink", () => {
    const index = createStrokeDetailsIndex(strokes, [{ id: "t", strokeIds: ["nope"] }]);
    expect(strokeDetailsFor(index, "t")).toEqual([]);
  });
});

describe("deriveTaskDetails", () => {
  it("returns the text below a text task", () => {
    const note = {
      content: `<div>${task("a", "Call Bob")}<br>about the offer</div>`,
      tasks: [{ id: "a", type: "text" }],
    };
    expect(deriveTaskDetails(note, note.tasks[0])).toEqual({
      text: ["about the offer"],
      strokes: [],
      referenceHeight: null,
    });
  });

  it("returns the ink below a stroke task and the headline height", () => {
    const note = {
      strokes: [bar("h", 100), bar("d1", 135)],
      tasks: [{ id: "t", type: "stroke", strokeIds: ["h"] }],
    };
    const out = deriveTaskDetails(note, note.tasks[0]);
    expect(out.strokes.map((s) => s.id)).toEqual(["d1"]);
    expect(out.referenceHeight).toBe(20);
    expect(out.text).toEqual([]);
  });

  it("ignores deleted tasks as boundaries and tolerates a missing note", () => {
    const note = {
      strokes: [bar("h", 100), bar("d1", 135), bar("d2", 165)],
      tasks: [
        { id: "t", type: "stroke", strokeIds: ["h"] },
        { id: "gone", type: "stroke", strokeIds: ["d2"] },
      ],
      deletedTasks: ["gone"],
    };
    expect(deriveTaskDetails(note, note.tasks[0]).strokes.map((s) => s.id)).toEqual(["d1", "d2"]);
    expect(deriveTaskDetails(null, { id: "x" }).strokes).toEqual([]);
  });
});

describe("deriveSuggestedTitle", () => {
  it("joins the recognised words that overlap a stroke task, parsing stored JSON", () => {
    const words = [
      { text: "Call", strokeIds: ["a", "b"] },
      { text: "Bob", strokeIds: ["c"] },
      { text: "other", strokeIds: ["z"] },
    ];
    const t = { id: "t", type: "stroke", strokeIds: ["a", "c"] };
    expect(deriveSuggestedTitle({ recognition: { words } }, t)).toBe("Call Bob");
    expect(deriveSuggestedTitle({ recognition: JSON.stringify({ words }) }, t)).toBe("Call Bob");
  });

  it("uses the span text for a text task and nothing when there is no recognition", () => {
    const note = { content: `<div>${task("a", "Call Bob")}</div>` };
    expect(deriveSuggestedTitle(note, { id: "a", type: "text" })).toBe("Call Bob");
    expect(deriveSuggestedTitle({}, { id: "t", type: "stroke", strokeIds: ["a"] })).toBe("");
    expect(deriveSuggestedTitle({ recognition: "not json" }, { id: "t", strokeIds: ["a"] })).toBe(
      "",
    );
  });
});
