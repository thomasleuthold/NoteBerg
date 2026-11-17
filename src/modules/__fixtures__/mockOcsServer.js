/**
 * src/modules/__fixtures__/mockOcsServer.js
 * A small Nextcloud instance for sharing tests: several users, each with their
 * own file tree (a MockWebDAVServer), and the OCS sharing API on top.
 *
 * It models what real Nextcloud does and the client must cope with:
 *  - responses wrapped in the OCS envelope (`ocs.meta.statuscode`), optionally
 *    answered with HTTP 200 even on failure (OCS v1 style);
 *  - a share is either accepted (the folder is mounted into the recipient's
 *    tree) or pending (not in `shared_with_me`, no mount) depending on the
 *    recipient's auto-accept policy;
 *  - granted permissions can be reduced by admin policy;
 *  - the recipient's `DELETE` on a share leaves it, removing only their access;
 *  - sharee search never returns the searching user, nor everyone without a query.
 *
 * Wire it with `wireMockNextcloud(fetchMock, instance)`.
 */

import { MockWebDAVServer } from "./mockWebDAVServer.js";

const PERM_ALL = 31;
const SHARE_API = "/ocs/v2.php/apps/files_sharing/api/v1";

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

export class MockNextcloud {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]
   * @param {number} [options.maxPermissions] - admin policy: bits above this are never granted
   * @param {string} [options.webroot] - sub-folder the instance lives under, e.g. "/nextcloud"
   * @param {string} [options.shareFolder] - server-wide default mount folder ("/" = tree root)
   * @param {boolean} [options.v1Errors] - answer OCS failures with HTTP 200 + a failing statuscode
   */
  constructor({
    baseUrl = "https://cloud.example.com",
    maxPermissions = PERM_ALL,
    shareFolder = "/",
    webroot = "",
    v1Errors = false,
  } = {}) {
    this.baseUrl = baseUrl;
    this.maxPermissions = maxPermissions;
    this.shareFolder = shareFolder;
    this.webroot = webroot;
    this.v1Errors = v1Errors;
    this.users = new Map(); // uid -> { uid, displayName, dav, autoAccept }
    this.shares = new Map(); // id -> share record
    this._nextShareId = 1;
    this.requests = []; // OCS requests: { method, path, query, form, user }
    /** Identity of cookie-authenticated (Nextcloud app build) requests. */
    this.sessionUser = null;
    /** Include the searching user in sharee results (real Nextcloud does not). */
    this.includeSelfInSharees = false;
  }

  /** Add a user with their own file tree. */
  addUser(uid, { displayName = uid, autoAccept = true } = {}) {
    const dav = new MockWebDAVServer({ loginName: uid });
    dav.baseUrl = this.baseUrl;
    const user = { uid, displayName, dav, autoAccept };
    this.users.set(uid, user);
    return user;
  }

  /** A user's file tree. */
  dav(uid) {
    return this.users.get(uid).dav;
  }

  /**
   * Share a folder as the owner would through the OCS API, for test setup.
   * @returns {Promise<object>} the share as OCS formats it (`id`, `file_target`, ...)
   */
  async share(ownerUid, path, recipientUid, permissions) {
    const response = this._createShare(this.users.get(ownerUid), {
      path,
      shareType: 0,
      shareWith: recipientUid,
      permissions,
    });
    const envelope = await response.json();
    if (envelope.ocs.meta.statuscode >= 300) {
      throw new Error(`share failed: ${envelope.ocs.meta.message}`);
    }
    return envelope.ocs.data;
  }

  // ─── Request routing ────────────────────────────────────────────────────────

  /** Authenticated user of a request, or null. */
  _authenticate(headers) {
    const auth = headers.Authorization ?? headers.authorization;
    if (auth?.startsWith("Basic ")) {
      const bytes = Uint8Array.from(atob(auth.slice(6)), (c) => c.charCodeAt(0));
      const login = new TextDecoder().decode(bytes).split(":")[0];
      return this.users.get(login) ?? null;
    }
    // Cookie session (same-origin fetch from the Nextcloud app)
    if (headers.requesttoken && this.sessionUser) return this.users.get(this.sessionUser) ?? null;
    return null;
  }

  /** Route any request of a test to the right user's tree or to the OCS API. */
  async handleRequest(url, options = {}) {
    const relative = url.startsWith(this.baseUrl) ? url.slice(this.baseUrl.length) : url;
    const unrooted =
      this.webroot && relative.startsWith(`${this.webroot}/`)
        ? relative.slice(this.webroot.length)
        : relative;
    url = unrooted;
    const pathname = unrooted.split("?")[0];

    const dav = pathname.match(/^\/remote\.php\/dav\/(?:files|uploads)\/([^/]+)/);
    if (dav) {
      const owner = this.users.get(decodeURIComponent(dav[1]));
      if (owner) {
        // Cookie-authenticated callers carry no Authorization header
        const headers = { ...(options.headers ?? {}) };
        if (!headers.Authorization && this.sessionUser === owner.uid) {
          headers.Authorization = owner.dav._basicAuthFor();
        }
        return owner.dav.handleRequest(url, { ...options, headers });
      }
    }

    if (pathname.startsWith("/ocs/")) return this._handleOcs(pathname, url, options);
    return response(404, {});
  }

  // ─── OCS ────────────────────────────────────────────────────────────────────

  _envelope(statuscode, data = [], message = "OK") {
    const failed = statuscode >= 300;
    const body = {
      ocs: { meta: { status: failed ? "failure" : "ok", statuscode, message }, data },
    };
    return response(failed && !this.v1Errors ? statuscode : 200, body);
  }

  _handleOcs(pathname, url, options) {
    const method = options.method || "GET";
    const headers = options.headers ?? {};
    const user = this._authenticate(headers);
    const query = Object.fromEntries(new URL(url, this.baseUrl).searchParams);
    const form = options.body ? Object.fromEntries(new URLSearchParams(options.body)) : {};
    this.requests.push({ method, path: pathname, query, form, user: user?.uid ?? null, headers });

    if (!user) return this._envelope(401, [], "Current user is not logged in");
    if (headers["OCS-APIRequest"] !== "true") return this._envelope(412, [], "CSRF check failed");

    if (pathname === "/ocs/v2.php/cloud/user") {
      return this._envelope(200, { id: user.uid, "display-name": user.displayName });
    }
    if (!pathname.startsWith(SHARE_API)) return this._envelope(404, [], "Not found");

    const route = pathname.slice(SHARE_API.length).replace(/^\//, "");
    const parts = route.split("/").filter(Boolean);

    if (parts[0] === "sharees" && method === "GET") return this._sharees(user, query);
    if (parts[0] !== "shares") return this._envelope(404, [], "Not found");

    if (parts.length === 1) {
      if (method === "GET") return this._listShares(user, query);
      if (method === "POST") return this._createShare(user, form);
    }
    if (parts[1] === "pending") {
      if (parts.length === 2 && method === "GET") return this._listPending(user);
      if (parts.length === 3 && method === "POST") return this._accept(user, parts[2]);
      if (parts.length === 3 && method === "DELETE") return this._reject(user, parts[2]);
    }
    if (parts.length === 2) {
      if (method === "PUT") return this._update(user, parts[1], form);
      if (method === "DELETE") return this._delete(user, parts[1]);
    }
    return this._envelope(404, [], "Not found");
  }

  _sharees(user, query) {
    const search = (query.search ?? "").toLowerCase();
    // Nextcloud never enumerates everyone: an empty query finds nobody
    const matches = search
      ? [...this.users.values()].filter(
          (u) =>
            (this.includeSelfInSharees || u.uid !== user.uid) &&
            (u.uid.toLowerCase().includes(search) || u.displayName.toLowerCase().includes(search)),
        )
      : [];
    const item = (u) => ({ label: u.displayName, value: { shareType: 0, shareWith: u.uid } });
    const exact = matches.filter((u) => u.uid.toLowerCase() === search);
    return this._envelope(200, {
      exact: { users: exact.map(item) },
      users: matches.filter((u) => !exact.includes(u)).map(item),
    });
  }

  _format(share, viewer) {
    const owner = this.users.get(share.owner);
    const recipient = this.users.get(share.shareWith);
    const mount = recipient.dav.mounts.get(share.id);
    const node = owner.dav.files.get(share.path);
    return {
      id: share.id,
      share_type: 0,
      permissions: share.permissions,
      item_type: "folder",
      item_source: share.itemSource,
      file_source: share.itemSource,
      uid_owner: share.owner,
      displayname_owner: owner.displayName,
      share_with: share.shareWith,
      share_with_displayname: recipient.displayName,
      path: viewer === share.owner ? share.path : (mount?.path ?? null),
      // Where the share is mounted in the recipient's tree; absent until accepted
      file_target:
        mount?.path ?? `${this.shareFolder.replace(/\/$/, "")}/${share.path.split("/").pop()}`,
      state: share.state,
      etag: node?.etag,
    };
  }

  _listShares(user, query) {
    if (query.shared_with_me === "true") {
      const mine = [...this.shares.values()].filter(
        (s) => s.shareWith === user.uid && s.state === 0,
      );
      return this._envelope(
        200,
        mine.map((s) => this._format(s, user.uid)),
      );
    }
    const path = query.path;
    // subfiles=true: everything directly inside the folder, not the folder itself
    const matches = (share) =>
      query.subfiles === "true"
        ? share.path.startsWith(`${path}/`) && !share.path.slice(path.length + 1).includes("/")
        : share.path === path;
    const own = [...this.shares.values()].filter(
      (s) => s.owner === user.uid && (path === undefined || matches(s)),
    );
    if (path !== undefined && !user.dav.files.has(path)) {
      return this._envelope(404, [], "Wrong path, file/folder doesn't exist");
    }
    return this._envelope(
      200,
      own.map((s) => this._format(s, user.uid)),
    );
  }

  _listPending(user) {
    const pending = [...this.shares.values()].filter(
      (s) => s.shareWith === user.uid && s.state === 1,
    );
    return this._envelope(
      200,
      pending.map((s) => this._format(s, user.uid)),
    );
  }

  _createShare(user, form) {
    const path = form.path;
    const target = this.users.get(form.shareWith);
    if (Number(form.shareType) !== 0) return this._envelope(400, [], "Unsupported share type");
    if (!user.dav.files.get(path)?.isCollection) {
      return this._envelope(404, [], "Wrong path, file/folder doesn't exist");
    }
    if (!target) return this._envelope(404, [], "Wrong share recipient");
    if (target.uid === user.uid) {
      return this._envelope(403, [], "Cannot share with yourself");
    }
    for (const s of this.shares.values()) {
      if (s.owner === user.uid && s.path === path && s.shareWith === target.uid) {
        return this._envelope(403, [], "Path is already shared with this user");
      }
    }

    const requested = form.permissions === undefined ? PERM_ALL : Number(form.permissions);
    const share = {
      id: String(this._nextShareId++),
      owner: user.uid,
      shareWith: target.uid,
      path,
      itemSource: String(user.dav.files.get(path).etag ?? path),
      permissions: requested & this.maxPermissions,
      state: target.autoAccept ? 0 : 1,
    };
    this.shares.set(share.id, share);
    if (share.state === 0) this._mount(share);
    return this._envelope(200, this._format(share, user.uid));
  }

  /** Mount an accepted share into the recipient's tree, avoiding name clashes. */
  _mount(share) {
    const recipient = this.users.get(share.shareWith);
    const owner = this.users.get(share.owner);
    const folder = this.shareFolder === "/" ? "" : this.shareFolder.replace(/\/$/, "");
    const name = share.path.split("/").pop();
    let path = `${folder}/${name}`;
    for (let n = 2; recipient.dav.files.has(path) || recipient.dav._findMount(path); n++) {
      path = `${folder}/${name} (${n})`;
    }
    recipient.dav.addMount({
      shareId: share.id,
      path,
      source: owner.dav,
      sourcePath: share.path,
      permissions: share.permissions,
    });
  }

  _accept(user, id) {
    const share = this.shares.get(id);
    if (!share || share.shareWith !== user.uid) return this._envelope(404, [], "Wrong share ID");
    if (share.state === 0) return this._envelope(200, []);
    share.state = 0;
    this._mount(share);
    return this._envelope(200, []);
  }

  /** Decline a pending share: it is never mounted and no longer listed as pending. */
  _reject(user, id) {
    const share = this.shares.get(id);
    if (!share || share.shareWith !== user.uid || share.state !== 1) {
      return this._envelope(404, [], "Wrong share ID");
    }
    share.state = 2;
    return this._envelope(200, []);
  }

  _update(user, id, form) {
    const share = this.shares.get(id);
    if (!share || share.owner !== user.uid) return this._envelope(404, [], "Wrong share ID");
    if (form.permissions !== undefined) {
      share.permissions = Number(form.permissions) & this.maxPermissions;
      this.users.get(share.shareWith).dav.setMountPermissions(id, share.permissions);
    }
    return this._envelope(200, this._format(share, user.uid));
  }

  _delete(user, id) {
    const share = this.shares.get(id);
    // Owner revokes; recipient leaves. Anyone else cannot see it.
    if (!share || (share.owner !== user.uid && share.shareWith !== user.uid)) {
      return this._envelope(404, [], "Wrong share ID");
    }
    this.shares.delete(id);
    this.users.get(share.shareWith).dav.removeMount(id);
    return this._envelope(200, []);
  }
}

/**
 * Route every fetch of a test to the instance (DAV of any user, OCS), while
 * still answering the login-flow and status endpoints.
 */
export function wireMockNextcloud(fetchMock, instance) {
  fetchMock.mockImplementation((url, options) => {
    if (url.includes("/status.php")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ installed: true, version: "28.0.0", versionstring: "28.0.0" }),
      });
    }
    return instance.handleRequest(url, options || {});
  });
}
