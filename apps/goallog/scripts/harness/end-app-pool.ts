// Preloaded with `--import` into every test file `node --test` spawns. db/client.ts keeps its pool, which
// idles for 240 s in production (RNP-02), on `globalThis.sql`; without this each process outlives its tests
// until those sockets time out.
import { after } from "node:test";

after(async () => {
  const pool = (globalThis as { sql?: { end: () => Promise<void> } }).sql;
  if (pool) await pool.end();
});
