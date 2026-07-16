/**
 * src/modules/nextcloudSync.auth.test.js
 * Authentication: login flow, isAuthenticated, testConnection, credential lifecycle.
 */

import { fetch } from "@tauri-apps/plugin-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockWebDAVServer, wireMockServer } from "./__fixtures__/mockWebDAVServer.js";
import {
  clearCredentials,
  getStoredCredentials,
  isAuthenticated,
  migrateCredentials,
  startLoginFlow,
  testConnection,
} from "./nextcloudSync.js";

// --- Mocks ---

// Mock Tauri HTTP plugin
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

// Mock Tauri Opener
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

// Mock masterPassword (static import in nextcloudSync.js)
vi.mock("./masterPassword.js", () => ({
  isAppUnlocked: vi.fn(() => false),
  getEncryptionKey: vi.fn(() => null),
}));

// Mock encryption (static import in nextcloudSync.js)
vi.mock("./encryption.js", () => ({
  decryptObject: vi.fn(),
}));

// Mock Secure Storage
const mockSecureStorage = new Map();
vi.mock("./secureStorage.js", () => ({
  saveSecureCredential: vi.fn((key, value) => {
    mockSecureStorage.set(key, value);
    return Promise.resolve();
  }),
  getSecureCredential: vi.fn((key) => {
    return Promise.resolve(mockSecureStorage.get(key) || null);
  }),
  deleteSecureCredential: vi.fn((key) => {
    mockSecureStorage.delete(key);
    return Promise.resolve();
  }),
}));

// In-memory note store for tests — getNote reads from here
const mockNoteStore = new Map();

// Mock Storage Module (Partial)
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
    // getNote / getRawNote return whatever was seeded in mockNoteStore
    getNote: vi.fn((id) => Promise.resolve(mockNoteStore.get(id) ?? null)),
    getRawNote: vi.fn((id) => Promise.resolve(mockNoteStore.get(id) ?? null)),
  };
});

// --- Tests ---

describe("Nextcloud Sync Module", () => {
  let mockServer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSecureStorage.clear();
    localStorage.clear();
    mockServer = new MockWebDAVServer();
    wireMockServer(fetch, mockServer);

    // Setup authenticated state
    mockSecureStorage.set(
      "nextcloud_credentials",
      JSON.stringify({
        serverUrl: "https://cloud.example.com",
        loginName: "testuser",
        appPassword: "app-password-123",
      }),
    );
  });

  describe("Authentication", () => {
    it("should detect authentication status", async () => {
      expect(await isAuthenticated()).toBe(true);
      mockSecureStorage.clear();
      expect(await isAuthenticated()).toBe(false);
    });

    it("should complete login flow", async () => {
      vi.useFakeTimers();
      mockSecureStorage.clear();

      const loginPromise = startLoginFlow("https://cloud.example.com");

      // Advance time to trigger the poll interval (5000ms)
      await vi.advanceTimersByTimeAsync(6000);

      const creds = await loginPromise;

      expect(creds).toEqual({
        serverUrl: "https://cloud.example.com",
        loginName: "testuser",
        appPassword: "app-password-123",
      });
      expect(mockSecureStorage.has("nextcloud_credentials")).toBe(true);
      vi.useRealTimers();
    });
  });

  describe("testConnection", () => {
    it("returns success for a reachable, valid Nextcloud server", async () => {
      const result = await testConnection("https://cloud.example.com");
      expect(result.success).toBe(true);
    });

    it("returns failure when the server responds with a non-ok status", async () => {
      fetch.mockImplementation(async (url) => {
        if (url.includes("/status.php")) {
          return { ok: false, status: 503, statusText: "Service Unavailable" };
        }
        return mockServer.handleRequest(url, {});
      });

      const result = await testConnection("https://cloud.example.com");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/503/);
    });

    it("returns failure when status.php returns invalid JSON", async () => {
      fetch.mockImplementation(async (url) => {
        if (url.includes("/status.php")) {
          return {
            ok: true,
            json: async () => {
              throw new SyntaxError("Unexpected token");
            },
          };
        }
        return mockServer.handleRequest(url, {});
      });

      const result = await testConnection("https://cloud.example.com");
      expect(result.success).toBe(false);
    });

    it("strips a trailing slash from the server URL before probing", async () => {
      let probedUrl = null;
      fetch.mockImplementation(async (url) => {
        if (url.includes("/status.php")) {
          probedUrl = url;
          return { ok: true, json: async () => ({ installed: true, version: "25.0.0" }) };
        }
        return mockServer.handleRequest(url, {});
      });

      await testConnection("https://cloud.example.com/");
      expect(probedUrl).toBe("https://cloud.example.com/status.php");
    });
  });

  describe("Credential lifecycle", () => {
    it("getStoredCredentials returns null when nothing is stored", async () => {
      mockSecureStorage.clear();
      expect(await getStoredCredentials()).toBeNull();
    });

    it("getStoredCredentials returns the parsed credentials when present", async () => {
      const creds = await getStoredCredentials();
      expect(creds).toEqual({
        serverUrl: "https://cloud.example.com",
        loginName: "testuser",
        appPassword: "app-password-123",
      });
    });

    it("clearCredentials removes stored credentials", async () => {
      await clearCredentials();
      expect(mockSecureStorage.has("nextcloud_credentials")).toBe(false);
      expect(await isAuthenticated()).toBe(false);
    });

    it("migrateCredentials moves a legacy localStorage credential into secure storage", async () => {
      mockSecureStorage.clear();
      localStorage.setItem(
        "nextcloud_credentials",
        JSON.stringify({
          serverUrl: "https://legacy.example.com",
          loginName: "legacyuser",
          appPassword: "legacy-pass",
        }),
      );

      await migrateCredentials();

      expect(localStorage.getItem("nextcloud_credentials")).toBeNull();
      const migrated = await getStoredCredentials();
      expect(migrated.loginName).toBe("legacyuser");
    });

    it("migrateCredentials is a no-op when secure storage already has credentials", async () => {
      localStorage.setItem(
        "nextcloud_credentials",
        JSON.stringify({ serverUrl: "https://legacy.example.com", loginName: "legacyuser" }),
      );

      await migrateCredentials();

      // Existing secure-storage credentials must not be clobbered by the legacy value
      const creds = await getStoredCredentials();
      expect(creds.loginName).toBe("testuser");
      expect(localStorage.getItem("nextcloud_credentials")).toBeNull();
    });

    it("migrateCredentials does nothing when there is no legacy credential", async () => {
      mockSecureStorage.clear();
      localStorage.removeItem("nextcloud_credentials");

      await migrateCredentials();

      expect(await getStoredCredentials()).toBeNull();
    });
  });
});
