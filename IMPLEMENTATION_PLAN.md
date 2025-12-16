# oneJournal - Implementation Plan

## Overview

A cross-platform note-taking application supporting handwritten notes, text, and drawings. Built as a lightweight HTML/CSS/JavaScript application with local-first storage and WebDAV sync.

## Architecture

### Technology Stack

- **Frontend**: Vanilla HTML5/CSS3/JavaScript (ES6+)
- **Local Storage**: IndexedDB (using idb library wrapper)
- **Canvas**: HTML5 Canvas for handwriting/drawing
- **Sync**: WebDAV protocol (using webdav client library)
- **Build Tool**: Vite (for development server, HMR, and bundling)
- **Task Runner**: Just (for command automation)
- **Linting**: ESLint with recommended config
- **Formatting**: Prettier
- **Type Checking**: JSDoc with TypeScript checking (optional, no compilation needed)

### UI/UX Design

#### Layout Structure

```
┌─────────────────────────────────────────────┐
│  Top Toolbar              [☰] Hamburger     │
├──────────┬──────────────────────────────────┤
│          │                                  │
│          │                                  │
│ Sidebar  │     Main Content Area           │
│          │     (Overview/Notebook/Settings) │
│          │                                  │
│          │                                  │
├──────────┴──────────────────────────────────┤
│  Footer (sync status, etc.)                 │
└─────────────────────────────────────────────┘
```

**Layout Components:**

1. **Top Toolbar**
   - Fixed position at top
   - Contains app title/logo (left)
   - Hamburger menu button (aligned right)
   - Action buttons contextual to current mode

2. **Left Sidebar**
   - Collapsible (toggle via hamburger)
   - Shows notebooks and quick notes list
   - Search/filter functionality
   - "New" button for creating notebooks/notes

3. **Main Content Area** - Three modes:
   - **Overview Mode**: Display and manage notebooks and quick notes
     - Grid/list view of notebooks
     - Quick notes section
     - Recent notes
   - **Notebook Mode**: Active notebook is open
     - Note editor (text/handwriting/drawing)
     - Canvas overlay for drawing
     - Formatting toolbar
   - **Settings Mode**: Configuration panel
     - WebDAV connection settings
     - Theme selection
     - Sync preferences
     - Export/import options

4. **Footer**
   - Fixed position at bottom
   - Sync status indicator (synced/syncing/offline)
   - Last sync timestamp
   - Connection status
   - Optional: storage usage indicator

#### Theme System

**Three Theme Support:**

1. **Light Theme** (Default)
   - Clean, bright interface
   - High readability
   - Standard colors

2. **Dark Theme**
   - Reduced eye strain in low light
   - Dark backgrounds, light text
   - Adjusted contrast ratios

3. **High Contrast Theme** (E-Paper optimized)
   - Pure black and white
   - No gradients or shadows
   - Optimized for e-ink displays
   - Maximum contrast for outdoor readability
   - Minimal UI flourishes

**Theme Implementation:**

- CSS variables for all colors
- Theme switcher in settings
- Persist theme preference in localStorage/IndexedDB
- Support system preference detection (`prefers-color-scheme`)
- E-paper mode: disable animations, simplify UI

### Core Components

```
oneJournal/
├── index.html          # Main application entry
├── src/
│   ├── main.js         # Application initialization & entry point
│   ├── components/     # Template function components
│   │   ├── toolbar.js      # Top toolbar with hamburger
│   │   ├── footer.js       # Footer with sync status
│   │   ├── sidebar.js      # Left sidebar
│   │   ├── noteCard.js     # Note card component
│   │   ├── notebookCard.js # Notebook card component
│   │   ├── editor.js       # Note editor
│   │   ├── overviewMode.js # Overview mode view
│   │   ├── settingsMode.js # Settings panel
│   │   └── modal.js        # Modal dialogs
│   ├── modules/        # Core application logic
│   │   ├── storage.js      # IndexedDB wrapper
│   │   ├── sync.js         # WebDAV sync logic
│   │   ├── canvas.js       # Drawing/handwriting engine
│   │   ├── notes.js        # Note management
│   │   ├── notebooks.js    # Notebook management
│   │   ├── theme.js        # Theme switching logic
│   │   └── router.js       # Mode/view routing
│   └── styles/
│       ├── main.css        # Base styles & CSS variables
│       ├── themes/
│       │   ├── light.css   # Light theme
│       │   ├── dark.css    # Dark theme
│       │   └── epaper.css  # High contrast e-paper theme
│       ├── layout.css      # Layout (toolbar, sidebar, footer)
│       ├── components.css  # Component styles
│       └── editor.css      # Editor-specific styles
├── public/             # Static assets (if needed)
├── dist/               # Build output (gitignored)
├── package.json
├── vite.config.js
├── justfile
├── .eslintrc.json
├── .prettierrc
└── .gitignore
```

## Implementation Phases

### Phase 1: Core Infrastructure (Foundation)

**Goal**: Set up basic app structure and local storage

#### Tasks:

1. **Project Setup**
   - Initialize npm project (`package.json`)
   - Install Vite and development dependencies
   - Set up Vite configuration
   - Create `justfile` with common commands
   - Configure ESLint and Prettier
   - Set up `.gitignore`
   - Create basic HTML structure
   - Set up CSS framework (minimal, custom)
   - Initialize JavaScript modules

2. **IndexedDB Storage Layer**
   - Design database schema:
     ```javascript
     {
       notebooks: {
         id: UUID,
         title: string,
         description: string,
         color: string,  // Optional color for visual organization
         created: timestamp,
         modified: timestamp,
         synced: boolean,
         deleted: boolean
       },
       notes: {
         id: UUID,
         notebookId: UUID | null,  // null for quick notes
         title: string,
         // All notes support mixed content (text + handwriting + drawing)
         textContent: string,      // Rich text/markdown content
         strokes: array,           // Drawing/handwriting strokes with pressure data
         canvasData: blob,         // Optional: rendered canvas snapshot for preview
         created: timestamp,
         modified: timestamp,
         synced: boolean,
         deleted: boolean,
         tags: array
       },
       settings: {
         key: string,
         value: any
         // Examples: theme, webdav_url, last_sync, etc.
       },
       syncQueue: {
         id: auto-increment,
         itemId: UUID,
         itemType: 'note' | 'notebook',
         operation: 'create' | 'update' | 'delete',
         timestamp: timestamp
       }
     }
     ```
   - Implement CRUD operations
   - Add indexing for search/filtering
   - Add relationship queries (notes by notebook)

3. **Basic UI Shell**
   - Top toolbar with hamburger menu (aligned right)
   - Left sidebar (collapsible)
   - Main content area with mode switching
   - Footer with sync status
   - Responsive layout

### Phase 1.5: Theme System & Navigation

**Goal**: Implement theme switching and view modes

#### Tasks:

1. **Theme System**
   - Create CSS files for three themes:
     - `light.css` - Default light theme
     - `dark.css` - Dark mode
     - `epaper.css` - High contrast for e-paper devices
   - Implement theme switching logic in `theme.js`
   - Detect system preference (`prefers-color-scheme`)
   - Persist theme choice in settings
   - E-paper mode: disable animations/transitions

2. **View Mode Routing**
   - Implement simple router in `router.js`:
     - Overview mode (default)
     - Notebook mode
     - Settings mode
   - Update main content area based on mode
   - Update toolbar actions based on mode
   - Browser history support (optional)

3. **Settings UI**
   - Create settings panel component
   - Theme selector dropdown
   - Placeholder for WebDAV settings
   - Save/restore settings from IndexedDB

### Phase 2: Overview Mode & Note Management

**Goal**: Implement overview mode with notebooks and quick notes

#### Tasks:

1. **Overview Mode UI**
   - Grid/list view for notebooks
   - Quick notes section
   - Recent notes list
   - "New Notebook" and "New Note" buttons
   - Empty states for no content

2. **Notebook Management**
   - Create notebook with title, description, color
   - List all notebooks
   - Delete notebook (with confirmation)
   - Edit notebook properties
   - Notebook card component with preview

3. **Quick Notes Management**
   - Create quick note (note without notebook)
   - List quick notes in overview
   - Note card component
   - Basic metadata display (date, has text/strokes)

4. **Navigation**
   - Click notebook to enter notebook mode
   - Click note to open editor
   - Sidebar updates based on context

### Phase 3: Note Editor (Text)

**Goal**: Implement text editing in notes

#### Tasks:

1. **Rich Text Editor**
   - Use `contenteditable` div or textarea for text content
   - Basic formatting toolbar (bold, italic, lists, headings)
   - Markdown support (optional enhancement)
   - Text content saved to `textContent` field

2. **Note Editing**
   - Create new note (empty text and strokes)
   - Edit note text content
   - Save note (auto-save with debouncing)
   - Delete note (with confirmation)
   - Note title editing

3. **UI Polish**
   - Keyboard shortcuts
   - Focus management
   - Unsaved changes warning

### Phase 4: Canvas Drawing Engine

**Goal**: Add handwriting and drawing capabilities to all notes

#### Tasks:

1. **Canvas Setup**
   - Initialize HTML5 Canvas overlay on note editor
   - Implement pointer event handlers:
     - `pointerdown`, `pointermove`, `pointerup`
     - Detect stylus vs touch vs mouse
     - Capture pressure sensitivity (`pressure` property)
   - Canvas layer sits above/beside text editor

2. **Drawing Features**
   - Stroke rendering (smooth lines)
   - Pen tools: pen, highlighter, eraser
   - Stroke width and color selection
   - Pressure-sensitive line width
   - Undo/redo functionality

3. **Stroke Storage**
   - Store strokes as vector data in `strokes` array
   - Each stroke: `{points: [{x, y, pressure, timestamp, page}], color, width, tool}`
   - Include page number with each stroke point for multi-page support
   - Serialize canvas to blob for thumbnails/preview (`canvasData`)
   - Efficient storage format (compressed JSON)

4. **Infinite Scrolling Canvas**
   - Support vertical infinite scrolling (tens of A4-sized pages)
   - Virtual pagination: render only visible pages + buffer
   - Page boundaries for organization (e.g., A4: 794x1123px @ 96dpi)
   - Smooth scrolling between pages
   - Page indicators/minimap for navigation
   - Auto-extend canvas as user draws near bottom

5. **Mixed Content Editing**
   - Seamlessly combine text and canvas in same note
   - Toggle between text editing and drawing modes
   - Text and canvas layers work together with scrolling
   - Both text and strokes save to same note

### Phase 5: WebDAV Sync

**Goal**: Implement cloud sync with Nextcloud/WebDAV

#### Tasks:

1. **WebDAV Client Integration**
   - Add webdav library (e.g., `webdav` npm package or custom implementation)
   - Connection settings UI:
     - Server URL
     - Username/password (stored securely in IndexedDB)
     - Test connection

2. **Sync Logic**
   - Conflict resolution strategy (last-write-wins or manual merge)
   - Sync queue management
   - Upload new/modified notes
   - Download remote changes
   - Handle deleted notes (soft delete)

3. **Sync State Management**
   - Track sync status per note
   - Show sync indicators in UI
   - Manual sync trigger
   - Auto-sync on interval (configurable)
   - Offline detection and queue management

4. **Data Format**
   - Export notes to WebDAV-friendly format (JSON files)
   - File naming convention: `{noteId}.json`
   - Attachments/canvas blobs as separate files

### Phase 6: Advanced Features

**Goal**: Polish and enhance user experience

#### Tasks:

1. **Search & Organization**
   - Full-text search
   - Tags/categories
   - Folders/notebooks
   - Favorites/pinning

2. **Export/Import**
   - Export to PDF (using jsPDF or similar)
   - Export to PNG (canvas notes)
   - Export to Markdown (text notes)
   - Import from files

3. **Settings & Customization**
   - Theme support (light/dark mode)
   - Canvas settings (default pen color, width)
   - Sync settings
   - Keyboard shortcuts customization

4. **Performance Optimization**
   - Virtual scrolling for large note lists
   - Lazy loading of canvas data
   - IndexedDB query optimization
   - Canvas rendering optimization

### Phase 7: PWA & Distribution

**Goal**: Make app installable and distributable

#### Tasks:

1. **Progressive Web App**
   - Service Worker for offline support
   - Cache static assets
   - Manifest file (app icon, name, theme)
   - Install prompt

2. **Build Process**
   - Bundle into single HTML file (optional)
   - Minify CSS/JS
   - Optimize assets
   - Version management

3. **Testing**
   - Cross-browser testing (Chrome, Firefox, Safari, Edge)
   - Touch/stylus device testing
   - WebDAV server compatibility testing
   - Performance testing

## Technical Decisions

### Why Single File (or minimal files)?

- **Portability**: Easy to share and host
- **Simplicity**: No complex build pipeline required
- **Offline-first**: All assets bundled together

### Why IndexedDB?

- **Capacity**: Much larger than localStorage (GBs vs MBs)
- **Performance**: Asynchronous, won't block UI
- **Structured**: Better for complex data (strokes, metadata)

### Why Canvas over SVG?

- **Performance**: Better for many strokes/points
- **Pressure sensitivity**: Direct control over rendering
- **Simplicity**: Easier stroke smoothing and rendering

### Why WebDAV?

- **Standard protocol**: Works with Nextcloud, ownCloud, etc.
- **Simple**: Well-documented, easy to implement
- **Self-hosted**: User owns their data

## Development Approach

### Development Tooling Setup

#### Vite Configuration

- **Development**: Fast dev server with HMR
- **Build**: Bundle to single HTML file using vite-plugin-singlefile
- **Preview**: Test production build locally
- **Optimization**: Minification, tree-shaking

#### Just Commands (justfile)

```
# Development
dev              # Start Vite dev server
build            # Build for production
preview          # Preview production build

# Code Quality
lint             # Run ESLint
format           # Run Prettier
format-check     # Check formatting without writing
type-check       # Check JSDoc types (if enabled)

# All checks
check            # Run all checks (lint + format-check + type-check)

# Utilities
clean            # Remove build artifacts
install          # Install dependencies
```

#### ESLint Configuration

- **Config**: `eslint:recommended` + browser environment
- **Rules**:
  - Enforce consistent code style
  - Catch common errors
  - No unused variables
  - Prefer const/let over var
- **Plugins**: None required for vanilla JS (keep it simple)

#### Prettier Configuration

- **Print width**: 100
- **Semi**: true
- **Single quote**: true
- **Trailing comma**: es5
- **Tab width**: 2
- **Arrow parens**: avoid

#### Optional: JSDoc + TypeScript Checking

- Use JSDoc comments for type hints
- Enable `checkJs` in jsconfig.json
- Get IDE autocomplete and type checking without TypeScript compilation
- Example:
  ```javascript
  /**
   * @param {string} noteId
   * @returns {Promise<Note|null>}
   */
  async function getNote(noteId) { ... }
  ```

### Iteration Strategy

1. Build each phase incrementally
2. Test thoroughly before moving to next phase
3. Keep single-file version working throughout (via Vite build)
4. Maintain backward compatibility for IndexedDB schema
5. Run `just check` before committing

### Testing Strategy

- Manual testing on multiple devices
- Test with real stylus devices (Surface Pen, Apple Pencil, etc.)
- Test WebDAV with actual Nextcloud instance
- Performance testing with large notes (1000+ strokes)
- Use Vite preview to test production builds

## Potential Challenges & Solutions

| Challenge                   | Solution                                         |
| --------------------------- | ------------------------------------------------ |
| Large canvas data size      | Store as compressed vector data, not images      |
| Sync conflicts              | Implement last-write-wins with conflict flagging |
| Stylus palm rejection       | Use pointer event types and CSS touch-action     |
| Offline sync queue          | Robust queue with retry logic and error handling |
| Cross-origin WebDAV         | CORS configuration on server, or use proxy       |
| Performance with many notes | Virtual scrolling, pagination, lazy loading      |

## Success Criteria

- ✅ Works on Windows, Linux, macOS, Android, iOS (via browser)
- ✅ Supports active stylus with pressure sensitivity
- ✅ Notes sync reliably with Nextcloud/WebDAV
- ✅ Works fully offline (with sync queue)
- ✅ Fast and responsive (<100ms note switching)
- ✅ Can be built without platform-specific tools
- ✅ Distributable as single HTML file or PWA
- ✅ Three theme support (light, dark, high-contrast e-paper)
- ✅ Organized with notebooks and quick notes
- ✅ Clean, intuitive UI with toolbar, sidebar, and footer

## UI Feature Summary

### Layout

- **Top Toolbar**: App title, contextual actions, hamburger menu (right-aligned)
- **Left Sidebar**: Collapsible, shows notebooks/notes, search/filter
- **Main Content**: Three modes - Overview, Notebook, Settings
- **Footer**: Sync status, last sync time, connection indicator

### Themes

1. **Light**: Default clean interface
2. **Dark**: Low-light optimized
3. **High Contrast (E-Paper)**: Black & white, no animations, e-ink optimized

### Organization

- **Notebooks**: Collections of related notes
- **Quick Notes**: Standalone notes without a notebook
- **Tags**: Optional metadata for organization

### Note Content

All notes support **mixed content** by default:

- **Text**: Rich text editing with formatting (stored in `textContent`)
- **Handwriting/Drawing**: Stylus/pen input with pressure sensitivity (stored in `strokes`)
- Both can exist in the same note simultaneously
- No need to choose a "type" - every note supports all input methods

## Next Steps

1. ✅ Review and approve this plan
2. ✅ Set up basic project structure
3. Continue with Phase 1 implementation (IndexedDB storage)
4. Iterate and gather feedback after each phase
