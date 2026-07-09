# Changelog

## [0.5.33] - 2026-07-06

### Security
- **Recognition backend**: sidecar now binds to `localhost` only by default; remote access requires explicit opt-in (`ServerSettings:AllowRemote` or `--allow-remote`)
- **Native audio**: recording path validated to prevent path traversal / arbitrary file reads, restricted to temp/cache dirs
- **Tauri capabilities**: removed unused `shell:allow-open` permission
- **Master password**: clearing it now also disables local encryption flag, preventing saves from silently failing closed
- **Encryption**: PBKDF2 iteration count raised from 100,000 to 600,000 for new key derivations; existing configs keep their stored iteration count for backward compatibility

### Changed
- **Thumbnails**: always re-rendered on demand instead of stored and synced — removes stale/missing-thumbnail and etag-churn bugs
- **Sync/storage**: reworked conflict and etag handling in `nextcloudSync.js`/`storage.webdav.js` following internal code review; simplified `tombstones.js`; added `sanitizeHtml.js` and `mime.js` utilities
- **ImageCropper**: JPEG quality raised to 0.95, added bilinear resampling and contrast LUT for sharper scanned/cropped images
- **NoteCanvas**: media saves now coalesced (one in-flight + one trailing save) with progress labeling; note close waits for pending media saves
- **UI**: improved keyboard handling (ESC/ENTER) and focus management in modals/dialogs; search field auto-focuses on tab activation
- Nextcloud supported version range bumped to 30–35
- Settings: "reset master password" only shown when a master password is set; removed unnecessary `resetSyncWorker` calls on sign-in/disconnect
- **Handwriting recognition (Windows)**: settings UI now shows a simple sidecar status indicator instead of a configurable service URL — self-hosting the recognition service is no longer a supported scenario
- **Handwriting recognition (other platforms)**: settings now show a hint that the feature is Windows-only, replacing the fallback-URL field
- Removed the legacy standalone Windows-service installer (`install-service.ps1`, `just package-backend`) — the recognition backend is only shipped as the bundled Tauri sidecar now

## [0.5.29-alpha.4] - 2026-04-20

### Fixed
- **Nextcloud**: App crash on load — `window.jQuery` is also a getter-only property in some NC versions; assignment now wrapped in try/catch like `window.$`
- **Nextcloud**: Text editor toolbar missing on subdirectory NC installs — Trumbowyg registered on NC's jQuery instead of ours because `window.jQuery` assignment was silently failing; now uses `Object.defineProperty` to redefine as writable first
- **Nextcloud**: WebDAV requests failing on subdirectory installs (e.g. `/nextcloud/`) — base URL now includes `OC.webroot` prefix

## [0.5.29-alpha.1] - 2026-04-19

### Fixed
- **All platforms**: Perspective transform broken — UMD library's `}(this, ...)` pattern fails in ES module strict mode; replaced with an explicit-scope wrapper shim that works in both Tauri (runtime) and Nextcloud (build-time, no `unsafe-eval`)
- **Nextcloud**: Text toolbar icons missing — Trumbowyg SVG sprite was inserted as `body.firstChild`, breaking Nextcloud's flex header layout; sprite is now relocated after `#header` post-init
- **Nextcloud**: Note options button displaced to bottom-right corner — button moved out of `.note-card-actions` container so it anchors to the card's top-right corner
- **Nextcloud**: App footer (version number) hidden — not needed in Nextcloud context

## [0.5.28-alpha.4] - 2026-04-19

### Fixed
- **Nextcloud**: App crash on load due to jQuery `$` conflicting with Nextcloud's getter-only `window.$` — fixed with try/catch assignment (descriptor check was silently dropped by esbuild tree-shaking)
- **Nextcloud**: Inter font rejected by browser font sanitizer — bundled font now excluded from NC build
- **Nextcloud**: Undo/redo history cleared after every local save — local WebDAV writes no longer trigger a live update reload; only external sync changes do
- **Nextcloud**: WebDAV folder structure not recreated after uninstall/reinstall — app now verifies root folder exists on startup instead of trusting a cached flag
- **Nextcloud**: File lock (HTTP 423) causing infinite save loop — PUT requests now retry with backoff on 423 responses
- **Nextcloud**: Perspective transform not working — UMD library's `)(this)` root detection fails in ES module strict mode; patched at build time to use `)(globalThis)` instead
- **Nextcloud**: Archive signature corrupted by Windows line endings — signing now runs inside the Linux container with `openssl base64 -A`

### Added
- `just nc-test` / `just nc-test-down` recipes for testing the published App Store package in a clean throwaway NC container (port 8081, no volume mount)

## [0.5.27] - 2026-04-18

First public alpha release as a Nextcloud app.

### Added
- Nextcloud App Store release (`noteberg` app ID)
- Native Windows audio DSP chain (compressor + limiter) matching the browser Web Audio processing
- `just build-nc` recipe for building and signing Nextcloud app releases
- `just fct` recipe for format, check, and test in one step
- OS keychain credential storage on all platforms (Windows Credential Manager, Android Keystore)
- End-to-end encryption for Nextcloud sync

### Changed
- Updated README with accurate security description, Quick Start, and OSS attributions
- Updated DESIGN.md with full architecture documentation
- Replaced ESLint/Prettier with Biome for linting and formatting
