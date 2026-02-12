/**
 * NoteNavigator - In-note navigation widget
 *
 * Collapsible vertical toolbar at upper-right corner of the note view.
 * Lets users jump between navigation items (search matches, PDF pages,
 * PDF chapters, highlighter strokes) with prev/next buttons and a
 * position indicator.
 */

import { getIcon } from "../../utils/icons.js";

const SUBJECT_ICONS = {
  search: "search",
  "pdf-page": "fileText",
  "pdf-chapter": "bookmark",
  highlighter: "highlighter",
};

export class NoteNavigator {
  /**
   * @param {HTMLElement} parentElement - The scroller-container element (position: relative)
   * @param {Object} options
   * @param {function(number)} options.onNavigate - Callback with content Y to scroll to
   */
  constructor(parentElement, options = {}) {
    this.parentElement = parentElement;
    this.onNavigate = options.onNavigate || (() => {});

    this.expanded = false;
    this.subjects = [];
    this.currentSubjectIndex = 0;
    this.currentItemIndex = -1;

    this.el = null;
    this._render();
  }

  /**
   * Set available navigation subjects and re-render.
   * @param {Array<{key: string, label: string, items: Array<{y: number, label?: string}>}>} subjects
   * @param {string} [autoSelectKey] - Key of subject to auto-select
   */
  setSubjects(subjects, autoSelectKey) {
    this.subjects = subjects.filter((s) => s.items.length > 0);
    this.currentSubjectIndex = 0;
    this.currentItemIndex = -1;

    if (autoSelectKey) {
      const idx = this.subjects.findIndex((s) => s.key === autoSelectKey);
      if (idx !== -1) this.currentSubjectIndex = idx;
    }

    this._render();
  }

  _currentSubject() {
    return this.subjects[this.currentSubjectIndex] || null;
  }

  _toggle() {
    this.expanded = !this.expanded;
    this._render();
  }

  _cycleSubject() {
    if (this.subjects.length <= 1) return;
    this.currentSubjectIndex = (this.currentSubjectIndex + 1) % this.subjects.length;
    this.currentItemIndex = -1;
    this._render();
  }

  _prevItem() {
    const subject = this._currentSubject();
    if (!subject || subject.items.length === 0) return;

    if (this.currentItemIndex <= 0) {
      this.currentItemIndex = subject.items.length - 1;
    } else {
      this.currentItemIndex--;
    }
    this._navigateTo(this.currentItemIndex);
    this._updateDisplay();
  }

  _nextItem() {
    const subject = this._currentSubject();
    if (!subject || subject.items.length === 0) return;

    if (this.currentItemIndex >= subject.items.length - 1) {
      this.currentItemIndex = 0;
    } else {
      this.currentItemIndex++;
    }
    this._navigateTo(this.currentItemIndex);
    this._updateDisplay();
  }

  _navigateTo(index) {
    const subject = this._currentSubject();
    if (!subject || !subject.items[index]) return;
    this.onNavigate(subject.items[index].y, subject.key);
  }

  _updateDisplay() {
    const posEl = this.el?.querySelector(".note-navigator__position");
    if (!posEl) return;
    const subject = this._currentSubject();
    if (!subject) return;
    posEl.textContent = `${this.currentItemIndex + 1}/${subject.items.length}`;
  }

  _render() {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }

    // Don't render if no subjects
    if (this.subjects.length === 0) return;

    this.el = document.createElement("div");
    this.el.className = `note-navigator ${this.expanded ? "note-navigator--expanded" : "note-navigator--collapsed"}`;

    if (!this.expanded) {
      this._renderCollapsed();
    } else {
      this._renderExpanded();
    }

    this.parentElement.appendChild(this.el);
  }

  _renderCollapsed() {
    const btn = document.createElement("button");
    btn.className = "note-navigator__toggle-btn";
    btn.title = "Navigator";
    btn.innerHTML = getIcon("compass", 22);
    btn.onclick = (e) => {
      e.stopPropagation();
      this._toggle();
    };
    this.el.appendChild(btn);
  }

  _renderExpanded() {
    const subject = this._currentSubject();

    // Collapse button
    const collapseBtn = document.createElement("button");
    collapseBtn.className = "note-navigator__btn";
    collapseBtn.title = "Collapse";
    collapseBtn.innerHTML = getIcon("chevronsUp", 22);
    collapseBtn.onclick = (e) => {
      e.stopPropagation();
      this._toggle();
    };
    this.el.appendChild(collapseBtn);

    // Previous button
    const prevBtn = document.createElement("button");
    prevBtn.className = "note-navigator__btn";
    prevBtn.title = "Previous";
    prevBtn.innerHTML = getIcon("arrowUp", 22);
    prevBtn.onclick = (e) => {
      e.stopPropagation();
      this._prevItem();
    };
    this.el.appendChild(prevBtn);

    // Subject / counter button
    const subjectBtn = document.createElement("button");
    subjectBtn.className = "note-navigator__subject-btn";
    subjectBtn.title = subject?.label || "";

    const iconName = SUBJECT_ICONS[subject?.key] || "compass";
    const iconSpan = document.createElement("span");
    iconSpan.className = "note-navigator__subject-icon";
    iconSpan.innerHTML = getIcon(iconName, 18);
    subjectBtn.appendChild(iconSpan);

    const posSpan = document.createElement("span");
    posSpan.className = "note-navigator__position";
    if (subject && this.currentItemIndex >= 0) {
      posSpan.textContent = `${this.currentItemIndex + 1}/${subject.items.length}`;
    } else {
      posSpan.textContent = subject ? `${subject.items.length}` : "";
    }
    subjectBtn.appendChild(posSpan);

    if (this.subjects.length > 1) {
      subjectBtn.onclick = (e) => {
        e.stopPropagation();
        this._cycleSubject();
      };
    }
    this.el.appendChild(subjectBtn);

    // Next button
    const nextBtn = document.createElement("button");
    nextBtn.className = "note-navigator__btn";
    nextBtn.title = "Next";
    nextBtn.innerHTML = getIcon("arrowDown", 22);
    nextBtn.onclick = (e) => {
      e.stopPropagation();
      this._nextItem();
    };
    this.el.appendChild(nextBtn);
  }

  destroy() {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }
}
