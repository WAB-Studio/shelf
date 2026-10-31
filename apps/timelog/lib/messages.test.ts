import assert from "node:assert/strict";
import { test } from "node:test";

import enCommon from "../messages/en/common.json";
import enTime from "../messages/en/time.json";
import esCommon from "../messages/es/common.json";
import esTime from "../messages/es/time.json";

// Every key as a dotted path, an array counted as its length.
function paths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return [`${prefix}[${value.length}]`];
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([key, one]) => paths(one, prefix ? `${prefix}.${key}` : key));
  return [prefix];
}

test("English carries exactly the keys Spanish does", () => {
  assert.deepEqual(paths(enCommon).sort(), paths(esCommon).sort());
  assert.deepEqual(paths(enTime).sort(), paths(esTime).sort());
});
