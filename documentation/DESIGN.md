# NoteBerg - Architecture & Design

## Architecture Overview

### Technology Choice: Tauri

Switched from web app to Tauri to eliminate CORS issues with Nextcloud sync.

**Benefits:**
- Native HTTP client (no CORS restrictions)
- Cross-platform: Windows, macOS, Linux, Android
- Small binary size (~10-20 MB)
- Native performance
- Offline-first capabilities

### Core Components

```
┌─────────────────────────────────────────┐
│           Frontend (Vite + JS)          │
│  ┌─────────────┐  ┌──────────────────┐ │
│  │  Components │  │  Drawing Canvas  │ │
│  └─────────────┘  └──────────────────┘ │
│  ┌─────────────┐  ┌──────────────────┐ │
│  │   Storage   │  │  Nextcloud Sync  │ │
│  └─────────────┘  └──────────────────┘ │
└─────────────────────────────────────────┘
                    │
┌───────────────────▼─────────────────────┐
│          Tauri Backend (Rust)           │
│  ┌──────────┐  ┌──────────┐  ┌───────┐ │
│  │   HTTP   │  │  Opener  │  │ Shell │ │
│  └──────────┘  └──────────┘  └───────┘ │
└─────────────────────────────────────────┘
```

## Data Layer

### Storage: IndexedDB

```javascript
{
  notebooks: {
    id, name, color, createdAt, updatedAt
  },
  notes: {
    id, notebookId, name, content, strokes,
    createdAt, updatedAt
  }
}
```

### Sync Strategy

**Nextcloud Integration:**
- Authentication: Login Flow v2 (OAuth-style)
- File Storage: WebDAV API
- Structure: `/NoteBerg/{notebook|note}_{id}.json`

**Sync Flow:**
1. Upload local changes (PUT)
2. Download remote changes (PROPFIND + GET)
3. Merge into local IndexedDB

## Drawing System

### Canvas Architecture

**Stroke-based rendering:**
- Strokes stored as arrays of points: `{x, y, pressure, timestamp}`
- Separate text layer overlays canvas
- Mode auto-switching: drawing → text, text → drawing

**Input Handling:**
- PointerEvent API for stylus, touch, mouse
- Pressure sensitivity support
- Eraser detection via `pointerType` or button

### Drawing Modes

1. **Draw Mode**: Freehand strokes
2. **Erase Mode**: Remove strokes by intersection
3. **Text Mode**: Editable text overlay

Auto-switch triggers:
- Drawing detected → switch to draw mode
- Text click → switch to text mode

## Platform-Specific

### Android Considerations

**URL Opening:**
- Uses `@tauri-apps/plugin-opener` (Android Intent system)
- Fallback: Manual URL copy via clipboard

**Build Configuration:**
- Signing: `key.properties` + keystore
- NDK for native compilation
- Min SDK: 24 (Android 7.0)

### Desktop

- Native window management
- File system access
- System tray integration (future)

## Security

**Credentials Storage:**
- LocalStorage for app passwords
- No plaintext passwords
- Nextcloud app-specific passwords

**Network:**
- HTTPS enforced for production
- Cleartext allowed in debug builds only

## Future Considerations

- Conflict resolution for concurrent edits
- End-to-end encryption option
- PDF export
- Handwriting recognition
- Real-time collaboration
