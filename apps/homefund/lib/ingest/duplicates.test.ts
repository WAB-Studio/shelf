import assert from "node:assert/strict";
import { test } from "node:test";

import { judgeDuplicate, type DuplicateCandidate } from "./duplicates";

function candidate(overrides: Partial<DuplicateCandidate> & { id: string }): DuplicateCandidate {
  return {
    status: "pending",
    receipt: false,
    shapeHash: "a".repeat(64),
    direction: "expense",
    merchantKey: null,
    merchantLabel: null,
    ...overrides,
  };
}

const receipt = { receipt: true, shapeHash: "b".repeat(64), direction: "expense" as const };
const alert = { receipt: false, shapeHash: "c".repeat(64), direction: "expense" as const };

test("a receipt repeats the pending or accepted alert of the same payment", () => {
  assert.deepEqual(judgeDuplicate(receipt, [candidate({ id: "alert" })]), {
    kind: "repeats",
    of: candidate({ id: "alert" }),
  });
  const accepted = candidate({ id: "done", status: "accepted" });
  const waiting = candidate({ id: "waiting" });
  const verdict = judgeDuplicate(receipt, [waiting, accepted]);
  assert.equal(verdict.kind, "repeats");
  assert.equal(verdict.kind === "repeats" && verdict.of.id, "done");
});

test("a receipt with no alert stays pending, unless a receipt of another template reports the payment", () => {
  assert.deepEqual(judgeDuplicate(receipt, []), { kind: "none" });
  assert.deepEqual(judgeDuplicate(receipt, [candidate({ id: "same", receipt: true, shapeHash: receipt.shapeHash })]), {
    kind: "none",
  });
  const verdict = judgeDuplicate(receipt, [candidate({ id: "gateway", receipt: true })]);
  assert.equal(verdict.kind === "repeats" && verdict.of.id, "gateway");
});

test("an alert replaces the receipts still waiting and never repeats another alert", () => {
  assert.deepEqual(judgeDuplicate(alert, [candidate({ id: "other-alert" })]), { kind: "none" });
  const verdict = judgeDuplicate(alert, [
    candidate({ id: "r1", receipt: true }),
    candidate({ id: "r2", receipt: true }),
    candidate({ id: "alert" }),
  ]);
  assert.equal(verdict.kind, "supersedes");
  assert.deepEqual(verdict.kind === "supersedes" && verdict.pending.map((row) => row.id), ["r1", "r2"]);
});

test("an alert that arrives after its receipt was accepted is the repeat", () => {
  const verdict = judgeDuplicate(alert, [candidate({ id: "r1", receipt: true, status: "accepted" })]);
  assert.equal(verdict.kind === "repeats" && verdict.of.id, "r1");
});

test("an income and an expense of one figure are two movements", () => {
  assert.deepEqual(judgeDuplicate(receipt, [candidate({ id: "refund", direction: "income" })]), { kind: "none" });
  assert.equal(judgeDuplicate(receipt, [candidate({ id: "unknown", direction: null })]).kind, "repeats");
});
