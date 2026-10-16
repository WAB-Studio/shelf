/**
 * A local MCP server, by stdio, over the reader's own exported log file
 * (RL-27). JSON-RPC 2.0 hand-written — no SDK, per `docs/voyager/SPEC.md`
 * §4's closed dependency list and its "do not install" wrappers on
 * principle. Three read-only tools; not one write ever opens the file.
 *
 * Run: `VOYAGER_LOG_PATH=/path/to/registro-lecturas-*.json npm run -w apps/voyager mcp:serve`
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { recentWords, topWords, wordHistory, type WordAggregate } from "./aggregate";
import type { LogExport } from "../../lib/log/export";
import type { LookupRecord } from "../../lib/log/types";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolContent(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

const TOOLS = [
  {
    name: "top_words",
    description: "The words most looked up in the reader's exported log, most frequent first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many words to return." },
        sinceDays: { type: "number", description: "Drop rows older than this many days." },
      },
      required: ["limit"],
    },
  },
  {
    name: "recent_words",
    description: "The words most recently looked up in the reader's exported log.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many words to return." },
      },
      required: ["limit"],
    },
  },
  {
    name: "word_history",
    description: "Every recorded lookup for one word, oldest first.",
    inputSchema: {
      type: "object",
      properties: {
        word: { type: "string", description: "The word, as its normalised form or as typed." },
      },
      required: ["word"],
    },
  },
] as const;

// Read once and reused: reading never touches `mtime`, so caching across the
// session's calls costs nothing the file's own age doesn't already cost.
let cachedRows: LookupRecord[] | null = null;

class LogReadError extends Error {}

function loadRows(): LookupRecord[] {
  if (cachedRows) return cachedRows;
  const path = process.env.VOYAGER_LOG_PATH;
  if (!path) throw new LogReadError("VOYAGER_LOG_PATH is not set.");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new LogReadError(`Cannot read ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new LogReadError(`Malformed export at ${path}: ${(error as Error).message}`);
  }
  const candidate = parsed as Partial<LogExport>;
  if (!candidate || !Array.isArray(candidate.rows)) {
    throw new LogReadError(`Malformed export at ${path}: no "rows" array.`);
  }
  cachedRows = candidate.rows as LookupRecord[];
  return cachedRows;
}

function requireObject(params: unknown): Record<string, unknown> {
  if (typeof params !== "object" || params === null) throw new TypeError("params must be an object.");
  return params as Record<string, unknown>;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number") throw new TypeError(`"${name}" must be a number.`);
  return value;
}

function callTool(name: string, params: unknown): WordAggregate[] | LookupRecord[] {
  const args = requireObject(params);
  const rows = loadRows();
  switch (name) {
    case "top_words":
      return topWords(rows, {
        limit: requireNumber(args.limit, "limit"),
        sinceDays: args.sinceDays === undefined ? undefined : requireNumber(args.sinceDays, "sinceDays"),
      });
    case "recent_words":
      return recentWords(rows, { limit: requireNumber(args.limit, "limit") });
    case "word_history":
      if (typeof args.word !== "string") throw new TypeError('"word" must be a string.');
      return wordHistory(rows, args.word);
    default:
      throw new RangeError(`Unknown tool "${name}".`);
  }
}

function handle(request: JsonRpcRequest): JsonRpcResponse | null {
  // A notification (no `id`) gets no reply, per JSON-RPC 2.0.
  const isNotification = request.id === undefined;
  const id: JsonRpcId = request.id ?? null;
  let response: JsonRpcResponse;
  try {
    switch (request.method) {
      case "initialize":
        response = ok(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "voyager-reading-log", version: "1" },
        });
        break;
      case "tools/list":
        response = ok(id, { tools: TOOLS });
        break;
      case "tools/call": {
        const args = requireObject(request.params);
        if (typeof args.name !== "string") throw new TypeError('"name" must be a string.');
        response = ok(id, toolContent(callTool(args.name, args.arguments)));
        break;
      }
      default:
        response = fail(id, METHOD_NOT_FOUND, `Unknown method "${request.method}".`);
    }
  } catch (error) {
    if (error instanceof LogReadError) response = fail(id, INTERNAL_ERROR, error.message);
    else if (error instanceof TypeError || error instanceof RangeError) {
      response = fail(id, INVALID_PARAMS, error.message);
    } else response = fail(id, INTERNAL_ERROR, (error as Error).message);
  }
  return isNotification ? null : response;
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    process.stdout.write(`${JSON.stringify(fail(null, PARSE_ERROR, "Invalid JSON."))}\n`);
    return;
  }
  const response = handle(request);
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
});
