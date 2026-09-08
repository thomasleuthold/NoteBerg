# AI Integration — Design

How NoteBerg reaches AI models, and what the first feature built on that — handwriting recognition by a vision model — does with it.

The provider connection, the consent flow, the Nextcloud proxy and the job queue are deliberately feature-agnostic. A later summarization or query feature is an addition rather than a new project.

---

## 1. Problem and constraints

Handwriting recognition previously existed on one platform of three. On Windows a bundled .NET sidecar (`Windows.UI.Input.Inking.Analysis.InkAnalyzer`) transcribes strokes locally. On Android and in the Nextcloud app, `autoRecognition.js` had no service to call, so `recognizeUnprocessedNotes()` was a no-op and handwritten content was never searchable — a user who searches for a note they wrote by hand and finds nothing concludes the application lost it.

Three constraints shaped the design:

- Results must retain the existing `note.recognition` shape, so search, canvas highlighting and MCP continue to work unmodified.
- Privacy is a product commitment. Nothing leaves the device unless the user selected a backend that sends it, and that selection is explicit.
- Windows must continue to work exactly as before, with no configuration, by default.

---

## 2. Two layers: provider and task

The provider/task split is the load-bearing structural decision.

| Layer | Module | Owns | Scope |
|---|---|---|---|
| **Provider** | `recognition/aiProvider.js` | provider id, endpoint, API key | one account-level fact, shared by every AI feature |
| **Task** | `recognition/recognitionSettings.js` | method, model (+ Replicate version), prompt, language, image size, token cap, timeout | per feature |

"Which service is reached, with which credential" is not a property of handwriting recognition. Holding it inside recognition made the two inseparable: selecting Windows Ink for handwriting also meant having no model access for anything else.

The **model** remains on the task side, because a model identifier is only meaningful for a given job — recognition requires a *vision* model, whereas summarization would require a text model.

Consequently a configured provider does not imply recognition can run, and recognition set to Windows Ink does not imply the provider is unconfigured. `isRecognitionReady()` joins the two halves, requiring both a reachable provider and a model.

Each setting has exactly one writer: `setProviderConfig()` rejects task fields and `setRecognitionConfig()` rejects provider fields. Enforcement is UI-only.

### Providers

- **OpenAI-compatible** (`backends/openAiBackend.js`) — LM Studio, Ollama, or any API exposing `/v1/chat/completions`. Synchronous.
- **Replicate** (`backends/replicateBackend.js`) — a predictions API: dispatch, then poll. Fixed host, token authentication, no endpoint field.
- **Windows Ink sidecar** (`backends/sidecarBackend.js`) — not an AI provider. Strokes in, exact word boxes out, offline and free.

The two AI providers share the surrounding pipeline (rasterize → transcribe → map coordinates) but not the request code.

---

## 3. Recognition: one request per page

The sidecar path is unchanged: strokes are sent to localhost and exact boxes are returned. The AI path is deliberately simple:

1. **Rasterize** the note's ink to one PNG per virtual A4 page — mono ink on white, with a minimum stroke width in *image* pixels so thin strokes do not vanish when scaled. Strokes only: typed text, inserted media and imported PDF backgrounds are never drawn, so they are never transmitted.
2. **One request per page**, carrying the image and the recognition prompt.
3. **Normalize** the reply, tag every word `precision: "approximate"`, and join `fullText`.

There is no line segmentation, deskewing or confidence scoring.

**Orientation independence is the principal benefit.** A projection-based line segmenter assumes horizontal text, tolerating under approximately 2° of skew before adjacent lines merge — within what a user produces on a blank canvas without noticing, and it fails silently. A vision model makes no such assumption, which removed the largest technical risk in the feature.

**Page images align to the page breaks drawn on the canvas.** An earlier scheme used overlapping slices at arbitrary offsets and required subsequent de-duplication; alignment removes the need for both. A user who avoids writing across a visible break can rely on no word being split between two images.

**Marker strokes are excluded.** Recognition renders mono, so a translucent highlighter sweep — wider than a pen stroke precisely so it reads as emphasis over text — would render as opaque black and obscure the word it was meant to highlight.

**A blank render is refused rather than sent.** This is the pipeline's most confusing failure: the request succeeds, the model correctly reports no handwriting, and the result is indistinguishable from a model that cannot read. The rasterizer samples the rendered pixels and raises instead, separating "the geometry is wrong" from "the model cannot read". An individual page may legitimately be empty, since a note can span pages with a gap; all pages being blank cannot.

**The binding constraint is legibility, not context size.** Downscaled handwriting is where vision-model accuracy collapses, so `maxImageEdge` (default 1600 px) is exposed as a setting rather than fixed, and the rasterizer logs the smallest text height rendered — below approximately 20 px, fine print will likely be missed.

---

## 4. Geometry: coloured bands, not coordinates

Vision models **do not produce trustworthy word coordinates.** Measured across several models, reported rows fall on an invented uniform pitch and drift by more than a line height — sufficient to place a highlight on the wrong text, and far too coarse to associate a word with the strokes that formed it. The original design assumed padding could absorb that drift; the error exceeds what any honest padding conceals.

The pipeline therefore stopped requesting measurement and began requesting perception:

> Each rendered page is painted with six pale horizontal colour bands — blue, green, yellow, orange, red, purple — and the model is asked *which band* each word sits on.

Bands are horizontal because notes are considerably taller than wide and text spans the full width: on a 15-line page, six bands hold approximately 2.5 lines each. They divide **each rendered image**, not the whole note — spanning the note would make one band cover hundreds of lines, locating a word no more precisely than "somewhere in the top half". The caller records which image a word came from, so the pair (image, colour) remains unambiguous.

**Separation is measured in RGB distance, not hue.** The first palette selected distant hues and rendered them very pale (~8% saturation, ~95% lightness), assuming distant hues remain distinct. They do not: at that lightness all colours compress into a small region of RGB space, leaving the six as little as 8 units apart out of a possible 441. The observed failure was pink read as purple — opposite sides of the wheel, but 14 units apart in RGB — placing two lines of a note a full band below where they were written. Pink was replaced with red and all colours darkened; the closest pair is now approximately 15 units and the pair that failed is 38, while the palette stays pale enough that handwriting remains the darkest content in the image. When changing these values, measure the worst pair rather than relying on the names — "red" and "orange" sound distinct and are in fact the closest pair.

### Stored shape

```jsonc
{
  "fullText": "the quick brown fox",
  "engine": "openai:qwen2.5-vl-7b-instruct",
  "words": [
    { "text": "the",   "precision": "exact",       "boundingRect": { "x": 120, "y": 240, "width": 48, "height": 22 } },
    { "text": "quick", "precision": "approximate", "boundingRect": null, "yRange": { "top": 900, "bottom": 1050 } }
  ]
}
```

- **`precision`** — `exact` (sidecar) or `approximate` (AI). An absent value means `exact`, so existing notes require no migration.
- **`boundingRect`** remains `null` on the AI path, kept explicit rather than populated with an estimate, so no downstream consumer can overstate what is known.
- **`yRange`** is a content-space Y range resolved from the band at write time, not a stored band index. An index is meaningless without the band scheme that produced it, so adding a seventh band would silently reinterpret every stored result — and, more importantly, an index cannot be corrected when content moves. Inserting space shifts everything below a point downward; "the third of six slices" has no arithmetic expressing that, whereas a Y range takes the same addition already applied to strokes (`ShiftContentCommand`).
- A word the model did not place carries no `yRange`. It remains in `fullText` and searchable, but cannot be displayed on the page.

Coordinates are in **note content space** — the same space as `stroke.x[]`/`stroke.y[]` — for both precision tiers.

### Rendering a band hit

An exact hit draws the highlight rectangle it always has; that path must not regress. A band hit draws a **bar in the margin** spanning the band rather than shading over the content: shading implies the match lies beneath it, whereas the bar indicates "somewhere on these lines" without obscuring the writing. It is coloured as an exact match rather than as its band, since band colours are an internal device and not user-facing vocabulary.

`regionSearch.js` serves two consumers that must *not* agree: the canvas draws one span per contiguous region, since adjacent bands must merge or a hairline seam reads as a rendering fault, while the match navigator counts one entry per occurrence. Collapsing both the same way produced a defect in which four visible matches were reported as two.

---

## 5. Manual invocation and the job queue

AI recognition **never runs automatically.** `selectBackend({ automatic: true })` refuses AI backends outright, in the same gate as the consent check.

The reason is cost and duration: a page takes minutes and incurs a charge per call. An automatic trigger would mean closing a note stalls on a request, and the startup catch-up scan would bill the user for every unrecognized note at once. Refused runs write nothing and leave `hasRecognition` false, so the note remains a candidate for a manual run.

The user starts recognition from the note toolbar. This enqueues a job (`recognition/recognitionQueue.js`); the dialog may then be closed and recognition continues.

The queue is:

- **Serial.** Two concurrent requests to a local model make both slower; against a cloud backend, concurrency primarily produces rate-limit errors.
- **Persisted**, so work survives application closure, Android backgrounding, or a Nextcloud tab being closed — uniformly on all three platforms. Persistence was chosen over per-platform close warnings, which could never behave identically.
- **Checkpointed per page.** An interruption costs at most the page in flight; a completed page is never lost.
- **Cancellable** via `AbortSignal`, threaded through to the HTTP call.
- **Fingerprinted.** A job records the note's stroke signature at creation; if the note was edited while the job waited, the result is refused rather than written over newer ink.
- **Deduplicated per note.** Re-queueing a waiting note replaces its strokes rather than adding a second job. A note already running is returned unchanged and flagged `duplicate`, so the caller can report the request as absorbed rather than attaching a second progress dialog whose Cancel button would terminate the first run.

Resume quality differs by provider, and the difference lies in the API shape:

| Provider | On interruption |
|---|---|
| Replicate | The prediction continues server-side. Its poll URL is persisted at dispatch, so the job collects a result already paid for. |
| OpenAI-compatible | `/chat/completions` is synchronous — no server-side resource, no identifier. The interrupted page is re-sent. |

**A failed page fails the whole note.** Partial transcription is never stored: `hasRecognition` derives from `recognition.fullText`, so a partial write would mark the note complete and hide it from every retry path. Partial work resides in the job store instead.

**A job is never silently discarded.** On resume, a job whose note changed while the application was closed, or whose provider or model no longer matches the configuration, is surfaced as a failed row rather than deleted — the bands already transcribed were paid for, and the user is the party who can resolve a mismatch. `failureReason.js` reduces the stored message to a short translatable category for that row, retaining the full message as its tooltip. Nothing is re-queued automatically: a user who continues writing would re-queue indefinitely, and on a paid backend every cycle incurs cost.

**The sidecar does not use the queue**, completing in well under a second; queueing would add latency and UI noise to the common case without benefit.

**Progress is quantified rather than indeterminate.** `onProgress(phase, current, total, detail)` reports `rasterize` → `transcribe` → `stitch` with a running word count, surfaced in the footer as page *x* of *n* alongside per-job queue rows.

---

## 6. Privacy and consent

Transmitting handwriting to a third party is in tension with a privacy-first product. The resolution is informed, explicit, per-host consent — never a default, and never implied by having configured a backend.

- **No AI backend is enabled by default on any platform.** Windows Ink is the default solely because it resolves locally and transmits nothing.
- **Consent is recorded against the destination host** (`recognition_consent_host`) rather than as a flag. Agreement to send ink to a model on the user's own machine is not agreement to send it to a cloud API, so pointing recognition elsewhere prompts again. Revocable in Settings.
- **Loopback requires no consent.** `localhost`, `127.0.0.1` and `[::1]` never leave the device, so there is no disclosure to make, and prompting would condition users to dismiss the dialog that matters.
- **What is transmitted is stated plainly:** rendered images of the handwriting and the prompt. The image is ink only — the rasterizer draws strokes on a plain background and nothing else, so typed text, inserted images and any imported PDF page behind the ink are absent by construction rather than by filtering. The note title, notebook, other notes and account identifiers are never included.
- **Settings names the fidelity tier** — "exact word positions" against "approximate word positions" — so a Windows user switching to AI reads the changed highlight as a stated trade-off rather than a defect.
- `PRIVACY_POLICY.md` and the Nextcloud `info.xml` description carry the same statements.

The consent gate resides in `selectBackend()`, so a configured backend the user has not consented to is treated exactly as an unconfigured one: recognition no-ops rather than uploading and prompting afterwards.

**There is no silent fallback.** A configured backend that is unavailable returns null and never falls back to a different one, since transmitting strokes to a destination the user did not select is precisely the failure this must prevent.

---

## 7. Endpoint validation and the Tauri allowlist

The Tauri HTTP allowlist (`src/components/recognition.json`) was widened from a single pinned sidecar URL to "localhost on any port, plus https", so users can direct recognition at their own local or cloud inference.

**That allowlist is a coarse outer bound enforced by the runtime; it is not the check.** `recognition/endpointValidation.js` performs the check: before any request, the destination is verified against the endpoint the user configured. Without it, the widened allowlist would permit any frontend code path to reach any https host.

The module also normalizes user input. The server root, `…/v1`, and the full `…/v1/chat/completions` all resolve to the same base, because requiring exactly one form produced a misleading symptom: the request reached the server, which answered 200 with a non-JSON body, so the error surfaced as unparseable content rather than as an incorrect URL.

Plain `http` is permitted only for loopback; a remote endpoint must use `https`.

**On Nextcloud this module is not the authority.** There the request is issued by the server, so the destination is determined by the administrator's allowlist (§7.1) and the field is a dropdown of it. `endpointValidation.js` still executes client-side but can only encounter values originating from that list. The two builds therefore differ on plain `http` to a remote host by design: it remains refused where there is no administrator, and is the administrator's decision where there is one.

---

## 7.1 The administrator's endpoint allowlist (Nextcloud only)

Recognition causes the *server* to open an outbound connection to a host the *user* selected. Without a control, every account on an instance could independently direct the server anywhere — an egress capability an administrator installing a notes application has not agreed to and had no means to inspect or revoke.

`lib/EndpointPolicy.php` provides that control, configured under **Administration → NoteBerg**. It has two halves, because there are two kinds of destination:

- **An allowlist of OpenAI-compatible endpoints**, which users select and enter. This is the surface the control exists for.
- **A switch for the built-in Replicate provider**, whose host is `REPLICATE_BASE` — a constant compiled into the client, populated into the stored endpoint by `setProviderConfig`, and never presented as a field. The administrator's decision is whether the provider may be used, not which URL may be reached, so a boolean states this accurately where a list entry would imply the administrator could redirect it.

Both deny by default. `permits()` routes a Replicate URL to the switch and all other URLs to the list.

**Deny by default.** An empty list permits nothing, so an instance that never configures this makes no outbound AI calls. Empty-means-unrestricted was rejected as equivalent to having no control: the state an administrator reaches by taking no action would be exactly the state the control exists to prevent. The cost is that the feature ships disabled, which the panel's empty state and a one-click preset for common hosted providers are intended to mitigate.

**This supersedes the link-local (`169.254.0.0/16`) block** that previously guarded `resolveUrl()`. That check existed because any host was otherwise reachable, and the cloud metadata address is what makes an SSRF worth exploiting. Under an allowlist nothing is reachable until an administrator names it, so the block is redundant — verified: with an empty list, `http://169.254.169.254/` is denied. The address can now be reached only by an administrator entering it, which the panel warns about rather than refuses, since the check cannot be complete in any case: a name in a zone the administrator controls can resolve anywhere.

**Matching is performed on parsed URL components, never on the raw string.** String comparison is the obvious implementation and is incorrect in a manner difficult to detect: `https://api.openai.com.evil.com/` contains a permitted entry as a prefix, and `https://api.openai.com@evil.com/` contains it as a substring. Two entry forms are accepted — a bare host (`api.openai.com`) permits https on the default port and any path, while a URL (`https://api.openai.com/v1`, `http://model.lan:8080`) pins the scheme and, where given, the port and a path prefix. Paths match at segment boundaries, so `/v1` permits `/v1/chat/completions` but not `/v1beta/…`, matching `isAllowedDestination`.

**Wildcards are deliberately unsupported.** Every entry names one host, which permits the settings field to be a `<select>` of valid choices rather than a text box, making the invalid state unreachable instead of reporting it after the fact. Subdomain wildcards (`*.openai.azure.com`, which Azure OpenAI's per-resource hosts would require) remain an additive change if a deployment needs them, at the cost of converting that dropdown into a combobox.

**The client mirrors both controls.** `show()` reports `allowedEndpoints` and `allowReplicate`; the settings form builds the endpoint dropdown from the former and omits the Replicate option entirely when the latter is false — withheld rather than shown and refused, since Replicate has no endpoint field on which to explain a rejection. A stored but no longer permitted value still renders, labelled, so a configuration predating a policy change is visible rather than silently blank. A server that reports no list is treated as permitting nothing, since a security control must not fail open on a version mismatch.

**There are two enforcement points but one boundary.** `RecognitionController::resolveUrl()` is the boundary and checks before every request, not only at save time, because the policy may be narrowed afterwards and a stored value must cease working immediately. `RecognitionConfigController::update()` also refuses, returning `endpoint-not-permitted`, so a user encounters a named error at the field rather than a feature that saved cleanly and silently never runs.

---

## 8. Nextcloud: a server-side proxy

In the Nextcloud build the frontend is a browser page on the Nextcloud origin, and direct `fetch` to an AI API fails on two independent grounds: providers do not return `Access-Control-Allow-Origin` for arbitrary browser origins, and an `https://` page cannot reach `http://localhost:1234` at all. Native builds have neither problem, as Tauri's HTTP plugin issues requests outside the browser's rules.

The Nextcloud app therefore proxies through its own PHP:

```
POST            /apps/noteberg/api/recognition/dispatch  starts one request, returns a token
POST            /apps/noteberg/api/recognition/collect   retrieves a dispatched request's result
POST            /apps/noteberg/api/recognition/proxy     forwards one request upstream, reply verbatim
GET|POST|DELETE /apps/noteberg/api/recognition/config    per-user provider configuration
```

`RecognitionController` is deliberately a *passthrough* rather than a job runner. Running transcription as a background job would require a database table, a `QueuedJob` and cron, and would not execute reliably on instances using AJAX cron. Durability resides on the client instead, identically on every platform.

### Asynchronous by default, synchronous where necessary

`dispatch` flushes its reply and closes the browser connection **before** making the upstream call, so the transcription outlives the request that initiated it. This is the only arrangement that survives a web server outside our control: `proxy_read_timeout` and `request_terminate_timeout` can only terminate a request that remains open, and after `fastcgi_finish_request()` none remains. Without it, a model slower than the server's idle limit produced a closed connection with no HTTP response, reaching the browser as a bare network error naming neither the endpoint nor the reason.

The result is written to a distributed cache slot that `collect` polls. A distributed cache is the one hard requirement, because `createDistributed()` returns a null cache that silently discards writes when none is configured. `proxy` is the original synchronous path, retained for servers that cannot support the above and still exposed to those timeouts; the settings UI states this rather than allowing it to be a surprise.

The client always calls `dispatch` and interprets the response: `async: true` carries a token to collect, `async: false` carries the result directly. Deciding on the server keeps the capability check in the only place able to perform it, since the client cannot determine whether php-fpm and a distributed cache are present. Splitting the upstream call across several short requests is not an alternative: a chat-completions request is indivisible, so a slice that abandoned the work would cause the next to start over, billing the user each cycle and never completing.

The body is forwarded unmodified, so the proxy requires no knowledge of which provider it is addressing. Limits: 12 MB body; upstream timeout 55 s by default, raised to the client's requested value up to a 600 s ceiling — the default sits below the 60 s that php-fpm and nginx both commonly use, since a higher value cannot be reached on a default deployment. Requests are rate-limited per user (60 per 300 s on `dispatch` and `proxy`), and CSRF protection remains enabled via `window.OC.requestToken`.

**That rate limit interacts with polling.** On Nextcloud every Replicate poll is a `dispatch` call, so the native 1.5 s cadence would exhaust the budget partway through a single band — and the prediction being polled has already been dispatched and paid for. The interval is therefore 5 s on Nextcloud, and a `429` during polling is waited out rather than treated as a failure. This raises the threshold rather than removing it; a dedicated, cheaper poll route remains available should it prove necessary.

**The destination and credential are not taken from the request.** Both are read from the user's server-side configuration, with two consequences: the API key never reaches the browser, so an XSS anywhere on the Nextcloud origin cannot exfiltrate it; and the URL is not client-supplied, so this is not an open fetcher. A caller can reach only the endpoint their own configuration names, and that configuration is itself bounded by the administrator's allowlist (§7.1).

---

## 9. Settings storage by platform

Storage is selected by what a value *is* — a secret, a server-relative address, or a device preference — rather than by platform convenience. The key column gives the native name first and the Nextcloud one second where they differ.

| Setting | Key | Windows / Android | Nextcloud |
|---|---|---|---|
| Provider id | `ai_provider` / `recognition_backend` | IndexedDB `settings` | Server, `oc_preferences` (per user) |
| Endpoint | `ai_endpoint` / `recognition_endpoint` | IndexedDB `settings` | Server, `oc_preferences` (per user) |
| API key | `ai_api_key:<provider>` / `recognition_api_key_<provider>` | OS credential store | Server, encrypted with `ICrypto` |
| Method | `recognition_method` | IndexedDB `settings` | `localStorage` |
| Model, Replicate version | `recognition_model`, `recognition_replicate_version` | IndexedDB `settings` | `localStorage` |
| Language, prompt, image size, token cap, timeout | `recognition_language`, `recognition_system_prompt`, `recognition_max_image_edge`, `recognition_max_tokens`, `recognition_timeout_seconds` | IndexedDB `settings` | `localStorage` |
| Consent host | `recognition_consent_host` | IndexedDB `settings` | `localStorage` |
| Job queue | — | IndexedDB `recognitionJobs` | `localStorage` (`noteberg_recognition_jobs`) |
| Endpoint allowlist, Replicate switch | `allowed_endpoints`, `allow_replicate` | not applicable | Server, `oc_appconfig` (instance-wide) |
| AI mode | `ai_mode` | not applicable | Server, `oc_appconfig` (instance-wide) |
| Central task settings (§9.1) | `ai_central_<task>_<name>` | not applicable | Server, `oc_appconfig` (instance-wide) |
| Monthly cap per task (§9.1) | `ai_limit_<task>` | not applicable | Server, `oc_appconfig` (instance-wide) |
| Usage counter (§9.1) | — | not applicable | Server, `noteberg_ai_usage` table |

Three rules determine placement.

**Secrets never use ordinary settings storage.** On the native builds the API key is routed through `secureStorage.js` to the operating system credential store — the keyring crate on desktop, `DeviceKeyPlugin` backed by the Android Keystore on Android. Keys occupy per-provider slots, because a single shared slot meant switching provider silently carried the previous token to the new endpoint, producing an authentication error referring to a credential the user never entered there. Deleting the outgoing key on switch would also have prevented this but destroys a working credential during a comparison, so separate slots keep both usable.

On Nextcloud the key is stored server-side and never transmitted to the browser, since that build has no secure browser storage: the fallback in `secureStorage.js` encrypts with a constant compiled into the shipped bundle, which is obfuscation rather than encryption, and any XSS on the Nextcloud origin could read it. It is additionally encrypted at rest with `ICrypto`, addressing the distinct threat of a database dump exposing `oc_preferences`.

**The provider and endpoint are server-relative on Nextcloud.** The request is issued by the server, so the URL must resolve from there — "localhost" in a browser setting denotes the user's machine, whereas the request originates from the server's. These are the only two fields held server-side; `getProviderConfig()` reads them from the server on Nextcloud and from local settings elsewhere, and the two copies are never both written, since a local copy would silently take precedence on read.

**Everything else is per-device by design.** The method, model, prompt, language and rendering parameters are preferences for the device in use, and the job queue holds partial work that must survive a reload without being mistaken for a completed recognition. The native builds use the IndexedDB `settings` store; Nextcloud uses `localStorage` namespaced with `noteberg_setting_`, the appropriate weight for values that are small, per-device and never synchronized. The job queue occupies a single `localStorage` key rather than one per job, since the queue is short and a single read/write keeps it atomic.

Under central management (§9.1) the last four rows take over: the provider, model and task settings are read from `oc_appconfig` and the per-user rows are not consulted. The two modes are exclusive, so no value is read from both.

In BYO mode the model is deliberately *not* stored server-side, being a per-task preference with no server frame of reference. `RecognitionConfigController::destroy()` still clears the retired `recognition_model` key so an instance configured before the provider/task split retains no value that nothing reads.

There is no configuration migration: the provider/task split and the relocation of Nextcloud provider configuration to the server both predate any released build, so the migrations that once performed them were removed rather than shipped as permanent startup work.

---

## 9.1 Central administration (Nextcloud only)

§9 describes each Nextcloud user bringing their own provider account. That arrangement does not suit the deployment an instance administrator is most likely to want: the organisation holds one account and users share it. Without central administration such an administrator must either have every user obtain and enter a personal token — which most will not do, so the feature effectively does not ship — or distribute one shared token, at which point every user can select the most expensive model in the catalog against the organisation's billing, with no attribution and no cap beyond the per-user rate limit, which scales *with* the number of users rather than bounding the instance.

### Two modes, exclusive

One instance-wide setting (`ai_mode`) selects between:

- **`byo` — users bring their own key.** Exactly the behaviour in §9: provider, endpoint and credential per user; model, prompt and task settings per device.
- **`central` — the administrator maintains everything.** Provider, endpoint, credential, model and all task settings move to `IAppConfig`. Users configure nothing and the settings UI renders the effective values read-only.

The modes are **exclusive, with no fallback.** "Central settings where the user has none" was considered and rejected: it is not merely more complex to implement but *unauditable*, since an administrator could not determine who is spending the organisation's money without enumerating every user's configuration. Exclusive modes make "which mode is this instance in" answerable from one value.

`byo` remains the default, so an existing instance is unaffected by the upgrade.

### Model enforcement moves to the server

In `central` mode the model must be enforced where it cannot be bypassed. Restricting the settings UI is not sufficient: the proxy forwards the request body untouched, so a user could POST to `/dispatch` directly with any body. Enforcement therefore lives in `RecognitionController::prepare()`, which compares the model named in the body against the administrator's configured value.

This is a deliberate departure from the passthrough property stated in §8. The proxy must now understand two body shapes — `model` for OpenAI-compatible requests, `version` or the path for Replicate — and must **fail closed** on a body it does not recognise, since a shape that escapes inspection is a shape that escapes the policy.

### Request quota

The administrator sets a **monthly request cap per user per task**, which applies **in central mode only**. Under BYO the account being charged is the user's own, so a cap set by the administrator would limit how much of the user's own money the user may spend — which is not what a control named "monthly pages per user" leads anyone to expect. Server load under BYO is bounded by the per-user rate limit on the proxy routes instead. The field is offered only alongside the other central settings, and `monthlyLimit()` returns unlimited under BYO whatever is stored, so a cap set while trying out central mode does not keep refusing runs after switching back.

Four further decisions define it:

**Requests, not tokens.** Token accounting was considered and dropped. Replicate reports no token usage at all — it bills compute seconds — so a token limit would be unimplementable for one of the two providers and would silently not apply there. Tokens are also only knowable *after* the spend, whereas a request count is enforceable before it. The cost is precision: requests are not equally expensive, and will be less so as further AI features arrive.

**Counted at dispatch**, before the upstream call. A failed request still consumes quota, which is correct often enough to be the right default: a request that reached the provider and failed there was frequently still billed.

**Only billable calls count.** The proxy carries three kinds of traffic, and counting all of them would make a page count run several times high. The discriminator is the HTTP method combined with the path: every billable call is a `POST` to `/chat/completions` or to a Replicate `…/predictions` path, while model listings, schema lookups and prediction polls are all `GET`. The server infers this from the request it already validates rather than trusting a client-supplied flag, since a flag the client sets is a quota the client can evade.

**Per task, from the outset.** The counter is keyed `(uid, task, period)` even though recognition is currently the only task. Each future AI feature will carry its own model, endpoint and cap, so the task is a first-class dimension; including it now costs nothing and avoids migrating a live table later.

Because the quota is per task, each task names its unit in the terms its users recognise — recognition sends one request per page, so its cap is presented as **pages**. The stored column and the enforcement code stay generic (`units`), since a later task will count something else and a schema that says "pages" would need renaming.

### Counters live in a database table

```
noteberg_ai_usage
  uid         varchar
  task        varchar     -- 'recognition', later 'summary', …
  period_key  varchar     -- '2026-09'
  units       integer
  unique (uid, task, period_key)
```

This is the application's first table and its first migration (`Version000000Date20260904000000`). Two alternatives were rejected:

- **`IAppConfig`** offers no atomic increment, so a counter would be read-modify-write and would undercount whenever two requests overlap — which is precisely the condition a shared-account quota exists for. Non-lazy values also load on every request to every app in the instance, and one key per user *per task* per period makes that cost scale with the dimension the design is adding. Marking keys lazy addresses the load cost but not the atomicity.
- **The distributed cache** has atomic `inc()` and is already a hard requirement for the async path, but a cache is evictable by design: quota would silently reset under memory pressure. For a spend control that is the wrong failure direction.

The table gives atomic increment via the unique constraint, durability across restarts, and per-user reporting — the last being a question an administrator will certainly ask and neither alternative can answer. The limit itself stays in `IAppConfig`, which is the correct home for administrator intent: rarely written, small, and legitimately part of a configuration backup. The distinction is that the **limit is configuration** and the **count is runtime state**.

### The administrator's panel, and what it reports

The instance-wide settings — mode, central provider and model, per-task cap, endpoint allowlist and the Replicate switch — are one section in Nextcloud's own admin settings (`Settings/AdminSection.php`, `Settings/AdminSettings.php`), served by `AdminConfigController` over `/api/admin/*`. Every route on it carries `AuthorizedAdminSetting` rather than `NoAdminRequired`: these values bound what the instance may spend and where it may connect, so administrator authorisation is the point of them.

Its script is hand-written (`js-admin/admin.js`) and copied into the build separately from the Vite bundle, because the application entry boots the whole note editor, which has no business loading on a settings page.

Alongside the controls, the panel reports **what has actually been spent**, one row per account for a chosen month. A cap that cannot be checked against real usage is set blind: the first question an administrator asks after setting one is who is consuming it, and the counter table is the only thing that can answer.

Reporting is deliberately separate from counting (`UsageReport` beside `UsageCounter`). The counter sits on the request path and must not acquire a dependency on the user backend — enumerating accounts to serve a quota check would put the slowest thing on the page in front of the fastest. `UsageReport` is reached once per admin page view, and that is where the account list belongs.

Two consequences follow from reporting on stored rows rather than on the account directory:

- **Rows are capped** (`MAX_ROWS`) and ordered spend-first, so a large user directory does not render a row per account. The cut therefore falls on users who have sent nothing — the ones the table was least able to say anything about — and the caller is told the true total so the page can say what was left out rather than silently truncating.
- **Usage outlives the account.** A row whose `uid` no longer resolves is still shown, marked as a deleted user, because the spend was real and subtracting it would make the reported total disagree with the provider's bill.

The report is scoped to recognition, that being the only task that spends anything today. A second task makes the task a parameter of the route and of the heading — which is why `UsageCounter` stores it as a column rather than assuming one.

### The remaining allowance is shown before the spend, not after

Under central management the recognition dialog shows what is left of the month's allowance before the run starts, and disables Start once nothing remains.

The alternative — discovering the allowance was gone from a failed run — is worse in a way the queue makes concrete: recognition is per page, so a user with a handful of pages left and a long note would spend them on its first pages and fail partway. Showing the count first makes that a decision rather than an outcome.

Consistent with §7.1, this is display, not enforcement: the number is reported by the server, and the control that matters remains `checkAndRecordQuota()` in `prepare()`. A limit of `0` means unlimited and is shown as nothing at all, since there is no decision to inform. The line is absent off Nextcloud and in BYO mode, where the account being charged is the user's own.

### Keeping the duplication honest

Adding server-side settings and enforcement widens the surface where a rule exists in both JavaScript and PHP. The mitigation is not shared code, which is impossible across the two languages, but a single authority:

- **The server is authoritative; the client mirrors.** `show()` already reports `allowedEndpoints` and `allowReplicate` and the settings form renders what it is told. The same applies to the mode, the effective central settings and the remaining quota — the client displays them and never re-derives them.
- **A rule that must exist twice is tested twice.** The endpoint matcher already exists as `EndpointPolicy::matches` and `isAllowedDestination`, kept in step by documented intent and by tests on both sides. Model matching joins that short list, and nothing else may.
- **The client never enforces.** Client-side checks exist to keep a user from entering a value the server would refuse; they are never the control. Every rule that matters is applied in `prepare()`, which is the one boundary every request crosses.

---

## 10. Choosing a model

A model identifier's exact form differs per provider (`qwen2.5-vl-7b-instruct` on LM Studio, `qwen/qwen3-vl-8b-instruct` on OpenRouter, `owner/name` plus a version hash on Replicate). A mistyped identifier fails silently at recognition time rather than at save time, so the user discovers the error when a note returns empty.

Every provider answers the question via `GET /models`. `modelCatalog.js` normalizes three listings that agree on almost nothing, and `modelPickerDialog.js` presents it behind a button beside the field.

| Provider | Shape | Describes |
|---|---|---|
| OpenRouter | `{data: [...]}` | id, name, description, input modalities, supported params |
| LM Studio / Ollama | `{data: [{id}]}` | an id and nothing further |
| Replicate | `{results: [...], next}` | owner, name, description, `latest_version.id` — no modalities, paginated over the public catalog |

The consequences are each deliberate:

- **Every descriptive field is optional.** Local servers are the path this was designed around; a UI assuming OpenRouter's shape would present a table of blanks for them.
- **An undescribed model's type is `unknown`, never inferred.** Inferring "text-only" from silence steers the user away from a model that works, while inferring "vision" from the name produces a badge they would act on that is sometimes wrong. A missing badge is recoverable; an incorrect one is not.
- **The vision filter is offered but disabled by default**, and hidden entirely when nothing in the listing declares modalities.
- **Replicate's listing is a bounded sample, so typing queries the provider.** Its catalog contains tens of thousands of models and the browse listing walks only the first few pages, so filtering that sample client-side answered for the sample rather than the catalog: a user could enter the exact name of a model Replicate holds and be told there were no matches. For Replicate the search box therefore queries `GET /v1/search?query=…` and replaces the list with the provider's response. Other providers return their listing whole, where the local filter is the complete answer.

  This uses the search API Replicate introduced in September 2025; the older `QUERY /v1/models` was unusable, as neither the Nextcloud proxy (GET/POST only) nor a plain fetch will issue that verb. The endpoint is in beta, so a failed search falls back to filtering the loaded sample rather than replacing the list with an error, and reports that it has done so. Searched hits nest the model under a `model` key beside relevance metadata, but that nested object uses the same schema the listing returns, `latest_version.id` included, so one normalizer serves both paths.

  A searched list is **not** re-filtered against the query text, since the provider ranks on descriptions and tags not visible client-side and re-applying the local match would discard hits it deliberately returned. The type and vision filters still apply, as those describe the model rather than the query.

  The browse listing requires several sequential requests while a search requires one, so a search dispatched while the listing is in flight routinely resolves first. The listing therefore renders only when no search has been dispatched; otherwise it populates the filter controls and the browse view silently, without replacing results the user already requested.
- **The picker populates the field; it never replaces it.** A server with no `/models` (404 reads as "no listing" rather than "broken"), a model newer than the listing, and Replicate's untraversed tail all remain configurable by hand.
- **Replicate selections carry `latest_version.id` into the version field.** Without it a community model fails at run time with "not found", the precise failure the picker exists to prevent. A blank version never overwrites one pinned manually.
- **Selecting does not save.** Save remains the single writer, so the selection populates the field and prompts the user to save.

**Security:** model names and descriptions are remote content, whether from a cloud API or from a local server that anything on the machine can write to. Rows are constructed with `textContent`, never `innerHTML`. Replicate's `next` cursor is a server-chosen URL, so the destination check is re-run on every page, since a redirected cursor would otherwise carry the API token off-host.

---

## 11. The prompt

Both providers send identical instructions from `recognition/prompts.js`, so a rule that improves accuracy on one is not omitted from the other. The prompt is user-editable, since different models respond to different phrasings.

Five tokens are substituted:

| Token | Substituted with |
|---|---|
| `{{regionList}}` | the band colours, so the list resides in one place |
| `{{language}}` | the language hint |
| `{{punctuation}}` | whether punctuation present on the page is transcribed or omitted |
| `{{breaks}}` | whether line and paragraph breaks are recorded |
| `{{shape}}` | the response-shape example, which varies with the break setting |

`{{language}}` is a token rather than a prefix applied by a backend: previously Replicate prepended the language and OpenAI ignored it entirely, so a prompt comparison between them was not measuring the same input. A token also places the hint where a user editing the prompt can see and reposition it. Language names are given in English (`Chinese (Simplified)`, not `zh-CN`) and deliberately not taken from the i18n catalogue, which is translated to the interface language: a German UI must not produce "The handwriting is most likely in Deutsch" within an otherwise English instruction. **`auto` is the default**, because an incorrect assertion is worse than none — a model told the page is English will "correct" German words into English, exactly the invention the prompt otherwise forbids.

The final three tokens are **per-run choices made in the recognition dialog**, not settings, and are carried on the job rather than re-read at run time, so a run uses what the user approved when starting it — including after a resume in a later session. Whether punctuation belongs in the result depends on the page rather than on a preference: prose requires the marks that were written, whereas a list of keywords reads better as bare words. Neither mode permits invented punctuation.

Breaks are **disabled by default** because models place markers unreliably: they omit line endings, emit the marker as the literal word `"break"`, and disagree on what constitutes a paragraph, so requesting layout costs accuracy on the text itself. `{{shape}}` exists because the example and the rules must agree — an example showing `{"break":1}` while the rules forbid the marker is a contradiction, and a model resolving it either way produces output the parser did not request.

Break handling is defended in depth. `aiRecognition.js` discards break entries at write time when they were not requested, so the stored result honours the choice regardless of what the model produced, and a break reported as the literal word `"break"` is repaired at the same boundary (`mapWordToContent`) — left alone it appears in the transcript where a line ending should be, which is both an incorrect word and a lost line.

A custom prompt is checked by `checkPrompt()` for the elements the parser requires — a JSON instruction, the `words` key, the region instruction — and for all four remaining placeholders, warning rather than blocking. The distinction is deliberate: the first group are parse failures, whereas a missing token means a control the user can still see in the dialog silently ceases to reach the model, which is worse than a control that is absent. An empty prompt selects the built-in default, so a user who never modifies it continues to receive improvements. The `{{breaks}}` check tests for the **token** rather than the resolved text, because with breaks disabled the resolved prompt contains the word "break" within a rule forbidding the marker, which a substring test would misread as the instruction being present.

---

## 12. Storage and sync

`recognition` is already a synchronized note field, `hasRecognition` already a derived index flag, and recognition already triggers an ordinary note write.

- Recognition performed on Android **propagates to Windows and Nextcloud through normal note sync.** Recognize once, search everywhere.
- The compare-before-write in `performRecognition` prevents recognition from causing sync churn, which matters now that multiple devices can recognize.
- `recognition.engine` records which engine produced the text (`sidecar-uwp`, `openai:<model>`, `replicate:<model>`), and a note that already has recognition is not re-recognized unless its strokes changed. Otherwise two devices with different backends would produce differing text for the same note and write over each other repeatedly.

No schema migration, sync-engine change or Nextcloud storage change is required.

---

## 13. Module map

| Module | Role |
|---|---|
| `recognition/aiProvider.js` | provider id, endpoint, credential; Nextcloud server-side config |
| `recognition/recognitionSettings.js` | method, model, prompt, language, image size, token cap; `isRecognitionReady()` |
| `recognition/recognitionService.js` | backend selection, the automatic/consent gate, word normalization |
| `recognition/aiRecognition.js` | rasterize → transcribe → map bands → stitch |
| `recognition/pageRasterizer.js` | note ink → one PNG per page, with colour bands |
| `recognition/regions.js` | band definitions, band ↔ content-space Y, span merging |
| `recognition/regionSearch.js` | matched words → canvas spans and navigator entries |
| `recognition/recognitionQueue.js` | persisted serial job queue, checkpoints, resume, cancel |
| `recognition/consent.js` | per-host consent, loopback exemption |
| `recognition/endpointValidation.js` | destination check, endpoint normalization, shared loopback host set |
| `recognition/prompts.js` | shared prompt and its five substitution tokens |
| `recognition/providerCheck.js` | reachability test |
| `recognition/modelCatalog.js` | normalizes three provider model listings; server-side search where the listing is a sample |
| `recognition/failureReason.js` | classifies a failed job's message into a short, translatable reason |
| `recognition/backends/*.js` | sidecar, OpenAI-compatible, Replicate, shared transport |
| `components/modelPickerDialog.js` | browse, filter or search the catalog |
| `components/modals.js` | recognition options dialog: per-run choices and the remaining allowance |
| `lib/EndpointPolicy.php` | Nextcloud only: administrator's endpoint allowlist and Replicate switch, both deny by default |
| `lib/AiPolicy.php` | Nextcloud only: mode, central task settings, model enforcement, monthly cap, billable-call test |
| `lib/UsageCounter.php` | Nextcloud only: atomic per-`(uid, task, period)` increment and the reporting queries |
| `lib/UsageReport.php` | Nextcloud only: the admin panel's view of the counter — rows with names, capped and spend-first |
| `lib/Controller/RecognitionController.php` | Nextcloud proxy; the boundary where model and quota are enforced |
| `lib/Controller/RecognitionConfigController.php` | Nextcloud per-user provider config |
| `lib/Controller/AdminConfigController.php` | Nextcloud instance-wide settings and the usage report, admin-only |
| `lib/Settings/AdminSection.php`, `AdminSettings.php` | registers the section in Nextcloud's admin settings |
| `lib/Migration/Version000000Date20260904000000.php` | creates `noteberg_ai_usage` |
| `js-admin/admin.js` | the admin panel's script, outside the Vite bundle |

---

## 14. Known limits

- **Transcription accuracy is the whole feature.** With geometry no longer derived from strokes, there is no fallback if a model reads handwriting badly — the note is simply wrong. Worth measuring per model against the UWP sidecar as a Windows baseline.
- **Localization is a band, never a box.** Roughly two or three lines of vertical extent. It must continue to travel with `precision: "approximate"`, and the UI must not promise per-word precision.
- **Words the model does not place** remain searchable but cannot be displayed on the page.
- **Resolution against legibility.** Too small a `maxImageEdge` and the model returns confident text for an illegible image. The rasterizer logs the smallest rendered text height as an early warning.
- **A word straddling a page break** is intact in one image only if the user avoided writing across the visible break.
- **Fingerprinting is inexpensive** — stroke count plus last stroke id. An edit that replaces strokes without changing either is not detected; the consequence is a stale recognition rather than data loss, and the note remains re-runnable.
- **Foreground only.** A queued job runs while the application is open. It is checkpointed and resumes, but does not progress in the background.
- **Consent is keyed on the host alone.** Two providers directed at the same host share one consent, and a path or port change on a consented host does not prompt again. The host determines where handwriting actually goes, so this is the correct granularity, but it is coarser than "this exact configuration".
- **Nextcloud polling remains bounded by a rate limit.** The 5 s interval and the `429` backoff (§8) raise the threshold rather than removing it; a sufficiently long run can still reach it, degrading to slower rather than to lost work.
- **The quota counts requests, not cost.** A page sent to an expensive model and a page sent to a cheap one consume the same unit, so a cap bounds volume rather than spend. The gap widens as further AI tasks arrive with different per-request costs.
- **Quota is consumed by failure.** A unit is charged at dispatch, before the upstream call, so a request that fails at the provider still counts. This is deliberate — such a request was frequently billed anyway — but a user hitting a persistent provider error can exhaust an allowance without obtaining any text.
- **Central mode must learn each new provider's body shape.** `permitsModel()` fails closed, so a provider added later cannot run under central management until model extraction is taught its request shape. BYO is unaffected.
