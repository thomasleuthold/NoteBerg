import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteNavigator } from "./NoteNavigator.js";

// Mock dependencies
vi.mock("../../utils/icons.js", () => ({
  getIcon: vi.fn((name) => `<svg>${name}</svg>`),
}));

describe("NoteNavigator", () => {
  let parentElement;
  let navigator;
  let onNavigate;

  const mockSubjects = [
    {
      key: "search",
      label: "Search Results",
      items: [{ y: 100 }, { y: 250 }, { y: 400 }],
    },
    {
      key: "pdf-page",
      label: "PDF Pages",
      items: [{ y: 0 }, { y: 800 }],
    },
  ];

  beforeEach(() => {
    parentElement = document.createElement("div");
    document.body.appendChild(parentElement);
    onNavigate = vi.fn();
    navigator = new NoteNavigator(parentElement, { onNavigate });
  });

  afterEach(() => {
    navigator.destroy();
    parentElement.remove();
    vi.clearAllMocks();
  });

  it("should not render if no subjects are provided", () => {
    expect(parentElement.querySelector(".note-navigator")).toBeNull();
  });

  it("should render in a collapsed state when subjects are set", () => {
    navigator.setSubjects(mockSubjects);
    expect(parentElement.querySelector(".note-navigator")).not.toBeNull();
    expect(parentElement.querySelector(".note-navigator--collapsed")).not.toBeNull();
    expect(parentElement.querySelector(".note-navigator--expanded")).toBeNull();
  });

  it("should expand when toggle button is clicked", () => {
    navigator.setSubjects(mockSubjects);
    const toggleBtn = parentElement.querySelector(".note-navigator__toggle-btn");
    toggleBtn.click();
    expect(parentElement.querySelector(".note-navigator--expanded")).not.toBeNull();
  });

  it("should collapse when collapse button is clicked", () => {
    navigator.setSubjects(mockSubjects);
    // Expand first
    parentElement.querySelector(".note-navigator__toggle-btn").click();
    expect(parentElement.querySelector(".note-navigator--expanded")).not.toBeNull();

    // Then collapse
    const collapseBtn = parentElement.querySelector(".note-navigator__btn[title='Collapse']");
    collapseBtn.click();
    expect(parentElement.querySelector(".note-navigator--collapsed")).not.toBeNull();
  });

  it("should cycle through subjects when subject button is clicked", () => {
    navigator.setSubjects(mockSubjects);
    navigator._toggle(); // Expand

    let subjectBtn = parentElement.querySelector(".note-navigator__subject-btn");
    expect(subjectBtn.title).toBe("Search Results");

    subjectBtn.click(); // Cycle to next subject

    // Re-query the button as the component re-renders
    subjectBtn = parentElement.querySelector(".note-navigator__subject-btn");
    expect(subjectBtn.title).toBe("PDF Pages");

    subjectBtn.click(); // Cycle back to the first subject

    // Re-query the button again
    subjectBtn = parentElement.querySelector(".note-navigator__subject-btn");
    expect(subjectBtn.title).toBe("Search Results");
  });

  it("should navigate to next and previous items", () => {
    navigator.setSubjects(mockSubjects);
    navigator._toggle(); // Expand

    const nextBtn = parentElement.querySelector(".note-navigator__btn[title='Next']");
    const prevBtn = parentElement.querySelector(".note-navigator__btn[title='Previous']");
    const positionEl = parentElement.querySelector(".note-navigator__position");

    // Next
    nextBtn.click();
    expect(positionEl.textContent).toBe("1/3");
    expect(onNavigate).toHaveBeenCalledWith(100, "search", { y: 100 });

    nextBtn.click();
    expect(positionEl.textContent).toBe("2/3");
    expect(onNavigate).toHaveBeenCalledWith(250, "search", { y: 250 });

    // Previous
    prevBtn.click();
    expect(positionEl.textContent).toBe("1/3");
    expect(onNavigate).toHaveBeenCalledWith(100, "search", { y: 100 });
  });

  it("should wrap around when navigating past the end or beginning", () => {
    navigator.setSubjects(mockSubjects);
    navigator._toggle(); // Expand

    const nextBtn = parentElement.querySelector(".note-navigator__btn[title='Next']");
    const prevBtn = parentElement.querySelector(".note-navigator__btn[title='Previous']");
    const positionEl = parentElement.querySelector(".note-navigator__position");

    // Go to the last item
    nextBtn.click(); // 1/3
    nextBtn.click(); // 2/3
    nextBtn.click(); // 3/3
    expect(positionEl.textContent).toBe("3/3");
    expect(onNavigate).toHaveBeenCalledWith(400, "search", { y: 400 });

    // Wrap to first
    nextBtn.click();
    expect(positionEl.textContent).toBe("1/3");
    expect(onNavigate).toHaveBeenCalledWith(100, "search", { y: 100 });

    // Wrap to last from first
    prevBtn.click();
    expect(positionEl.textContent).toBe("3/3");
    expect(onNavigate).toHaveBeenCalledWith(400, "search", { y: 400 });
  });

  it("should auto-select a subject if autoSelectKey is provided", () => {
    navigator.setSubjects(mockSubjects, "pdf-page");
    navigator._toggle(); // Expand
    const subjectBtn = parentElement.querySelector(".note-navigator__subject-btn");
    expect(subjectBtn.title).toBe("PDF Pages");
  });

  it("should not cycle subjects if there is only one subject", () => {
    navigator.setSubjects([mockSubjects[0]]);
    navigator._toggle(); // Expand

    const subjectBtn = parentElement.querySelector(".note-navigator__subject-btn");
    expect(subjectBtn.title).toBe("Search Results");

    // Should not have a click handler to cycle
    subjectBtn.click();
    expect(subjectBtn.title).toBe("Search Results"); // Stays the same
  });

  it("should reset item index when cycling subjects", () => {
    navigator.setSubjects(mockSubjects);
    navigator._toggle(); // Expand

    const nextBtn = parentElement.querySelector(".note-navigator__btn[title='Next']");
    let subjectBtn = parentElement.querySelector(".note-navigator__subject-btn");
    let positionEl = parentElement.querySelector(".note-navigator__position");

    nextBtn.click();
    expect(positionEl.textContent).toBe("1/3");

    subjectBtn.click(); // Cycle to PDF Pages

    // Re-query elements after re-render
    positionEl = parentElement.querySelector(".note-navigator__position");
    subjectBtn = parentElement.querySelector(".note-navigator__subject-btn");

    expect(positionEl.textContent).toBe("2"); // No item selected, just shows total

    nextBtn.click();

    positionEl = parentElement.querySelector(".note-navigator__position");
    expect(positionEl.textContent).toBe("1/2");
    expect(onNavigate).toHaveBeenCalledWith(0, "pdf-page", { y: 0 });
  });

  it("should handle being destroyed", () => {
    navigator.setSubjects(mockSubjects);
    expect(parentElement.querySelector(".note-navigator")).not.toBeNull();
    navigator.destroy();
    expect(parentElement.querySelector(".note-navigator")).toBeNull();
  });
});
