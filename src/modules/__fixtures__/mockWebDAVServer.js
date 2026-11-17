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

// Nextcloud share permission bits
const PERM_UPDATE = 2;
const PERM_CREATE = 4;
const PERM_DELETE = 8;

const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");
const forbidden = () => ({
  ok: false,
  status: 403,
  statusText: "Forbidden",
  headers: { get: () => null },
  text: async () => "",
});

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

    // Shares mounted into this user's tree, keyed by share id:
    //   { path, source: MockWebDAVServer, sourcePath, permissions, ownerId }
    // Requests below `path` are served from the owner's tree, limited by the
    // granted permission bits. A mount root is not a file of this user's own tree.
    this.mounts = new Map();
    /** Older servers answer PROPFIND without oc:owner-id; the client must cope. */
    this.reportOwnerId = true;
    /** The owner ID PROPFIND reports for this user's own files, if it differs from the account's (e.g. in case). */
    this.reportedOwnerId = null;

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
    this.mounts.clear();
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
    // A notebook cannot exist without the folder that holds all of them
    if (!this.files.has("/NoteBerg/notebooks")) {
      this.files.set("/NoteBerg/notebooks", { isCollection: true, mtime: new Date() });
    }
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

  // --- Shares ---

  /**
   * Mount a folder of another user's tree into this one, as accepting a share does.
   * @param {object} mount
   * @param {string|number} mount.shareId
   * @param {string} mount.path - where it appears in this user's tree
   * @param {MockWebDAVServer} mount.source - the owner's server
   * @param {string} mount.sourcePath - the shared folder in the owner's tree
   * @param {number} mount.permissions - granted permission bits
   */
  addMount({ shareId, path, source, sourcePath, permissions }) {
    this.mounts.set(String(shareId), {
      path,
      source,
      sourcePath,
      permissions,
      ownerId: source.userId,
    });
    return this;
  }

  removeMount(shareId) {
    this.mounts.delete(String(shareId));
    return this;
  }

  setMountPermissions(shareId, permissions) {
    const mount = this.mounts.get(String(shareId));
    if (mount) mount.permissions = permissions;
    return this;
  }

  /** The mount a path lies in (or is the root of), or null. */
  _findMount(path) {
    let best = null;
    for (const mount of this.mounts.values()) {
      const within = path === mount.path || path.startsWith(`${mount.path}/`);
      if (within && (!best || mount.path.length > best.path.length)) best = mount;
    }
    return best;
  }

  /** A path inside a mount, translated into the owner's tree. */
  _toSourcePath(mount, path) {
    return mount.sourcePath + path.slice(mount.path.length);
  }

  /** Where a path is stored: this tree, or the owner's when it lies in a mount. */
  _resolveStore(path) {
    const mount = this._findMount(path);
    if (!mount) return { files: this.files, path, mount: null, server: this };
    return {
      files: mount.source.files,
      path: this._toSourcePath(mount, path),
      mount,
      server: mount.source,
    };
  }

  _basicAuthFor() {
    return `Basic ${btoa(`${this.loginName}:app-password-123`)}`;
  }

  /**
   * Serve a request that lies inside a mount from the owner's tree, enforcing
   * the permission bits the share grants. Responses that name paths are
   * rewritten back into this user's namespace.
   */
  async _handleMountRequest(mount, method, path, headers, options) {
    const source = mount.source;
    const sourcePath = this._toSourcePath(mount, path);
    const granted = mount.permissions;
    const isRoot = path === mount.path;

    // The recipient renaming the mount root moves where the share appears
    if (method === "MOVE" && isRoot) return this._moveMount(mount, headers);

    if (method === "PUT") {
      const needed = source.files.has(sourcePath) ? PERM_UPDATE : PERM_CREATE;
      if (!(granted & needed)) return forbidden();
    } else if (method === "MKCOL" || method === "COPY") {
      if (!(granted & PERM_CREATE)) return forbidden();
    } else if (method === "DELETE") {
      if (!(granted & PERM_DELETE)) return forbidden();
    } else if (method === "MOVE") {
      if (!(granted & PERM_DELETE) || !(granted & PERM_CREATE)) return forbidden();
    }

    const forwardHeaders = { ...headers, Authorization: source._basicAuthFor() };
    if (headers.Destination) {
      const destPath = this._parseUrl(headers.Destination).path;
      if (this._findMount(destPath) !== mount) return forbidden();
      forwardHeaders.Destination = `${source.baseUrl}${source.rootPath}${encodePath(
        this._toSourcePath(mount, destPath),
      )}`;
    }
    const response = await source.handleRequest(
      `${source.baseUrl}${source.rootPath}${encodePath(sourcePath)}`,
      { ...options, headers: forwardHeaders },
    );

    if (method !== "PROPFIND" || !response.text) return response;
    const from = `${source.rootPath}${encodePath(mount.sourcePath)}`;
    const to = `${this.rootPath}${encodePath(mount.path)}`;
    const xml = (await response.text()).split(from).join(to);
    return { ...response, text: async () => xml };
  }

  /** WebDAV MOVE of a mount root: Nextcloud stores the new location as the share's target. */
  _moveMount(mount, headers) {
    const dest = headers.Destination ? this._parseUrl(headers.Destination).path : null;
    if (!dest) return { ok: false, status: 400, statusText: "Bad Request" };
    const parent = dest.substring(0, dest.lastIndexOf("/")) || "/";
    if (!this.files.has(parent) || this.files.has(dest) || this._findMount(dest)) {
      return { ok: false, status: 409, statusText: "Conflict", text: async () => "" };
    }
    mount.path = dest;
    return { ok: true, status: 201, statusText: "Created", text: async () => "" };
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

    this.requests.push({ method, path, headers: { ...headers }, body: options.body });

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

    const mount = this._findMount(path);
    if (mount) return this._handleMountRequest(mount, method, path, headers, options);

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
      let xml =
        '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">';

      const addItem = (p, f, ownerId = this.reportedOwnerId ?? this.userId) => {
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
                ${this.reportOwnerId ? `<oc:owner-id>${ownerId}</oc:owner-id>` : ""}
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

      // Shares mounted below the requested folder are part of its tree: the mount
      // root is a child, and a recursive listing continues into the owner's files
      if (file.isCollection && depth !== "0") {
        const prefix = path.endsWith("/") ? path : `${path}/`;
        for (const m of this.mounts.values()) {
          const relative = m.path.slice(prefix.length);
          const isChild = m.path.startsWith(prefix) && !relative.includes("/");
          if (isChild || (depth === "infinity" && m.path.startsWith(prefix))) {
            addItem(m.path, m.source.files.get(m.sourcePath) ?? { isCollection: true }, m.ownerId);
          }
          if (depth === "infinity" && m.path.startsWith(prefix)) {
            const ownerPrefix = `${m.sourcePath}/`;
            for (const [ownerPath, ownerFile] of m.source.files) {
              if (ownerPath.startsWith(ownerPrefix)) {
                addItem(m.path + ownerPath.slice(m.sourcePath.length), ownerFile, m.ownerId);
              }
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

      const dest = this._resolveStore(destPath);
      const destParent = dest.path.substring(0, dest.path.lastIndexOf("/")) || "/";
      if (!dest.files.has(destParent)) {
        return { ok: false, status: 409, statusText: "Conflict", text: async () => "" };
      }
      const existing = dest.files.get(dest.path);
      if (dest.mount && !(dest.mount.permissions & (existing ? PERM_UPDATE : PERM_CREATE))) {
        return forbidden();
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

      const etag = dest.server._generateEtag();
      dest.files.set(dest.path, {
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
