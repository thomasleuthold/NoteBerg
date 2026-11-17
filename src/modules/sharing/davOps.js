/**
 * The file operations the sharing module needs (the DavOps contract of
 * sharedRoots.js), defined once for both builds. A build supplies only how one
 * WebDAV request on the user's own tree is sent and authenticated: the native
 * build through the Tauri client with the stored app password, the Nextcloud
 * app build with the session cookie and request token. What a status means —
 * absent, gone, failed — is decided here, so the builds cannot disagree about it.
 */

/** PROPFIND body asking who owns a node, along with what a folder listing needs. */
export const OWNER_PROPFIND_BODY =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><d:getlastmodified/><d:getetag/><d:resourcetype/><oc:owner-id/></d:prop></d:propfind>';

/** The `oc:owner-id` in a PROPFIND answer, or null when the server did not report one. */
export function ownerIdOf(xml) {
  const match = xml.match(/<[^:>]*:?owner-id[^>]*>([\s\S]*?)<\/[^:>]*:?owner-id>/i);
  return match?.[1]?.trim() || null;
}

function httpError(what, response) {
  const error = new Error(`DAV ${what} failed: ${response.status}`);
  error.status = response.status;
  return error;
}

/**
 * @typedef {object} DavTransport
 * @property {(method: string, path: string, init?: {headers?: Record<string, string>, body?: string, destination?: string}) => Promise<Response>} request
 *   one request on a path of the user's own tree; `destination` is a path too,
 *   which the transport turns into its absolute Destination URL
 * @property {(path: string) => Promise<void>} mkcol - an existing folder is fine
 */

/**
 * @param {DavTransport} transport
 * @returns {import("./sharedRoots.js").DavOps}
 */
export function createDavOps({ request, mkcol }) {
  const propfind0 = (path, body) =>
    request("PROPFIND", path, {
      headers: { Depth: "0", ...(body ? { "Content-Type": "application/xml" } : {}) },
      body,
    });

  return {
    async ownerOf(path) {
      const response = await propfind0(path, OWNER_PROPFIND_BODY);
      if (response.status === 404) return undefined;
      if (!response.ok) throw httpError(`PROPFIND ${path}`, response);
      return ownerIdOf(await response.text());
    },

    // Only a definite 404/403 says the folder is not there (for this user); a
    // server error is not an answer and must never read as "gone"
    async exists(path) {
      const response = await propfind0(path);
      if (response.status === 404 || response.status === 403) return false;
      if (!response.ok) throw httpError(`PROPFIND ${path}`, response);
      return true;
    },

    mkcol,

    async move(from, to) {
      const response = await request("MOVE", from, {
        headers: { Overwrite: "F" },
        destination: to,
      });
      if (!response.ok) throw httpError(`MOVE ${from} -> ${to}`, response);
    },

    async readJson(path) {
      const response = await request("GET", path);
      if (response.status === 404) return null;
      if (!response.ok) throw httpError(`GET ${path}`, response);
      try {
        const parsed = JSON.parse(await response.text());
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch (_e) {
        return null;
      }
    },
  };
}
