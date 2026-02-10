/**
 * Unit tests for TextEditorLayer
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TextChangeCommand } from "./commands/TextChangeCommand";
import jQuery from "./jquerySetup";
import { TextEditorLayer } from "./TextEditorLayer";

// Mock dependencies
vi.mock("./jquerySetup");
vi.mock("./commands/TextChangeCommand");

// Mock Trumbowyg and CSS imports
vi.mock("trumbowyg", () => ({}));
vi.mock("trumbowyg/dist/ui/trumbowyg.css", () => ({}));
vi.mock("trumbowyg/dist/plugins/colors/trumbowyg.colors.js", () => ({}));
vi.mock("trumbowyg/dist/plugins/colors/ui/trumbowyg.colors.css", () => ({}));
vi.mock("trumbowyg/dist/plugins/fontsize/trumbowyg.fontsize.js", () => ({}));
vi.mock("trumbowyg/dist/plugins/indent/trumbowyg.indent.js", () => ({}));
vi.mock("trumbowyg/dist/plugins/lineheight/trumbowyg.lineheight.js", () => ({}));
vi.mock("trumbowyg/dist/plugins/table/trumbowyg.table.js", () => ({}));
vi.mock("trumbowyg/dist/plugins/table/ui/trumbowyg.table.css", () => ({}));
vi.mock("./TextEditorLayer.css", () => ({}));

describe("TextEditorLayer", () => {
  let viewportElement;
  let scrollerContainer;
  let mockHistoryManager;
  let layer;
  let mockJQueryInstance;
  let mockResizeObserver;
  let mockMutationObserver;

  beforeEach(() => {
    // Setup DOM elements
    viewportElement = document.createElement("div");
    scrollerContainer = document.createElement("div");
    document.body.appendChild(viewportElement);
    document.body.appendChild(scrollerContainer);

    // Mock HistoryManager
    mockHistoryManager = {
      push: vi.fn(),
    };

    // Mock ResizeObserver
    mockResizeObserver = {
      observe: vi.fn(),
      disconnect: vi.fn(),
    };
    global.ResizeObserver = vi.fn(() => mockResizeObserver);

    // Mock MutationObserver
    mockMutationObserver = {
      observe: vi.fn(),
      disconnect: vi.fn(),
    };
    global.MutationObserver = vi.fn(() => mockMutationObserver);

    // Mock jQuery instance
    mockJQueryInstance = {
      trumbowyg: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      data: vi.fn(),
      find: vi.fn(),
      addClass: vi.fn(),
      removeClass: vi.fn(),
      css: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      trigger: vi.fn(),
      length: 1,
      0: document.createElement("div"),
    };
    // Allow chaining
    mockJQueryInstance.find.mockReturnValue(mockJQueryInstance);
    mockJQueryInstance.css.mockReturnValue(mockJQueryInstance);

    // Setup jQuery mock
    jQuery.mockReturnValue(mockJQueryInstance);
    jQuery.trumbowyg = { svgPath: "" };

    vi.useFakeTimers();
  });

  afterEach(() => {
    if (layer) {
      layer.destroy();
    }
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  test("constructor creates DOM elements", () => {
    layer = new TextEditorLayer(viewportElement, scrollerContainer);

    expect(viewportElement.querySelector(".note-canvas__text-editor-layer")).not.toBeNull();
    expect(scrollerContainer.querySelector(".note-canvas__trumbowyg-toolbar")).not.toBeNull();
  });

  test("init initializes Trumbowyg and sets content", () => {
    layer = new TextEditorLayer(viewportElement, scrollerContainer);
    const initialHtml = "<p>Test</p>";

    layer.init(initialHtml);

    expect(jQuery).toHaveBeenCalled();
    expect(mockJQueryInstance.trumbowyg).toHaveBeenCalledWith(expect.any(Object));
    expect(mockJQueryInstance.trumbowyg).toHaveBeenCalledWith("html", initialHtml);
  });

  test("update applies transform to container", () => {
    layer = new TextEditorLayer(viewportElement, scrollerContainer);
    const zoom = 2;
    const scrollLeft = 100;
    const scrollTop = 50;
    const centeringOffset = 200;

    layer.update(zoom, scrollLeft, scrollTop, centeringOffset);

    const container = viewportElement.querySelector(".note-canvas__text-editor-layer");
    // screenX = -100 + 200 = 100
    // screenY = -50
    expect(container.style.top).toBe("-50px");
    expect(container.style.left).toBe("100px");
    expect(container.style.transform).toBe("scale(2)");
    expect(container.style.width).toBe("1200px"); // Default maxContentWidth
  });

  test("setMode toggles toolbar visibility", () => {
    layer = new TextEditorLayer(viewportElement, scrollerContainer);
    const toolbar = scrollerContainer.querySelector(".note-canvas__trumbowyg-toolbar");

    layer.setMode("text");
    expect(toolbar.style.display).toBe("");

    layer.setMode("pan");
    expect(toolbar.style.display).toBe("none");
  });

  test("content changes trigger save and history (debounced)", () => {
    const onContentChange = vi.fn();
    layer = new TextEditorLayer(viewportElement, scrollerContainer, {
      onContentChange,
      historyManager: mockHistoryManager,
    });
    layer.init("initial");

    // Simulate content change
    const changeCallback = mockJQueryInstance.on.mock.calls.find(
      (call) => call[0] === "tbwchange",
    )[1];

    // Mock getContent to return new content
    mockJQueryInstance.trumbowyg.mockImplementation((arg) => {
      if (arg === "html") return "new content";
    });

    changeCallback(); // Trigger change

    // Should be debounced
    expect(onContentChange).not.toHaveBeenCalled();
    expect(mockHistoryManager.push).not.toHaveBeenCalled();

    // Fast forward history timer (300ms)
    vi.advanceTimersByTime(300);
    expect(mockHistoryManager.push).toHaveBeenCalled();
    expect(TextChangeCommand).toHaveBeenCalledWith("initial", "new content");

    // Fast forward save timer (total 500ms)
    vi.advanceTimersByTime(200);
    expect(onContentChange).toHaveBeenCalledWith("new content");
  });

  test("setContentSilently updates content without history", () => {
    layer = new TextEditorLayer(viewportElement, scrollerContainer, {
      historyManager: mockHistoryManager,
    });
    layer.init("initial");

    // Mock getContent to return the updated content so _pushHistoryCommand sees no change
    mockJQueryInstance.trumbowyg.mockImplementation((arg, val) => {
      if (arg === "html" && val === undefined) return "silent update";
    });

    layer.setContentSilently("silent update");

    expect(mockJQueryInstance.trumbowyg).toHaveBeenCalledWith("html", "silent update");

    // Simulate change event that might occur
    const changeCallback = mockJQueryInstance.on.mock.calls.find(
      (call) => call[0] === "tbwchange",
    )[1];
    changeCallback();

    vi.runAllTimers();
    expect(mockHistoryManager.push).not.toHaveBeenCalled();
  });

  test("forceSave pushes pending history and saves immediately", () => {
    const onContentChange = vi.fn();
    layer = new TextEditorLayer(viewportElement, scrollerContainer, {
      onContentChange,
      historyManager: mockHistoryManager,
    });
    layer.init("initial");

    // Simulate dirty state
    mockJQueryInstance.trumbowyg.mockReturnValue("dirty content");
    layer.isDirty = true;

    layer.forceSave();

    expect(mockHistoryManager.push).toHaveBeenCalled();
    expect(onContentChange).toHaveBeenCalledWith("dirty content");
  });

  test("destroy cleans up resources", () => {
    layer = new TextEditorLayer(viewportElement, scrollerContainer);
    layer.init("");

    layer.destroy();

    expect(mockJQueryInstance.off).toHaveBeenCalledWith("tbwchange");
    expect(mockJQueryInstance.trumbowyg).toHaveBeenCalledWith("destroy");
    expect(viewportElement.querySelector(".note-canvas__text-editor-layer")).toBeNull();
    expect(scrollerContainer.querySelector(".note-canvas__trumbowyg-toolbar")).toBeNull();
  });

  test("ResizeObserver tracks height changes", () => {
    const onHeightChange = vi.fn();
    layer = new TextEditorLayer(viewportElement, scrollerContainer, {
      onHeightChange,
    });

    // Manually add the element that ResizeObserver looks for, since mock trumbowyg won't create it
    const editorDiv = viewportElement.querySelector(".note-canvas__text-editor");
    const trumbowygEditor = document.createElement("div");
    trumbowygEditor.className = "trumbowyg-editor";
    editorDiv.appendChild(trumbowygEditor);

    layer.init("");

    expect(global.ResizeObserver).toHaveBeenCalled();
    expect(mockResizeObserver.observe).toHaveBeenCalledWith(trumbowygEditor);

    // Simulate resize with borderBoxSize (includes padding)
    const resizeCallback = global.ResizeObserver.mock.calls[0][0];
    resizeCallback([{
      borderBoxSize: [{ blockSize: 500 }],
      contentRect: { height: 460 },
    }]);

    expect(onHeightChange).toHaveBeenCalledWith(500);
  });
});
