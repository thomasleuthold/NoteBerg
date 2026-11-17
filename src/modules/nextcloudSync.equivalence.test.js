/**
 * src/modules/nextcloudSync.equivalence.test.js
 *
 * With notebook sharing switched off, the app talks to Nextcloud the way the
 * released app (`main`, before sharing) does. This replays one sync story
 * (__fixtures__/syncScenarios.js) and compares the requests with the ones
 * recorded from `main` in __fixtures__/syncStory.main.golden.json.
 *
 * What must match, step by step: the requests (method, path, Depth, whether they
 * are conditional, content type, the PROPFIND body) and the outcome of the sync.
 * What may differ: the JSON a note or notebook is uploaded with may carry more
 * fields than before (version stamps, tombstones), but never fewer, and never a
 * changed value for a field `main` already wrote.
 *
 * Re-recording the golden file (only when the released behaviour is what
 * changed, i.e. after a release):
 *   1. extract `main` (git archive main), copy this test, the scenarios file and
 *      the mock server over it, and link node_modules;
 *   2. RECORD_SYNC_GOLDEN=<path> npx vitest run src/modules/nextcloudSync.equivalence.test.js
 * Intended differences from `main` go into INTENDED below, each with its reason.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetch } from "@tauri-apps/plugin-http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockWebDAVServer, wireMockServer } from "./__fixtures__/mockWebDAVServer.js";
import { runStory } from "./__fixtures__/syncScenarios.js";
import { fullSync, hasRemoteChanges } from "./nextcloudSync.js";

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

vi.mock("./storage.js", async (importOriginal) => ({
  ...(await importOriginal()),
  saveFile: vi.fn(async () => "file-id"),
  getFile: vi.fn(async () => new Blob(["test"], { type: "text/plain" })),
  checkFileExists: vi.fn(async () => false),
  deleteFile: vi.fn(async () => {}),
  permanentlyDeleteNote: vi.fn(),
  permanentlyDeleteNotebook: vi.fn(),
  permanentlyDeleteNotesInNotebook: vi.fn(),
  getSetting: vi.fn(async () => null),
  getStorageVersion: vi.fn(async () => 1),
  isLocalEncryptionEnabled: vi.fn(async () => false),
  initStorage: vi.fn(async () => {}),
  updateNote: vi.fn(async () => {}),
  saveNote: vi.fn(async () => {}),
  getNote: vi.fn(async () => null),
  getRawNote: vi.fn(async () => null),
}));

const GOLDEN_PATH = join(process.cwd(), "src/modules/__fixtures__/syncStory.main.golden.json");
const NOW = 1_700_000_000_000;

/**
 * Differences from `main` that are intended. A step name maps to the reason.
 * Empty: the requests are the same.
 */
const INTENDED = {};

function newServer() {
  const server = new MockWebDAVServer();
  wireMockServer(fetch, server);
  return server;
}

async function replay() {
  secrets.set(
    "nextcloud_credentials",
    JSON.stringify({
      serverUrl: "https://cloud.example.com",
      loginName: "testuser",
      appPassword: "app-password-123",
    }),
  );
  return runStory({ newServer, fullSync, hasRemoteChanges });
}

/** A field-by-field check that `actual` holds everything `expected` does, with the same values. */
function superset(expected, actual, path = "") {
  if (expected === null || typeof expected !== "object") {
    return expected === actual
      ? []
      : [`${path}: ${JSON.stringify(expected)} became ${JSON.stringify(actual)}`];
  }
  if (actual === null || typeof actual !== "object") return [`${path}: object became ${actual}`];
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return [`${path}: array of ${expected.length} became ${actual?.length}`];
    }
    return expected.flatMap((value, i) => superset(value, actual[i], `${path}[${i}]`));
  }
  return Object.keys(expected).flatMap((key) =>
    key in actual
      ? superset(expected[key], actual[key], `${path}.${key}`)
      : [`${path}.${key}: dropped`],
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  secrets.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

/** What differs between the released app's story and this one; empty when they match. */
function differences(story, golden) {
  const problems = [];
  if (JSON.stringify(story.map((s) => s.step)) !== JSON.stringify(golden.map((s) => s.step))) {
    return ["the story has other steps than the recorded one"];
  }
  golden.forEach((expected, i) => {
    const actual = story[i];
    if (INTENDED[expected.step]) return;
    if (JSON.stringify(expected.summary) !== JSON.stringify(actual.summary)) {
      problems.push(
        `${expected.step}: outcome ${JSON.stringify(expected.summary)} became ${JSON.stringify(actual.summary)}`,
      );
    }
    const strip = ({ json: _json, ...rest }) => rest;
    const want = expected.requests.map(strip);
    const got = actual.requests.map(strip);
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      problems.push(
        `${expected.step}: requests differ
  released: ${want.map((r) => `${r.method} ${r.path}`).join(" | ")}
  now:      ${got.map((r) => `${r.method} ${r.path}`).join(" | ")}`,
      );
      return;
    }
    expected.requests.forEach((req, j) => {
      if (req.json === undefined) return;
      for (const issue of superset(req.json, actual.requests[j].json, "")) {
        problems.push(`${expected.step}: ${req.method} ${req.path} ${issue}`);
      }
    });
  });
  return problems;
}

const golden = () => JSON.parse(readFileSync(GOLDEN_PATH, "utf-8"));
const recording = Boolean(process.env.RECORD_SYNC_GOLDEN);

describe("with notebook sharing switched off", () => {
  it("syncs with the same requests as the released app", async () => {
    const story = await replay();

    if (recording) {
      writeFileSync(
        process.env.RECORD_SYNC_GOLDEN,
        `${JSON.stringify(story, null, 2)}
`,
      );
      return;
    }

    const problems = differences(story, golden());
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("covers the whole story", async () => {
    const story = await replay();
    // The story is only worth comparing while it exercises uploads, downloads,
    // merges and deletions
    const requests = story.flatMap((s) => s.requests).map((r) => r.method);
    expect(requests).toEqual(expect.arrayContaining(["PROPFIND", "PUT", "GET", "DELETE"]));
    expect(story.some((s) => s.summary.downloadedNotes?.length > 0)).toBe(true);
    expect(story.some((s) => s.summary.uploadedNotes > 0)).toBe(true);
  });

  // The comparison has to be able to fail: with sharing on, the sync asks the
  // server for each item's owner, which the released app never does.
  it.skipIf(recording)("would notice sharing being on", async () => {
    localStorage.setItem("sharing_enabled", "true");
    try {
      const problems = differences(await replay(), golden());
      expect(problems.join("\n")).toContain("requests differ");
    } finally {
      localStorage.removeItem("sharing_enabled");
    }
  });
});
