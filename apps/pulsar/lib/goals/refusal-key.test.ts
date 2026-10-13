import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { REFUSAL_CODES, refusalKey, refusalName } from "./refusal-key";

const tree = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "messages", "es", "tree.json"), "utf8"));
const read = (key: string): unknown => key.split(".").slice(1).reduce((n, p) => (n as Record<string, unknown> | undefined)?.[p], tree);

test("the table names all eight placement codes", () => {
  assert.deepEqual([...REFUSAL_CODES].sort(), ["aboveArchived", "aboveClosed", "belowEndsLater", "belowNoEnd", "closed", "cycle", "endPastAbove", "tooDeep"]);
});

test("every placement code maps to a message in tree.json", () => {
  for (const code of REFUSAL_CODES) {
    const key = refusalKey(code);
    assert.match(key, /^tree\.errors\./);
    assert.equal(typeof read(key), "string", `${code} -> ${key} has no message`);
  }
});

test("a refusal that blames a goal names it in its words", () => {
  for (const code of ["aboveClosed", "endPastAbove", "belowEndsLater", "aboveArchived"] as const) {
    assert.match(read(refusalKey(code)) as string, /\{name\}/, code);
  }
});

test("refusalName reads the goal each refusal carries", () => {
  const ref = { id: "a", name: "Caso", horizon: "2026-12-31" };
  assert.equal(refusalName({ code: "belowEndsLater", below: ref }), "Caso");
  assert.equal(refusalName({ code: "endPastAbove", above: ref }), "Caso");
  assert.equal(refusalName({ code: "cycle" }), null);
});

test("the holder and lookup messages exist", () => {
  for (const k of ["notFound", "holderNoRhythm", "holderNoBudget", "holderTaskFixed"]) {
    assert.equal(typeof read(`tree.errors.${k}`), "string", k);
  }
});
