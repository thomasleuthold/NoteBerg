/**
 * MCP Access Log.
 *
 * A durable, capped, restart-surviving audit trail of MCP tool calls —
 * deliberately separate from utils/logger.js (the in-app debug logger), which
 * is unfit for this purpose: in-memory only (nothing survives a restart),
 * capped at 1000 entries with silent oldest-first eviction, JS-only by
 * explicit design (Rust logs never reach it), and casually user-clearable.
 * See documentation/roadmap/mcp/DESIGN.md §2 and PLAN.md Phase 5 for the full
 * rationale.
 *
 * Owns its own dedicated IndexedDB database (not a new object store in
 * storage.js's shared schema) — keeps this fully within MCP-owned files per
 * the containment rule in PLAN.md, independent of note-data versioning.
 *
 * Logs *what was called and with what arguments*, never fetched note
 * content/images/strokes — that's the audit-relevant fact, not the payload.
 */

import { openDB } from "idb";
import { getSetting, setSetting } from "./storage.js";

const DB_NAME = "NoteBergMcpLog";
const DB_VERSION = 1;
const STORE_NAME = "entries";

// User-chosen cap: a simple count limit (oldest evicted first), not
// age-based retention — deliberately simpler, with the size ceiling as the
// primary safeguard against unbounded growth.
const MAX_ENTRIES = 15000;

const AUDIT_LOG_ENABLED_KEY = "mcp_audit_log_enabled";

let dbPromise = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const store = database.createObjectStore(STORE_NAME, {
            keyPath: "id",
            autoIncrement: true,
          });
          store.createIndex("timestamp", "timestamp");
        }
      },
    });
  }
  return dbPromise;
}

/** Audit logging defaults to on — an audit trail that's off by default defeats its own purpose. */
export async function isAuditLogEnabled() {
  return (await getSetting(AUDIT_LOG_ENABLED_KEY)) ?? true;
}

export async function setAuditLogEnabled(enabled) {
  await setSetting(AUDIT_LOG_ENABLED_KEY, enabled);
}

/**
 * Record one MCP tool call. A no-op when audit logging is disabled — existing
 * entries are left untouched (disabling logging and clearing history are two
 * separate, deliberate actions). tokenName is a plain string copy of the
 * authenticating token's name at call time, not a foreign key into the token
 * list — so history stays attributable even after that token is later
 * revoked or renamed (see DESIGN.md §2a).
 * @param {{tool: string, arguments: object, tokenName?: string|null, ok: boolean, errorMessage?: string, durationMs: number}} entry
 */
export async function appendAuditEntry({
  tool,
  arguments: args,
  tokenName,
  ok,
  errorMessage,
  durationMs,
}) {
  if (!(await isAuditLogEnabled())) return;

  const db = await getDb();
  await db.add(STORE_NAME, {
    timestamp: Date.now(),
    tool,
    arguments: args ?? {},
    tokenName: tokenName ?? null,
    ok,
    errorMessage: errorMessage ?? null,
    durationMs,
  });

  await enforceCap(db);
}

/**
 * Evict oldest entries once the cap is exceeded. Runs after each append
 * rather than only periodically — call volume for a personal MCP tool log is
 * low enough that this is cheap, and it keeps the store's size bounded at all
 * times rather than allowing bursts past the cap between maintenance runs.
 */
async function enforceCap(db) {
  const count = await db.count(STORE_NAME);
  if (count <= MAX_ENTRIES) return;

  const overflow = count - MAX_ENTRIES;
  const tx = db.transaction(STORE_NAME, "readwrite");
  let cursor = await tx.store.index("timestamp").openCursor();
  let deleted = 0;
  while (cursor && deleted < overflow) {
    await cursor.delete();
    deleted++;
    cursor = await cursor.continue();
  }
  await tx.done;
}

/**
 * Most recent entries first, paginated. The store is capped at MAX_ENTRIES
 * small structured records (no note content/images), so pulling the whole
 * index and slicing in memory is simpler than cursor-based IndexedDB
 * pagination and cheap enough at this scale.
 * @param {number} limit - Page size.
 * @param {number} offset - Number of (newest-first) entries to skip.
 */
export async function getRecentAuditEntries(limit = 50, offset = 0) {
  const db = await getDb();
  const all = await db.getAllFromIndex(STORE_NAME, "timestamp");
  return all.reverse().slice(offset, offset + limit);
}

export async function getAuditEntryCount() {
  const db = await getDb();
  return db.count(STORE_NAME);
}

/** Explicit, separate action from disabling logging — clears all recorded history. */
export async function clearAuditLog() {
  const db = await getDb();
  await db.clear(STORE_NAME);
}
