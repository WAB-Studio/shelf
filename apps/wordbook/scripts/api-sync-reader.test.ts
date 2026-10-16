// A round sent for one reader under another reader's session writes nothing.
// Session and database are stand-ins: no `reading.*` row is touched.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, mock, test } from "node:test";

const here = (relative: string) => new URL(relative, import.meta.url).href;

const stubRoot = mkdtempSync(path.join(tmpdir(), "server-only-"));
mkdirSync(path.join(stubRoot, "server-only"));
writeFileSync(path.join(stubRoot, "server-only", "index.js"), "module.exports = {};\n");
process.env.NODE_PATH = stubRoot;
(Module as unknown as { _initPaths: () => void })._initPaths();
after(() => rmSync(stubRoot, { recursive: true, force: true }));

const SESSION_READER = "11111111-1111-4111-8111-111111111111";
const OTHER_READER = "22222222-2222-4222-8222-222222222222";
const DEVICE = "33333333-3333-4333-8333-333333333333";

let dbCalls = 0;
mock.module(here("../lib/session.ts"), {
  namedExports: {
    getReader: async () => ({ id: SESSION_READER }),
    withReaderDb: async () => {
      dbCalls += 1;
      return { status: "ok", accepted: 0, downloaded: [] };
    },
  },
});
mock.module(here("../lib/sync/upload.ts"), { namedExports: { downloadRows: async () => [], writeUpload: async () => ({}) } });

const post = async (body: unknown) => {
  const { POST } = await import("../app/api/log/sync/route");
  return POST(new Request("http://localhost/api/log/sync", { method: "POST", body: JSON.stringify(body) }));
};

test("a round sent for another reader answers 409 and reaches no database", async () => {
  dbCalls = 0;
  const response = await post({ deviceId: DEVICE, readerId: OTHER_READER, rows: [], since: null });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "reader" });
  assert.equal(dbCalls, 0);
});

test("a round sent for the session's reader goes through", async () => {
  dbCalls = 0;
  const response = await post({ deviceId: DEVICE, readerId: SESSION_READER, rows: [], since: null });
  assert.equal(response.status, 200);
  assert.equal(dbCalls, 1);
});

test("a round with no readerId is refused as invalid", async () => {
  dbCalls = 0;
  const response = await post({ deviceId: DEVICE, rows: [], since: null });
  assert.equal(response.status, 400);
  assert.equal(dbCalls, 0);
});
