# AI-Backed Handwriting Recognition — Design

Status: **Draft / for discussion.** No code written yet.
Scope: make handwriting recognition available on **all three platforms** (Windows/Tauri, Android/Tauri, Nextcloud app) by adding pluggable AI recognition backends alongside the existing Windows sidecar.

---

## 1. Why this first

Recognition is the feature that defines the category, and today it exists on exactly one of our three platforms. `autoRecognition.js` resolves its service URL from a Tauri sidecar command (`get_recognition_url`) and returns `null` everywhere else — so on Android and in the Nextcloud app, `recognizeUnprocessedNotes()` is a no-op and **handwritten content is never searchable**.

That is a parity hole in our own stated principle, and it is more damaging than a missing feature: a user who searches for a note they wrote by hand and gets nothing concludes the app loses their notes.

This also gives AI integration a job every user feels, rather than a menu of AI toys. Recognition is the beachhead; §10 covers what the same plumbing unlocks afterwards.

**Goals**
- Handwriting recognition and handwriting search on Windows, Android, and the NC app.
- Windows keeps working exactly as today, with no configuration, by default.
- Recognition backend is user- (or admin-) configurable: local AI (LM Studio / Ollama), a cloud API (OpenAI-compatible, OpenRouter), or the existing Windows sidecar.
- **Privacy is not silently traded away.** Nothing leaves the device unless the user chose a backend that sends it, and that choice is explicit.
- Recognition results stay in the existing `note.recognition` shape so search, highlighting and MCP keep working untouched.

**Non-goals (v1)**
- Replacing the Windows sidecar. It stays the Windows default: it is free, offline, fast, and already shipped.
- Live/incremental recognition as the user writes. Recognition stays debounced and runs per note.
- Recognition of drawings/diagrams as anything other than text (see §10).
- Server-side recognition running *inside* Nextcloud (no PHP inference; the NC app proxies to an external endpoint).

---

## 2. The constraint that shapes everything: `recognition.words` carries geometry

It is tempting to treat this as "send an image to a vision model, get text back." Text alone is not enough — two shipped features read positions out of `note.recognition`.

`note.recognition` is consumed in five places:

| Consumer | Field used | Needs geometry? |
|---|---|---|
| `overviewMode.js:718` — cross-note search | `recognition.fullText` | No |
| `NoteCanvas.js:1415` — highlight matches on canvas | `recognition.words[].boundingRect` | **Yes** |
| `NoteCanvas.js:1844` — scrollbar match positions | `recognition.words[].boundingRect.y` | **Yes** |
| `storage.js:95` — `hasRecognition` index flag | `recognition.fullText` | No |
| `mcpBridge.js:84,520` — MCP `recognized_text` | `recognition.fullText` | No |

So any backend must return positions as well as text. The open question is *how precise* those positions have to be — and the answer turns out to be "less precise than assumed, provided we render them honestly" (§2.1).

The reader is defensively written (`word.boundingRect || word.boundingBox || word.rect || word`, `x`-or-`left`, `width`-or-`w`), so a backend emitting a slightly different box shape will not crash. **We should not rely on that.** `recognitionService.js` normalizes to `boundingRect` before storage; the tolerant reader stays a legacy-data safety net, not an interface.

### 2.1 Two fidelity tiers, and why that is fine

The obvious approach — send the page to a vision model, get text — cannot produce trustworthy word boxes. LLM coordinate output drifts with image scale, is not reproducible run-to-run, and (per Qwen-VL's own documented behaviour) **merges adjacent words when spacing is tight**, which silently drops the second word's position entirely.

The original conclusion drawn from this was "therefore derive geometry from strokes." That conclusion was too strong. It rests on an assumption worth naming: *that a highlight must be a crisp rectangle.* A precise-looking box in the wrong place is a visible error. **An intentionally imprecise indicator is not** — it makes a claim ("around here") that approximate data can actually support.

So v1 ships two fidelity tiers, and says which is which:

| Tier | Source | Geometry | Rendered as |
|---|---|---|---|
| `exact` | Windows sidecar (UWP `InkAnalyzer`) | true per-word boxes | crisp highlight rect, as today |
| `approximate` | AI vision model, whole page | model-reported, may drift or merge | soft radial gradient centred on the position |

This is the decision that unlocks the whole design. Once approximate positions are rendered honestly, we no longer need to derive geometry ourselves — and everything that derivation would have required (line segmentation on arbitrary orientations, deskew, confidence scoring, per-line rasterization, per-line request batching) drops out of scope.

### 2.2 Storage: one flag, no migration

`words[]` keeps `boundingRect` and gains `precision`:

```jsonc
{
  "fullText": "the quick brown fox",
  "engine": "qwen2.5-vl:7b",
  "words": [
    { "text": "the",   "precision": "exact",       "boundingRect": { "x": 120, "y": 240, "width": 48, "height": 22 } },
    { "text": "quick", "precision": "approximate", "boundingRect": { "x": 176, "y": 238, "width": 71, "height": 26 } }
  ]
}
```

Every existing consumer keeps working untouched: `overviewMode.js:718`, `storage.js:95` and `mcpBridge.js` read `fullText` only, and the two geometry readers (`NoteCanvas.js:1415`, `:1844`) already read `boundingRect`. **Absent `precision` means `exact`** — so old notes and sidecar output need no migration and no special-casing.

Coordinates stay in **note content space** (same as `stroke.x[]`/`stroke.y[]`), for both tiers.

---

## 3. Whole-page recognition

The AI path is deliberately the simple one:

1. **Render the note to one image.** Strokes only, on white. No segmentation, no per-line crops.
2. **One request.** Prompt for a transcription plus per-word bounding boxes (Qwen-VL and comparable VL models accept coordinate-output requests directly).
3. **Normalize** model coordinates back into content space, mark every word `precision: "approximate"`, join `fullText`.

That is the entire pipeline. No deskew, no confidence scoring, no line/word clustering, no per-line batching.

### 3.1 What this buys, and what it costs

**Buys — the big one is orientation independence.** A projection-based line segmenter assumes text runs horizontally and that gaps between lines span the page width; the tolerance works out to **under ~2° of skew at 800px content width** before adjacent lines merge into one crop. That is inside what someone produces on a blank canvas without noticing, it accumulates down a page, and it fails silently. Deliberately vertical text, diagram labels and rotated margin notes fail outright.

A VL model has no such assumption. Skewed, vertical, diagonal and mixed-orientation pages are all just pages. **This removes the single largest technical risk in the feature**, and it is a better reason to take this path than the reduction in code.

**Costs, honestly:**

- **Word-box accuracy is lower, and degrades exactly where handwriting is hardest** — tight spacing, dense pages, heavy cursive. Mitigated by rendering, not by geometry (§3.3).
- **Merged adjacent words.** When the model merges two words into one box, the second word gets no distinct position. Search still finds it via `fullText`; the highlight is simply less precise. Acceptable under gradient rendering, and a reason not to promise per-word precision in the UI.
- **Not necessarily fewer tokens.** One full page at native resolution is a large image. Qwen-VL's dynamic resolution means a dense page can run to thousands of vision tokens — comparable in total pixels to many line crops, and on a self-hosted model that is precisely the prompt-processing cost that makes local inference slow. The saving is in avoiding *repeated preamble*, not in image encoding.
- **Resolution vs. accuracy is the real constraint.** If a page exceeds what the model handles well the image must be downscaled, and downscaled handwriting is where VL accuracy collapses. This — not request count — is what bounds page size (§3.2).
- **Accuracy on dense or unstructured scripts** is documented as weaker than specialized supervised HTR. Measured per model in PLAN Phase 3.

### 3.2 Tiling: the one place page size still matters

Resolution is the binding constraint, so a long note cannot always be one image. Where a note exceeds the resolution at which handwriting stays legible, split it into **horizontal bands with generous overlap** (enough that a full text line is intact in at least one band), transcribe each, and stitch.

This is chunking for *legibility*, not for context economy, and it is the only reason to send more than one request per note:

- **Bands are cut at content Y offsets we choose,** so returned coordinates map back by a known translation — no ordering ambiguity of the kind per-line indexing had to guard against.
- **Overlap means duplicates.** De-duplicate stitched words by position proximity and text match. Prefer the copy further from a band edge, since a word bisected by a cut is the one most likely to be misread.
- **Band height derives from the model's effective resolution limit,** measured in PLAN Phase 3 — not a fixed constant.

A typical single-page note is one request. A long scrolling note is a handful.

### 3.3 Rendering: our lever on accuracy

Since we control rasterization completely, it is worth treating as a tuning surface rather than a detail. Candidates to measure in PLAN Phase 3: stroke width normalization (thin strokes vanish at low resolution), contrast, background handling for notes over an imported PDF (transcribe ink only, or ink plus page?), and per-band resolution. These are cheap to vary and likely to move accuracy more than prompt wording does.

### 3.4 Backend interface

```js
/**
 * Transcribe rendered page images.
 *
 * @param {Array<{ index: number, png: Blob, contentOffsetY: number, scale: number }>} bands
 *        usually one; more only when tiling for legibility (§3.2)
 * @param {{ language: string, signal: AbortSignal,
 *           onProgress?: (phase: string, current: number, total: number) => void }} opts
 * @returns {Promise<Array<{ text: string, boundingRect: {x,y,width,height} }>>}
 *          coordinates in the band's own image space; the caller maps to content space
 */
async function transcribePage(bands, opts)
```

The sidecar keeps its own richer path (`recognizeStrokes` — strokes in, exact boxes out) and never goes through rasterization. Forcing it through an image pipeline would discard a working, more accurate, offline, free path for the sake of symmetry.

`recognitionService.js` owns rasterization, band mapping, stitching, and tagging `precision`. Backends never write into the note.

---

## 4. Rendering approximate positions

`CanvasRenderer.js:1361` currently draws every highlight identically:

```js
this.ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
this.ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
```

`setHighlights(rects)` (`:383`) takes `{x, y, w, h}`. Both gain a `precision` field and the draw loop branches:

- **`exact`** — unchanged. Windows sidecar output looks exactly as it does today; this must not regress.
- **`approximate`** — a radial gradient centred on the box centre, sized somewhat larger than the box, fading to transparent. No stroke, no hard edge. The visual claim is "around here", which is what the data supports.

Two details that matter:

- **Padding must exceed expected drift.** A gradient tight to a drifted box is still visibly off-target. Size it from measured drift (PLAN Phase 3), not by eye.
- **Scrollbar positions** (`NoteCanvas.js:1844`) read `boundingRect.y` and need no change — a slightly-off scroll target is already harmless.

**Say it in the UI, once.** Where recognition source is surfaced in settings, name the tier: exact word positions on Windows via the local recognizer, approximate positions with AI. Users should not have to infer from a soft edge that precision differs. This also makes the sidecar's continued existence legible rather than looking like legacy.

---

## 5. Nextcloud: the CORS problem is real, and the proxy is the right answer

**Confirmed constraint.** In the NC app the frontend is a browser page on the Nextcloud origin. Direct `fetch` to an AI API from there fails on two independent grounds:

1. **CORS.** `api.openai.com` and `openrouter.ai` do not return `Access-Control-Allow-Origin` for arbitrary browser origins. The request is blocked by the browser, not by us.
2. **Mixed content.** LM Studio / Ollama on `http://localhost:1234` from an `https://` Nextcloud page is blocked as mixed content, and NC's CSP `connect-src` would have to be widened to allow it anyway.

Native builds have neither problem: Tauri's HTTP plugin bypasses CORS entirely, gated by an allowlist (`src/components/recognition.json` currently pins `http://localhost:5000/*` — this must widen, see §8).

So the NC app gets a **PHP proxy endpoint** in our own app:

```
POST /apps/noteberg/api/v1/recognize
  body: { lines: [ { id, png (base64) } ], language }
  →  server-side call to the admin-configured endpoint
  ←  { lines: [ { id, text } ] }
```

`lib/Controller/RecognitionController.php`, routed in `appinfo/routes.php` (which today declares exactly one route, `page#index`). Uses `OCP\Http\Client\IClientService` — Nextcloud's own HTTP client, already available, no Composer dependency to add (the app currently vendors none).

This is not merely a CORS workaround, it is the better design:

- **The API key never reaches the browser.** It lives in NC's app config, set by an admin via `OCP\IAppConfig`, and is never sent to the client. A key in browser `localStorage` is readable by any XSS anywhere on the instance.
- **Admin configures once, whole instance benefits.** This is the same shape as the rest of our Nextcloud story: the admin deploys, the users just have it. It is a procurement-friendly answer to "how do we get handwriting search for 400 students."
- **The admin can point it at on-premise inference,** so an instance can have AI recognition with nothing leaving the building.

**Rate limiting** via `#[UserRateThrottle]` (a proxy endpoint spending an instance-wide API budget is abusable by any logged-in user). **CSRF** is default-on for `#[NoAdminRequired]` routes and stays on — the frontend already has `window.OC.requestToken` (same pattern as `storage.webdav.js`).

---

## 6. Privacy: the thing we must not get wrong

Privacy-first is a stated product pillar. Sending handwriting to a third-party API is in direct tension with it. The resolution is **informed, explicit, per-backend consent**, never a default.

- **No backend is enabled by default on Android or NC.** The user (or admin) picks one. No opportunistic upload.
- **First-time consent dialog** naming the concrete destination host, shown before the first byte leaves the device, and recorded (`recognition_consent_host`). Changing the endpoint re-prompts.
- **Local backends are presented first** in settings — LM Studio and Ollama are the recommended path, cloud is the convenience option.
- **What is sent is stated plainly:** rendered images of handwriting lines. Not the note title, not the notebook, not other notes, no account identifier.
- **Settings shows the active backend and destination** persistently, not only at setup.
- **`PRIVACY_POLICY.md` must be updated** in the same release. A privacy-first app that quietly gains a cloud upload path has a credibility problem far more expensive than the feature.

For the NC build the consent is the admin's at configuration time; end users see the destination in settings but do not each get a dialog (they cannot change it).

---

## 7. Progress and cancellation UI

Today recognition is a **binary indicator**: `autoRecognition.js` fires `recognition-start` / `recognition-end`, and `footer.js:133` shows or hides a small pen glyph. That is honest for the Windows sidecar, where a note is recognized in well under a second locally.

It is **not** adequate for an AI backend. A self-hosted model on modest hardware may take tens of seconds for a dense page, and a cloud call on a slow connection is not much better. A silent, unquantified pen icon during a 40-second wait reads as a hang, and the catch-up scan (`recognizeUnprocessedNotes()`, which walks *every* unrecognized note at startup) can run for minutes across a backlog with no indication of how far along it is or when it ends.

**Requirements:**

- **Quantified progress, not a spinner.** Report `(current, total)` at both levels: chunks within a note, and notes within a catch-up run. The codebase already has the convention — `onProgress?.(current, total)` in `pdfExport.js:491`, and the phase-labelled `onProgress?.("pages", i, total)` in `pdfManager.js:94`. Follow the phase-labelled form: recognition has genuinely distinct phases (`segment` → `rasterize` → `transcribe`), and the slow one is worth naming so the user can see *what* is slow.
- **Extend the event contract, don't replace it.** Keep `recognition-start` / `recognition-end` so `footer.js` keeps working untouched, and add `recognition-progress` carrying `{phase, current, total, noteId}`. Backwards-compatible; the sidecar path can simply not emit it.
- **Cancellable.** A long local-AI run must be abortable — `AbortSignal` threaded through `recognize()` (already in the §3 interface signature) to the HTTP call. Cancelling leaves `hasRecognition` false, so the note is simply picked up by the next catch-up scan. Non-negotiable for the startup backlog case, where a user who just wants to open a note should not be stuck behind a queue.
- **Two surfaces, matched to the two contexts:**
  - *Foreground* (user just closed a note, or hit "recognize now"): the footer indicator gains a progress readout. Non-modal — recognition must never block writing.
  - *Backlog* (catch-up scan over N notes): a dismissible status row showing note `x/N` with a cancel action. Dismissing hides the UI and lets it continue; cancel stops it.
- **Set expectations before the first run.** After configuring a backend, the settings "Test recognition" button should report the measured round-trip so a user learns their setup is a 2-second or a 40-second proposition *before* they hit it on a real note.
- **NC app included.** `footer.js` currently guards the indicator behind `if (!IS_NEXTCLOUD)`, so the NC build shows no recognition status at all. Since NC is a platform this feature exists to serve, that guard has to be revisited — a proxied call through PHP to a remote model is precisely the slow case.

**Deliberately not doing:** a modal progress dialog, or blocking note closure on recognition. `NoteCanvas.destroy()` already awaits recognition before sync (memory: the `destroyPromise` race fix) — with slow backends that await must not become a visible stall on close. Verify this path: an AI backend taking 30 seconds must not delay closing a note by 30 seconds. If it does, recognition moves fully background for non-sidecar backends and the note syncs without recognition, gaining it on the next pass.

---

## 8. Changes to existing code, by file

| File | Change | Risk |
|---|---|---|
| `src/modules/autoRecognition.js` | extract HTTP into backends; keep scheduling/persistence; emit `recognition-progress` | Medium — it is the load-bearing path on Windows today |
| `src/modules/recognitionService.js` | **new** — backend registry, rasterization, band stitching, `precision` tagging | — |
| `src/modules/recognition/pageRasterizer.js` | **new** — note → page PNG, banded when needed (§3.2), off main thread | Low |
| `src/modules/recognition/backends/*.js` | **new** — sidecar (`recognizeStrokes`) / openai (`transcribePage`) / ncProxy | — |
| `src/components/NoteCanvas/CanvasRenderer.js` | `setHighlights` accepts `precision`; draw loop branches rect vs. gradient (§4) | Medium — `exact` rendering must not change |
| `src/components/NoteCanvas/NoteCanvas.js` | pass `precision` through `_highlightSearchTerms`; verify `destroy()` doesn't stall on slow backends (§7) | Medium — `destroyPromise` awaits recognition today |
| `src/modules/footer.js` | progress readout + cancel; revisit the `if (!IS_NEXTCLOUD)` guard (§7) | Low |
| `src/components/settingsMode.js` | backend picker, endpoint/key/model fields, consent, **fidelity tier stated** (§4) | Low |
| `src/components/recognition.json` | Tauri HTTP allowlist must widen beyond `localhost:5000` | **High — see below** |
| `lib/Controller/RecognitionController.php` | **new** — NC proxy | — |
| `appinfo/routes.php` | add the API route | Low |
| `lib/Settings/AdminSettings.php` | **new** — NC admin config UI | — |
| `PRIVACY_POLICY.md`, `README.md`, `info.xml` | document the capability | Low |

**Untouched by design:** `NoteCanvas/strokeLineDetection.js` stays where it is and keeps serving the lasso task flow. Whole-page recognition does not use line segmentation, so it is neither moved nor retuned — the no-regression guarantee for that shipped feature is now free rather than something the plan has to defend. (It remains untested code; worth a test file on its own merits, but that is no longer this feature's dependency.)

**The Tauri allowlist is the sharp edge.** `recognition.json` currently allows exactly `http://localhost:5000/*`. Supporting user-supplied endpoints means widening it, and a permissive `http://**` allowlist would let any compromised frontend code reach any host. Preferred: allow `http://localhost:*/*` and `http://127.0.0.1:*/*` for local inference, plus an explicit `https://**` for cloud — and keep the *actual* destination validated in JS against the user's configured endpoint before the call. This needs a deliberate security review, not a quick widening (§11).

Note `recognition.json` is Tauri-only; it does not constrain the NC or proxy paths.

---

## 9. Storage and sync: deliberately nothing changes

`recognition` is already a synced field on the note, `hasRecognition` is already a derived index flag (`storage.js:95`), and recognition already triggers a normal note write that syncs. So:

- Recognition performed on Android **propagates to Windows and NC through ordinary note sync.** Recognize once, search everywhere. This is a real benefit of keeping the existing data shape.
- The compare-before-write in `performRecognition` (`JSON.stringify(note.recognition) !== ...`) already prevents recognition from causing sync churn. Keep it — with multiple devices now able to recognize, two devices producing slightly different text for the same note would otherwise ping-pong writes.
- **New concern:** two devices with *different backends* will produce different text for the same note, and each will see the other's as a change. Mitigation: record `recognition.engine` (e.g. `"sidecar-uwp"`, `"openai:gpt-…"`) and **do not re-recognize a note that already has recognition from any engine** unless its strokes changed. The existing candidate filter (`hasStrokes && !hasRecognition`) already gives us this for free; the risk is only if we later loosen it.

No schema migration, no sync-engine change, no NC storage change.

---

## 10. What this unlocks afterwards (not v1)

The backend abstraction, the consent flow, the settings UI and the NC proxy are the expensive parts. Once they exist, each of these is a small addition rather than a project:

- **Note summarization** — text in, text out, no geometry problem at all.
- **Handwriting → typed text** ("convert selection to text") — rasterize the selection, transcribe, insert. Same pipeline, smaller image.
- **Shape straightening** — deterministic, no model needed, but naturally lives beside this.
- **Ask about your notes** — recognition makes handwriting searchable; this makes it queryable.
- **Sketch → image** — different modality, same backend/consent plumbing.

This is the argument for building recognition on a general backend abstraction rather than a recognition-specific one.

---

## 11. Open risks to validate during build

- **Transcription accuracy is now the whole feature.** With geometry no longer derived from strokes, there is no fallback if the model reads handwriting badly — the note is simply wrong. Measure per model against the UWP sidecar as a Windows baseline, on cursive, dense pages, and non-Latin scripts. This is the single go/no-go question.
- **Resolution vs. legibility (§3.2).** Find the page size at which each candidate model stops reading handwriting reliably; that number sets band height. Get it wrong and long notes degrade silently — the model returns confident text for an illegible image.
- **Word-box drift magnitude.** The gradient rendering only works if padding exceeds typical drift (§4). Measure drift distance distribution, not just whether boxes "look about right". A gradient smaller than the error is worse than no highlight, because it points confidently at the wrong place.
- **Merged adjacent words** cost the second word its position entirely. Quantify how often, on tight handwriting — if frequent, per-word highlighting is closer to per-phrase and the UI wording should say so.
- **Band stitching correctness.** Overlapping bands produce duplicate words; de-duplication must not drop genuine repeats ("the the" written twice is legitimate) nor keep both copies of a straddling word.
- **Prompt-processing cost on self-hosted models.** A full page is a large image, and vision-token cost on a dense page can be substantial. Measure fixed per-request overhead on a real LM Studio setup, not just total latency.
- **Tauri allowlist widening** (§8) is a genuine attack-surface increase. Security review required.
- **Cost/latency on a dense page.** Must not cost real money per note or take a minute. Measure on both cloud and self-hosted.
- **NC admin config discoverability** — an unconfigured proxy must degrade to "recognition unavailable" cleanly, exactly as today's missing sidecar does, not to errors.
- **Language handling.** The sidecar takes `?language=` and uses the system recognizer; a vision model takes it as a prompt hint. Same setting, quite different semantics — verify non-Latin scripts (the settings list already offers `ja-JP`, `zh-CN`).
- **Android performance.** Rasterizing a full page (or several bands) on a mid-range phone must not stall the UI; rasterize off the main thread.
- **Slow backends must not stall note closing.** `NoteCanvas.destroy()` awaits recognition before sync today. A 30-second AI call in that path would be a 30-second stall on close (§7). Verify and, if needed, make non-sidecar recognition fully background.
- **Two fidelity tiers must not confuse.** A Windows user switching from sidecar to AI sees highlights change appearance. Settings must name the tier (§4) so this reads as a stated trade rather than a bug.
