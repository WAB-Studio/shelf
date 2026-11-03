import assert from "node:assert/strict";
import test from "node:test";

import messages from "@/messages/es/import.json";
import { movedExample } from "./example";

const example = messages.template.example;

test("RP-149: on 2026-10-01 the text example is the catalogue's own", () => {
  assert.equal(movedExample(example, "2026-10-01"), example);
});

test("RP-149: on 2026-11-02 the example starts in November, each date moved once", () => {
  const moved = movedExample(example, "2026-11-02");
  assert.ok(!moved.includes("2026-10"), moved);
  assert.ok(moved.includes("- 2026-11-01 a 2027-01-31 · Evals y harness"));
  assert.ok(moved.includes("- 2026-11 · 12 h\n- 2026-12 · 20 h"));
  assert.ok(moved.includes("horizonte: 2028-11-01") && moved.includes("horizonte: 2027-11-01") && moved.includes("horizonte: 2027-04-01"));
  assert.ok(moved.includes("- 2026-11 · 4 h · Leer AI Engineering"));
});
