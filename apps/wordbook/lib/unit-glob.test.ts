// check:unit must discover every test directory, scripts/mcp included.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

test("the check:unit glob discovers scripts/mcp/aggregate.test.ts and lib tests", () => {
  const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const pattern = /"([^"]+\.test\.ts)"/.exec(pkg.scripts["check:unit"])?.[1];
  assert.ok(pattern, "check:unit names a test glob");
  assert.ok(path.matchesGlob("scripts/mcp/aggregate.test.ts", pattern));
  assert.ok(path.matchesGlob("lib/provider/fetch.test.ts", pattern));
});
