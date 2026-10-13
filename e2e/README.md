# Browser e2e tests (PoC)

Real browser, real app, **no compiled Tauri app**. Playwright drives installed
Edge (same Chromium engine as WebView2) against the production frontend bundle,
with the Tauri runtime faked.

```
just test-e2e          # or: npm run test:e2e
npx playwright test --ui           # debug interactively
npx playwright test -g "stroke"    # one test
E2E_BROWSER=chromium npm run test:e2e   # use Playwright's own Chromium
```

`playwright.config.js` builds into `dist-e2e/` and serves it with `vite preview`
on port 3100 (not 3000, so a running `tauri dev` is unaffected). The build takes
~3s; the bundle is used instead of the dev server because Vite dev serves ~150
unbundled modules per page load, which every test would pay for.

## Layout

- `support/tauriMock.js` — installs `window.__TAURI_INTERNALS__` before app
  scripts run. Commands are a static table (`DEFAULT_TAURI_RESPONSES`); unknown
  commands reject loudly, so a new native dependency fails a test instead of
  hanging. All calls are recorded on `window.__tauriCalls`.
- `support/fixtures.js` — `test` whose `page` is already booted as a native
  client in a fresh context (empty IndexedDB), and which fails on uncaught page
  errors. Override mocked commands per test with `test.use({ tauriResponses })`.
- `support/fakeArchive.js` — in-memory stand-in for the Rust zip commands
  (`restore_*`, `backup_*`) over a `{ entryName: {text} | {base64} }` map, i.e.
  the archive layout itself. `window.__fakeArchive.source` is what restore reads
  (swap with `.load(entries)`); `.written` is what a backup produced, and can be
  fed straight back in as another install's restore source.
- `support/fakeKeyring.js` — stateful stand-in for the OS keychain commands
  (`save_credential`, `get_credential`, `delete_credential`). Entries survive a
  reload like the real keychain; `window.__fakeKeyring.delete(key)` makes it
  "lose" one.
- `support/input.js` — pen strokes (with pressure) and multi-touch gestures sent
  through Chromium's input pipeline over CDP, so the app gets real
  `PointerEvent`s of type pen/touch rather than a mouse.
- `fixtures/media.js` — flat-colour PDFs (pdf-lib) and PNGs (the browser's
  canvas), built at run time. One colour per page/image, so "this page is on
  screen" is a pixel count (`countCanvasPixels` in app.js).
- `fixtures/fakeCamera.js` — generates a Y4M video of a white sheet seen at an
  angle on a dark desk, which Chromium plays as the webcam.
- `fixtures/corpus.js` — `buildCorpus({ notes: { <id>: overrides } })`: a known
  archive (2 notebooks, 4 notes incl. strokes, text, an image, a recycle-bin
  note). Restoring it is the supported way to seed an app with known content.
- `support/styles.js` — `expectVisiblySelected(selected, unselected)`: computed-style
  comparison, so a missing or overridden CSS rule for a "selected" state fails
  (unit tests run without the app's CSS and cannot see this). Blurs and unhovers
  first, because focus rings otherwise mask a missing selected style.
- `support/app.js` — user-level helpers (`createQuickNote`, `drawStroke`,
  `restoreFromSettings`, ...) and black-box IndexedDB readers (`readNotes`, ...).
- `*.e2e.js` — specs. (Not `*.test.js`: those belong to vitest.)

## Projects

`playwright.config.js` has two projects. `app` runs every spec except
`camera.e2e.js`. `camera` runs that one with Chromium's fake-camera flags,
which apply to the whole browser and so cannot be set per test.
`npx playwright test --project camera` runs it alone.

First-run tours are marked seen by default (they overlay and intercept clicks);
use `test.use({ firstRunHelp: true })` to test them. `test.use({ theme: "dark" })`
switches theme (default light).

## What belongs here

Unit tests mock `storage.js`, the router and the archive, so they cannot see the
seams between modules. An e2e test earns its place only if it needs a real
browser (canvas, workers, IndexedDB, pdf.js, layout), crosses a seam the unit
tests mock out, or is a whole user journey. Never re-test a branch a unit test
already covers — assert the outcome in the DOM or IndexedDB.

## Seeding: restore per test, not a snapshot

Playwright's `storageState({ indexedDB: true })` was tried as a way to restore
once and reuse the result. It keeps notes but **loses blob bytes** (`files.data`
comes back as a plain object), so any test touching media would silently see
broken images. Seeding by restoring through the UI per test (~2s) stays.

## Not covered (by design)

Rust commands, WebView2/Android specifics, Nextcloud sync, the NC build. The
manual pass in `documentation/manual_test.md` covers what is left.
