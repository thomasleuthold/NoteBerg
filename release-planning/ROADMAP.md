# Release roadmap

Private, git-ignored. Updated 2026-10-14, right after 0.5.43.

Rule of thumb: a release ships what is **finished and verified on Windows, Android and Nextcloud**. Items below are candidates, not promises; scope is cut by dropping items, never by shipping them half-done.

## 0.5.44 — proposed scope

| # | Item | Size | Risk | Notes |
|---|------|------|------|-------|
| 1 | Task properties and filter | S (branch exists) | low | Branch `task_properties_and_filter` is one commit, 30 files, from 2026-09-22. Needs rebase on main (backup/restore, settings, i18n touched since), then multi-platform check and manual test. Cheapest large user-visible win |
| 2 | Search: bounded cost for huge PDFs | M | medium | Investigate first (profile where the minutes go), then fix. Likely cause: PDF text extracted/scanned at search time. Fix direction: index PDF text once (per page, stored, invalidated on PDF change) and search the index; show incremental results. Touches all three platforms |
| 3 | Store rating request (Android) + README link | XS | low | Play In-App Review API (Kotlin plugin). Ask rarely: after a positive moment (e.g. after N days and a completed backup or sync), never in the middle of work, honor the quota. README badge/link is trivial |
| 4 | Performance and stability | ongoing | low | Time-boxed bucket, not a feature. Fill it from real findings (the search work will produce some) rather than speculative refactors |

## 0.5.45 — candidate

| Item | Size | Risk | Notes |
|------|------|------|-------|
| Custom pen/marker colors with a good picker | M–L | medium | Bigger than it looks: color is stored per stroke, so the data model, rendering, PDF export, sync/merge, presets, and dark-mode color inversion (if any) all need checking. Picker UX is the real work: recent/saved colors, hex input, eyedropper on canvas, touch + pen friendly, works on a small phone and in the Nextcloud web build. Design it separately (mock-ups first) |
| AI: audio transcription | M | medium | Needs an audio-capable endpoint; most vision-only OpenAI-compatible setups will not have one. Decide provider story first |
| AI: note / PDF summary | M | medium | Reuses the existing connection (aiProvider.js). PDF size limits and cost warnings matter — same lesson as recognition's per-page queue |

## Strategic — not scheduled

- **Second sync target** (Google Drive / OneDrive / other). Largest strategic lever (reaches non-Nextcloud users) and largest cost. Needs its own design doc before any commitment: how the sync layer is abstracted (today `nextcloudSync.js` is the native path, with etag/WebDAV assumptions throughout), conflict model, OAuth on Windows and Android, app verification / review requirements for Google, encryption interaction. A WebDAV-generic target (any WebDAV server) might deliver much of the reach for a fraction of the work and should be evaluated alongside.
- **Notebook sharing**: design in `documentation/notebook_sharing_design.md`.

## Open items from earlier work

- Text layer vs ink offset across devices — two fixable causes found, not fixed (`documentation/investigations/TEXT_LAYER_CROSS_DEVICE_OFFSET.md`).
- Nextcloud Android Chrome input throttling — no fix available.

## Per-release checklist

1. `just fct` green.
2. Multi-platform pass: Windows, Android, Nextcloud.
3. CHANGELOG entries under `[Unreleased]`, Play release notes (Android items, <= 500 chars).
4. Version bump, `info.xml` release date, stamp the CHANGELOG.
