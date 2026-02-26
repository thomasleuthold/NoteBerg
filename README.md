# NoteBerg

> **Beta software** — NoteBerg is an experimental, personal note-taking app built almost entirely through **vibe coding** (AI-assisted development). It is not production-ready. Expect rough edges, breaking changes, and missing features.

A cross-platform note-taking app with handwriting support, text editing, and Nextcloud sync — built as an experiment in how far AI-assisted development can take a real-world desktop application.

## Features

### Handwriting & Drawing
- ✍️ Handwriting input with active stylus and pressure sensitivity
- 🖊️ Pen tool with customizable colors
- 🖍️ Marker/highlighter tool
- ⬜ Lasso selection — move, resize, rotate, copy selected strokes
- 🔲 Eraser tool for stroke removal
- ↩️ Unlimited undo/redo across all operations
- ☑️ Mark handwritten notes as task

### Text Editing
- 📝 Rich text editor (WYSIWYG) with formatting, tables, colors, and font sizes
- 🔄 Automatic mode switching between drawing and text editing
- ☑️ Task checkboxes inline with notes

### Handwriting Recognition
- 🔍 Automatic background recognition of handwritten content (Windows only, via local recognition service)
- 💬 Recognition text used for full-text search across all notes

### Media & Import/Export
- 📄 PDF import — annotate PDFs with pen and text
- 🖼️ Image insertion with cropping and perspective correction
- 📤 PDF export with automatic A4 pagination, images, strokes, and background patterns

### Organization
- 🗂️ Notebooks for hierarchical organization
- 📋 Note overview with thumbnail previews
- 🔍 Full-text search across handwriting and typed text
- ☑️ Markers tab — browse task markers across all notes
- 🗑️ Recycle bin with soft delete and permanent deletion

### Sync & Storage
- 🔄 Nextcloud sync via Login Flow v2 (OAuth2) + WebDAV
- 💾 Offline-first — all data stored locally in IndexedDB
- 🔀 Conflict resolution with automatic and manual merge
- ⚡ Background sync with change detection

### Security & Encryption
- 🔐 Optional master password with PBKDF2 (100,000 iterations) + AES-256-GCM encryption
- 🔒 Optional end-to-end encryption for Nextcloud sync

### UI & Platform
- 🌙 Dark mode / light mode with system preference detection
- 🖥️ Desktop app — Windows, macOS, Linux not tested so far
- 📱 Mobile app — Android, iOS not tested so far
- 🌐 Background patterns — ruled lines and grid
- 🔡 Internationalization — English, German

## Security Warning

> ⚠️ **This app is in beta and has known security limitations. Do not use it to store highly sensitive data.**

Current security state:

- **Master password** is stored in `localStorage`, encrypted with AES-256-GCM — but the encryption key is **hardcoded in the source code**. Anyone with access to the app bundle can decrypt it. The OS keyring (Windows Credential Manager, macOS Keychain) is **not used** at the moment.
- **Nextcloud credentials** (server URL, username, app password) are stored the same way — `localStorage` with the same hardcoded encryption key.
- Neither the master password nor Nextcloud credentials have proper OS-level protection. The "encryption" is obfuscation only.
- The app was built largely via **vibe coding (AI-assisted development)** and has not undergone a security audit.
- Use a dedicated Nextcloud app password (not your main account password) for sync — you can revoke it independently if needed.

## Quick Start

### Desktop

```bash
npm install
npm run tauri dev
```

### Android

See [ANDROID_BUILD_WINDOWS.md](documentation/ANDROID_BUILD_WINDOWS.md) for detailed setup.

```bash
npm run tauri android build
```

## Development

```bash
# Desktop development
npm run dev              # Frontend only
npm run tauri dev        # Full Tauri app

# Android development
npm run tauri android dev

# Build
npm run build            # Frontend
npm run tauri build      # Desktop app
npm run tauri android build  # Android APK

# Linting / formatting (Biome)
npm run lint
npm run format
```

## Project Structure

```
NoteBerg/
├── src/
│   ├── components/         # UI components
│   ├── modules/            # Core logic (storage, sync, canvas, encryption)
│   └── styles/             # CSS files
├── src-tauri/              # Tauri/Rust backend
├── src-recognition-backend/ # Windows handwriting recognition service (C#)
├── public/                 # Static assets
└── documentation/          # Build guides and design docs
```

## Technology Stack

- **Framework**: Tauri v2 (Rust + Web)
- **Frontend**: Vanilla JavaScript (ES6+)
- **Build**: Vite
- **Storage**: IndexedDB via `idb`
- **Sync**: Nextcloud (Login Flow v2 + WebDAV)
- **Drawing**: HTML5 Canvas with PointerEvent API
- **Text editor**: Trumbowyg
- **PDF rendering**: PDF.js
- **PDF generation**: pdf-lib
- **Thumbnail generation**: html2canvas

## Documentation

- [ANDROID_BUILD_WINDOWS.md](documentation/ANDROID_BUILD_WINDOWS.md) — Android build setup on Windows
- [DESIGN.md](documentation/DESIGN.md) — Architecture and design decisions

## Thank You

NoteBerg stands on the shoulders of many excellent open-source projects. A sincere thank you to all their contributors:

| Project | Use |
|---|---|
| [Tauri](https://tauri.app/) | Cross-platform desktop/mobile app framework |
| [Vite](https://vitejs.dev/) | Frontend build tool |
| [vite-plugin-singlefile](https://github.com/richardtallent/vite-plugin-singlefile) | Bundle app into a single HTML file |
| [idb](https://github.com/jakearchibald/idb) | IndexedDB wrapper |
| [i18next](https://www.i18next.com/) | Internationalization |
| [jQuery](https://jquery.com/) | DOM utilities (required by Trumbowyg) |
| [Trumbowyg](https://alex-d.github.io/Trumbowyg/) | Lightweight WYSIWYG text editor |
| [PDF.js](https://mozilla.github.io/pdf.js/) | PDF rendering in the canvas |
| [pdf-lib](https://pdf-lib.js.org/) | PDF export generation |
| [html2canvas](https://html2canvas.hertzen.com/) | Note thumbnail generation |
| [perspective-transform](https://github.com/fhguilherme/perspective-transform) | Image perspective correction |
| [Feather Icons](https://feathericons.com/) | UI icon set |
| [Biome](https://biomejs.dev/) | Linting and formatting |
| [ESLint](https://eslint.org/) | JavaScript linting |
| [Prettier](https://prettier.io/) | Code formatting |
| [Vitest](https://vitest.dev/) | Unit testing framework |
| [Testing Library](https://testing-library.com/) | DOM testing utilities |
| [jsdom](https://github.com/jsdom/jsdom) | DOM environment for tests |
| [Express](https://expressjs.com/) | Dev proxy server |
| [cors](https://github.com/expressjs/cors) | CORS middleware for dev proxy |
| [node-fetch](https://github.com/node-fetch/node-fetch) | Fetch API for dev tooling |

And a special thanks to the [Nextcloud](https://nextcloud.com/) project for providing an open, self-hostable sync platform that makes apps like this possible without depending on proprietary cloud infrastructure.

## License

MIT
