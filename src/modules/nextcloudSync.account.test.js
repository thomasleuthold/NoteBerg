/**
 * src/modules/nextcloudSync.account.test.js
 * WebDAV account root: the login name from Login Flow v2 vs Nextcloud's internal
 * user ID. They differ on LDAP/AD backends (UUID user IDs) and for email/alias
 * logins; DAV paths only exist under the user ID (GitHub issue: initial sync
 * failed with "Failed to create folder: 409 Conflict").
 */

import { fetch } from "@tauri-apps/plugin-http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockWebDAVServer, wireMockServer } from "./__fixtures__/mockWebDAVServer.js";
import {
  clearCredentials,
  fullSync,
  getStoredCredentials,
  isAuthenticated,
  listFiles,
  startLoginFlow,
  syncNotes,
} from "./nextcloudSync.js";
import { getFile } from "./storage.js";

// --- Mocks ---

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

vi.mock("./masterPassword.js", () => ({
  isAppUnlocked: vi.fn(() => false),
  getEncryptionKey: vi.fn(() => null),
}));

vi.mock("./encryption.js", () => ({
  decryptObject: vi.fn(),
}));

const mockSecureStorage = new Map();
vi.mock("./secureStorage.js", () => ({
  saveSecureCredential: vi.fn((key, value) => {
    mockSecureStorage.set(key, value);
    return Promise.resolve();
  }),
  getSecureCredential: vi.fn((key) => Promise.resolve(mockSecureStorage.get(key) || null)),
  deleteSecureCredential: vi.fn((key) => {
    mockSecureStorage.delete(key);
    return Promise.resolve();
  }),
}));

const mockNoteStore = new Map();

vi.mock("./storage.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    saveFile: vi.fn(() => Promise.resolve("file-id")),
    getFile: vi.fn(() => Promise.resolve(new Blob(["test"], { type: "text/plain" }))),
    checkFileExists: vi.fn(() => Promise.resolve(false)),
    deleteFile: vi.fn(() => Promise.resolve()),
    permanentlyDeleteNote: vi.fn(),
    permanentlyDeleteNotebook: vi.fn(),
    permanentlyDeleteNotesInNotebook: vi.fn(),
    getSetting: vi.fn(() => Promise.resolve(null)),
    getStorageVersion: vi.fn(() => Promise.resolve(1)),
    isLocalEncryptionEnabled: vi.fn(() => Promise.resolve(false)),
    initStorage: vi.fn(() => Promise.resolve()),
    updateNote: vi.fn(() => Promise.resolve()),
    saveNote: vi.fn(() => Promise.resolve()),
    getNote: vi.fn((id) => Promise.resolve(mockNoteStore.get(id) ?? null)),
    getRawNote: vi.fn((id) => Promise.resolve(mockNoteStore.get(id) ?? null)),
  };
});

// --- Fixtures ---

const SERVER_URL = "https://cloud.example.com";
const LDAP_LOGIN = "alice@example.com";
const LDAP_USER_ID = "5b3c1d2e-0f4a-4b7c-9d8e-1a2b3c4d5e6f";

const storeCredentials = (creds) =>
  mockSecureStorage.set(
    "nextcloud_credentials",
    JSON.stringify({ serverUrl: SERVER_URL, appPassword: "app-password-123", ...creds }),
  );

const storedCredentials = () => JSON.parse(mockSecureStorage.get("nextcloud_credentials"));

const ocsRequests = (server) => server.requests.filter((r) => r.path.startsWith("/ocs/"));

/** A note in a notebook whose folder chain already exists on the server. */
const seedNotebookFolders = (server, notebookId = "nb1") => {
  server.files.set(`/NoteBerg/notebooks/${notebookId}`, { isCollection: true, mtime: new Date() });
  server.files.set(`/NoteBerg/notebooks/${notebookId}/notes`, {
    isCollection: true,
    mtime: new Date(),
  });
};

const localNote = (id, extra = {}) => ({
  id,
  notebookId: "nb1",
  strokes: [{ id: `${id}-s1`, time: [1], x: [1], y: [1] }],
  deletedStrokes: [],
  version: 1,
  modified: 1000,
  synced: false,
  ...extra,
});

// --- Tests ---

describe("Nextcloud WebDAV account root (login name vs user ID)", () => {
  let server;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Also resets the module's in-memory user-ID lookup state between tests.
    await clearCredentials();
    mockSecureStorage.clear();
    mockNoteStore.clear();
    getFile.mockResolvedValue(new Blob(["test"], { type: "text/plain" }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("login flow", () => {
    const login = async () => {
      vi.useFakeTimers();
      const loginPromise = startLoginFlow(SERVER_URL);
      await vi.advanceTimersByTimeAsync(6000); // one 5s poll interval
      return loginPromise;
    };

    it("stores the internal user ID next to the login name", async () => {
      server = new MockWebDAVServer({ loginName: LDAP_LOGIN, userId: LDAP_USER_ID });
      wireMockServer(fetch, server);

      const creds = await login();

      expect(creds).toEqual({
        serverUrl: SERVER_URL,
        loginName: LDAP_LOGIN,
        appPassword: "app-password-123",
        userId: LDAP_USER_ID,
      });
      expect(storedCredentials()).toEqual(creds);
    });

    it("still logs in when the user-ID lookup fails, leaving userId to be resolved on sync", async () => {
      server = new MockWebDAVServer({ loginName: LDAP_LOGIN, userId: LDAP_USER_ID });
      wireMockServer(fetch, server);
      server.failNext({ method: "GET", pathMatch: "/ocs/", status: 503 });

      const creds = await login();

      expect(creds.userId).toBeUndefined();
      expect(await isAuthenticated()).toBe(true);
    });
  });

  describe("LDAP / email login (login name differs from user ID)", () => {
    beforeEach(() => {
      server = new MockWebDAVServer({ loginName: LDAP_LOGIN, userId: LDAP_USER_ID });
      wireMockServer(fetch, server);
    });

    it("first sync after login creates the folder structure and uploads under the user ID", async () => {
      storeCredentials({ loginName: LDAP_LOGIN, userId: LDAP_USER_ID });
      seedNotebookFolders(server);

      const result = await fullSync([], [localNote("n1")]);

      expect(result.uploaded.notes.uploaded).toBe(1);
      expect(server.files.has("/NoteBerg/notebooks/nb1/notes/n1.json")).toBe(true);
      // The previously failing step: MKCOL of the root folder chain.
      expect(server.files.has("/NoteBerg/notebooks")).toBe(true);
      // userId is already known — no lookup needed.
      expect(ocsRequests(server)).toHaveLength(0);
    });

    it("backfills the user ID for credentials saved before it was stored (the reported failure)", async () => {
      storeCredentials({ loginName: LDAP_LOGIN });
      seedNotebookFolders(server);

      const result = await fullSync([], [localNote("n1")]);

      expect(result.uploaded.notes.uploaded).toBe(1);
      expect(server.files.has("/NoteBerg/notebooks/nb1/notes/n1.json")).toBe(true);
      expect(storedCredentials().userId).toBe(LDAP_USER_ID);
      // Every WebDAV request went to a valid root — none hit the login-name path.
      const davFetches = fetch.mock.calls.map(([url]) => url).filter((u) => u.includes("/dav/"));
      expect(davFetches.length).toBeGreaterThan(0);
      expect(davFetches.every((u) => u.includes(`/${LDAP_USER_ID}`))).toBe(true);
    });

    it("looks the user ID up only once, even though a sync issues many requests concurrently", async () => {
      storeCredentials({ loginName: LDAP_LOGIN });
      seedNotebookFolders(server);

      await fullSync([], [localNote("n1"), localNote("n2"), localNote("n3")]);
      await fullSync([], [localNote("n4")]);

      expect(ocsRequests(server)).toHaveLength(1);
    });

    it("routes chunked media uploads (uploads root and MOVE destination) through the user ID", async () => {
      storeCredentials({ loginName: LDAP_LOGIN, userId: LDAP_USER_ID });
      seedNotebookFolders(server);
      const payload = "P".repeat(12 * 1024 * 1024); // above the chunked-upload threshold
      getFile.mockResolvedValue(new Blob([payload]));

      const result = await syncNotes([
        {
          id: "big",
          notebookId: "nb1",
          media: [{ id: "m1", fileId: "pdf1", type: "pdf-page" }],
          pdfSource: "pdf1",
          modified: Date.now(),
        },
      ]);

      expect(result.uploaded).toBe(1);
      expect(server.requests.some((r) => r.method === "MOVE")).toBe(true);
      expect(server.files.get("/NoteBerg/notebooks/nb1/notes/big_media/pdf1.bin")?.content).toBe(
        payload,
      );
    });

    it("fails the sync — rather than reporting an empty server — if the lookup is unavailable", async () => {
      // Documents the residual limit: with no user ID the login name is the
      // only guess, and on such a server it is wrong. The error must surface.
      storeCredentials({ loginName: LDAP_LOGIN });
      seedNotebookFolders(server);
      server.failEvery({ method: "GET", pathMatch: "/ocs/", status: 503 });

      await expect(fullSync([], [localNote("n1")])).rejects.toThrow(/409/);
      expect(storedCredentials().userId).toBeUndefined();
    });

    it("percent-encodes a user ID that contains URL-reserved characters", async () => {
      server = new MockWebDAVServer({ loginName: "bob", userId: "bob smith@example.com" });
      wireMockServer(fetch, server);
      storeCredentials({ loginName: "bob" });

      await listFiles("/NoteBerg");

      const davUrls = fetch.mock.calls.map(([url]) => url).filter((u) => u.includes("/dav/"));
      expect(davUrls).toEqual([
        `${SERVER_URL}/remote.php/dav/files/bob%20smith%40example.com/NoteBerg`,
      ]);
    });
  });

  describe("existing setups (login name equals user ID)", () => {
    beforeEach(() => {
      server = new MockWebDAVServer({ loginName: "testuser" });
      wireMockServer(fetch, server);
    });

    it("keeps already-synced notes in sync: same paths, same etags, nothing re-downloaded", async () => {
      // A setup created before userId existed, with a note synced at etag-A.
      storeCredentials({ loginName: "testuser" });
      server.seedNotebook("nb1");
      server.seedNote("nb1", { id: "n1", modified: 1000 }, { etag: "etag-A" });
      const synced = localNote("n1", { synced: true, lastSyncedEtag: "etag-A" });
      mockNoteStore.set("n1", synced);

      const result = await fullSync([], [synced]);

      expect(result.downloaded.notes).toHaveLength(0);
      expect(result.conflicts.notes).toHaveLength(0);
      expect(storedCredentials().userId).toBe("testuser");
      expect(storedCredentials().loginName).toBe("testuser");
    });

    it("falls back to the login name when the lookup fails, and retries only after a cooldown", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-05T10:00:00Z"));
      storeCredentials({ loginName: "testuser" });
      server.seedNotebook("nb1");
      server.failEvery({ method: "GET", pathMatch: "/ocs/", status: 503 });

      // Sync keeps working exactly as before the user ID existed.
      expect((await listFiles("/NoteBerg/notebooks/nb1")).map((f) => f.name)).toEqual([
        "_notebook.json",
      ]);
      await listFiles("/NoteBerg/notebooks/nb1");
      expect(ocsRequests(server)).toHaveLength(1); // no retry storm within one sync
      expect(storedCredentials().userId).toBeUndefined();

      server.clearFaults();
      vi.setSystemTime(new Date("2026-10-05T10:06:00Z"));
      await listFiles("/NoteBerg/notebooks/nb1");

      expect(ocsRequests(server)).toHaveLength(2);
      expect(storedCredentials().userId).toBe("testuser");
    });

    it("does not resurrect credentials when the user logs out during the lookup", async () => {
      storeCredentials({ loginName: "testuser" });
      let releaseOcs;
      const ocsGate = new Promise((resolve) => {
        releaseOcs = resolve;
      });
      fetch.mockImplementation(async (url, options) => {
        if (url.includes("/ocs/")) await ocsGate;
        return server.handleRequest(url, options || {});
      });

      const pending = listFiles("/NoteBerg");
      await vi.waitFor(() =>
        expect(fetch.mock.calls.some(([url]) => url.includes("/ocs/"))).toBe(true),
      );
      await clearCredentials();
      releaseOcs();
      await pending;

      expect(await getStoredCredentials()).toBeNull();
    });
  });
});
