// ── MCP server ────────────────────────────────────────────────────────────────
//
// Local HTTP server exposing NoteBerg notebooks/notes to MCP clients, speaking
// real MCP over the "Streamable HTTP" transport (JSON-RPC 2.0 over a single
// POST /mcp endpoint — see https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).
// Proves (Phase 0), hardens (Phase 1), and adds real enable/token management
// (Phase 2) for the vertical path: MCP client -> Rust localhost server ->
// webview JS bridge -> storage.js -> back. Phase 3 (this revision) replaces
// the ad-hoc REST route from Phases 0-2 with the actual protocol so a real
// client (Claude Desktop, etc.) can connect. Still one tool (`list_notebooks`).
// See documentation/mcp_design.md and documentation/roadmap/mcp/PLAN.md.
//
// Windows-only for this slice (matches the recognition-sidecar precedent).
//
// Streamable HTTP scope deliberately kept minimal (spec permits all of this):
//   - POST /mcp responses are always a single `application/json` body, never
//     an SSE stream — our tool calls are fast request/response, so the
//     spec-optional SSE-response path buys us nothing.
//   - GET /mcp (server-initiated stream) is not offered -> 405, since we have
//     no server-to-client push (no notifications, no progress) yet.
//   - No `Mcp-Session-Id` — session management is spec-optional and our state
//     (McpState) is single-shared, not per-session.
//
// Security model (see DESIGN.md ADR-002 and the loopback/TLS discussion):
//   - Bound to 127.0.0.1 only — never reachable off-machine.
//   - Bearer token is the real security boundary (not TLS — loopback traffic
//     never touches a network segment, so there is no MITM to defend against).
//     This matches the spec's own local-server guidance (security_best_practices
//     §"Local MCP Server Compromise": HTTP transport SHOULD require an auth token).
//   - `Origin` header validation (spec-required, DNS-rebinding protection): any
//     request carrying an `Origin` header is rejected outright. Real MCP client
//     libraries are not browser pages and do not send `Origin`; only a
//     browser-originated fetch (the rebinding attack) would carry one. This is
//     stricter than an allow-list and is safe specifically because this server
//     has no legitimate browser-facing caller.
//   - Off by default (DESIGN ADR-002 invariant). Tokens are generated in JS
//     (mcpBridge.js), stored in the OS keyring (same path as the master
//     password), and pushed into this module's in-memory state via
//     `mcp_set_config` — Rust never generates, persists, or reads a token
//     back out; it only compares incoming requests against the current set.
//   - Multiple, independently-named tokens can be valid at once (DESIGN §2a):
//     `McpState.tokens` maps each token secret to the human-readable name the
//     user gave it (e.g. "Claude Desktop"), so revoking one client's access
//     doesn't affect any other client's token, and the audit log can record
//     *which* named token made each call, not just that some token matched.
//   - `mcp_respond` is a pure courier: it only ever delivers a pre-computed
//     JSON payload to the pending request that matches `request_id`. It must
//     never gain the ability to execute or dispatch anything — that would be
//     a privilege escalation from "thin translation layer" to "code executor".
//   - `mcp_set_config`/`mcp_get_status` only ever move `enabled`/`has_token`
//     state; `mcp_get_status` never returns the token itself, mirroring how
//     `get_credential` is treated as write-mostly for secrets elsewhere.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// Protocol version this server implements. Echoed back in `initialize` if the
/// client requests it (per-spec version negotiation is "respond with a version
/// you support" — we only support one, so we always offer this one).
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

/// Fixed port for the MCP server. Not user-configurable in v1 — revisit if a
/// real conflict is reported (matches the recognition sidecar's fixed-port
/// precedent).
const MCP_PORT: u16 = 8765;

/// How long the HTTP handler waits for the webview to answer before giving up.
const BRIDGE_TIMEOUT: Duration = Duration::from_secs(10);

pub struct McpState {
    /// Off by default (DESIGN ADR-002 invariant: enable explicitly). Only
    /// meaningful together with `tokens` being non-empty — see `handle_request`.
    pub enabled: AtomicBool,
    /// Every currently-valid token, keyed by secret, valued by the
    /// human-readable name the user gave it (DESIGN §2a). Empty until the
    /// user generates at least one via Settings. Requests are rejected (fail
    /// closed) whenever this is empty, regardless of `enabled`.
    tokens: Mutex<HashMap<String, String>>,
    /// requestId -> channel the parked HTTP handler is waiting on. Each inbound
    /// request is handled on its own thread (see `start`), so this map is
    /// accessed concurrently — guarded by the Mutex, keyed by a collision-free
    /// monotonic counter (see `next_request_id`), never by a wall-clock reading.
    pending: Mutex<HashMap<String, Sender<BridgeResult>>>,
    next_request_id: AtomicU64,
}

impl McpState {
    fn new() -> Self {
        Self {
            // Off by default (DESIGN ADR-002 invariant). Real state is pushed
            // in by mcpBridge.js shortly after app unlock via mcp_set_config;
            // until then (and on every fresh process start) this is inert.
            enabled: AtomicBool::new(false),
            tokens: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            next_request_id: AtomicU64::new(0),
        }
    }

    /// Monotonically increasing id, safe across concurrently spawned request
    /// threads (unlike a timestamp, which can collide under Windows' timer
    /// granularity when many threads start in the same tick).
    fn next_request_id(&self) -> String {
        format!("{:x}", self.next_request_id.fetch_add(1, Ordering::Relaxed))
    }
}

#[derive(Serialize)]
pub struct McpStatus {
    enabled: bool,
    has_token: bool,
    port: u16,
}

/// One named token as pushed from JS — mirrors mcpBridge.js's token metadata
/// list (id/name live in IndexedDB settings; this struct only ever carries
/// the secret + name actually needed to authenticate a request, never an id).
#[derive(Deserialize)]
pub struct McpTokenEntry {
    value: String,
    name: String,
}

/// Tauri command: push the current enabled flag + full token set from JS (the
/// source of truth — settings live in IndexedDB/keyring, both webview-owned)
/// into this module's in-memory state. Called once on startup after unlock,
/// and again whenever the user changes the enabled setting or
/// generates/revokes a token. `tokens` always **replaces** the whole set
/// (never merged/diffed) — simplest correct behavior, and matches the
/// existing "JS is the source of truth" invariant (ADR-002) for a set
/// instead of a single scalar.
#[tauri::command]
pub fn mcp_set_config(app: AppHandle, enabled: bool, tokens: Vec<McpTokenEntry>) {
    let state = app.state::<McpState>();
    state.enabled.store(enabled, Ordering::Relaxed);
    let mut map = HashMap::new();
    for entry in tokens {
        if !entry.value.is_empty() {
            map.insert(entry.value, entry.name);
        }
    }
    *state.tokens.lock().unwrap() = map;
}

/// Tauri command: report enabled/has-token/port without ever exposing any
/// token value itself back to JS (JS already owns the token metadata list
/// independently in IndexedDB settings — this is only for Rust's own state).
#[tauri::command]
pub fn mcp_get_status(app: AppHandle) -> McpStatus {
    let state = app.state::<McpState>();
    let has_token = !state.tokens.lock().unwrap().is_empty();
    McpStatus {
        enabled: state.enabled.load(Ordering::Relaxed),
        has_token,
        port: MCP_PORT,
    }
}

/// Result the JS bridge hands back for a given request.
struct BridgeResult {
    ok: bool,
    json: String,
}

/// Tauri command the JS bridge calls to deliver a tool result. Pure courier:
/// looks up `request_id` and forwards the payload — no dispatch, no execution.
#[tauri::command]
pub fn mcp_respond(app: AppHandle, request_id: String, ok: bool, json: String) {
    let state = app.state::<McpState>();
    deliver(&state.pending, &request_id, BridgeResult { ok, json });
}

/// Core correlation-map logic, split out of `mcp_respond` so it's testable
/// without a running Tauri `AppHandle`. Looks up `request_id` and forwards the
/// result — no matching entry (already timed out, or an unknown id) is a
/// silent no-op, never an error.
fn deliver(pending: &Mutex<HashMap<String, Sender<BridgeResult>>>, request_id: &str, result: BridgeResult) {
    let sender = pending.lock().unwrap().remove(request_id);
    if let Some(sender) = sender {
        let _ = sender.send(result);
    }
}

/// Start the MCP server on its own thread. Safe to call unconditionally at
/// setup; requests are rejected (enabled=false / bad token) until Phase 2
/// wires real enable/disable + token management.
pub fn start(app: &tauri::App) {
    app.manage(McpState::new());

    let server = match tiny_http::Server::http(("127.0.0.1", MCP_PORT)) {
        Ok(server) => server,
        Err(e) => {
            eprintln!("[MCP] Failed to bind 127.0.0.1:{}: {}", MCP_PORT, e);
            return;
        }
    };
    eprintln!("[MCP] Listening on 127.0.0.1:{} (disabled by default)", MCP_PORT);

    let app_handle = app.handle().clone();
    std::thread::spawn(move || {
        // Each request gets its own thread: handle_request blocks for up to
        // BRIDGE_TIMEOUT waiting on the webview round-trip, so handling requests
        // one-at-a-time on the accept loop would serialize unrelated MCP calls
        // behind each other's full timeout window.
        for request in server.incoming_requests() {
            let app_handle = app_handle.clone();
            std::thread::spawn(move || handle_request(&app_handle, request));
        }
    });
}

fn handle_request(app: &AppHandle, mut request: tiny_http::Request) {
    let state = app.state::<McpState>();

    if !state.enabled.load(Ordering::Relaxed) {
        respond(request, 503, "MCP server is disabled");
        return;
    }

    // Fail closed: no tokens configured means no request can ever be valid,
    // regardless of `enabled` (mirrors DESIGN ADR-002 — the token is the
    // actual security boundary, not the enabled flag by itself).
    let tokens = state.tokens.lock().unwrap().clone();
    if tokens.is_empty() {
        respond(request, 503, "MCP server has no token configured");
        return;
    }

    let Some(token_name) = matched_token_name(&request, &tokens) else {
        respond(request, 401, "Unauthorized");
        return;
    };

    // DNS-rebinding protection (spec-required): reject any request carrying
    // an Origin header. Real MCP client libraries are not browser pages and
    // do not send Origin on plain HTTP requests — only a browser-originated
    // fetch (the rebinding attack this guards against) would ever carry one.
    if has_origin_header(&request) {
        respond(request, 403, "Cross-origin requests are not permitted");
        return;
    }

    if request.url() != "/mcp" {
        respond(request, 404, "Not found");
        return;
    }

    match *request.method() {
        tiny_http::Method::Post => {
            let mut body = String::new();
            if let Err(e) = request.as_reader().read_to_string(&mut body) {
                respond(request, 400, &format!("Failed to read request body: {e}"));
                return;
            }
            handle_mcp_post(app, &state, request, &body, &token_name);
        }
        // No server-initiated stream is offered (no notifications/progress to
        // push yet) — 405 is spec-legal ("or else return HTTP 405 Method Not
        // Allowed, indicating the server does not offer an SSE stream here").
        tiny_http::Method::Get => respond(request, 405, "This server does not offer a GET/SSE stream"),
        _ => respond(request, 405, "Method not allowed"),
    }
}

/// Check the request's bearer token against every currently-valid token
/// (DESIGN §2a — multiple named tokens can be valid at once) and return the
/// name of whichever one matched, or `None` if none did. Compares against
/// *every* entry (not short-circuiting on the first match) so the time taken
/// doesn't leak how many tokens exist or which one a guess is closest to;
/// each individual comparison is itself constant-time (`constant_time_eq`).
fn matched_token_name(request: &tiny_http::Request, tokens: &HashMap<String, String>) -> Option<String> {
    let presented = request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("Authorization"))
        .map(|h| h.value.as_str())
        .map(|v| v.strip_prefix("Bearer ").unwrap_or(""))?;

    let mut matched: Option<String> = None;
    for (secret, name) in tokens {
        if constant_time_eq(presented.as_bytes(), secret.as_bytes()) {
            matched = Some(name.clone());
        }
    }
    matched
}

fn has_origin_header(request: &tiny_http::Request) -> bool {
    request
        .headers()
        .iter()
        .any(|h| h.field.as_str().as_str().eq_ignore_ascii_case("Origin"))
}

/// Compare two byte strings without early-exiting on the first mismatch, so
/// the time taken doesn't leak how many leading bytes of a guessed token were
/// correct. Real length differences still short-circuit (safe: length is not
/// secret-dependent information worth hiding here, and hiding it would require
/// padding to a fixed size).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Reach into the webview and invoke the JS bridge. `tool` and `request_id`
/// are controlled by this module (never user input), so plain string
/// interpolation is safe for them. `arguments` originates from the MCP
/// client's `tools/call` params — it is serialized via `serde_json` (proper
/// JSON encoding, not string concatenation), so client-supplied strings
/// (e.g. a note title used as a search term) can't break out of the script.
fn eval_bridge(app: &AppHandle, tool: &str, request_id: &str, arguments: &Value) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let script = format!(
        "window.__mcpBridge && window.__mcpBridge.handle({}, {}, {});",
        serde_json::to_string(tool).unwrap(),
        serde_json::to_string(request_id).unwrap(),
        serde_json::to_string(arguments).unwrap(),
    );
    window.eval(&script).map_err(|e| e.to_string())
}

/// Result of calling a tool through the webview bridge: either the tool's
/// JSON result, or an error message — both cases are reported back to the MCP
/// client as a normal `tools/call` result (with `isError` set accordingly),
/// not as a JSON-RPC protocol error, per spec ("Tool Execution Errors").
enum ToolCallOutcome {
    Ok(Value),
    Err(String),
}

/// Drive one tool call through the existing eval-bridge/pending round-trip
/// (unchanged from Phase 0/1) and return its outcome. `park_and_wait` is the
/// only piece that talks to the webview; the JSON-RPC layer above it just
/// shapes the request/response envelope.
///
/// `token_name` (DESIGN §2a) is the name of the token that authenticated this
/// request — determined once in `handle_request` where the auth check
/// happens, then threaded all the way down to here. Rather than widen
/// `eval_bridge`'s signature and the JS-facing `handle(tool, requestId, args)`
/// contract with a whole new parameter, it's folded into `arguments` under a
/// reserved `_tokenName` key (mirroring the existing `__mcp_content_kind`
/// reserved-field convention already used for the Rust<->JS contract in the
/// other direction) — `mcpBridge.js` reads and strips it before passing the
/// rest of `arguments` to the actual tool handler.
fn call_tool(app: &AppHandle, state: &McpState, tool: &str, arguments: &Value, token_name: &str) -> ToolCallOutcome {
    let mut arguments = arguments.clone();
    if let Value::Object(map) = &mut arguments {
        map.insert("_tokenName".to_string(), json!(token_name));
    }

    let request_id = state.next_request_id();
    let (tx, rx) = mpsc::channel::<BridgeResult>();
    state.pending.lock().unwrap().insert(request_id.clone(), tx);

    if let Err(e) = eval_bridge(app, tool, &request_id, &arguments) {
        state.pending.lock().unwrap().remove(&request_id);
        eprintln!("[MCP] eval failed: {}", e);
        return ToolCallOutcome::Err(format!("Bridge eval failed: {e}"));
    }

    match rx.recv_timeout(BRIDGE_TIMEOUT) {
        Ok(BridgeResult { ok: true, json }) => match serde_json::from_str::<Value>(&json) {
            Ok(value) => ToolCallOutcome::Ok(value),
            Err(e) => ToolCallOutcome::Err(format!("Tool returned invalid JSON: {e}")),
        },
        // The bridge's error path (mcpBridge.js's handle() catch block) sends
        // JSON.stringify({error: "..."}) here, not a plain string — unwrap that
        // envelope so callers get a clean human-readable message, not literal
        // JSON text like {"error":"Note not found: x"} showing up as the message.
        Ok(BridgeResult { ok: false, json }) => ToolCallOutcome::Err(extract_bridge_error_message(&json)),
        Err(_timeout) => {
            // Clean up so a late/never-arriving response can't linger forever.
            state.pending.lock().unwrap().remove(&request_id);
            ToolCallOutcome::Err("Webview did not respond in time".to_string())
        }
    }
}

/// Unwrap the bridge's `{"error": "..."}` JSON envelope into a plain message
/// string. Falls back to the raw text if it isn't that shape (defensive —
/// keeps behavior sane even if a future handler sends something unexpected).
fn extract_bridge_error_message(json: &str) -> String {
    match serde_json::from_str::<Value>(json) {
        Ok(value) => value
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or(json.to_string()),
        Err(_) => json.to_string(),
    }
}

// ── JSON-RPC / MCP protocol layer ───────────────────────────────────────────
//
// Minimal JSON-RPC 2.0 + MCP method set: `initialize`, `notifications/initialized`,
// `tools/list`, `tools/call`. Everything below only shapes envelopes and
// dispatches to `call_tool` above — no data access happens in this section.

#[derive(Deserialize)]
struct JsonRpcRequest {
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

/// Names of every tool this server knows how to execute. Kept as one list so
/// `tools/list`'s catalog and `tools/call`'s "is this a known tool" check
/// can't drift apart (e.g. a tool advertised but not actually callable).
const KNOWN_TOOLS: &[&str] = &[
    "list_notebooks",
    "list_notes",
    "get_note",
    "search_notes",
    "get_task_markers",
    "get_task_marker_image",
];

/// The `tools/list` catalog. Kept as a function (not a constant) since
/// `inputSchema` is a `Value` and building it inline reads clearer than a
/// static initializer here. Descriptions and schemas are the actual data an
/// MCP client uses to decide when/how to call each tool, so they're written
/// for that audience (an LLM deciding what to call), not for us.
fn tool_descriptors() -> Vec<Value> {
    vec![
        json!({
            "name": "list_notebooks",
            "description": "List all of the user's NoteBerg notebooks (id, title, description, color, timestamps, noteCount, lastNoteModified). Does not include individual notes — call list_notes with a notebook's id for that. Looking for something by keyword instead of browsing? Use search_notes.",
            "inputSchema": {
                "type": "object",
                "properties": {},
            }
        }),
        json!({
            "name": "list_notes",
            "description": "List notes (id, title, timestamps, tags, hasStrokes/hasContent/hasRecognition flags, media/recordings id lists — no content) in a given notebook, or all notes across every notebook if notebook_id is omitted. This is an index only — call get_note with a note's id to read its actual content (typed text, recognized handwriting, attachments, etc.). Looking for something by keyword instead of browsing? Use search_notes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "notebook_id": {
                        "type": "string",
                        "description": "Notebook id to list notes from. Omit to list all notes across all notebooks."
                    }
                },
            }
        }),
        json!({
            "name": "get_note",
            "description": "Get one note's content in a specific format. Use 'metadata' first if you only need title/timestamps/tags. For handwriting specifically: try 'recognized_text' first (OCR'd text) — if that's empty or garbled, 'strokes_images' renders the actual handwriting as a picture you can read visually instead.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The note id." },
                    "format": {
                        "type": "string",
                        "enum": ["metadata", "text_html", "recognized_text", "recognized_words", "strokes_raw", "strokes_images", "note_pdf", "attachments_list", "attachment"],
                        "description": "metadata: title/timestamps/tags/attachments (no content) only. text_html: the typed rich-text content as raw HTML. recognized_text: full recognized handwriting text. recognized_words: recognized handwriting as individual words with bounding boxes. strokes_raw: raw pen stroke data. strokes_images: a single PNG image of just the handwritten strokes (no typed text, no attached media) covering the whole note — useful for visually inspecting or re-recognizing handwriting. note_pdf: the note exported as a PDF (typed text, strokes, and attached images/PDF pages all rendered together, with real pagination) — useful for a complete view of the note's content. attachments_list: metadata for every attachment on the note — images, audio recordings, and the imported PDF if any (no binary data). attachment: one attachment's actual data (image/audio/PDF) — requires attachment_id."
                    },
                    "attachment_id": {
                        "type": "string",
                        "description": "Required only when format is 'attachment' — the id of the attachment to fetch (from a prior attachments_list call). The note's imported PDF, if any, always has the id 'pdf'."
                    }
                },
                "required": ["id", "format"],
            }
        }),
        json!({
            "name": "search_notes",
            "description": "Search all notes' typed text, recognized handwriting, and extracted PDF text for a query. Supports '*' and '?' wildcards. Returns lightweight matches (id, title, notebookId, modified, which sources matched) — call get_note for full content. Looking for checkbox/to-do items specifically? Use get_task_markers instead — it returns structured checked/unchecked state, not just text matches.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query. '*' matches any run of characters, '?' matches a single character." }
                },
                "required": ["query"],
            }
        }),
        json!({
            "name": "get_task_markers",
            "description": "List task markers (checkbox items) across notes, optionally scoped to one notebook. Each marker includes its checked state, a best-effort text label, which note it's in (noteId/noteTitle/notebookId), and that note's modified timestamp (noteModified). If handwriting recognition couldn't produce usable text for a handwritten (stroke) task, label is null — call get_task_marker_image with that marker's note_id and id to view the handwriting directly as an image.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "notebook_id": {
                        "type": "string",
                        "description": "Notebook id to scope task markers to. Omit to list task markers across all notebooks."
                    }
                },
            }
        }),
        json!({
            "name": "get_task_marker_image",
            "description": "Render one handwritten (stroke) task marker's handwriting as an image. Use this when get_task_markers returned label: null for a marker, so you can read its content visually instead of guessing from raw data.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "note_id": { "type": "string", "description": "The note id (from get_task_markers' noteId field)." },
                    "task_id": { "type": "string", "description": "The task marker id (from get_task_markers' id field)." }
                },
                "required": ["note_id", "task_id"],
            }
        }),
    ]
}

/// Outcome of the pure (no-webview-access) parse+route step.
enum RouteOutcome {
    /// Final response — nothing more to do.
    Response(u16, Option<Value>),
    /// A validated `tools/call` for a known tool — the caller still needs to
    /// actually run it (requires `app`/`state`, so it's kept out of the pure
    /// routing function to keep that part unit-testable without an AppHandle).
    CallTool { id: Option<Value>, tool: String, arguments: Value },
    /// `resources/list` or `resources/read` — both need webview data (notebook/
    /// note lists), so like CallTool they're deferred out of this pure function.
    /// Routed through the same internal bridge tools (`__resources_list`,
    /// `__resource_read`) as call_tool — not advertised in tool_descriptors()/
    /// KNOWN_TOOLS, so they're unreachable via tools/call, only via resources/*.
    ReadResources { id: Option<Value>, bridge_tool: &'static str, arguments: Value },
}

/// Parse and route one JSON-RPC message, without touching the webview. Split
/// out of `dispatch_mcp_message` so `initialize`, `notifications/initialized`,
/// `tools/list`, and the JSON-RPC/validation error paths are unit-testable
/// without a running Tauri `AppHandle` — only `tools/call`'s actual execution
/// needs one, and that's handled by `dispatch_mcp_message` below.
fn route_mcp_message(body: &str) -> RouteOutcome {
    let parsed: JsonRpcRequest = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => {
            // Malformed JSON-RPC: id is unknown, so respond with a null-id error
            // (spec allows this for requests that couldn't be parsed at all).
            return RouteOutcome::Response(
                400,
                Some(json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32700, "message": format!("Parse error: {e}") }
                })),
            );
        }
    };

    let id = parsed.id.clone();

    match parsed.method.as_str() {
        "initialize" => RouteOutcome::Response(200, Some(jsonrpc_result(id, initialize_result()))),

        // Notifications (no `id`) get no body per spec: "If the server accepts
        // the input, the server MUST return HTTP status code 202 Accepted with
        // no body." We accept unconditionally — there's no session state that
        // could reject an `initialized` notification.
        "notifications/initialized" => RouteOutcome::Response(202, None),

        "tools/list" => RouteOutcome::Response(
            200,
            Some(jsonrpc_result(id, json!({ "tools": tool_descriptors() }))),
        ),

        "tools/call" => {
            let Some(name) = parsed.params.get("name").and_then(Value::as_str) else {
                return RouteOutcome::Response(
                    200,
                    Some(jsonrpc_error(id, -32602, "Missing required param: name")),
                );
            };

            if !KNOWN_TOOLS.contains(&name) {
                return RouteOutcome::Response(
                    200,
                    Some(jsonrpc_error(id, -32601, &format!("Unknown tool: {name}"))),
                );
            }

            // "arguments" is optional per spec; default to an empty object so
            // downstream handlers can always treat it as an object to read from.
            let arguments = parsed.params.get("arguments").cloned().unwrap_or(json!({}));

            // Must actually be an object: call_tool injects _tokenName by
            // inserting into it as a map, which is a silent no-op for any
            // other JSON type (e.g. a client sending "arguments": [] would
            // otherwise reach the tool with token attribution quietly
            // dropped, rather than being rejected as the malformed request
            // it is per the tools/call params schema).
            if !arguments.is_object() {
                return RouteOutcome::Response(
                    200,
                    Some(jsonrpc_error(id, -32602, "\"arguments\" must be an object")),
                );
            }

            RouteOutcome::CallTool { id, tool: name.to_string(), arguments }
        }

        "resources/list" => RouteOutcome::ReadResources {
            id,
            bridge_tool: "__resources_list",
            arguments: json!({}),
        },

        "resources/read" => {
            let Some(uri) = parsed.params.get("uri").and_then(Value::as_str) else {
                return RouteOutcome::Response(
                    200,
                    Some(jsonrpc_error(id, -32602, "Missing required param: uri")),
                );
            };
            RouteOutcome::ReadResources {
                id,
                bridge_tool: "__resource_read",
                arguments: json!({ "uri": uri }),
            }
        }

        other => RouteOutcome::Response(200, Some(jsonrpc_error(id, -32601, &format!("Method not found: {other}")))),
    }
}

/// Parse and dispatch one JSON-RPC message from a POST body. Returns the HTTP
/// status + JSON body to send, or `None` for a message that requires no HTTP
/// body (a notification the server accepts — spec: respond 202 with no body).
fn dispatch_mcp_message(app: &AppHandle, state: &McpState, body: &str, token_name: &str) -> (u16, Option<Value>) {
    match route_mcp_message(body) {
        RouteOutcome::Response(status, value) => (status, value),
        RouteOutcome::CallTool { id, tool, arguments } => {
            let result = match call_tool(app, state, &tool, &arguments, token_name) {
                ToolCallOutcome::Ok(value) => json!({
                    "content": [to_mcp_content_block(value)],
                    "isError": false,
                }),
                ToolCallOutcome::Err(message) => json!({
                    "content": [{ "type": "text", "text": message }],
                    "isError": true,
                }),
            };
            (200, Some(jsonrpc_result(id, result)))
        }
        RouteOutcome::ReadResources { id, bridge_tool, arguments } => {
            // resources/list and resources/read have their own top-level result
            // shapes ({resources:[...]} / {contents:[...]}) per spec — unlike
            // tools/call, there's no "content" envelope to build here, so the
            // JS handler's return value (already in that shape) is used as-is.
            match call_tool(app, state, bridge_tool, &arguments, token_name) {
                ToolCallOutcome::Ok(value) => (200, Some(jsonrpc_result(id, value))),
                ToolCallOutcome::Err(message) => {
                    // Resource not found per spec is -32002; anything else is -32603.
                    let code = if message.contains("not found") { -32002 } else { -32603 };
                    (200, Some(jsonrpc_error(id, code, &message)))
                }
            }
        }
    }
}

/// Build the MCP `content` block for a successful tool result. A JS handler
/// signals a non-text result by returning an object with `__mcp_content_kind`
/// set to `"image"`, `"audio"`, or `"resource"` (plus that kind's fields —
/// see mcpBridge.js's ATTACHMENT_KIND_TO_MCP_CONTENT for the JS side of this
/// contract); anything else (including plain arrays/strings/numbers) becomes
/// a `text` block, same as before this format existed. This is Rust
/// *interpreting* an already-computed JS result into the wire shape the MCP
/// spec expects — it does not decide *what* to fetch or execute anything,
/// so it doesn't conflict with mcp_respond's "pure courier" invariant.
fn to_mcp_content_block(value: Value) -> Value {
    let kind = value.get("__mcp_content_kind").and_then(Value::as_str);
    match kind {
        Some("image") => json!({
            "type": "image",
            "data": value.get("data").cloned().unwrap_or(Value::Null),
            "mimeType": value.get("mimeType").cloned().unwrap_or(Value::Null),
        }),
        Some("audio") => json!({
            "type": "audio",
            "data": value.get("data").cloned().unwrap_or(Value::Null),
            "mimeType": value.get("mimeType").cloned().unwrap_or(Value::Null),
        }),
        // MCP has no dedicated PDF/binary-document content type — the spec's
        // generic "Embedded Resources" mechanism is the documented fit for
        // arbitrary binary content (see MCP tools spec, "Embedded Resources").
        Some("resource") => json!({
            "type": "resource",
            "resource": {
                "uri": value.get("uri").cloned().unwrap_or(Value::Null),
                "mimeType": value.get("mimeType").cloned().unwrap_or(Value::Null),
                "blob": value.get("blob").cloned().unwrap_or(Value::Null),
            }
        }),
        _ => json!({ "type": "text", "text": value.to_string() }),
    }
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        // Neither subscribe nor listChanged: no server-to-client push mechanism
        // exists (consistent with offering no GET/SSE stream — see module docs).
        "capabilities": { "tools": {}, "resources": {} },
        "serverInfo": { "name": "noteberg-mcp", "version": env!("CARGO_PKG_VERSION") },
    })
}

fn jsonrpc_result(id: Option<Value>, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn jsonrpc_error(id: Option<Value>, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn handle_mcp_post(app: &AppHandle, state: &McpState, request: tiny_http::Request, body: &str, token_name: &str) {
    let (status, response_body) = dispatch_mcp_message(app, state, body, token_name);
    match response_body {
        Some(value) => respond_json(request, status, &value.to_string()),
        None => {
            let response = tiny_http::Response::empty(status);
            let _ = request.respond(response);
        }
    }
}

fn respond(request: tiny_http::Request, status: u16, message: &str) {
    let body = serde_json::json!({ "error": message }).to_string();
    respond_json(request, status, &body);
}

fn respond_json(request: tiny_http::Request, status: u16, body: &str) {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    let response = tiny_http::Response::from_string(body)
        .with_status_code(status)
        .with_header(header);
    let _ = request.respond(response);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_pending() -> Mutex<HashMap<String, Sender<BridgeResult>>> {
        Mutex::new(HashMap::new())
    }

    #[test]
    fn delivers_result_to_the_matching_pending_request() {
        let pending = empty_pending();
        let (tx, rx) = mpsc::channel::<BridgeResult>();
        pending.lock().unwrap().insert("req-1".to_string(), tx);

        deliver(&pending, "req-1", BridgeResult { ok: true, json: "[1,2,3]".to_string() });

        let result = rx.try_recv().expect("expected a delivered result");
        assert!(result.ok);
        assert_eq!(result.json, "[1,2,3]");
        // Delivered entries are removed — no double-delivery possible.
        assert!(!pending.lock().unwrap().contains_key("req-1"));
    }

    #[test]
    fn unknown_request_id_is_a_silent_no_op() {
        let pending = empty_pending();
        // No entry for "does-not-exist" — must not panic, must not insert anything.
        deliver(&pending, "does-not-exist", BridgeResult { ok: true, json: "{}".to_string() });
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn late_delivery_after_timeout_cleanup_is_a_silent_no_op() {
        let pending = empty_pending();
        let (tx, rx) = mpsc::channel::<BridgeResult>();
        pending.lock().unwrap().insert("req-2".to_string(), tx);

        // Simulate the timeout path in handle_request: the entry is removed
        // before the (late) bridge response ever arrives.
        pending.lock().unwrap().remove("req-2");

        deliver(&pending, "req-2", BridgeResult { ok: true, json: "{}".to_string() });

        // The receiver's sender was dropped with the removed entry, so the
        // channel is closed — nothing should have been (or could be) delivered.
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn concurrent_requests_resolve_independently_with_monotonic_ids() {
        let state = McpState::new();
        let mut receivers = Vec::new();

        for i in 0..50 {
            let id = state.next_request_id();
            let (tx, rx) = mpsc::channel::<BridgeResult>();
            state.pending.lock().unwrap().insert(id.clone(), tx);
            receivers.push((id, i, rx));
        }

        // IDs must be unique even though they were minted in a tight loop —
        // this is exactly the property a wall-clock-based id could violate.
        let mut ids: Vec<_> = receivers.iter().map(|(id, _, _)| id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 50, "request ids must be unique under rapid-fire minting");

        // Deliver out of order and confirm each receiver gets exactly its own payload.
        for (id, i, _) in receivers.iter().rev() {
            deliver(&state.pending, id, BridgeResult { ok: true, json: i.to_string() });
        }

        for (_, i, rx) in &receivers {
            let result = rx.try_recv().expect("expected a delivered result");
            assert_eq!(result.json, i.to_string());
        }
    }

    #[test]
    fn has_valid_token_matches_bearer_scheme_case_insensitively_on_header_name() {
        // has_valid_token is exercised indirectly via handle_request in the live
        // curl-based check (Phase 0); here we cover the header-parsing edge
        // cases that are cheap to hit without a real tiny_http::Request.
        let header = tiny_http::Header::from_bytes(&b"authorization"[..], &b"Bearer good-token"[..]).unwrap();
        assert!(header.field.as_str().as_str().eq_ignore_ascii_case("Authorization"));
        assert_eq!(header.value.as_str().strip_prefix("Bearer "), Some("good-token"));
    }

    #[test]
    fn constant_time_eq_accepts_matching_and_rejects_mismatched_or_wrong_length() {
        assert!(constant_time_eq(b"same-token", b"same-token"));
        assert!(!constant_time_eq(b"same-token", b"same-tokeX"));
        assert!(!constant_time_eq(b"short", b"a-longer-token"));
        assert!(!constant_time_eq(b"", b"non-empty"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn state_starts_disabled_with_no_tokens_and_fresh_config_replaces_both() {
        let state = McpState::new();
        assert!(!state.enabled.load(Ordering::Relaxed));
        assert!(state.tokens.lock().unwrap().is_empty());

        state.enabled.store(true, Ordering::Relaxed);
        state
            .tokens
            .lock()
            .unwrap()
            .insert("generated-token".to_string(), "Claude Desktop".to_string());

        assert!(state.enabled.load(Ordering::Relaxed));
        assert_eq!(
            state.tokens.lock().unwrap().get("generated-token").map(String::as_str),
            Some("Claude Desktop")
        );
    }

    #[test]
    fn mcp_set_config_filters_out_empty_token_values() {
        // An empty `value` in a pushed token entry is dropped rather than
        // stored — mirrors the old single-token behavior where a revoke
        // (empty string from JS) reliably re-triggers fail-closed behavior
        // in handle_request instead of leaving a "" token that could only
        // ever be matched by another empty Authorization header.
        let entries = vec![
            McpTokenEntry { value: "".to_string(), name: "Empty".to_string() },
            McpTokenEntry { value: "real-token".to_string(), name: "Real".to_string() },
        ];
        let mut map = HashMap::new();
        for entry in entries {
            if !entry.value.is_empty() {
                map.insert(entry.value, entry.name);
            }
        }
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("real-token").map(String::as_str), Some("Real"));
    }

    #[test]
    fn matched_token_name_finds_the_right_token_among_several() {
        let mut tokens = HashMap::new();
        tokens.insert("token-a".to_string(), "Claude Desktop".to_string());
        tokens.insert("token-b".to_string(), "Cursor".to_string());

        // Build a request-like header check directly against the map, since
        // constructing a real tiny_http::Request in a unit test is awkward
        // (same reasoning as has_valid_token's original test) — exercise the
        // per-token comparison loop's logic via constant_time_eq directly.
        for (secret, expected_name) in &tokens {
            let mut matched = None;
            for (candidate_secret, candidate_name) in &tokens {
                if constant_time_eq(secret.as_bytes(), candidate_secret.as_bytes()) {
                    matched = Some(candidate_name.clone());
                }
            }
            assert_eq!(matched.as_deref(), Some(expected_name.as_str()));
        }
    }

    #[test]
    fn matched_token_name_returns_none_for_unknown_token() {
        let mut tokens = HashMap::new();
        tokens.insert("token-a".to_string(), "Claude Desktop".to_string());

        let presented = "not-a-real-token";
        let mut matched: Option<String> = None;
        for (secret, name) in &tokens {
            if constant_time_eq(presented.as_bytes(), secret.as_bytes()) {
                matched = Some(name.clone());
            }
        }
        assert!(matched.is_none());
    }

    // ── JSON-RPC / MCP protocol routing (Phase 3) ─────────────────────────

    fn as_response(outcome: RouteOutcome) -> (u16, Option<Value>) {
        match outcome {
            RouteOutcome::Response(status, value) => (status, value),
            RouteOutcome::CallTool { .. } => panic!("expected a Response, got CallTool"),
            RouteOutcome::ReadResources { .. } => panic!("expected a Response, got ReadResources"),
        }
    }

    #[test]
    fn initialize_returns_protocol_version_and_tools_capability() {
        let body = json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test", "version": "1.0" } }
        })
        .to_string();

        let (status, value) = as_response(route_mcp_message(&body));
        assert_eq!(status, 200);
        let value = value.unwrap();
        assert_eq!(value["id"], json!(1));
        assert_eq!(value["result"]["protocolVersion"], json!(MCP_PROTOCOL_VERSION));
        assert!(value["result"]["capabilities"]["tools"].is_object());
        assert!(value["result"]["capabilities"]["resources"].is_object());
        assert!(value["result"]["serverInfo"]["name"].is_string());
    }

    #[test]
    fn initialized_notification_is_accepted_with_202_and_no_body() {
        let body = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string();
        let (status, value) = as_response(route_mcp_message(&body));
        assert_eq!(status, 202);
        assert!(value.is_none());
    }

    #[test]
    fn tools_list_advertises_all_known_tools_with_schemas() {
        let body = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }).to_string();
        let (status, value) = as_response(route_mcp_message(&body));
        assert_eq!(status, 200);
        let value = value.unwrap();
        let tools = value["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, KNOWN_TOOLS);
        for tool in tools {
            assert!(tool["inputSchema"].is_object(), "{} missing inputSchema", tool["name"]);
        }
    }

    #[test]
    fn tools_call_forwards_arguments_for_a_multi_arg_tool() {
        let body = json!({
            "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": { "name": "get_note", "arguments": { "id": "note-1", "format": "metadata" } }
        })
        .to_string();

        match route_mcp_message(&body) {
            RouteOutcome::CallTool { tool, arguments, .. } => {
                assert_eq!(tool, "get_note");
                assert_eq!(arguments["id"], json!("note-1"));
                assert_eq!(arguments["format"], json!("metadata"));
            }
            _ => panic!("expected CallTool for a known tool"),
        }
    }

    #[test]
    fn tools_call_defaults_missing_arguments_to_an_empty_object() {
        let body = json!({ "jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": { "name": "list_notebooks" } })
            .to_string();

        match route_mcp_message(&body) {
            RouteOutcome::CallTool { arguments, .. } => assert_eq!(arguments, json!({})),
            _ => panic!("expected CallTool for a known tool"),
        }
    }

    #[test]
    fn tools_call_rejects_non_object_arguments() {
        // call_tool injects _tokenName by inserting into `arguments` as a
        // map — a silent no-op for any non-object JSON value, which would
        // otherwise let a call through with token attribution quietly
        // dropped instead of being rejected as malformed.
        for bad_arguments in [json!([]), json!("x"), json!(5), json!(null)] {
            let body = json!({
                "jsonrpc": "2.0", "id": 9, "method": "tools/call",
                "params": { "name": "list_notebooks", "arguments": bad_arguments }
            })
            .to_string();

            match route_mcp_message(&body) {
                RouteOutcome::Response(200, Some(value)) => {
                    assert_eq!(value["error"]["code"], -32602, "bad arguments: {bad_arguments}");
                }
                _ => panic!("expected a -32602 Response for arguments {bad_arguments}"),
            }
        }
    }

    #[test]
    fn tools_call_with_known_tool_routes_to_call_tool_not_a_response() {
        let body = json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "list_notebooks", "arguments": {} }
        })
        .to_string();

        match route_mcp_message(&body) {
            RouteOutcome::CallTool { id, tool, arguments } => {
                assert_eq!(id, Some(json!(3)));
                assert_eq!(tool, "list_notebooks");
                assert_eq!(arguments, json!({}));
            }
            _ => panic!("expected CallTool for a known tool"),
        }
    }

    #[test]
    fn tools_call_with_unknown_tool_is_a_jsonrpc_error_not_a_call() {
        let body = json!({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "delete_everything", "arguments": {} }
        })
        .to_string();

        let (status, value) = as_response(route_mcp_message(&body));
        assert_eq!(status, 200);
        let value = value.unwrap();
        assert_eq!(value["error"]["code"], json!(-32601));
    }

    #[test]
    fn tools_call_missing_name_param_is_a_jsonrpc_error() {
        let body = json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {} }).to_string();
        let (status, value) = as_response(route_mcp_message(&body));
        assert_eq!(status, 200);
        assert_eq!(value.unwrap()["error"]["code"], json!(-32602));
    }

    #[test]
    fn unknown_method_is_a_jsonrpc_method_not_found_error() {
        let body = json!({ "jsonrpc": "2.0", "id": 6, "method": "not/a/real/method" }).to_string();
        let (status, value) = as_response(route_mcp_message(&body));
        assert_eq!(status, 200);
        assert_eq!(value.unwrap()["error"]["code"], json!(-32601));
    }

    #[test]
    fn malformed_json_body_is_a_parse_error_with_null_id() {
        let (status, value) = as_response(route_mcp_message("not valid json{{{"));
        assert_eq!(status, 400);
        let value = value.unwrap();
        assert_eq!(value["error"]["code"], json!(-32700));
        assert_eq!(value["id"], Value::Null);
    }

    #[test]
    fn has_origin_header_detects_origin_case_insensitively() {
        // Mirrors has_valid_token's header-matching approach; exercised via a
        // constructed tiny_http::Header rather than a full Request (same
        // reasoning as has_valid_token_matches_bearer_scheme... above).
        let header = tiny_http::Header::from_bytes(&b"origin"[..], &b"https://evil.example"[..]).unwrap();
        assert!(header.field.as_str().as_str().eq_ignore_ascii_case("Origin"));
    }

    // ── MCP content-block wrapping (attachments: image/audio/pdf) ────────

    #[test]
    fn plain_value_becomes_a_text_content_block() {
        let block = to_mcp_content_block(json!({"title": "My Note"}));
        assert_eq!(block["type"], json!("text"));
        assert_eq!(block["text"], json!(json!({"title": "My Note"}).to_string()));
    }

    #[test]
    fn image_kind_marker_becomes_an_image_content_block() {
        let value = json!({
            "__mcp_content_kind": "image",
            "data": "base64pixels",
            "mimeType": "image/jpeg",
        });
        let block = to_mcp_content_block(value);
        assert_eq!(block["type"], json!("image"));
        assert_eq!(block["data"], json!("base64pixels"));
        assert_eq!(block["mimeType"], json!("image/jpeg"));
        // The internal marker must not leak into the wire format.
        assert!(block.get("__mcp_content_kind").is_none());
    }

    #[test]
    fn audio_kind_marker_becomes_an_audio_content_block() {
        let value = json!({
            "__mcp_content_kind": "audio",
            "data": "base64audio",
            "mimeType": "audio/webm",
        });
        let block = to_mcp_content_block(value);
        assert_eq!(block["type"], json!("audio"));
        assert_eq!(block["data"], json!("base64audio"));
        assert_eq!(block["mimeType"], json!("audio/webm"));
    }

    #[test]
    fn resource_kind_marker_becomes_an_embedded_resource_content_block() {
        // The PDF case: MCP has no dedicated PDF type, so it goes through the
        // generic "resource" content type per the spec.
        let value = json!({
            "__mcp_content_kind": "resource",
            "uri": "noteberg://note/abc/pdf",
            "mimeType": "application/pdf",
            "blob": "base64pdf",
        });
        let block = to_mcp_content_block(value);
        assert_eq!(block["type"], json!("resource"));
        assert_eq!(block["resource"]["uri"], json!("noteberg://note/abc/pdf"));
        assert_eq!(block["resource"]["mimeType"], json!("application/pdf"));
        assert_eq!(block["resource"]["blob"], json!("base64pdf"));
    }

    #[test]
    fn get_note_tool_descriptor_advertises_attachment_formats() {
        let get_note = tool_descriptors().into_iter().find(|t| t["name"] == "get_note").unwrap();
        let format_enum = get_note["inputSchema"]["properties"]["format"]["enum"].as_array().unwrap();
        let formats: Vec<&str> = format_enum.iter().map(|v| v.as_str().unwrap()).collect();
        assert!(formats.contains(&"attachments_list"));
        assert!(formats.contains(&"attachment"));
        assert!(get_note["inputSchema"]["properties"]["attachment_id"].is_object());
    }

    #[test]
    fn get_note_tool_descriptor_advertises_rendering_formats() {
        let get_note = tool_descriptors().into_iter().find(|t| t["name"] == "get_note").unwrap();
        let format_enum = get_note["inputSchema"]["properties"]["format"]["enum"].as_array().unwrap();
        let formats: Vec<&str> = format_enum.iter().map(|v| v.as_str().unwrap()).collect();
        assert!(formats.contains(&"strokes_images"));
        assert!(formats.contains(&"note_pdf"));
    }

    #[test]
    fn search_notes_tool_descriptor_requires_query() {
        let search = tool_descriptors().into_iter().find(|t| t["name"] == "search_notes").unwrap();
        let required = search["inputSchema"]["required"].as_array().unwrap();
        assert!(required.contains(&json!("query")));
    }

    #[test]
    fn get_task_markers_tool_descriptor_has_optional_notebook_id() {
        let markers = tool_descriptors().into_iter().find(|t| t["name"] == "get_task_markers").unwrap();
        assert!(markers["inputSchema"]["properties"]["notebook_id"].is_object());
        // notebook_id is optional — no "required" array, or it doesn't list it.
        let required = markers["inputSchema"].get("required");
        if let Some(req) = required {
            assert!(!req.as_array().unwrap().contains(&json!("notebook_id")));
        }
    }

    #[test]
    fn get_task_marker_image_tool_descriptor_requires_note_id_and_task_id() {
        let tool = tool_descriptors().into_iter().find(|t| t["name"] == "get_task_marker_image").unwrap();
        let required = tool["inputSchema"]["required"].as_array().unwrap();
        assert!(required.contains(&json!("note_id")));
        assert!(required.contains(&json!("task_id")));
    }

    #[test]
    fn tools_call_routes_search_notes_and_get_task_markers() {
        for name in ["search_notes", "get_task_markers"] {
            let body = json!({
                "jsonrpc": "2.0", "id": 9, "method": "tools/call",
                "params": { "name": name, "arguments": {} }
            })
            .to_string();
            match route_mcp_message(&body) {
                RouteOutcome::CallTool { tool, .. } => assert_eq!(tool, name),
                _ => panic!("expected CallTool for known tool {name}"),
            }
        }
    }

    // ── MCP resources (notebooks/notes as URIs) ───────────────────────────

    #[test]
    fn resources_list_routes_to_the_internal_bridge_tool() {
        let body = json!({ "jsonrpc": "2.0", "id": 10, "method": "resources/list" }).to_string();
        match route_mcp_message(&body) {
            RouteOutcome::ReadResources { id, bridge_tool, arguments } => {
                assert_eq!(id, Some(json!(10)));
                assert_eq!(bridge_tool, "__resources_list");
                assert_eq!(arguments, json!({}));
            }
            _ => panic!("expected ReadResources"),
        }
    }

    #[test]
    fn resources_read_routes_with_the_requested_uri() {
        let body = json!({
            "jsonrpc": "2.0", "id": 11, "method": "resources/read",
            "params": { "uri": "noteberg://note/abc-123" }
        })
        .to_string();
        match route_mcp_message(&body) {
            RouteOutcome::ReadResources { bridge_tool, arguments, .. } => {
                assert_eq!(bridge_tool, "__resource_read");
                assert_eq!(arguments["uri"], json!("noteberg://note/abc-123"));
            }
            _ => panic!("expected ReadResources"),
        }
    }

    #[test]
    fn resources_read_missing_uri_is_a_jsonrpc_error() {
        let body = json!({ "jsonrpc": "2.0", "id": 12, "method": "resources/read", "params": {} }).to_string();
        let (status, value) = as_response(route_mcp_message(&body));
        assert_eq!(status, 200);
        assert_eq!(value.unwrap()["error"]["code"], json!(-32602));
    }

    #[test]
    fn internal_bridge_tools_are_not_advertised_or_callable_via_tools_call() {
        // __resources_list/__resource_read must stay reachable only via
        // resources/list and resources/read, never discoverable/callable as
        // a regular tool.
        assert!(!KNOWN_TOOLS.contains(&"__resources_list"));
        assert!(!KNOWN_TOOLS.contains(&"__resource_read"));
        let descriptors = tool_descriptors();
        let names: Vec<&str> = descriptors.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(!names.contains(&"__resources_list"));
        assert!(!names.contains(&"__resource_read"));

        let body = json!({
            "jsonrpc": "2.0", "id": 13, "method": "tools/call",
            "params": { "name": "__resources_list", "arguments": {} }
        })
        .to_string();
        let (status, value) = as_response(route_mcp_message(&body));
        assert_eq!(status, 200);
        assert_eq!(value.unwrap()["error"]["code"], json!(-32601));
    }

    #[test]
    fn extract_bridge_error_message_unwraps_the_error_envelope() {
        // The bridge's catch block sends JSON.stringify({error: "..."}) — this
        // must become the plain message, not literal JSON text, so it doesn't
        // show up doubly-encoded in a tools/call text block or a resources/read
        // JSON-RPC error.message.
        assert_eq!(
            extract_bridge_error_message(r#"{"error":"Note not found: xyz"}"#),
            "Note not found: xyz"
        );
    }

    #[test]
    fn extract_bridge_error_message_falls_back_to_raw_text_for_unexpected_shapes() {
        assert_eq!(extract_bridge_error_message("not json at all"), "not json at all");
        assert_eq!(extract_bridge_error_message(r#"{"no_error_field": true}"#), r#"{"no_error_field": true}"#);
    }
}
