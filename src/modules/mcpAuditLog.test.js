/**
 * src/modules/mcpAuditLog.test.js
 * Unit tests for the MCP access log: append, the 15,000-entry count cap
 * (oldest evicted first), enabled/disabled no-op behavior, and clear.
 *
 * Mocks "idb" with a small in-memory store covering exactly the surface
 * mcpAuditLog.js uses (add/count/getAllFromIndex/clear + a cursor for
 * eviction), following the same hand-rolled-mock convention already used in
 * storage.test.js rather than introducing a new fake-indexeddb dependency.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let entries = []; // [{ id, timestamp, tool, arguments, ok, errorMessage, durationMs }]
let nextId = 1;
const settings = new Map();

vi.mock("idb", () => ({
  openDB: vi.fn(() =>
    Promise.resolve({
      add: vi.fn((_storeName, record) => {
        const stored = { ...record, id: nextId++ };
        entries.push(stored);
        return Promise.resolve(stored.id);
      }),
      count: vi.fn(() => Promise.resolve(entries.length)),
      clear: vi.fn(() => {
        entries = [];
        return Promise.resolve();
      }),
      getAllFromIndex: vi.fn(() =>
        Promise.resolve([...entries].sort((a, b) => a.timestamp - b.timestamp)),
      ),
      transaction: vi.fn(() => {
        // Cursor over entries sorted by timestamp ascending (oldest first),
        // supporting exactly what enforceCap() needs: delete + continue.
        const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
        let index = 0;
        const makeCursor = () => {
          if (index >= sorted.length) return null;
          const current = sorted[index];
          return {
            delete: vi.fn(() => {
              entries = entries.filter((e) => e.id !== current.id);
              return Promise.resolve();
            }),
            continue: vi.fn(() => {
              index++;
              return Promise.resolve(makeCursor());
            }),
          };
        };
        return {
          store: {
            index: vi.fn(() => ({
              openCursor: vi.fn(() => Promise.resolve(makeCursor())),
            })),
          },
          done: Promise.resolve(),
        };
      }),
    }),
  ),
}));

vi.mock("./storage.js", () => ({
  getSetting: vi.fn((key) => Promise.resolve(settings.get(key) ?? null)),
  setSetting: vi.fn((key, value) => {
    settings.set(key, value);
    return Promise.resolve();
  }),
}));

beforeEach(() => {
  entries = [];
  nextId = 1;
  settings.clear();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("mcpAuditLog", () => {
  it("appends an entry with the expected shape", async () => {
    const { appendAuditEntry, getRecentAuditEntries } = await import("./mcpAuditLog.js");

    await appendAuditEntry({
      tool: "list_notebooks",
      arguments: {},
      ok: true,
      durationMs: 12,
    });

    const recent = await getRecentAuditEntries();
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      tool: "list_notebooks",
      arguments: {},
      ok: true,
      errorMessage: null,
      durationMs: 12,
    });
    expect(typeof recent[0].timestamp).toBe("number");
  });

  it("records the authenticating token's name, defaulting to null when absent", async () => {
    const { appendAuditEntry, getRecentAuditEntries } = await import("./mcpAuditLog.js");

    await appendAuditEntry({
      tool: "list_notebooks",
      arguments: {},
      tokenName: "Claude Desktop",
      ok: true,
      durationMs: 1,
    });
    await appendAuditEntry({ tool: "list_notes", arguments: {}, ok: true, durationMs: 1 });

    const recent = await getRecentAuditEntries();
    expect(recent[0].tokenName).toBe(null); // most recent append (list_notes) had no tokenName passed
    expect(recent[1].tokenName).toBe("Claude Desktop");
  });

  it("records failed calls with their error message", async () => {
    const { appendAuditEntry, getRecentAuditEntries } = await import("./mcpAuditLog.js");

    await appendAuditEntry({
      tool: "get_note",
      arguments: { id: "missing" },
      ok: false,
      errorMessage: "Note not found: missing",
      durationMs: 3,
    });

    const [entry] = await getRecentAuditEntries();
    expect(entry.ok).toBe(false);
    expect(entry.errorMessage).toBe("Note not found: missing");
  });

  it("does nothing when audit logging is disabled", async () => {
    const { appendAuditEntry, setAuditLogEnabled, getAuditEntryCount } = await import(
      "./mcpAuditLog.js"
    );

    await setAuditLogEnabled(false);
    await appendAuditEntry({ tool: "list_notebooks", arguments: {}, ok: true, durationMs: 1 });

    expect(await getAuditEntryCount()).toBe(0);
  });

  it("defaults to enabled when no setting has been saved yet", async () => {
    const { isAuditLogEnabled } = await import("./mcpAuditLog.js");
    expect(await isAuditLogEnabled()).toBe(true);
  });

  it("evicts the oldest entries once the count exceeds the cap", async () => {
    const { appendAuditEntry, getAuditEntryCount } = await import("./mcpAuditLog.js");

    // Seed entries directly (bypassing appendAuditEntry's own cap check per
    // call) so the test doesn't need to actually perform 15,001 appends.
    const cap = 15000;
    for (let i = 0; i < cap; i++) {
      entries.push({
        id: nextId++,
        timestamp: i,
        tool: "list_notebooks",
        arguments: {},
        ok: true,
        errorMessage: null,
        durationMs: 1,
      });
    }
    expect(entries.length).toBe(cap);

    // One more append should push it over the cap and trigger eviction of
    // exactly the single oldest entry (timestamp 0).
    await appendAuditEntry({
      tool: "search_notes",
      arguments: { query: "x" },
      ok: true,
      durationMs: 5,
    });

    const count = await getAuditEntryCount();
    expect(count).toBe(cap); // back down to the cap, not cap+1
    expect(entries.some((e) => e.timestamp === 0)).toBe(false); // oldest evicted
    expect(entries.some((e) => e.tool === "search_notes")).toBe(true); // newest kept
  });

  it("clearAuditLog removes all entries", async () => {
    const { appendAuditEntry, clearAuditLog, getAuditEntryCount } = await import(
      "./mcpAuditLog.js"
    );

    await appendAuditEntry({ tool: "list_notebooks", arguments: {}, ok: true, durationMs: 1 });
    await appendAuditEntry({ tool: "list_notes", arguments: {}, ok: true, durationMs: 1 });
    expect(await getAuditEntryCount()).toBe(2);

    await clearAuditLog();
    expect(await getAuditEntryCount()).toBe(0);
  });

  it("getRecentAuditEntries returns newest first and respects the limit", async () => {
    const { getRecentAuditEntries } = await import("./mcpAuditLog.js");

    for (let i = 0; i < 5; i++) {
      entries.push({
        id: nextId++,
        timestamp: i,
        tool: `tool_${i}`,
        arguments: {},
        ok: true,
        errorMessage: null,
        durationMs: 1,
      });
    }

    const recent = await getRecentAuditEntries(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].tool).toBe("tool_4"); // newest first
    expect(recent[1].tool).toBe("tool_3");
  });

  it("getRecentAuditEntries supports paging via offset", async () => {
    const { getRecentAuditEntries } = await import("./mcpAuditLog.js");

    for (let i = 0; i < 5; i++) {
      entries.push({
        id: nextId++,
        timestamp: i,
        tool: `tool_${i}`,
        arguments: {},
        ok: true,
        errorMessage: null,
        durationMs: 1,
      });
    }

    const page2 = await getRecentAuditEntries(2, 2);
    expect(page2).toHaveLength(2);
    expect(page2[0].tool).toBe("tool_2");
    expect(page2[1].tool).toBe("tool_1");
  });
});
