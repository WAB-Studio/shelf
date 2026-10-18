// A sync round that names searches to delete (RL-66, RL-70) costs the same three
// statements as one that does not (the gate, the write, the download), answers both new fields on every 200, and
// hands the named marks and the mark cursor to the statement that owns them.
// The session is a stand-in whose transaction counts `execute` calls; the real
// route and the real `lib/sync/upload.ts` run on top of it. Nothing touches Postgres.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, mock, test } from "node:test";

import { PgDialect } from "drizzle-orm/pg-core";

const here = (relative: string) => new URL(relative, import.meta.url).href;

const stubRoot = mkdtempSync(path.join(tmpdir(), "server-only-"));
mkdirSync(path.join(stubRoot, "server-only"));
writeFileSync(path.join(stubRoot, "server-only", "index.js"), "module.exports = {};\n");
process.env.NODE_PATH = stubRoot;
(Module as unknown as { _initPaths: () => void })._initPaths();
after(() => rmSync(stubRoot, { recursive: true, force: true }));

const READER = "11111111-1111-4111-8111-111111111111";
const DEVICE = "33333333-3333-4333-8333-333333333333";
const PEER = "44444444-4444-4444-8444-444444444444";
const MARK_DEVICE = "55555555-5555-4555-8555-555555555555";
const SINCE_AT = "2026-10-08T12:00:00.123456Z";

const state = { signedIn: true, retired: false, allowed: true, executed: [] as { sql: string; params: unknown[] }[] };

// The first statement is `reading.sync_gate`: a day past the cap reads as a count
// no batch fits under. The second answers its row whatever columns the route
// reads off it; the third finds no peer rows.
function gateRow(): unknown {
  return { retired: state.retired, today: state.allowed ? "0" : String(Number.MAX_SAFE_INTEGER) };
}

function writeRow(): unknown {
  return new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "retired") return state.retired;
        if (key === "allowed") return state.allowed;
        if (key === "tombstones") return [];
        return 0;
      },
    },
  );
}

mock.module(here("../lib/session.ts"), {
  namedExports: {
    getReader: async () => (state.signedIn ? { id: READER } : null),
    withReaderDb: async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
          const { sql, params } = new PgDialect().sqlToQuery(query);
          state.executed.push({ sql, params });
          return state.executed.length === 1 ? [gateRow()] : state.executed.length === 2 ? [writeRow()] : [];
        },
      }),
  },
});

beforeEach(() => {
  Object.assign(state, { signedIn: true, retired: false, allowed: true, executed: [] });
});

const post = async (body: unknown) => {
  const { POST } = await import("../app/api/log/sync/route");
  const response = await POST(new Request("http://localhost/api/log/sync", { method: "POST", body: JSON.stringify(body) }));
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
};

const base = { deviceId: DEVICE, readerId: READER, rows: [], since: null };
const marks = (count: number) => Array.from({ length: count }, (_, index) => ({ deviceId: MARK_DEVICE, localId: index + 1 }));
const cursorAt = (deviceId: string, localId: number) => `${SINCE_AT}|${deviceId}|${localId}`;

test("a round costs three statements past settle, with tombstones named or not", async () => {
  await post(base);
  assert.equal(state.executed.length, 3, "no tombstones");

  state.executed = [];
  await post({ ...base, tombstones: marks(3), tombstonesSince: cursorAt(PEER, 7) });
  assert.equal(state.executed.length, 3, "tombstones and a mark cursor");
  assert.ok(JSON.stringify(state.executed[1].params).includes(MARK_DEVICE), "and the tombstones ride in the write, the second of them");

  state.executed = [];
  await post({ ...base, tombstones: marks(500), since: cursorAt(PEER, 2) });
  assert.equal(state.executed.length, 3, "a full list of tombstones and a download cursor");
});

test("a body written before tombstones existed answers 200 with both fields present", async () => {
  const response = await post(base);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.tombstones, []);
  assert.equal(response.json.tombstoneCursor, null);
  assert.ok("tombstoneCursor" in response.json, "the key is on the wire, not dropped");
});

test("the mark cursor echoes a legible tombstonesSince when no mark came down", async () => {
  const legible = cursorAt(PEER, 7);
  const response = await post({ ...base, tombstonesSince: legible });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.tombstones, []);
  assert.equal(response.json.tombstoneCursor, legible);
});

test("a garbled tombstonesSince is no cursor: 200, nothing echoed, nothing bound", async () => {
  const response = await post({ ...base, tombstonesSince: "x|y|1" });
  assert.equal(response.status, 200);
  assert.equal(response.json.tombstoneCursor, null);
  assert.ok(!JSON.stringify(state.executed.map((call) => call.params)).includes("x|y|1"));
});

test("the cursor of the rows and the cursor of the marks do not stand in for each other", async () => {
  const response = await post({ ...base, since: cursorAt(PEER, 2) });
  assert.equal(response.json.cursor, cursorAt(PEER, 2));
  assert.equal(response.json.tombstoneCursor, null);
});

test("the named tombstones and the decoded mark cursor reach the write statement", async () => {
  await post({ ...base, tombstones: marks(2), tombstonesSince: cursorAt(PEER, 7) });
  const bound = JSON.stringify(state.executed[1].params);
  assert.ok(bound.includes(MARK_DEVICE), "the device named by a tombstone is a parameter");
  assert.ok(bound.includes(PEER), "the device of the mark cursor is a parameter");
  assert.ok(bound.includes(SINCE_AT), "the instant of the mark cursor is a parameter");
});

test("a tombstone list with no entry binds none of the named device", async () => {
  await post({ ...base, tombstones: [] });
  assert.ok(!JSON.stringify(state.executed[1].params).includes(MARK_DEVICE));
});

test("500 tombstones pass and 501 are a bad request that reaches no statement", async () => {
  assert.equal((await post({ ...base, tombstones: marks(500) })).status, 200);
  state.executed = [];
  const refused = await post({ ...base, tombstones: marks(501) });
  assert.equal(refused.status, 400);
  assert.equal(state.executed.length, 0);
});

test("a malformed tombstone is a bad request that reaches no statement", async () => {
  const refused = await post({ ...base, tombstones: [{ deviceId: "nope", localId: 0 }] });
  assert.equal(refused.status, 400);
  assert.equal(state.executed.length, 0);
});

test("a retired device answers 409 and a day past the cap 429, tombstones named", async () => {
  state.retired = true;
  const retired = await post({ ...base, tombstones: marks(2) });
  assert.equal(retired.status, 409);
  assert.deepEqual(retired.json, { error: "retired" });

  Object.assign(state, { retired: false, allowed: false, executed: [] });
  const quota = await post({ ...base, tombstones: marks(2) });
  assert.equal(quota.status, 429);
  assert.deepEqual(quota.json, { error: "quota" });
});

test("no session answers 401 and reaches no statement", async () => {
  state.signedIn = false;
  const response = await post({ ...base, tombstones: marks(1) });
  assert.equal(response.status, 401);
  assert.equal(state.executed.length, 0);
});
