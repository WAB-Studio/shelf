// One caller spends at most a fifth of the day's model calls across every
// paid route. The database is a stand-in that counts per (client) row the way
// `claimClientCall`'s conditional upsert does; nothing is read or written.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, mock, test } from "node:test";

const here = (p: string) => new URL(p, import.meta.url).href;

const stubRoot = mkdtempSync(path.join(tmpdir(), "server-only-"));
mkdirSync(path.join(stubRoot, "server-only"));
writeFileSync(path.join(stubRoot, "server-only", "index.js"), "module.exports = {};\n");
process.env.NODE_PATH = stubRoot;
(Module as unknown as { _initPaths: () => void })._initPaths();
after(() => rmSync(stubRoot, { recursive: true, force: true }));

const rows = new Map<string, number>();

// The SQL's two bound values, in order: the caller's row key and the cap.
const db = {
  execute: async (query: { queryChunks: unknown[] }) => {
    const params = query.queryChunks.filter((c) => typeof c === "string" || typeof c === "number");
    const client = params[0] as string;
    const cap = params[1] as number;
    const calls = rows.get(client) ?? 0;
    if (calls >= cap) return [];
    rows.set(client, calls + 1);
    return [{ calls: calls + 1 }];
  },
};

mock.module(here("../../db/client.ts"), { namedExports: { db } });
mock.module(here("../env.ts"), { namedExports: { env: { CLIENT_KEY_SALT: "x".repeat(16) } } });

beforeEach(() => rows.clear());

test("a caller is refused at a fifth of the day's calls", async () => {
  const { claimCallerShare } = await import("./caller-share");
  const results: boolean[] = [];
  for (let i = 0; i < 12; i++) results.push(await claimCallerShare("a", 50));
  assert.equal(results.filter(Boolean).length, 10);
  assert.deepEqual(results.slice(0, 10), Array(10).fill(true));
  assert.equal(results[10], false);
});

test("another caller still passes when the first is refused", async () => {
  const { claimCallerShare } = await import("./caller-share");
  for (let i = 0; i < 10; i++) await claimCallerShare("a", 50);
  assert.equal(await claimCallerShare("a", 50), false);
  assert.equal(await claimCallerShare("b", 50), true);
});

test("the share derives from the day cap and is never below one call", async () => {
  const { callerShareCap } = await import("./caller-share");
  assert.equal(callerShareCap(100), 20);
  assert.equal(callerShareCap(7), 1);
  assert.equal(callerShareCap(1), 1);
});
