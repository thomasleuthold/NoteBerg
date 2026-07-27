# MCP Server — Design

Status: **Implemented and shipped.** Read-only surface (§1) is built, tested, and verified against a real MCP client (Claude Desktop). Write tools (§5) are not yet built.
Scope: expose NoteBerg notebooks and notes to external AI clients (Claude Desktop, Cursor, …) via a **Model Context Protocol** server. Passive/read-first: the AI *reads* your notes as context. Off by default, token-protected, **native (Tauri) desktop only** — not the Nextcloud app build, not Android.

This is the first of two AI features. The companion **active AI integration** (chat about a note, summarize, LLM handwriting recognition, transcription, sketch→image) is tracked separately and shares none of this server's plumbing.

---

## ADR-001: Host the MCP server inside the desktop app, reaching through the webview

### Context and problem

We want an external MCP client to read the user's notebooks/notes. NoteBerg has three deployment targets with very different capabilities:

- **Windows/desktop (Tauri)** — a Rust host process wrapping a WebView2 webview; already spawns a localhost sidecar (recognition service on `127.0.0.1:5089`).
- **Android (Tauri)** — same webview model, but MCP clients are desktop tools; nobody points an MCP client at a phone. Out of scope.
- **Nextcloud app build** (`VITE_PLATFORM=nextcloud`) — a thin PHP page over WebDAV; no business logic that parses note content.

All note data lives in **IndexedDB, which is owned by the webview**, not by Rust. Notes may be encrypted at rest; the encryption key is derived from a master password auto-fetched from the OS keyring on startup and held **only in the unlocked webview session** (`masterPassword.js`). So the data — and the ability to decrypt it — lives in JS, not in Rust and not on any server.

Where should the MCP server live, and how does it reach the data?

### Decision

**Host the MCP server in the Tauri Rust process, bound to `127.0.0.1`, and answer every request by reaching through to the webview's existing `storage.js` code ("Shape A").**

- Rust owns the localhost socket, the bearer token, and the enabled/disabled flag (managed state, mirroring the existing `RecognitionState` pattern).
- Each MCP tool call is forwarded Rust → webview via `eval`, handled by a small JS bridge that calls the **existing** storage functions (`getAllNotebooks()`, `getNote()`, existing search, existing task-marker logic), and the result is returned Rust ← webview via an `invoke` callback (`mcp_respond`).
- The server is **off by default**, gated on an explicit user opt-in plus a generated token, and only starts accepting connections **after** `initStorage()` + auto-unlock have completed.
- **Native desktop only.** Compiled/started under `#[cfg(target_os = "windows")]` initially (extendable to macOS/Linux desktop; never Android/NC).

### Consequences

**Positive**
- **Zero storage refactor.** Every hard problem — the split-store schema (`notes` index + `noteContent`), the fail-closed encryption pipeline, sync metadata (`synced`/`version`/`lastSyncedEtag`), migrations — stays solved in one place. The MCP server is a *thin translation layer*, not a second implementation of storage.
- **Decryption "just works."** Because we execute in the unlocked webview session, `getNote()` returns plaintext transparently. No key handling in Rust, no key ever leaves the webview.
- **No locked-state matrix.** The vault auto-unlocks on start and cannot be re-locked while the app runs (see ADR-002). The server only lives inside a running app, so there is **no reachable state** where the server is up but content is locked. Every tool assumes decrypted access — a whole sub-spec disappears.
- **Small, auditable security boundary.** `127.0.0.1` bind + bearer token, consistent with the existing sidecar and keyring patterns.

**Negative / accepted**
- **MCP works only while the app window is open.** The server lives in the Tauri process; closed app = no MCP. Accepted: "app must be running" is a normal constraint for a companion MCP, and clients reconnect.
- **The Rust→webview→Rust round-trip is new.** All existing Tauri calls go JS→Rust (`invoke`) or Rust→native plugin. Reaching *back into JS and awaiting a result* has no precedent in this codebase and is the one genuinely novel piece of plumbing (see §3). It is deliberately de-risked first via a single-tool breakthrough slice.
- **Ties MCP availability to the desktop build.** Nextcloud-app and Android users get no MCP. Accepted for v1; see rejected Alternative B.

### Alternatives considered and rejected

**Alternative A — Nextcloud-hosted MCP server (new PHP route).**
Reuses NC app-password auth, works from any machine even when the client app is closed. **Rejected because:** (1) it is **blind to E2E-encrypted notes** — the server only has ciphertext; the key is client-side only. (2) It serves a **shrinking fraction of users** — Nextcloud is only *one* sync backend, and other WebDAV backends are planned; the client is the one component common to all backends. (3) It opens an authenticated route on a **public server** (larger attack surface) versus a localhost-only bind. (4) The NC app has **no note-parsing layer** today; it would need net-new PHP that understands the note JSON format, duplicating format knowledge.

**Alternative B — Local Windows server that reads IndexedDB directly from Rust.**
Would let the server answer headlessly (app closed). **Rejected because:** IndexedDB is an undocumented, version-fragile LevelDB blob in the WebView2 user-data dir; parsing it from Rust is a maintenance trap that breaks on WebView2 updates. It *still* couldn't decrypt encrypted notes (key is webview-only), so it wouldn't even deliver the headless benefit for encrypted users.

**Alternative C — Refactor primary storage from IndexedDB to local files so Rust can serve them.**
Considered explicitly (it looks like a "win-win"). **Rejected because it is lose-lose:** (1) it would force re-implementing the split schema, encryption pipeline, and sync metadata in Rust — or maintaining the format in *two* places. (2) It **taxes the app's hottest paths** — `getAllNotes()` per overview render, `getNote()` per open, `_saveNoteSplit()` per edit — routing each through IPC serialization, to serve a feature used by <1% of sessions. (3) It **does not even fix the motivating problem**: encrypted content on disk is `{data, iv}` ciphertext, and the key still only exists in the unlocked webview, so Rust would *still* have to go through the webview to decrypt. The refactor buys nothing for the case that motivated it.

**Alternative D — SQLite read-only projection cache (write-through from the webview).**
The webview writes a decrypted-if-unlocked projection (`{id, title, notebookId, recognizedText, taskMarkers, modified}`) into a Rust-owned SQLite DB; the server reads that, enabling **headless** list/search/markers. **Deferred, not adopted:** it addresses only the "app closed" limitation, at the cost of a second store, staleness, and re-implementing search server-side — and it *still* can't serve encrypted content headless (`recognition` is encrypted; key is webview-only). Revisit **only if** users concretely ask for headless MCP.

---

## ADR-002: Rely on the existing always-unlocked vault model; no MCP-specific lock handling

### Context and problem

Local at-rest encryption is optional (`encrypt_local_data`). When on, content fields (`content`, `strokes`, `media`, `tasks`, `recognition`) are AES-GCM encrypted in `noteContent`; index fields (`title`, `notebookId`, `tags`, `modified`, `created`, `hasStrokes`, `hasContent`, `hasRecognition`) stay plaintext. The master password is **always** stored in the OS keyring and auto-fetched on startup (`autoUnlockFromKeyring`); there is **no user-facing lock action** during a running session (`lockApp()` fires only on `clearMasterPassword()`).

Does the MCP server need per-tool locked-state behavior, and does it change the encryption threat model?

### Decision

**No lock-state handling. Gate the listener on "storage ready + unlocked," then treat the vault as unconditionally unlocked for the server's lifetime.** Document that the MCP server does **not** lower the existing security posture.

### Consequences

- The MCP server is up **iff** the app is running **iff** the vault is unlocked. One binary invariant to enforce (start the listener after `initializeApp()` completes), instead of a per-tool locked/unlocked matrix.
- **Threat model is honest and narrow.** The current model already assumes a *trusted local session*: any process in the unlocked OS session can read the master password from the keyring. At-rest encryption protects the IndexedDB file, not against local processes. Therefore the MCP server does **not** weaken encryption — the real boundary it must defend is *"prevent a remote or non-app process from using the localhost port."* That boundary is the **bearer token** (+ `127.0.0.1` bind), not the crypto.
- `127.0.0.1` is reachable by any local process/user, so the **token is the actual gate**, not the bind. Treat the token with the seriousness the encryption only appears to offer.

### Alternatives considered and rejected

- **Per-tool "note is locked" errors / a locked-mode surface.** Rejected: unreachable given auto-unlock. Dead code.
- **Require a separate MCP unlock/confirmation each session.** Rejected for v1 as friction with no security gain given the trusted-local-session model; per-*write* confirmation is retained (see §5).

---

## 1. Tool surface

Read tools map 1:1 onto existing JS. Write tools are deferred past the read breakthrough.

| MCP tool | Maps to (existing JS) | Notes |
|---|---|---|
| `list_notebooks` | `getAllNotebooks()` + `getAllNotes()`, curated via `summarizeNotebook()` | No params. **The breakthrough-slice tool.** Response is a curated summary, not the raw storage record — see the "list/read field curation" note below the table. |
| `list_notes(notebook_id?)` | `getNotesByNotebook()` / `getAllNotes()`, curated via `summarizeNote()` | Index entries only; no content decryption needed. Response is curated, same note as above. |
| `get_note(id, format, attachment_id?)` | `getNote()` | One tool, format param — not N tools. `attachment_id` only used/required when `format = "attachment"` (renamed from an earlier `media`/`media_id` draft — see §1 format table below). |
| `search_notes(query)` | `searchAllNotes()` (`overviewMode.js`, extracted from the overview search UI's inline handler — same function, not a reimplementation) | Matches across **three** sources: typed `note.content`, `recognition.fullText`, and extracted PDF text (`pdfManager.js`'s `extractPdfText`) — broader than the original "recognition.fullText only" assumption in this doc's first draft. Supports `*`/`?` wildcards, matched via a linear glob scanner, not a regex (see the ReDoS note below the table). Inherently a vault-unlocked-session operation (content is decrypted in-memory by `getNote()`); fine per ADR-002. Returns a lightweight summary (id/title/notebookId/`modified`/which-source-matched); a client wanting full content calls `get_note`. |
| `get_task_markers(notebook_id?)` | `extractTasksFromNote()` + `deriveTaskLabel()` (`overviewMode.js`, both exported from existing private functions — `extractTasksFromNote` was already private-but-correct; `deriveTaskLabel` was extracted out of `renderTaskItem`'s inline label logic) | Mirrors `renderMarkersTab`'s candidate-filtering + per-note extraction, without the progressive-rendering/UI-repaint parts. Each marker includes a derived human-readable label: for a text task, the matching `<span data-task-id>`'s text from the note's HTML; for a stroke task, recognized words whose `strokeIds` overlap the task's. `label: null` when recognition produced nothing usable — see `get_task_marker_image` below for how a client resolves that. Also includes `notebookId`/`noteModified`, free since the fully-fetched note is already in hand — lets a client group/sort without a second `list_notes` call. |
| `get_task_marker_image(note_id, task_id)` | one task's `strokes`, via `renderStrokeArrayToDataUrl()` (shared core extracted from `strokes_images`) | Companion to `get_task_markers`: when a marker has `label: null` (handwriting recognition found nothing usable for a stroke task), call this to render just that task's strokes as a real MCP `image` content block. **Shipped wrong once first**: the initial attempt embedded the image as a plain base64 field directly on the marker's JSON object instead of a separate tool. That was "verified live" by manually decoding the field and viewing the file — not by exercising it as an MCP client actually would — and a real Claude Desktop session immediately got stuck trying to bash-decode a JSON string field it had no way to natively render (MCP clients only get image rendering for a real `{type:"image"}` content block, never for base64 sitting in text/JSON). Same underlying lesson as the `note_pdf`/`resource`-block issue in Phase 4b, missed the first time. Corrected by splitting into two tools, mirroring `attachments_list`/`attachment`'s existing list-then-fetch pattern. |

**List/read endpoint field curation (Phase 5c):** `list_notebooks`/`list_notes` originally returned `storage.js`'s raw index record verbatim — including internal sync/versioning fields (`synced`, `lastSyncedEtag`, `version`, `formatVersion`, `encrypted`, `background`, and a stale legacy `hasThumbnail`) that are pure noise to an AI client. `summarizeNote()`/`summarizeNotebook()` (`mcpBridge.js`) curate this down to what's actually useful, plus a few genuinely free additions: `list_notebooks` gains `noteCount`/`lastNoteModified` (computed from the same `getAllNotes()` fetch `list_notes` already needs, not a new IndexedDB read); `get_note`'s `metadata` format gains `attachments` (the full note is already loaded for this format, so `pdfSource`/media/recordings cost nothing extra there, unlike the list endpoints' lightweight index). Deliberately **no `hasPdf` flag** on the list endpoints: `pdfSource` lives only in the encrypted `noteContent` payload, not the index these calls read, so exposing it would mean loading full content per note — the exact cost this list exists to avoid.

**`search_notes` ReDoS, found and fixed via code review (Phase 5d):** the original glob-to-regex translation (`escapeRegex(query).replace(/\*/g, ".*")`) was catastrophic-backtracking — confirmed empirically, a 3-wildcard query against just 800 characters of non-matching note content took 41 seconds, run synchronously on the single-threaded webview (freezing the whole app, not just search). This mattered more via MCP than the UI search box it was extracted from, since a query reaching it through `search_notes` can be built by an LLM client rather than typed by a person. A wildcard-count cap was tried first and was itself wrong — 2 adjacent `.*` groups already suffice for the blowup. **Fixed properly** by replacing the regex entirely with a linear two-pointer glob-matching algorithm (`wildcardMatch`/`globQueryMatches`), provably free of backtracking regardless of wildcard count or content length (confirmed: 50 wildcards against 500,000 characters resolves in ~11ms).

### `get_note` format values

| `format` | Source | Rationale |
|---|---|---|
| `metadata` | index fields (title, notebookId, tags, timestamps, `hasStrokes`/`hasContent`/`hasRecognition`) | No content decryption needed. |
| `text_html` | `note.content` (raw HTML string) | The editor's real output, not a derived plain-text guess. Returned **as-is, unstripped** — formatting (tables, colors, font sizes) is real user content; stripping it would be a lossy, invented transform with no existing precedent, and there's no reliable way back from stripped text to structure. An AI client can strip tags itself if it wants prose. Named `text_html`, not bare `text`, so it isn't ambiguous next to `recognized_text`. |
| `recognized_text` | `recognition.fullText` (string) | Covers the common "what does this note say" case. |
| `recognized_words` | `recognition.words` (array of `{text, boundingRect}`, verbatim) | Distinct from `recognized_text`: needed for spatial queries ("what's written in the top-right"). `recognition.fullText` and `.words` are already two separate fields in the stored shape (see `autoRecognition.js`) — this exposes an existing split, not a new one. |
| `strokes_raw` | `note.strokes` | Renamed from an earlier `raw_strokes` draft for naming consistency with the other qualifier-last names. |
| `strokes_images` | rendered PNG of the note's **strokes only** (no media, no background, no typed text) | Scope is deliberately narrow: this format's purpose is to give an AI a source image for **handwriting recognition** — an alternative/supplement to the local recognition sidecar — so it must contain only the handwriting, not the whole note's visual presentation. **One image covering the full (endless) canvas height, not one image per A4 "page."** NoteBerg's canvas has no stored page boundaries — `showA4PageBreaks` (`CanvasRenderer.js`) and `pdfExport.js`'s page slicing are both *derived rendering conventions* computed from a fixed height constant at render/export time, not real data on the note. Per-page images would force the MCP layer to invent a pagination decision that cuts strokes/words at an arbitrary boundary for a problem (print layout) this format doesn't have. Built following the same pattern already proven live in `NoteCanvas.js`'s `_renderSelectionToPng` (the copy-selection-to-system-clipboard-as-PNG feature) — offscreen canvas, size cap + scale-to-fit, drawn via `drawStroke`/`getThemePalette` (`utils/noteRenderer.js`) — except bounds come from `getStrokeBounds(note.strokes)` (also already exported there) covering the whole note, not a selection. Deliberately does **not** reuse `renderNoteSnapshot` (also in `noteRenderer.js`): that function renders background+media+strokes+text into a fixed 360×500 thumbnail box, built for overview cards — a scope mismatch for a recognition-focused, strokes-only, full-height image. |
| `note_pdf` | the note exported to PDF via the existing `exportNoteToPdf()` (`modules/pdfExport.js`) | An alternative, more complete "see the whole note" format alongside `strokes_images`. Reuses a mature, already-tested pipeline as-is: real A4 pagination, strokes overlaid on original PDF pages when the note has an imported PDF, typed text rendered via `html2canvas`, images placed at their real positions. Confirmed via `MediaManager.js` that `exportNoteToPdf`'s `mediaItems` argument is just `note.media` (`getItems()` returns `this.mediaItems`, built directly from `initialMedia` — no live editor/DOM instance required), so it's callable directly from the MCP bridge with the already-fetched note. Better than a bespoke full-height PNG for this job: real page structure and real text a client can read directly rather than needing to OCR a raster, and its page breaks are genuine, user-visible pagination (the same PDF the user would get from the app's own export), not an arbitrary cut invented for MCP. Returned via the same MCP embedded-resource content block as the `attachment` format's `pdf` kind (`{type:"resource", resource:{uri, mimeType:"application/pdf", blob}}`). **Known client-side limitation, confirmed not a server bug — see `documentation/mcp.md`'s "Known issue: `note_pdf` may fail in Claude Desktop" for the full writeup and links.** `strokes_images` (a plain `image` block) is the working alternative today for handwriting-focused use. |
| `attachments_list` | `note.media`, `note.recordings`, `note.pdfSource` merged (metadata only, no blob data) | A note has **three** binary attachment channels, not one: images (`note.media[]`), audio recordings (`note.recordings[]`), and a single imported PDF (`note.pdfSource`, one `fileId` string, not an array). An earlier `media_list`/`media` design only covered images and silently omitted the other two — discovered live when a real client asked "is there an image about X" and got a correct answer only because the note happened to have no recordings/PDF to miss. Unified into one list with a `kind` field (`"image"` \| `"recording"` \| `"pdf"`) per entry, mirroring the index/content split `storage.js` already makes internally for `media` (cheap listing vs. expensive payload) — now applied uniformly across all three channels instead of just one. |
| `attachment` | one blob, selected by `attachment_id` from a prior `attachments_list` call (the PDF's id is always `"pdf"`) | The only format needing an extra argument. **Returned via the correct MCP content-block type for its kind, not as a JSON-wrapped data URI inside a `text` block.** This was the second bug the same live test surfaced: an image returned as `{type:"text", text:"{\"dataUrl\":...}"}` forced the client to treat a giant base64 string as text to parse/save-to-file/decode, rather than natively viewing it as an image — exactly the stuck behavior observed. Fix: `image` kind → MCP `{type:"image", data, mimeType}` block (mimeType from the actual `Blob`'s stored type — **not** `note.media[].type`, which is the canvas-placement kind "image"/"pdf-page", a distinct bug found and fixed in the same pass); `recording` kind → MCP `{type:"audio", data, mimeType}` block; `pdf` kind → MCP embedded-resource block (`{type:"resource", resource:{uri, mimeType:"application/pdf", blob}}` — MCP has no dedicated PDF content type, so the generic embedded-resource mechanism is the correct fit, per the spec's "Data Types" section). **Known issue, not yet fixed: the `recording` kind's reported `mimeType` is unreliable** — recordings come from multiple capture paths (browser `MediaRecorder`, native Windows WAV, at least one producing MP3) that don't consistently tag the stored blob's real type; verified live that the audio bytes themselves are valid, only the MIME label is wrong. Needs magic-byte sniffing or a save-time fix, not attempted yet. `image` and `pdf` were verified working end-to-end (including visually rendering a fetched image); `recording` was not. |

**Write tools (deferred, after read path proven):** `append_text(note_id, text)`, `create_note(...)`, `add_image(note_id, image)`, and possibly `add_task_marker` / `set_task_status` to close the read→act loop. **`draw_strokes` is explicitly out** for v1 — large surface (pressure/width/**temporal order matters** for recognition), unclear value.

## 1a. MCP Resources (notebooks/notes as URIs)

In addition to tools, notebooks and notes are exposed as MCP **resources** (`resources/list` / `resources/read`), per the [MCP resources spec](https://modelcontextprotocol.io/specification/2025-06-18/server/resources) — a browsable index a client can attach as context, distinct from the tool-call API above.

- **Capability declared:** `{"resources": {}}` — neither `subscribe` nor `listChanged`, since there's no server-to-client push mechanism (consistent with offering no GET/SSE stream, DESIGN §4).
- **URI scheme:** custom `noteberg://notebook/{id}` and `noteberg://note/{id}` (the spec explicitly permits custom schemes, RFC3986-conformant).
- **`resources/read` returns a compact snapshot, not every format.** For a note: `{id, notebookId, title, html, recognizedText}` — enough to know "what is this note," not a menu of every `get_note` representation. A client that wants a specific format (strokes, attachments, the PDF export, etc.) still calls `get_note` — resources and tools serve different jobs here (browsable context vs. explicit, parameterized fetch).
- **Plumbing:** both `resources/list` and `resources/read` need webview data (the notebook/note lists), so — like `tools/call` — they can't be answered by the pure `route_mcp_message` router alone. Routed through a new `RouteOutcome::ReadResources` variant into the **same `call_tool` eval-bridge/pending machinery** already used for real tools, targeting two bridge-side function names (`__resources_list`, `__resource_read` in `mcpBridge.js`) that are deliberately **not** registered in `KNOWN_TOOLS` or advertised in `tool_descriptors()` — reachable only via the `resources/*` methods, never discoverable or invokable through `tools/call` (a dedicated test locks this in). No new round-trip mechanism was built; this is the third consumer of the same plumbing tool calls already use.
- **Errors:** resource-not-found maps to the spec's `-32002` code (vs. `-32601`/`-32602`/`-32603` used elsewhere for method/param/internal errors).

**A real (if cosmetic) bug found while building this, fixed at the source:** `call_tool`'s error path had been passing the bridge's raw `{"error": "..."}` JSON string straight through as the error message since Phase 4a — every `tools/call` error text was doubly-JSON-encoded (e.g. literal text `{"error":"Note not found: x"}` shown to the client instead of the clean message). Unnoticed until now because a JSON-string-as-text is still readable in a `text` content block; it would have been far more visible as a malformed `error.message` in `resources/read`'s JSON-RPC error. Fixed with `extract_bridge_error_message()`, unwrapping the envelope once in `call_tool` — both the `tools/call` and `resources/read` error paths get the fix automatically, not patched per-callsite.

---

## 2. Security model (summary of ADR-002)

- **Off by default.** Explicit user opt-in in Settings.
- **Bearer token(s)**, each generated on demand and independently revocable (see §2a — multiple named tokens, not a single shared secret), stored via the existing keyring path (`secureStorage.js` → `save_credential`). Sent as `Authorization: Bearer <token>`. **This is the security boundary.**
- **`127.0.0.1` bind only.**
- **Scoped tokens:** read-only vs read-write (write path only, not yet built). Reads may be silent-with-log; **writes should not be silent** (see §5).
- **Activity log** surfaced in-app so reads aren't invisible. **Not** the existing debug logger (`utils/logger.js`) — confirmed unfit for this: in-memory only (nothing survives a restart), capped at 1000 entries with silent oldest-first eviction, JS-only by explicit design (the file's own comment says Rust logs never reach it, for performance reasons), and casually user-clearable. The MCP access log is a separate, dedicated component (`mcpAuditLog.js`, its own IndexedDB database, capped at 15,000 entries, on/off toggle, cleared independently of debug logs). Each entry also records **which named token** made the call (see §2a), so the log can answer "which client did this," not just "what was accessed." Cleared alongside `purgeLocalData()` (call-site wiring in `settingsMode.js`, not inside `storage.js` — keeps the containment boundary intact) so a full local-data wipe doesn't leave MCP history behind.
- **At-a-glance status in the footer**: a small badge (Windows only, shown only when the server is actually enabled *and* running — not just when the persisted setting says so) sits next to the sync indicator, and briefly changes color on real MCP traffic. Driven by two window events dispatched from `mcpBridge.js` — `mcp-status-changed` (from `pushConfigToRust`, the single funnel every enable/disable/token mutation already goes through) and `mcp-activity` (from `handle()`, the single choke point every tool call passes through, same place the audit logger hooks in) — so `footer.js` needed no new plumbing into the bridge, just two listeners.
- **Known gap, not yet fixed:** rejected requests (401 bad token, 503 disabled/no-token) are handled entirely in `mcp.rs` and never reach the JS audit log — the single most security-relevant signal ("who tried and failed to get in") currently leaves no trace. Deferred; would need Rust to call back into the webview purely to log a failed attempt, a real architectural addition rather than a small fix.
- Listener starts **only after** storage init + auto-unlock.

---

## 2a. Multi-token support

**Problem found after Phase 5**: the original design used a single fixed keyring key (`mcp_token`) — genuinely "zero or one token at a time," enforced in both `secureStorage.js`'s storage shape and Rust's `McpState.token: Mutex<Option<String>>`. This meant every configured MCP client (Claude Desktop, Cursor, anything else) had to share the *same* credential, with two real consequences: (1) no way to revoke access for one client without also breaking every other client using the same token, and (2) the newly-built audit log could record *what* was called but never *which client* called it, since there was only ever one token to distinguish.

**Fix: named, independently-revocable tokens.**

- **Storage split, mirroring the existing pattern used elsewhere in this codebase (secrets in keyring, metadata in IndexedDB settings, never the two combined in one place):**
  - Token **metadata** (`{id, name, created}` — never the secret) stored as a list under a single `mcp_tokens` setting via `storage.js`'s existing `getSetting`/`setSetting`.
  - Each token's **secret** stored under its own keyring entry, keyed `mcp_token_{id}` — never all in one flat string, so revoking one doesn't require rewriting a combined blob.
- **Rust (`McpState`)**: `token: Mutex<Option<String>>` → a set of currently-valid token secrets (a `HashMap<token_secret, token_name>` for straightforward name-per-request lookup during the constant-time auth check, rather than a bare `HashSet` that would need a second lookup). `mcp_set_config`'s `token: Option<String>` param becomes `tokens: Vec<{value, name}>` (or equivalent), replacing the whole set on each push from JS — matching the existing "JS is the source of truth, Rust never persists" invariant (ADR-002), just for a set instead of a scalar.
- **Threaded through the call path**: `has_valid_token` now returns *which* token matched (its name), not just a bool. That name flows through `eval_bridge`/`call_tool` into the arguments passed to the JS bridge handler, and from there into `mcpAuditLog.js`'s entry shape (`tokenName` field) — a real plumbing change through the previously-thin `arguments: Value` path, done deliberately alongside the storage change rather than as a follow-up, since "which client did this" was a core motivation for naming tokens at all.
- **Settings UI**: the single "Generate/Regenerate access token" + "Revoke access token" button pair is replaced with a list — one row per named token, each independently revocable, plus a "Generate new token" action that **prompts for a name** (e.g. "Claude Desktop") before creating it, falling back to an auto-generated label if left blank. Each token's secret is still shown exactly once at creation time (same "shown once, copied to clipboard" UX as before), never retrievable again afterward.
- **Audit log viewer**: gains a token/client column, so a past entry can be attributed to the specific token that made it — including tokens that have since been revoked (the name is stored with the log entry itself, not looked up live from the current token list, so revoking a token doesn't retroactively blank out its history).

---

## 3. The one hard piece: Rust → webview → Rust round-trip

Existing calls are JS→Rust (`invoke`) or Rust→native-plugin (`run_mobile_plugin`). MCP needs the reverse: an inbound HTTP request on the Rust side must run JS in the webview and **await** the result.

**Mechanism (agreed — "eval + invoke callback"):**

1. Rust receives the HTTP request, mints a `requestId`, parks a response channel in a `Mutex<HashMap<requestId, Sender>>` (managed state).
2. Rust calls `webview.eval("window.__mcpBridge.handle('list_notebooks', '<requestId>', '<argsJson>')")`.
3. The JS bridge (`mcpBridge.js`) runs the mapped storage function, then `invoke('mcp_respond', { id, ok, json })`.
4. The `mcp_respond` Rust command looks up `requestId`, sends the payload through the channel; the parked HTTP handler wakes and writes the response.
5. **Timeout** on the parked channel so a webview that never answers doesn't leak a hung request.

`eval` takes a string, so args are JSON-stringified. For `list_notebooks` there are no args — which is exactly why it is the breakthrough tool.

**Rejected bridge alt:** `emit`/`listen` event channel — equivalent effort, same id-correlation map, marginally less direct than `eval`+`invoke`. Not chosen.

---

## 4. Transport: plain HTTP first (Phase 0/1/2), real MCP protocol second (Phase 3 — done)

The **breakthrough slice** (Phase 0) was deliberately *not* spec-compliant MCP: a plain `GET /list_notebooks` + bearer header returning a JSON array, using a minimal server lib (`tiny_http`) — just enough to prove data flows `client → Rust → webview JS → storage → back`.

**Phase 3 replaced that ad-hoc route with the real protocol**, per the MCP spec's ["Streamable HTTP" transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) — the right choice because our server is a long-lived process handling multiple connections (not spawned per-connection like stdio requires):

- A single `POST /mcp` endpoint speaking JSON-RPC 2.0 (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`).
- Responses are **always** a single `application/json` body — the spec permits a POST response to be either plain JSON or an SSE stream, client's choice to accept either; since our tool calls are fast request/response with no server-to-client push, SSE was legitimately skippable, avoiding real complexity.
- `GET /mcp` (server-initiated stream) returns **405** — spec-legal ("or else return HTTP 405 Method Not Allowed, indicating the server does not offer an SSE stream at this endpoint"). We have no notifications/progress to push yet.
- No `Mcp-Session-Id` — session management is spec-optional; `McpState` is single-shared, not per-session.
- **`Origin` header validation** (spec-required, DNS-rebinding protection): any request carrying an `Origin` header is rejected (403). Real MCP client libraries are not browser pages and don't send `Origin` on plain HTTP requests — only a browser-originated fetch (the rebinding attack) would carry one. Verified live: a curl request with `Origin: https://evil.example` gets 403; the same request without it succeeds.
- The bearer-token auth from Phase 2 sits **underneath** the JSON-RPC layer, checked first — matches the spec's own local-server guidance (`security_best_practices` §"Local MCP Server Compromise": HTTP transport SHOULD require an auth token).

**Verified against a real handshake sequence** (curl simulating what an MCP client actually sends, in order): `initialize` → 200 with correct `protocolVersion`/`capabilities`/`serverInfo`; `notifications/initialized` → 202 with no body; `tools/list` → 200 advertising `list_notebooks` with its schema; `tools/call` → 200 with real notebook data routed through the **unchanged** Phase 0/1 eval-bridge/pending machinery, wrapped as an MCP `content` block. Error paths also verified: unknown tool → JSON-RPC `-32601`; missing `name` param → `-32602`; malformed JSON body → `-32700` with null id; the old `/list_notebooks` route → 404 (cleanly removed, not left as a parallel path).

---

## 5. Write-path consent with an unattended client (open design question)

An MCP client acts without the user watching. For **reads**, silent-with-activity-log is acceptable (trusted-local-session model). For **writes**, an unattended agent appending/creating content unprompted is riskier. Options to decide when the write path is designed:

- Per-write confirmation toast ("Claude wants to append to 'Meeting notes' — allow?") — safest, but breaks unattended flows.
- Write-scoped token the user grants deliberately, then writes are silent-with-log.
- Hybrid: creates allowed silently; destructive/overwrite operations always confirmed.

Not resolved here — reads ship first.

---

## 6. Platform gating

- Code under `#[cfg(target_os = "windows")]` for v1 (the recognition sidecar already establishes this pattern), structured so macOS/Linux desktop can be enabled later by widening the cfg.
- **Never** compiled/started on Android or in the NC build.
- The JS bridge import is gated by an **explicit platform allowlist** (`isMcpSupportedPlatform()` in `main.js`), not an OS-negation — it must positively match whatever `target_os` values the Rust `cfg` currently supports (Windows only today), so it can never silently admit a platform (future macOS/Linux desktop, or mobile) before that platform's Rust side actually exists. NC is separately unreachable via the existing `IS_NEXTCLOUD` guard.

---

## 7. Open items

1. ~~Confirm MCP-client HTTP/SSE transport support (§4).~~ **Resolved in Phase 3**: the spec's "Streamable HTTP" transport lets a POST response be either a single `application/json` body or an SSE stream, client's choice to accept either — we always answer plain JSON (our tool calls are fast request/response), and offer no GET/SSE stream (405). This is spec-legal and avoids taking on SSE complexity. Verified against the live spec docs, a real curl-driven handshake, **and a real Claude Desktop connection**. One caveat surfaced: Claude Desktop's `claude_desktop_config.json` only supports stdio `command`/`args` entries, not a direct HTTP URL — connecting it requires the community `mcp-remote` stdio↔HTTP bridge (the same pattern Blender's own MCP integration uses for its long-lived-app-with-persistent-server architecture). Not a flaw in our server or in Streamable HTTP; a known gap in one client's config loader.
2. Write-path consent model (§5).
3. Whether `search_notes` should transparently fall back to the recognition sidecar for notes lacking cached `recognition` (or only search cached text). Likely: cached text only for v1.
4. Token-management UX (generate / show-once / revoke) in Settings — **done in Phase 2.**
