import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// `json_agg` without `order by` answers in heap order, so an UPDATE sends the row to the end of
// the list (a phase edited through «Cambiar la fase» fell below the future ones). Every list a
// screen draws in the order it came back must say its order.
const root = join(import.meta.dirname, "..", "..");
const files = [
  ...readdirSync(join(root, "lib", "queries")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(root, "lib", "queries", f)),
  join(root, "app", "actions", "plan.ts"),
];

// Aggregates of unordered sets: a flag list and a day set read by membership, never by position.
const sets = ["g.horizon::text", "x.horizon::text", "'commitment_id', f.commitment_id", "'satisfaction', c.satisfaction"];

test("every json_agg that lists rows names its order", () => {
  const bare: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/json_agg\(/g)) {
      let i = m.index + m[0].length;
      let depth = 1;
      while (depth) depth += (src[i] === "(" ? 1 : 0) - (src[i++] === ")" ? 1 : 0);
      const call = src.slice(m.index, i);
      if (/\border by\b/.test(call) || sets.some((s) => call.includes(s))) continue;
      bare.push(`${file.slice(root.length)}:${src.slice(0, m.index).split("\n").length}`);
    }
  }
  assert.deepEqual(bare, []);
});
