# oneJournal - Project Status

**Last Updated:** 2025-12-15

## ✅ Completed

### Project Setup (Phase 1)

- [x] npm project initialized with all dependencies
- [x] Vite configured for single-file HTML output
- [x] Just task runner set up
- [x] ESLint + Prettier configured
- [x] Project folder structure created
- [x] Basic HTML shell with layout placeholders
- [x] CSS variables and base styles
- [x] Initial component styles (note cards, empty states)
- [x] Build verified (9.1 kB single HTML file)

## 📋 Architecture Decisions Made

### Core Decisions

1. ✅ **Technology:** HTML/CSS/JS + Vite (single file PWA)
   - Rationale: Cross-platform, no Mac needed, easy to build/distribute
   - Alternative considered: Flutter (rejected - needs Mac for iOS)

2. ✅ **Notes:** All notes support mixed content (text + handwriting + drawing)
   - No "note type" selection needed
   - Schema: `textContent` + `strokes` in same object

3. ✅ **Canvas:** Infinite scrolling (tens of A4 pages)
   - Virtual rendering for performance
   - Page dimensions: 794×1123px (A4 @ 96dpi)
   - Strokes store page number

4. ✅ **Themes:** Three modes (light, dark, high-contrast e-paper)
   - E-paper: pure B&W, no animations, e-ink optimized

5. ✅ **UI Layout:**
   - Top toolbar (hamburger right-aligned)
   - Left sidebar (collapsible)
   - Main content (3 modes: overview, notebook, settings)
   - Footer (sync status)

## 📂 Documentation

- **[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)** - Full roadmap (7 phases)
- **[.context.md](.context.md)** - Quick reference for developers/AI
- **[README.md](README.md)** - User documentation
- **[SETUP_COMPLETE.md](SETUP_COMPLETE.md)** - Setup verification

## 🚀 Next Steps

### Immediate (Phase 1.5 - Theme System & Navigation)

1. Create theme CSS files (light, dark, epaper)
2. Implement theme switching logic
3. Create simple router for view modes
4. Build settings UI with theme selector

### Short Term (Phase 2 - Overview & Notes)

1. Implement IndexedDB storage layer
2. Create notebook and note CRUD operations
3. Build overview mode UI
4. Implement note/notebook cards

### Medium Term (Phases 3-4)

1. Text editor with formatting
2. Canvas drawing engine with stylus support
3. Infinite scrolling implementation

## 🔧 Development Environment

**Commands:**

```bash
just dev      # Start development (port 3000)
just build    # Build production
just check    # Lint + format check
```

**Tech Stack:**

- Node.js packages: 146 installed
- Vite: v5.4.21
- Build output: Single HTML file (~10KB base)

## 📊 Current Stats

- **Files:** ~20 total
- **LOC:** ~500 (mostly setup/config/docs)
- **Dependencies:** 146 packages (dev + prod)
- **Build Time:** ~100ms
- **Bundle Size:** 9.1 kB (gzipped: 3.01 kB)

## 🎯 Project Goals

- [x] Cross-platform (Windows/Linux/macOS/Android/iOS via browser)
- [x] Easy to build (no Mac/iOS tools needed)
- [ ] Local-first with IndexedDB
- [ ] WebDAV sync (Nextcloud compatible)
- [ ] Active stylus support with pressure sensitivity
- [ ] Offline-capable PWA
- [ ] Three themes including e-paper mode

## 📝 Key Decisions Log

| Date       | Decision                           | Rationale                                                 |
| ---------- | ---------------------------------- | --------------------------------------------------------- |
| 2025-12-15 | HTML/PWA over Flutter              | No Mac needed, easier build, cross-platform including web |
| 2025-12-15 | Mixed content notes (no types)     | Simpler UX, more flexible workflow                        |
| 2025-12-15 | Infinite scrolling canvas          | Natural notebook experience, support long-form content    |
| 2025-12-15 | Template functions over frameworks | Keep it simple, vanilla JS, no dependencies               |
| 2025-12-15 | E-paper theme as priority          | Target e-ink devices, outdoor readability                 |

---

**Status:** ✅ Foundation complete, ready for feature implementation
