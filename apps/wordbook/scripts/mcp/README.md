# Reading log MCP server

A local, read-only MCP server over the reading log the app exports from
`/registro` (RL-20). It runs on the reader's own machine, never as part of
the deployed app, and reads a JSON file — it never touches IndexedDB, the
network or the database `apps/voyager` uses for the sync copy.

## Run it

```
VOYAGER_LOG_PATH=/path/to/registro-lecturas-2026-09-08.json npm run -w apps/voyager mcp:serve
```

`VOYAGER_LOG_PATH` names the file `/registro`'s download produced. The
server reads it lazily, on the first tool call, and caches the rows for the
rest of the session — it never writes to the file, so its `mtime` never
moves.

## Point Claude Desktop at it

Add to Claude Desktop's MCP config:

```json
{
  "mcpServers": {
    "voyager-reading-log": {
      "command": "npx",
      "args": ["tsx", "apps/voyager/scripts/mcp/server.ts"],
      "cwd": "/absolute/path/to/finances-app",
      "env": { "VOYAGER_LOG_PATH": "/absolute/path/to/registro-lecturas-2026-09-08.json" }
    }
  }
}
```

The log file ages as soon as it is exported: reexport from `/registro` and
restart the server to pick up newer rows.

## Protocol

JSON-RPC 2.0 over stdin/stdout, one message per line. No SDK: MCP over
stdio is a handful of methods, and `docs/voyager/SPEC.md` §4 rejects
wrapper libraries on principle.

- `initialize` — capability handshake.
- `tools/list` — the three tools below.
- `tools/call` — `{ name, arguments }`, answers `{ content: [{ type: "text", text }] }`
  where `text` is the JSON-encoded result.

## Tools

All three are read-only. None of them ever opens the file for writing.

- **`top_words({ limit, sinceDays? })`** — the words looked up most often,
  most frequent first; `sinceDays` drops rows older than that many days.
  Returns `{ normalised, headword, count, lastAt, missRate }[]`.
- **`recent_words({ limit })`** — the same shape, ordered by the most
  recent lookup first.
- **`word_history({ word })`** — every row the log carries for one word,
  oldest first.

## Errors

A missing `VOYAGER_LOG_PATH`, a file that cannot be read, or a file whose
JSON does not carry a `rows` array all answer a JSON-RPC error on the next
`tools/call` — the process itself never exits, and never crashes on a
malformed request line either.
