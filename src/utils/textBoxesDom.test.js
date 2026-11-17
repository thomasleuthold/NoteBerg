/**
 * src/utils/textBoxesDom.test.js
 * Static text boxes for the thumbnail and the PDF export (text boxes DESIGN
 * §8): the same elements and classes as the editor's text layer, boxes at
 * their positions, no frames or handles, untrusted HTML sanitized.
 */

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderStaticTextBoxes } from "./textBoxesDom.js";

const box = (id, x, y, w, inner) =>
  `<div class="text-box" data-box-id="${id}" data-x="${x}" data-y="${y}" data-w="${w}">${inner}</div>`;

describe("renderStaticTextBoxes", () => {
  let root;
  let offsetHeight;

  // A box measures 48 px, the main text 120 px, as laid out in a browser
  beforeAll(() => {
    offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        if (this.classList?.contains("text-box--main")) return 120;
        return this.classList?.contains("text-box") ? 48 : 0;
      },
    });
  });
  afterAll(() => Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight));

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    root.className = "text-boxes";
    document.body.appendChild(root);
  });

  it("lays the main text in flow and every box at its position", () => {
    const height = renderStaticTextBoxes(
      root,
      `<p>Main</p>${box("tb_a", 600, 300, 400, "<p>A</p>")}${box("tb_b", 80, 900, 320, "<p>B</p>")}`,
    );
    const [main, a, b] = root.children;
    expect(main.className).toBe("text-box text-box--main");
    expect(main.firstElementChild.className).toBe("text-box__content");
    expect(main.textContent).toBe("Main");
    expect([a.style.left, a.style.top, a.style.width]).toEqual(["600px", "300px", "400px"]);
    expect([b.style.left, b.style.top, b.style.width]).toEqual(["80px", "900px", "320px"]);
    expect(height).toBe(948);
    // No frames, handles or editor in a picture of the page
    expect(root.querySelector(".text-box__frame, .text-box__chrome, [contenteditable]")).toBeNull();
  });

  it("renders a note without boxes as its main text", () => {
    renderStaticTextBoxes(root, "<p>one</p><p><br></p><p>two</p>");
    expect(root.children).toHaveLength(1);
    expect(root.firstElementChild.firstElementChild.innerHTML).toBe(
      "<p>one</p><p><br></p><p>two</p>",
    );
  });

  it("places a box without valid geometry below the lowest content", () => {
    renderStaticTextBoxes(
      root,
      `${box("tb_a", 0, 100, 400, "<p>A</p>")}<div class="text-box" data-box-id="tb_x"><p>lost</p></div>`,
    );
    const lost = root.children[1];
    expect(lost.textContent).toBe("lost");
    expect(lost.style.top).toBe(`${100 + 48 + 24}px`);
  });

  it("shows text tasks with their checkbox, done ones struck through", () => {
    renderStaticTextBoxes(
      root,
      '<p><span class="task-text" data-task-id="t1">open</span></p><p><span class="task-text" data-task-id="t2">done</span></p><p><span class="task-text" data-task-id="gone">orphan</span></p>',
      {
        tasks: [
          { id: "t1", type: "text", checked: false },
          { id: "t2", type: "text", checked: true },
        ],
      },
    );
    const boxes = [...root.querySelectorAll(".task-text-checkbox")];
    expect(boxes.map((b) => b.nextElementSibling.dataset.taskId)).toEqual(["t1", "t2"]);
    expect(boxes[1].classList).toContain("task-text-checkbox--checked");
    expect([...root.querySelectorAll(".task-text--done")].map((s) => s.textContent)).toEqual([
      "done",
    ]);
  });

  it("puts a stroke task's checkbox where the editor does, and counts it in the height", () => {
    const strokes = [{ id: "s1", x: [300, 400], y: [1500, 1540] }];
    const height = renderStaticTextBoxes(root, "", {
      strokes,
      tasks: [{ id: "t", type: "stroke", strokeIds: ["s1"], checked: false }],
    });
    const [checkbox] = root.querySelectorAll(".text-boxes__stroke-task");
    expect([checkbox.style.left, checkbox.style.top, checkbox.style.width]).toEqual([
      "270px",
      "1509px",
      "22px",
    ]);
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    expect(height).toBe(1531);
  });

  it("sanitizes the note's HTML", () => {
    renderStaticTextBoxes(root, `${box("tb_a", 0, 0, 400, '<img src="x" onerror="alert(1)">')}`);
    expect(root.innerHTML).not.toContain("onerror");
  });
});

describe("textBoxes.css", () => {
  // The stylesheet the thumbnail, the export and the editor share. A rule on
  // <br> is what made thumbnails collapse empty lines in Firefox: Chromium
  // ignores display on <br>, Firefox applies it.
  it("styles no <br>, so line breaks render alike in every browser", () => {
    const css = readFileSync("src/styles/textBoxes.css", "utf8");
    expect(css).not.toMatch(/\bbr\b[^{]*\{/);
  });
});
