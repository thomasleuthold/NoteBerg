# oneJournal

A cross-platform note-taking app with handwriting support and Nextcloud sync.

## Features

- ✍️ Handwriting with active stylus support
- 📝 Text editing with automatic mode switching
- 🗂️ Notebook organization
- 🔄 Nextcloud sync via Login Flow v2
- 💾 Offline-first (IndexedDB storage)
- 🖥️ Desktop app (Windows, macOS, Linux)
- 📱 Android app

## Quick Start

### Desktop

```bash
npm install
npm run tauri dev
```

### Android

See [ANDROID_BUILD_WINDOWS.md](ANDROID_BUILD_WINDOWS.md) for detailed setup.

```bash
npm run tauri android build
```

## Project Structure

```
oneJournal/
├── src/
│   ├── components/      # UI components
│   ├── modules/         # Core logic (storage, sync, canvas)
│   └── styles/          # CSS files
├── src-tauri/           # Tauri/Rust backend
├── public/              # Static assets
└── dist/                # Build output
```

## Technology Stack

- **Framework**: Tauri v2 (Rust + Web)
- **Frontend**: Vanilla JavaScript (ES6+)
- **Build**: Vite
- **Storage**: IndexedDB
- **Sync**: Nextcloud (Login Flow v2 + WebDAV)
- **Drawing**: HTML5 Canvas with PointerEvent API

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
```

## Documentation

- [ANDROID_BUILD_WINDOWS.md](ANDROID_BUILD_WINDOWS.md) - Android build setup
- [DESIGN.md](DESIGN.md) - Architecture and design decisions

## License

MIT
