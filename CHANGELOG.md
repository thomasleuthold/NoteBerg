# Changelog

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
