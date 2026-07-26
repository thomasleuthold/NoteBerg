# MCP Server (AI Integration)

NoteBerg can expose your notebooks to AI assistants (Claude Desktop, and any other [Model Context Protocol](https://modelcontextprotocol.io/) client) over a local, token-protected connection. This lets an AI assistant read your notebook list as context for a conversation — for example, "what notebooks do I have?" or using a notebook name to find the right notes to talk about.

> **Status: early / read-only.** Notebooks and notes can be listed and searched, task markers can be listed, and a note's content can be read in several formats (typed text, recognized handwriting, raw strokes, attached images/audio/PDF, a rendered handwriting image, or a full PDF export). Notebooks and notes are also browsable as MCP resources. Any write actions (adding notes, images, strokes) are not implemented yet. See [Current limitations](#current-limitations) below.

> **Windows only.** The MCP server is part of the NoteBerg desktop app on Windows. It is not available in the Android app or the Nextcloud app.

## What this is (and isn't)

- The MCP server runs **inside the NoteBerg desktop app**, only while NoteBerg is open. It is **off by default** — you must explicitly enable it and generate an access token.
- It listens only on `127.0.0.1` (your own machine) — it is never reachable from the network or the internet.
- It does not send any of your data anywhere on its own. It only answers requests from an MCP client that you've configured with a token you generated.
- **You can create multiple named tokens** — one per MCP client (e.g. one for Claude Desktop, one for a work laptop) — so you can tell them apart in the access log and revoke one without affecting the others.
- A small blue **"MCP"** badge appears in the app's footer, next to the sync status, whenever the server is enabled and actually running. It briefly flashes green on real MCP traffic (a tool call from a connected client), so you can see at a glance when an AI assistant is actively reading your notes.
- For the technical design and security rationale (why no TLS is needed on a loopback connection, why the token is the real security boundary, how the connection reaches into the app), see [documentation/roadmap/mcp/DESIGN.md](roadmap/mcp/DESIGN.md).

## 1. Enable the MCP server in NoteBerg

1. Open NoteBerg (Windows desktop app).
2. Go to **Settings → MCP Server (AI Integration)** (this section appears right after "Handwriting Recognition").
3. Toggle **Enable MCP server** on.
4. Click **Generate new token**, give it a name (e.g. "Claude Desktop") so you can recognize it later, and confirm. The token is shown only this once — NoteBerg tries to copy it to your clipboard automatically, and there's also a **Copy** button next to it if that fails or you need to copy it again. Save it somewhere safe (e.g. a password manager) before closing the dialog. If you lose it, revoke it and generate a new one.
5. Each token you generate gets its own row under **Access tokens**, with its own **Revoke** button — revoking one token has no effect on any other token you've generated.

The server listens on `http://127.0.0.1:8765/mcp`.

If the footer's "MCP" badge doesn't appear after enabling, or the **Status** line in Settings shows a warning that the server didn't start correctly this session, click **Retry** next to that warning — this recovers from a one-off startup hiccup without needing to restart the app.

## 2. Connect an MCP client

### Prerequisites

- **NoteBerg must be running** with the MCP server enabled (step 1). The server only exists while the app is open.
- **[Node.js](https://nodejs.org/)** (which includes `npx`) installed on your machine. Most MCP clients — including Claude Desktop below — don't talk to a local HTTP server directly; they connect to a small bridge process that Node runs on the fly. Check you have it with:
  ```
  node --version
  npx --version
  ```

### Why a bridge process is needed

MCP defines two ways for a client to connect to a server: spawning it as a subprocess (`stdio`), or connecting to an already-running server over HTTP (`Streamable HTTP`). NoteBerg's server is the second kind — it's already running inside the app, not something a client spawns itself.

Some MCP clients (e.g. Cursor) can connect to a Streamable HTTP URL directly. **Claude Desktop's configuration file currently only supports the `stdio` (spawn-a-subprocess) style** — it does not support pointing directly at a URL. This isn't specific to NoteBerg: it's the same situation faced by other tools that expose MCP from inside a long-running app (for example, [Blender's MCP integration](https://github.com/ahujasid/blender-mcp) uses the identical pattern). The standard solution is a small bridge tool, [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), which Claude Desktop spawns via `stdio`, and which then speaks Streamable HTTP to NoteBerg's server on your behalf.

### Configure Claude Desktop

1. Open Claude Desktop's config file:
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

   (You can also get here via Claude Desktop's menu: **File → Settings → Developer → Edit Config**.)

2. Add a `noteberg` entry under `mcpServers`, replacing `<YOUR_TOKEN>` with the token you generated in step 1:

   ```json
   {
     "mcpServers": {
       "noteberg": {
         "command": "cmd",
         "args": [
           "/c",
           "npx",
           "-y",
           "mcp-remote",
           "http://127.0.0.1:8765/mcp",
           "--header",
           "Authorization:Bearer ${NOTEBERG_MCP_TOKEN}",
           "--allow-http"
         ],
         "env": {
           "NOTEBERG_MCP_TOKEN": "<YOUR_TOKEN>"
         }
       }
     }
   }
   ```

   If you already have other entries under `mcpServers`, just add `"noteberg": { ... }` alongside them — don't replace the whole file.

   > **Windows note:** the `"command": "cmd", "args": ["/c", "npx", ...]` wrapper is required. Using `"command": "npx"` directly fails on Windows with an error like `"C:\Program" is not recognized` — this is a [known issue](https://github.com/modelcontextprotocol/servers/issues/3460) where Windows can't directly spawn the `npx.cmd` shim, unrelated to NoteBerg. `cmd /c` works around it.
   >
   > **macOS/Linux:** use `"command": "npx"` directly (no `cmd /c` wrapper needed) — `"args"` starts straight at `"-y"`.

3. Make sure NoteBerg is running with the MCP server enabled (step 1), then **fully quit and restart Claude Desktop** (not just close the window — use the tray/menu bar icon to quit, since Claude Desktop keeps running in the background).

4. On first launch, Claude Desktop will download the `mcp-remote` package via `npx` — this needs internet access once and may take a few seconds. After that it's cached locally.

5. Ask Claude something like *"What NoteBerg notebooks do I have?"* — it should call the `list_notebooks` tool and show your notebooks.

### Troubleshooting

If Claude Desktop shows **"Server disconnected"**:

1. Confirm NoteBerg is running and the MCP server is enabled (Settings → MCP Server), and that the Status line doesn't show a "didn't start correctly" warning (see [Enable the MCP server](#1-enable-the-mcp-server-in-noteberg) above).
2. Confirm the token in the config matches one that's still listed under **Access tokens** in NoteBerg's Settings — revoking a token immediately breaks any client still using it.
3. Check Claude Desktop's logs for the actual error:
   - **Windows**: `%APPDATA%\Claude\logs\mcp-server-noteberg.log`
   - **macOS**: `~/Library/Logs/Claude/mcp-server-noteberg.log`
4. Test the server directly, independent of Claude Desktop, from a terminal (replace `<YOUR_TOKEN>`):
   ```bash
   curl -X POST -H "Authorization: Bearer <YOUR_TOKEN>" -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
     http://127.0.0.1:8765/mcp
   ```
   A successful response looks like `{"id":1,"jsonrpc":"2.0","result":{"protocolVersion":"2025-06-18",...}}`. If this fails, the problem is on the NoteBerg side (server disabled, wrong token, app not running) rather than in Claude Desktop's configuration.

If asking Claude to fetch a note's **PDF** (`get_note` with `format: "note_pdf"`) fails with something like `content.0.image.source.media_type: Input is not one of the permitted values`, see [Known issue: `note_pdf` may fail in Claude Desktop](#known-issue-note_pdf-may-fail-in-claude-desktop) below — this is not a NoteBerg server bug.

If Claude shows the literal text `[image]` instead of a picture when asked to view a note's handwriting or a task marker's image, see [Known issue: images may show as `[image]` placeholder text in Claude Desktop](#known-issue-images-may-show-as-image-placeholder-text-in-claude-desktop) below — also not a NoteBerg server bug.

## What an AI assistant can see and do

Once connected, an MCP client can call these tools (all read-only today):

| Tool | What it does |
|---|---|
| `list_notebooks` | Lists your notebooks (title, description, color, timestamps, note count, most recently edited note). |
| `list_notes` | Lists notes in one notebook, or across all of them (title, tags, timestamps, whether the note has handwriting/typed text/recognized text, and its attachments). |
| `get_note` | Reads one note's content — you (or the AI) choose the format: metadata only, typed text as HTML, recognized handwriting text, recognized words with positions, raw pen strokes, a rendered image of just the handwriting, a full PDF export, a list of attachments, or one specific attachment (image/audio/PDF). |
| `search_notes` | Searches typed text, recognized handwriting, and extracted PDF text across all notes (supports `*`/`?` wildcards). |
| `get_task_markers` | Lists checkbox/task items across notes (checked state, a best-effort text label, which note and notebook it's in). |
| `get_task_marker_image` | Renders one unresolved handwritten task as an image, when automatic handwriting recognition couldn't produce readable text for it. |

Notebooks and notes are also browsable as MCP **resources**, a lighter-weight index a client can attach as background context without an explicit tool call.

Nothing here can modify, delete, or create anything in NoteBerg — every one of these is a read. See [Current limitations](#current-limitations) below for what's planned but not yet built.

## Reviewing MCP access

Settings → MCP Server also has an **access log**, on by default, recording every request made through the MCP connection: which tool was called, its arguments, which named token made the call, success/failure, and how long it took. This is separate from the general debug logs elsewhere in Settings, and clearing those doesn't affect it.

- **View access log** opens a paginated table of recorded activity.
- **Clear access log** permanently deletes the recorded history (separate action from turning logging off).
- The log is capped at 15,000 entries — oldest entries are dropped automatically once the cap is reached, so it can't grow without bound.
- Using **Purge Local Data** (Settings → Danger Zone) also clears the MCP access log, since it's meant to wipe all local data, not just notes.
- You can turn logging off entirely with the **Log MCP access** toggle, though leaving it on is recommended — it's the only visibility you have into what an AI client has actually accessed.

## Known issue: `note_pdf` may fail in Claude Desktop

NoteBerg's server correctly returns a note's PDF export as a spec-compliant MCP **embedded resource** content block (`{type:"resource", resource:{uri, mimeType:"application/pdf", blob}}}` — this was verified directly against the running server). Claude Desktop's (and/or the `mcp-remote` bridge's) support for this MCP content type is currently immature — it can silently drop the block, or in some cases mis-forward it as if it were meant to be an `image` block, which then fails because `application/pdf` isn't a valid image type. This is a documented gap in the current MCP client ecosystem, not specific to NoteBerg:

- [Claude Desktop does not surface MCP `EmbeddedResource` blocks as artifacts (anthropics/claude-ai-mcp#287)](https://github.com/anthropics/claude-ai-mcp/issues/287)
- [Returning an `EmbeddedResourceBlock` from a tool does not work with Claude Desktop (modelcontextprotocol/csharp-sdk#1261)](https://github.com/modelcontextprotocol/csharp-sdk/issues/1261)

There is no fully reliable workaround from the server side today — see the next section, since plain `image` blocks can hit a related client-side gap too.

## Known issue: images may show as `[image]` placeholder text in Claude Desktop

Formats that return a handwriting image (`get_note` with `format: "strokes_images"`, and `get_task_marker_image`) correctly send a spec-compliant MCP **image** content block (`{type:"image", mimeType:"image/png", data:"<base64>"}}` — verified directly against the running server, and confirmed in Claude Desktop's own log that the bridge received and forwarded exactly one correctly-shaped block). Despite that, Claude Desktop's tool-result handling has been observed to display the literal text `[image]` instead of rendering the picture. This is a known, independently-documented gap in Claude Desktop/claude.ai's own MCP image handling, not something specific to NoteBerg or fixable by changing the server's response shape:

- [MCP `ImageContent` returned as text in tool results instead of native image blocks (anthropics/claude-code#31208)](https://github.com/anthropics/claude-code/issues/31208)
- [Image content blocks from tool results not rendered inline (anthropics/claude-ai-mcp#238)](https://github.com/anthropics/claude-ai-mcp/issues/238)

If this happens, there isn't a reliable client-side workaround today beyond retrying (behavior has been inconsistent) or using an MCP client whose image-content handling is more mature.

## Current limitations

- **Read-only.** Notebooks/notes can be listed, searched, and read (multiple formats, see `get_note`'s `format` parameter); task markers can be listed. Any write actions (adding notes, images, strokes) are planned but not yet implemented.
- **`note_pdf` may not work in Claude Desktop today**, and **image results (`strokes_images`, `get_task_marker_image`) may show as `[image]` placeholder text instead of rendering** — see the two Known issues above. Both are confirmed client-side gaps, not NoteBerg server bugs.
- **The `recording` kind of `get_note`'s `attachment`/`attachments_list` formats has an unreliable MIME type** — the audio bytes are valid, but the reported format label may be wrong, which can make a client reject or mishandle it. Images and PDFs are unaffected.
- **The access log only records tool calls made with a valid token — not rejected connection attempts** (wrong token, or a request that arrives while the server is disabled). A rejected attempt is refused before it ever reaches the log — it doesn't leak any data, but it also currently leaves no trace to review.
- **Windows only**, and only while the NoteBerg desktop app is running.
- **No macOS/Linux desktop support yet** — the underlying design allows for it later, but it isn't built.
- The `mcp-remote` bridge is a third-party community package, not something NoteBerg publishes or controls. It's the same pattern other long-running-app MCP integrations use (e.g. Blender's), but if this feature matures, NoteBerg may eventually publish its own small bridge instead.

For the full design rationale, security model, and phased implementation plan, see [documentation/roadmap/mcp/DESIGN.md](roadmap/mcp/DESIGN.md) and [documentation/roadmap/mcp/PLAN.md](roadmap/mcp/PLAN.md).
