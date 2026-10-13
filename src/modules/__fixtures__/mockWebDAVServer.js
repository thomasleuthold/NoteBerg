/**
 * src/modules/__fixtures__/mockWebDAVServer.js
 * Reusable, high-fidelity stateful WebDAV mock server for Nextcloud sync tests.
 *
 * Drive it via `fetch.mockImplementation((url, options) => server.handleRequest(url, options))`
 * after `vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }))`.
 */

// Virtual path prefix under which chunked-upload sessions are stored. Not a
// real WebDAV path — see _parseUrl.
const UPLOADS_PREFIX = "/__uploads__";

const OCS_USER_PATH = "/ocs/v2.php/cloud/user";

export class MockWebDAVServer {
  /**
   * @param {object} [account]
   * @param {string} [account.loginName] - what the user types at login; accepted by Basic auth
   * @param {string} [account.userId] - Nextcloud's internal user ID; the only name valid in
   *   DAV paths. Differs from loginName on LDAP/AD (UUIDs) and for email/alias logins.
   */
  constructor({ loginName = "testuser", userId = loginName } = {}) {
    this.files = new Map(); // path -> { content, etag, mtime, isCollection, locked }
    this.baseUrl = "https://cloud.example.com";
    this.loginName = loginName;
    this.userId = userId;
    this.rootPath = `/remote.php/dav/files/${encodeURIComponent(userId)}`;

    this._etagCounter = 0;
    this.requests = [];
    this._failNextQueue = []; // [{ method, pathMatch, status, retryAfter, throws }]
    this._failEveryRules = []; // same shape, applied to every matching request
    this._rejectDepthInfinity = false;

    this.files.set("/", { isCollection: true, mtime: new Date() });
    this.files.set("/NoteBerg", { isCollection: true, mtime: new Date() });
    // Nextcloud provisions the per-user chunked-upload root automatically, so
    // clients MKCOL only the session directory beneath it.
    this.files.set(UPLOADS_PREFIX, { isCollection: true, mtime: new Date() });
  }

  reset() {
    this.files.clear();
    this._etagCounter = 0;
    this.requests = [];
    this._failNextQueue = [];
    this._failEveryRules = [];
    this._rejectDepthInfinity = false;
    this.files.set("/", { isCollection: true, mtime: new Date() });
    this.files.set("/NoteBerg", { isCollection: true, mtime: new Date() });
    // Nextcloud provisions the per-user chunked-upload root automatically, so
    // clients MKCOL only the session directory beneath it.
    this.files.set(UPLOADS_PREFIX, { isCollection: true, mtime: new Date() });
  }

  // --- Seed DSL ---

  seedNotebook(id, { title = id, modified = Date.now(), etag, ...rest } = {}) {
    this.files.set(`/NoteBerg/notebooks/${id}`, { isCollection: true, mtime: new Date() });
    this.files.set(`/NoteBerg/notebooks/${id}/notes`, { isCollection: true, mtime: new Date() });
    this.files.set(`/NoteBerg/notebooks/${id}/_notebook.json`, {
      content: JSON.stringify({ id, title, modified, ...rest }),
      etag: etag ?? this._generateEtag(),
      mtime: new Date(modified),
    });
    return this;
  }

  seedNote(notebookId, note, { etag, mtime } = {}) {
    const dir = notebookId ? `/NoteBerg/notebooks/${notebookId}/notes` : "/NoteBerg/quickNotes";
    if (notebookId) {
      this.files.set(`/NoteBerg/notebooks/${notebookId}`, {
        isCollection: true,
        mtime: new Date(),
      });
      this.files.set(dir, { isCollection: true, mtime: new Date() });
    } else if (!this.files.has(dir)) {
      this.files.set(dir, { isCollection: true, mtime: new Date() });
    }
    this.files.set(`${dir}/${note.id}.json`, {
      content: JSON.stringify(note),
      etag: etag ?? this._generateEtag(),
      mtime: mtime ?? new Date(note.modified ?? Date.now()),
    });
    return this;
  }

  seedQuickNote(note, opts = {}) {
    return this.seedNote(null, note, opts);
  }

  seedTombstone(notebookId, tombstone, { etag } = {}) {
    const path = notebookId
      ? `/NoteBerg/notebooks/${notebookId}/_tombstones.json`
      : "/NoteBerg/notebooks/_tombstones.json";
    this.files.set(path, {
      content: JSON.stringify(tombstone),
      etag: etag ?? this._generateEtag(),
      mtime: new Date(),
    });
    return this;
  }

  seedMedia(notebookId, noteId, fileId, { content = "data", etag } = {}) {
    const dir = `/NoteBerg/notebooks/${notebookId}/notes/${noteId}_media`;
    if (!this.files.has(dir)) this.files.set(dir, { isCollection: true, mtime: new Date() });
    this.files.set(`${dir}/${fileId}.bin`, {
      content,
      etag: etag ?? this._generateEtag(),
      mtime: new Date(),
    });
    return this;
  }

  // --- Fault injection ---

  /** Fail the next request matching { method, pathMatch } with the given status (once). */
  failNext({ method, pathMatch, status = 500, retryAfter, throws } = {}) {
    this._failNextQueue.push({ method, pathMatch, status, retryAfter, throws });
    return this;
  }

  /** Fail every request matching { method, pathMatch } until cleared. */
  failEvery({ method, pathMatch, status = 500, retryAfter, throws } = {}) {
    this._failEveryRules.push({ method, pathMatch, status, retryAfter, throws });
    return this;
  }

  clearFaults() {
    this._failNextQueue = [];
    this._failEveryRules = [];
  }

  /** Reject PROPFIND Depth: infinity with 400, forcing the per-folder fallback walk. */
  rejectDepthInfinity(value = true) {
    this._rejectDepthInfinity = value;
    return this;
  }

  _matchesRule(rule, method, path) {
    if (rule.method && rule.method !== method) return false;
    if (rule.pathMatch) {
      if (rule.pathMatch instanceof RegExp) {
        if (!rule.pathMatch.test(path)) return false;
      } else if (!path.includes(rule.pathMatch)) {
        return false;
      }
    }
    return true;
  }

  _applyFaults(method, path) {
    for (let i = 0; i < this._failNextQueue.length; i++) {
      const rule = this._failNextQueue[i];
      if (this._matchesRule(rule, method, path)) {
        this._failNextQueue.splice(i, 1);
        return rule;
      }
    }
    for (const rule of this._failEveryRules) {
      if (this._matchesRule(rule, method, path)) return rule;
    }
    return null;
  }

  _faultResponse(rule) {
    if (rule.throws) {
      throw new Error(rule.throws === true ? "Network error" : rule.throws);
    }
    const headers = {};
    if (rule.retryAfter != null) headers["retry-after"] = String(rule.retryAfter);
    return {
      ok: false,
      status: rule.status,
      statusText: `Injected ${rule.status}`,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: async () => "",
    };
  }

  // --- Internals ---

  /**
   * Split a request URL into the stored path and the DAV principal it names.
   * `principal` is null for non-DAV endpoints (OCS).
   */
  _parseUrl(url) {
    const pathname = (url.startsWith(this.baseUrl) ? url.slice(this.baseUrl.length) : url).split(
      "?",
    )[0];
    const dav = pathname.match(/^\/remote\.php\/dav\/(files|uploads)\/([^/]+)(\/.*)?$/);
    if (!dav) return { path: decodeURIComponent(pathname), principal: null };

    const [, root, principal, rest = ""] = dav;
    let path = decodeURIComponent(rest);
    // Chunked uploads live under a sibling DAV root (/uploads/{user}) rather
    // than /files/{user}. Map it to a reserved virtual prefix so the session
    // directory and its chunks are stored in the same Map without ever
    // colliding with a real note path.
    if (root === "uploads") path = `${UPLOADS_PREFIX}${path}`;
    else if (path === "") path = "/";
    return { path, principal: decodeURIComponent(principal) };
  }

  /** Basic auth accepts the login name (and, like Nextcloud, the user ID). */
  _authenticates(authorization) {
    if (!authorization?.startsWith("Basic ")) return false;
    const bytes = Uint8Array.from(atob(authorization.slice(6)), (c) => c.charCodeAt(0));
    const user = new TextDecoder().decode(bytes).split(":")[0];
    return user === this.loginName || user === this.userId;
  }

  _ocsUser(method) {
    if (method !== "GET") return { ok: false, status: 405, statusText: "Method Not Allowed" };
    const body = {
      ocs: {
        meta: { status: "ok", statuscode: 200, message: "OK" },
        data: { id: this.userId, "display-name": this.loginName },
      },
    };
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  _generateEtag() {
    this._etagCounter += 1;
    return `etag-seed-${this._etagCounter}`;
  }

  async handleRequest(url, options) {
    const method = options.method || "GET";
    const { path, principal } = this._parseUrl(url);
    const headers = options.headers || {};

    this.requests.push({ method, path, headers: { ...headers } });

    if (!this._authenticates(headers.Authorization)) {
      return { ok: false, status: 401, statusText: "Unauthorized", text: async () => "" };
    }

    const fault = this._applyFaults(method, path);
    if (fault) return this._faultResponse(fault);

    if (path === OCS_USER_PATH) return this._ocsUser(method);

    // A DAV root named after anything but the user ID does not exist. Nextcloud
    // logs "Principal ... not found" and answers writes with 409 (their parent
    // node is missing) and reads with 404 — the LDAP/email-login failure mode.
    const destinationPrincipal = headers.Destination
      ? this._parseUrl(headers.Destination).principal
      : null;
    if (
      (principal !== null && principal !== this.userId) ||
      (destinationPrincipal !== null && destinationPrincipal !== this.userId)
    ) {
      const isWrite = method === "MKCOL" || method === "PUT" || method === "MOVE";
      return isWrite
        ? { ok: false, status: 409, statusText: "Conflict", text: async () => "" }
        : { ok: false, status: 404, statusText: "Not Found", text: async () => "" };
    }

    if (method === "MKCOL") {
      if (this.files.has(path)) return { ok: false, status: 405, statusText: "Method Not Allowed" };
      const parent = path.substring(0, path.lastIndexOf("/")) || "/";
      if (!this.files.has(parent)) return { ok: false, status: 409, statusText: "Conflict" };

      this.files.set(path, { isCollection: true, mtime: new Date(), etag: this._generateEtag() });
      return { ok: true, status: 201, statusText: "Created" };
    }

    if (method === "PUT") {
      const ifMatch = headers["If-Match"];
      const ifNoneMatch = headers["If-None-Match"];
      const existing = this.files.get(path);

      if (existing?.locked) {
        return { ok: false, status: 423, statusText: "Locked", text: async () => "" };
      }

      // Real WebDAV rejects a PUT whose parent collection is missing with 409
      // Conflict (same as MKCOL). The normal sync path creates the folder chain
      // first (ensureHierarchicalStructure + createFolder), so faithful clients
      // never hit this — but an orphaned upload (e.g. a note whose notebook was
      // purged on another device) must fail here rather than silently
      // resurrecting the parent folder.
      if (!existing) {
        const parent = path.substring(0, path.lastIndexOf("/")) || "/";
        if (!this.files.has(parent)) {
          return { ok: false, status: 409, statusText: "Conflict", text: async () => "" };
        }
      }

      // The &quot; entity-encoding only exists in PROPFIND XML serialization;
      // a real server compares If-Match against the bare etag.
      const bareEtag = (e) => e?.replace(/&quot;/g, "").replace(/"/g, "");
      if (ifMatch && (!existing || bareEtag(existing.etag) !== bareEtag(ifMatch))) {
        return { ok: false, status: 412, statusText: "Precondition Failed", text: async () => "" };
      }
      if (ifNoneMatch === "*" && existing) {
        return { ok: false, status: 412, statusText: "Precondition Failed", text: async () => "" };
      }

      if (this._quotaExceeded) {
        return { ok: false, status: 507, statusText: "Insufficient Storage", text: async () => "" };
      }

      // Bodies arrive as strings (JSON) or Blobs (media, incl. upload chunks).
      // Blobs are read to text so stored content is comparable and chunked
      // uploads can be reassembled by plain concatenation on MOVE.
      const content =
        typeof Blob !== "undefined" && options.body instanceof Blob
          ? await options.body.text()
          : options.body;
      const etag = this._generateEtag();
      this.files.set(path, {
        isCollection: false,
        content,
        mtime: new Date(),
        etag,
      });

      return {
        ok: true,
        status: existing ? 204 : 201,
        headers: { get: (name) => (name.toLowerCase() === "etag" ? `"${etag}"` : null) },
        text: async () => "",
      };
    }

    if (method === "GET") {
      const file = this.files.get(path);
      if (!file) return { ok: false, status: 404, statusText: "Not Found" };
      if (file.isCollection) return { ok: false, status: 405, statusText: "Is Collection" };
      // Real servers always have an etag for an existing file — lazily assign
      // one for files seeded without it so If-Match round-trips work.
      if (!file.etag) file.etag = this._generateEtag();

      // A real Response exposes the whole body-reading surface, and a real
      // WebDAV GET always carries Content-Length — the sync's in-flight memory
      // budget reads that header to size large media downloads.
      const bodyBytes = new TextEncoder().encode(file.content);
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) => {
            const key = name.toLowerCase();
            if (key === "etag") return `"${file.etag}"`;
            if (key === "content-length") return String(bodyBytes.byteLength);
            return null;
          },
        },
        text: async () => file.content,
        arrayBuffer: async () => bodyBytes.buffer,
        blob: async () => new Blob([bodyBytes]),
        json: async () => JSON.parse(file.content),
      };
    }

    if (method === "DELETE") {
      if (!this.files.has(path)) return { ok: false, status: 404, statusText: "Not Found" };

      for (const key of this.files.keys()) {
        if (key.startsWith(`${path}/`) || key === path) {
          this.files.delete(key);
        }
      }
      return { ok: true, status: 204, statusText: "No Content" };
    }

    if (method === "PROPFIND") {
      if (!this.files.has(path)) return { ok: false, status: 404, statusText: "Not Found" };

      const depth = headers.Depth || "1";
      if (depth === "infinity" && this._rejectDepthInfinity) {
        return { ok: false, status: 400, statusText: "Bad Request", text: async () => "" };
      }

      const file = this.files.get(path);
      let xml = '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">';

      const addItem = (p, f) => {
        const href = this.rootPath + p.split("/").map(encodeURIComponent).join("/");
        const mtime = f.mtime instanceof Date ? f.mtime : new Date();
        const type = f.isCollection ? "<d:collection/>" : "";
        xml += `
          <d:response>
            <d:href>${href}</d:href>
            <d:propstat>
              <d:prop>
                <d:getlastmodified>${mtime.toUTCString()}</d:getlastmodified>
                <d:getetag>"${f.etag || ""}"</d:getetag>
                <d:resourcetype>${type}</d:resourcetype>
              </d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>`;
      };

      addItem(path, file);

      if (file.isCollection && depth !== "0") {
        // Scope strictly to descendants of THIS collection. Comparing with a
        // trailing slash prevents a prefix-sibling leak: a PROPFIND of
        // `/notebooks/nb1` must not return `/notebooks/nb10`'s subtree just
        // because the string starts with "nb1". Real servers scope by path
        // segment, not by raw string prefix.
        const prefix = path.endsWith("/") ? path : `${path}/`;
        for (const [childPath, childFile] of this.files.entries()) {
          if (childPath !== path && childPath.startsWith(prefix)) {
            const relative = childPath.substring(prefix.length);
            const isDirectChild = relative.indexOf("/") === -1;

            if (depth === "infinity" || isDirectChild) {
              addItem(childPath, childFile);
            }
          }
        }
      }

      xml += "</d:multistatus>";
      return { ok: true, status: 207, text: async () => xml };
    }

    // Assembles a chunked upload: MOVE {session}/.file -> Destination.
    // Chunks are concatenated in numeric order, matching how Nextcloud stitches
    // them, so a test can assert the reassembled body equals the original.
    if (method === "MOVE") {
      const destination = headers.Destination;
      if (!destination) return { ok: false, status: 400, statusText: "Bad Request" };
      const destPath = this._parseUrl(destination).path;

      if (!path.startsWith(`${UPLOADS_PREFIX}/`) || !path.endsWith("/.file")) {
        return { ok: false, status: 501, statusText: "Not Implemented" };
      }

      const sessionPath = path.substring(0, path.length - "/.file".length);
      if (!this.files.has(sessionPath)) {
        return { ok: false, status: 404, statusText: "Not Found", text: async () => "" };
      }

      const destParent = destPath.substring(0, destPath.lastIndexOf("/")) || "/";
      if (!this.files.has(destParent)) {
        return { ok: false, status: 409, statusText: "Conflict", text: async () => "" };
      }

      const chunkPrefix = `${sessionPath}/`;
      const chunks = [];
      for (const [chunkPath, chunkFile] of this.files.entries()) {
        if (chunkPath.startsWith(chunkPrefix) && !chunkFile.isCollection) {
          const name = chunkPath.substring(chunkPrefix.length);
          if (/^\d+$/.test(name)) chunks.push({ index: Number(name), content: chunkFile.content });
        }
      }
      chunks.sort((a, b) => a.index - b.index);

      const existing = this.files.get(destPath);
      const etag = this._generateEtag();
      this.files.set(destPath, {
        isCollection: false,
        content: chunks.map((c) => c.content).join(""),
        mtime: new Date(),
        etag,
      });

      // The session directory is consumed by the assembly.
      for (const key of [...this.files.keys()]) {
        if (key === sessionPath || key.startsWith(chunkPrefix)) this.files.delete(key);
      }

      return {
        ok: true,
        status: existing ? 204 : 201,
        statusText: existing ? "No Content" : "Created",
        headers: { get: (name) => (name.toLowerCase() === "etag" ? `"${etag}"` : null) },
        text: async () => "",
      };
    }

    if (method === "HEAD") {
      const file = this.files.get(path);
      if (!file) return { ok: false, status: 404 };
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === "etag" ? `"${file.etag}"` : null) },
      };
    }

    return { ok: false, status: 501, statusText: "Not Implemented" };
  }

  /** Marks a path as locked; subsequent PUT returns 423 until unlocked. */
  lock(path) {
    const file = this.files.get(path);
    if (file) file.locked = true;
    return this;
  }

  unlock(path) {
    const file = this.files.get(path);
    if (file) file.locked = false;
    return this;
  }

  setQuotaExceeded(value = true) {
    this._quotaExceeded = value;
    return this;
  }
}

/**
 * Wires `fetch.mockImplementation` to route to `server`, while still handling
 * the Nextcloud login-flow / status.php endpoints tests commonly need.
 * Returns the same `fetch` vi.fn() for convenience (chaining not required).
 */
export function wireMockServer(fetchMock, server) {
  fetchMock.mockImplementation((url, options) => {
    if (url.includes("/index.php/login/v2")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            poll: { token: "test-token", endpoint: "https://cloud.example.com/login/v2/poll" },
            login: "https://cloud.example.com/login/v2/flow/123",
          }),
      });
    }
    if (url.includes("/login/v2/poll")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          server: "https://cloud.example.com",
          loginName: server.loginName,
          appPassword: "app-password-123",
        }),
      });
    }
    if (url.includes("/status.php")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          installed: true,
          version: "25.0.0",
          versionstring: "Nextcloud 25.0.0",
        }),
      });
    }

    return server.handleRequest(url, options || {});
  });
}
