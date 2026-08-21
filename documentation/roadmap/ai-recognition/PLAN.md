# AI-Backed Handwriting Recognition — Implementation Plan

Companion to [DESIGN.md](./DESIGN.md). Ordered so each phase is independently testable and merges without breaking Windows recognition.

Guiding rule: **Windows sidecar behaviour must be unchanged** until a user deliberately selects a different backend. The one phase that could regress existing Windows users (Phase 1, backend extraction) lands separately from any new capability so it is bisectable on its own.

**Phase 3 is the go/no-go gate.** With geometry no longer derived from strokes (DESIGN §2.1), transcription accuracy *is* the feature — there is no fallback if the model reads handwriting badly. Phase 3 measures that before any UI, proxy, or settings work happens.

**Ordering principle: nothing blocks testing against real notes.** The measurement that decides this feature needs a configurable endpoint and a way to re-run over a corpus — so both land in Phase 2/3, ahead of the settings UI, rather than forcing a wait for Phase 5. Settings (Phase 5) adds discoverability, consent and key management over configuration that already works; it is not the gate on being able to try a model. Concretely: the Tauri allowlist (Phase 2) comes first because without it no endpoint is reachable at all, and Phase 3 carries its own dev harness (§3.0) because a hand-clicked sweep across models and corpus notes would not realistically get done.

---

## Phase 0 — Baseline and corpus

1. Record current Windows behaviour as the reference: `autoRecognition.test.js` green, plus captured sidecar output (`fullText` + word boxes) for a set of real handwritten notes. This doubles as the **accuracy baseline** every AI model is measured against.
2. Assemble the evaluation corpus:
   - multi-line prose, ordinary handwriting;
   - heavy cursive;
   - a dense page (~40 lines) — the resolution stress case;
   - a long scrolling note that will require banding (DESIGN §3.2);
   - mixed pen/marker;
   - a note over an imported PDF (does the background help or hurt? DESIGN §3.3);
   - a non-Latin sample (`ja-JP` or `zh-CN`);
   - **orientation cases** — a skewed page, deliberately vertical text, a diagram with radiating labels, and a mixed-orientation page. Under the old per-line design these were expected failures; under whole-page they are expected to **work**, and they are the evidence for that claim.

   Store expected transcriptions alongside.

**Exit:** baseline green; corpus committed with expected text. No source changes.

---

## Phase 1 — Backend abstraction (sidecar only, no behaviour change)

Pure refactor of `autoRecognition.js`:

- `recognitionService.js` — backend registry; owns rasterization, band mapping, stitching and `precision` tagging so backends never write geometry into the note (DESIGN §3.4).
- `backends/sidecarBackend.js` — today's Tauri sidecar code, moved verbatim, implementing `recognizeStrokes` (strokes in, exact boxes out). It never goes through rasterization.
- Sidecar results are tagged `precision: "exact"`; absent `precision` already means `exact` (DESIGN §2.2), so nothing downstream changes.

`autoRecognition.js` keeps the debounce, `recognizeUnprocessedNotes()`, the start/end events, and the compare-before-write.

**Exit:** Windows recognition identical to Phase 0 — same requests, same stored `recognition` object. Existing tests pass unmodified. **Standalone commit** so any Windows regression bisects to exactly this.

---

## Phase 2 — Tauri allowlist + security review

Separate phase because it is an attack-surface change, not a feature (DESIGN §8) — and it comes **before** the AI backend because nothing in Phase 3 can reach a configured endpoint from Tauri without it. `recognition.json` currently allows exactly `http://localhost:5000/*`, so a dev-configured LM Studio on `:1234` or any cloud host is blocked outright.

- Widen `src/components/recognition.json` to `http://localhost:*/*`, `http://127.0.0.1:*/*`, and `https://**`.
- Validate the destination in JS against the user's configured endpoint before every call — the allowlist is the outer bound, not the check.
- Run `/security-review` on the diff; document what the widening does and does not permit.

**Exit:** allowlist widened with a written rationale; destination validation unit-tested (a call to a host other than the configured endpoint is refused).

---

## Phase 3 — Rasterizer + AI backend, measured against real notes (dev-only)

The go/no-go phase, and the one that decides the feature. Build the minimum needed to answer "is this good enough?" — plus the minimum needed to *run that measurement repeatedly against real notes*, which is not nothing (§3.0).

### 3.0 Make it configurable and runnable before measuring anything

Real-note testing is the whole point of this phase, so the ability to point at a model and re-run must exist here — **not in Phase 5**. Two cheap pieces, in this order:

**Configuration without UI.** `getSetting`/`setSetting` (`storage.js:764`) is a plain key-value store; nothing about reading `recognition_backend`, `recognition_endpoint`, `recognition_model` or `recognition_api_key` requires a settings screen. Phase 3 reads them directly, seeded from the devtools console or a dev-only seed helper. Phase 5 later builds a UI over the *same keys* — it adds discoverability, consent and secure key storage, not capability.

The one thing that cannot wait: the key must not sit in plaintext even during development. Route it through `secureStorage.js` from the first commit, so Phase 5 is a UI over working storage rather than a storage migration.

**A harness, not a click-through.** The metric table in §3.2 is a *sweep* — several models × several corpus notes × several rendering settings. Done by hand that is hundreds of manual recognitions, so it will not actually get done, and the numbers that decide the feature will end up guessed.

So build a dev-only runner that takes a set of note IDs and a config matrix, runs recognition over each combination, and writes results (transcription, boxes, timings, token counts) to a file for diffing. Ideally a script that drives `recognitionService` directly rather than a UI affordance, so it can run unattended over the whole corpus.

This is throwaway scaffolding and worth building anyway: it is also how Phase 7's regression checks run, and how any future model swap gets re-validated without repeating the manual work.

**Real notes, not synthetic ones.** The corpus is exported real handwriting (Phase 0), not generated strokes. Synthetic strokes are uniform in pressure, spacing and rhythm in ways that flatter a recognizer — measuring against them would produce numbers that do not survive contact with a real notebook.

### 3.1 The pipeline

- `recognition/pageRasterizer.js` — note → page PNG via `OffscreenCanvas`, off the main thread, with banding (DESIGN §3.2) and the §3.3 rendering knobs exposed as parameters so the harness can sweep them.
- `backends/openAiBackend.js` — one request per band, prompting for transcription plus per-word boxes; coordinate normalization back to content space; band stitching with overlap de-duplication.
- Dev flag only. No settings UI, no gradient rendering yet — the harness inspects boxes numerically, which is more precise than looking at them anyway.

### 3.2 Measure

Across the Phase 0 corpus, on **both** a cloud model and a real self-hosted setup (Qwen2.5-VL via LM Studio or Ollama). Record results in this folder:

| Metric | Decides |
|---|---|
| **Word accuracy vs. sidecar baseline** | ship or stop |
| Accuracy on cursive / dense / non-Latin | which models are viable |
| **Accuracy on the orientation cases** | whether whole-page delivers its main promised win |
| **Effective resolution limit per model** | band height (DESIGN §3.2) |
| **Word-box drift distribution** | gradient padding (DESIGN §4) — measure distance, not vibes |
| **Merged-word frequency** | whether "per-word" is honest UI wording |
| Fixed per-request overhead, self-hosted | latency floor on local inference |
| Total latency + token cost, dense page | whether Phase 4's progress UI suffices |
| Rendering-knob sweep (§3.3) | stroke width, contrast, PDF background |

**Exit:** documented accuracy/latency/cost per candidate model, with chosen band height, gradient padding and rendering defaults — **produced by a harness that can be re-run**, not by hand. **Go/no-go** — if no model reads handwriting well enough, stop here: there is no geometry fallback to retreat to, and shipping confident wrong transcriptions is worse than shipping nothing.

---

## Phase 4 — Gradient rendering + progress UI

Two user-visible changes that both must exist before anyone can select an AI backend.

**4a. Approximate highlight rendering** (DESIGN §4):
- `CanvasRenderer.setHighlights()` (`:383`) accepts `precision` per rect; the draw loop (`:1361`) branches — `exact` keeps today's `fillRect`/`strokeRect` exactly, `approximate` draws a radial gradient with padding from Phase 3's measured drift.
- `NoteCanvas._highlightSearchTerms()` (`:1415`) passes `precision` through.
- Visual check: sidecar highlights on Windows are pixel-identical to before.

**4b. Progress and cancellation** (DESIGN §7):
- Keep `recognition-start` / `recognition-end` (so `footer.js:133` keeps working); add `recognition-progress` with `{phase, current, total, noteId}`. Phases: `rasterize` → `transcribe` → `stitch`. Follow the existing phase-labelled convention (`pdfManager.js:94`).
- Thread `AbortSignal` from caller through `recognitionService` into the backend HTTP call. Cancel leaves `hasRecognition` false; the next catch-up scan retries.
- Foreground surface: footer indicator gains a quantified readout, non-modal.
- Backlog surface: `recognizeUnprocessedNotes()` reports note `x/N`, dismissible, with cancel.
- NC app: revisit the `if (!IS_NEXTCLOUD)` guard in `footer.js:122` — the proxied path is the slow case and has no status UI today.
- **The `destroy()` audit** (DESIGN §7, §11): `NoteCanvas.destroy()` awaits recognition before sync. Measure with a slow backend; if closing a note stalls, non-sidecar recognition moves fully background and the note gains recognition on the next pass. This is a correctness check on an existing race fix (`destroyPromise` ordering ahead of `syncOnNoteClose()`), so it must not be skipped.

**Exit:** approximate highlights render as gradients and read as intentional; a 40-second recognition shows quantified progress, cancels cleanly, and does not stall note closing. Sidecar path visually unchanged.

---

## Phase 5 — Settings, consent, and Android enablement

Makes the feature usable by someone who is not us. Configuration already works by this point (Phase 3 §3.0) — this phase adds discoverability, consent and safe key handling **over the same setting keys**, so it is UI work rather than new capability.

- Backend picker in `settingsMode.js`: Sidecar (Windows only) / Local AI / Cloud AI — **local listed first** (DESIGN §6). Reads/writes the `recognition_*` keys Phase 3 already uses.
- **Name the fidelity tier** (DESIGN §4): the sidecar gives exact word positions, AI gives approximate ones. Stated in settings, so a Windows user switching backends understands why highlights change appearance.
- Endpoint, model, API key fields. Key storage already goes through `secureStorage.js` from Phase 3, so this is a form over working storage, not a migration.
- **Consent dialog** naming the destination host before the first request; persisted as `recognition_consent_host`; re-prompt on endpoint change.
- Extend the existing "Test recognition" button to the selected backend, reporting measured round-trip so users learn their setup's speed before hitting it on a real note.
- Persistent display of active backend + destination.
- Android: the settings section becomes visible (today gated to Windows), and `recognizeUnprocessedNotes()` starts finding candidates once a backend is configured.
- Update `PRIVACY_POLICY.md` **in this phase, not later**.

**Exit:** on Android, a user configures a backend, consents, writes a note, and finds it by handwriting search. Windows default path untouched. No backend configured → silent no-op exactly as today.

---

## Phase 6 — Nextcloud proxy

- `lib/Controller/RecognitionController.php` — `POST /api/v1/recognize`, `#[NoAdminRequired]`, CSRF on, `#[UserRateThrottle]`; calls the configured endpoint via `OCP\Http\Client\IClientService`.
- Add the route to `appinfo/routes.php` (currently `page#index` only).
- `lib/Settings/AdminSettings.php` — admin sets endpoint/model/key; key held in `OCP\IAppConfig`, **never returned to the client**.
- `backends/ncProxyBackend.js` — same-origin `fetch`, `requesttoken` header (mirroring `storage.webdav.js`).
- **Payload size matters here.** Whole-page images are larger than line crops; verify NC's upload limits and PHP `post_max_size` do not bite on a dense multi-band note.
- Unconfigured → the endpoint reports unavailable and the client degrades to "recognition unavailable", exactly as a missing sidecar does today.

**Exit:** in the NC app, an admin configures once and any user's handwriting becomes searchable. Verify no API key ever appears in a client response; verify rate limiting; verify CSP/CORS are not touched from the browser side.

---

## Phase 7 — Cross-platform hardening

- **Recognize on one device, search on another** — recognition syncs as an ordinary note field (DESIGN §9). Test Android→Windows and Android→NC.
- **Mixed-fidelity across devices**: a note recognized by the sidecar on Windows and by AI on Android carries different `precision`. Confirm the compare-before-write does not ping-pong, and that `recognition.engine` disambiguates. A device must not re-recognize a note that already has recognition just because another engine produced it.
- Android performance: full-page (or multi-band) rasterization must not stall the UI.
- Degradation: endpoint unreachable, bad key, rate-limited, timeout mid-note — all leave `hasRecognition` false and retry on the next catch-up scan, never corrupt `recognition`.

**Exit:** each DESIGN §11 risk has a passing test or a documented, accepted limitation.

---

## Test strategy

- `pageRasterizer.test.js` — deterministic PNG output for a known stroke set; band boundaries land where expected; band overlap is sufficient to contain a full text line.
- `recognitionService.test.js` — backend selection; `precision` tagging (sidecar → `exact`, AI → `approximate`); band coordinate mapping; overlap de-duplication, including the case where a genuine repeated word must **not** be de-duplicated; refusal to auto-fall-back to an unchosen backend.
- `openAiBackend.test.js` — mock model responses modelling **real** VL API behaviour: coordinates outside image bounds, merged adjacent words, missing boxes for some words, refusal, malformed JSON, 429, and mid-request abort. A word with text but no usable box must still reach `fullText`.
- `CanvasRenderer` highlight tests — `exact` rects render as today (regression guard); `approximate` takes the gradient path.
- `ncProxyBackend.nextcloud.test.js` — via `vitest.config.nextcloud.js` (same pattern as `StrokeManager.nextcloud.test.js` / `ncFullscreen.nextcloud.test.js`).
- Per project convention: mocks model real external behaviour; tests assert requirements; no can't-fail tests.
- Every phase re-runs the Phase 0 Windows baseline to prove the sidecar path is unchanged.

## Multi-platform checklist (every phase)

- **Windows (Tauri)** — sidecar still default and unchanged; AI backend selectable; exact highlights render exactly as before.
- **Android (Tauri)** — the platform this feature exists for; verify on real hardware, not emulator.
- **Nextcloud app** — proxy path; no direct browser→AI call anywhere (it cannot work, DESIGN §5).

## Suggested commit boundaries

Phases 1, 2, 3 are safe standalone commits with no user-visible change (3 is dev-flagged, including its harness).

**Phase 1 must land alone** — it is the only phase that can regress existing Windows recognition, so it should bisect cleanly against nothing else.

**Phase 3's harness and dev-seeded config are scaffolding, and that is fine.** They are not throwaway in practice: the harness is how Phase 7's regression checks run and how any future model swap gets re-validated. Keep it in the tree rather than deleting it once Phase 5 lands.

Phase 4 is user-visible but backend-neutral: gradient rendering is inert until something emits `approximate` results, and progress UI is inert until something is slow. Phases 5 and 6 are the feature-visible commits, and each ships one platform.

**Not touched by this feature:** `NoteCanvas/strokeLineDetection.js` stays where it is, serving the lasso task flow. Whole-page recognition needs no line segmentation, so there is no move, no retune, and no risk to that shipped behaviour (DESIGN §8).
