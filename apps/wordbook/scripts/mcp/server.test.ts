// RL-27's server driven over its own stdio, as an MCP client drives it: the protocol, the three
// tools and its reading of the exported file, which it never writes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";

import type { LookupRecord } from "../../lib/log/types";

const SERVER = join(import.meta.dirname, "server.ts");
const DAY = 86_400_000;

function row(normalised: string, at: number): LookupRecord {
  return {
    schema: 2,
    at,
    text: normalised,
    normalised,
    kind: "word",
    outcome: "exact",
    headword: normalised,
    rule: null,
    senses: 1,
    translation: null,
    dictionaryReady: true,
    origin: null,
  };
}

const dir = mkdtempSync(join(tmpdir(), "wordbook-mcp-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const logPath = join(dir, "registro-lecturas.json");
const now = Date.now();
writeFileSync(
  logPath,
  JSON.stringify({
    rows: [row("snuff", now - 3 * DAY), row("frisk", now - 2 * DAY), row("snuff", now - DAY)],
  }),
);

type Reply = {
  id: unknown;
  result?: { capabilities?: unknown; tools?: { name: string }[]; content?: { text: string }[] };
  error?: { code: number; message: string };
};

// Writes every line to one server and returns the replies it printed, in order, once stdin closes.
async function converse(lines: string[], env: Record<string, string | undefined>): Promise<Reply[]> {
  const child = spawn(process.execPath, ["--import", "tsx", SERVER], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const replies: Reply[] = [];
  const out = createInterface({ input: child.stdout });
  out.on("line", (line) => replies.push(JSON.parse(line) as Reply));
  const closed = new Promise((resolve) => out.on("close", resolve));
  for (const line of lines) child.stdin.write(`${line}\n`);
  child.stdin.end();
  await closed;
  return replies;
}

const call = (id: number, name: string, args: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const text = (reply: Reply) => JSON.parse(reply.result?.content?.[0]?.text ?? "null");

test("RL-27: the server answers initialize and lists exactly its three tools", async () => {
  const [init, list] = await converse(
    [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ],
    { VOYAGER_LOG_PATH: logPath },
  );
  assert.equal(init.id, 1);
  assert.deepEqual(init.result?.capabilities, { tools: {} });
  assert.deepEqual(
    list.result?.tools?.map((tool) => tool.name),
    ["top_words", "recent_words", "word_history"],
  );
});

test("RL-27: each tool reads the exported file, and the file is left byte for byte as it was", async () => {
  const bytes = readFileSync(logPath);
  const mtime = statSync(logPath).mtimeMs;
  const [top, recent, history] = await converse(
    [
      call(1, "top_words", { limit: 1 }),
      call(2, "recent_words", { limit: 2 }),
      call(3, "word_history", { word: "snuff" }),
    ],
    { VOYAGER_LOG_PATH: logPath },
  );
  assert.equal(text(top)[0].normalised, "snuff");
  assert.equal(text(top).length, 1);
  assert.deepEqual(
    text(recent).map((word: { normalised: string }) => word.normalised),
    ["snuff", "frisk"],
  );
  assert.equal(text(history).length, 2);
  assert.ok(readFileSync(logPath).equals(bytes));
  assert.equal(statSync(logPath).mtimeMs, mtime);
});

test("RL-27: bad input answers its JSON-RPC error, a notification gets no reply", async () => {
  const replies = await converse(
    [
      "not json",
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list" }),
      call(2, "top_words", { limit: "ten" }),
      call(3, "delete_word", {}),
    ],
    { VOYAGER_LOG_PATH: logPath },
  );
  assert.deepEqual(
    replies.map((reply) => [reply.id, reply.error?.code]),
    [
      [null, -32700],
      [1, -32601],
      [2, -32602],
      [3, -32602],
    ],
  );
});

test("RL-27: a missing or malformed file is an error the client reads, never a crash", async () => {
  const broken = join(dir, "roto.json");
  writeFileSync(broken, JSON.stringify({ filas: [] }));
  const [missing] = await converse([call(1, "top_words", { limit: 1 })], {
    VOYAGER_LOG_PATH: join(dir, "no-existe.json"),
  });
  const [malformed, unset] = await converse([call(1, "top_words", { limit: 1 })], {
    VOYAGER_LOG_PATH: broken,
  }).then(async (first) => [
    ...first,
    ...(await converse([call(2, "top_words", { limit: 1 })], { VOYAGER_LOG_PATH: undefined })),
  ]);
  assert.equal(missing.error?.code, -32603);
  assert.match(missing.error?.message ?? "", /Cannot read/);
  assert.match(malformed.error?.message ?? "", /no "rows" array/);
  assert.match(unset.error?.message ?? "", /VOYAGER_LOG_PATH is not set/);
});
