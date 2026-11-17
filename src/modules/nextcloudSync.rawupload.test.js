/**
 * src/modules/nextcloudSync.rawupload.test.js
 * Uploads go to the app's `nc_put_file` command with the body as raw bytes
 * (review P4): the HTTP plugin sends a body over IPC as a JSON array of
 * numbers, which blocked the main thread for 1.5 s on a 1.3 MB note. The
 * command names no server and no login (it reads them itself); the HTTP plugin
 * remains the way when the command cannot be used.
 */

import { fetch } from "@tauri-apps/plugin-http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockWebDAVServer, wireMockServer } from "./__fixtures__/mockWebDAVServer.js";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./masterPassword.js", () => ({
  isAppUnlocked: vi.fn(() => false),
  getEncryptionKey: vi.fn(() => null),
}));
vi.mock("./encryption.js", () => ({ decryptObject: vi.fn() }));
const secrets = new Map();
vi.mock("./secureStorage.js", () => ({
  saveSecureCredential: vi.fn(async (key, value) => void secrets.set(key, value)),
  getSecureCredential: vi.fn(async (key) => secrets.get(key) ?? null),
  deleteSecureCredential: vi.fn(async (key) => void secrets.delete(key)),
}));
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args) => invoke(...args) }));

let server;
let uploadNoteText;

beforeEach(async () => {
  vi.resetModules();
  invoke.mockReset();
  server = new MockWebDAVServer();
  wireMockServer(fetch, server);
  secrets.set(
    "nextcloud_credentials",
    JSON.stringify({
      serverUrl: "https://cloud.example.com",
      loginName: "testuser",
      appPassword: "app-password-123",
      userId: "testuser",
    }),
  );
  window.__TAURI_INTERNALS__ = {};
  ({ uploadNoteText } = await import("./nextcloudSync.js"));
});

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

const PATH = "/Shared_NoteBerg/Müller/notes/n1.json";

describe("uploading through the app's raw upload command", () => {
  it("sends the body as raw bytes, with only the path and the conditions", async () => {
    invoke.mockResolvedValue({ status: 204, etag: "e2" });

    await expect(uploadNoteText(PATH, '{"id":"n1"}', 3_000_000, "e1")).resolves.toBe("e2");

    const [command, body, { headers }] = invoke.mock.calls[0];
    expect(command).toBe("nc_put_file");
    // Bytes, not an array of numbers (a Uint8Array, from whichever realm encoded it)
    expect(ArrayBuffer.isView(body)).toBe(true);
    expect(new TextDecoder().decode(body)).toBe('{"id":"n1"}');
    expect(headers).toEqual({
      "x-nb-path": "/Shared_NoteBerg/M%C3%BCller/notes/n1.json",
      "x-nb-content-type": "application/json",
      "x-nb-tree": "files",
      "x-nb-if-match": "e1",
      "x-nb-mtime": "3000",
    });
    // Nothing went through the HTTP plugin, and no credentials crossed IPC
    expect(server.requests.filter((r) => r.method === "PUT")).toEqual([]);
    expect(JSON.stringify(headers)).not.toContain("app-password");
  });

  it("reports a conflict as the plugin path does (412: the server moved on)", async () => {
    invoke.mockResolvedValue({ status: 412, etag: null });
    await expect(uploadNoteText(PATH, "{}", null, "old")).rejects.toMatchObject({ status: 412 });
  });

  it("uses the HTTP plugin when the app has no such command (an older build)", async () => {
    invoke.mockRejectedValue("Command nc_put_file not found");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    server.files.set("/Shared_NoteBerg/Müller/notes", { isCollection: true, mtime: new Date() });

    const etag = await uploadNoteText(PATH, '{"id":"n1"}', null, null);

    expect(etag).toBeTruthy();
    expect(server.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
    // And from then on without asking for the command again
    await uploadNoteText(PATH, '{"id":"n1"}', null, null);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("falls back to the HTTP plugin when the IPC delivers the body as JSON, not raw", async () => {
    invoke.mockRejectedValue("nc_put_file expects a raw byte body or a base64 string");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    server.files.set("/Shared_NoteBerg/Müller/notes", { isCollection: true, mtime: new Date() });

    await uploadNoteText(PATH, '{"id":"n1"}', null, null);

    expect(server.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  it("fails the upload when the request itself fails, without sending it twice", async () => {
    invoke.mockRejectedValue("upload failed: connection reset");
    await expect(uploadNoteText(PATH, "{}", null, "e1")).rejects.toThrow(/connection reset/);
    expect(server.requests.filter((r) => r.method === "PUT")).toEqual([]);
  });
});

describe("on Android, whose IPC cannot carry raw bytes", () => {
  it("sends the body as one base64 string, not a typed array", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit" });
    vi.resetModules();
    ({ uploadNoteText } = await import("./nextcloudSync.js"));
    invoke.mockResolvedValue({ status: 204, etag: "e2" });

    await expect(uploadNoteText(PATH, '{"id":"n1"}', null, "e1")).resolves.toBe("e2");

    const [command, body, { headers }] = invoke.mock.calls[0];
    expect(command).toBe("nc_put_file");
    expect(typeof body).toBe("string");
    expect(atob(body)).toBe('{"id":"n1"}');
    expect(headers["x-nb-if-match"]).toBe("e1");
    vi.unstubAllGlobals();
  });
});
