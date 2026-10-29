import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { clearCreated, describePart, failedReasonKey, readCreated, reasonSentence, saveCreated } from "./created-store";

const catalogue = JSON.parse(readFileSync(new URL("../../messages/es/import.json", import.meta.url), "utf8"));
const memory = new Map<string, string>();
(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
};

const leaf = (key: string): unknown => key.split(".").slice(1).reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalogue);

// The reasons `FailedPart.reason` carries: the constraint map and the fallback of app/actions/import.ts.
const REASONS = [
  "import.errors.cadenceWeekdays",
  "import.errors.cadenceCount",
  "import.errors.quantityNoAmount",
  "import.errors.noteShape",
  "import.errors.partFailed",
  "import.errors.phaseOverlaps",
];

test("every reason a failed part carries has a sentence of its own, and none says «tabla»", () => {
  assert.deepEqual(Object.keys(failedReasonKey).sort(), [...REASONS].sort());
  for (const reason of REASONS) {
    const sentence = leaf(reasonSentence(reason));
    assert.equal(typeof sentence, "string", reason);
    assert.doesNotMatch(sentence as string, /tabla/i, reason);
    assert.notEqual(sentence, leaf(reason), `${reason} reuses the sentence written for before the create`);
  }
});

test("an unknown reason reads as the general one", () => {
  assert.equal(reasonSentence("import.errors.other"), "import.created.reasons.partFailed");
});

test("describePart names the goal and the kind from the path", () => {
  const goal = { name: "Casa", tasks: [{ name: "A", month: "2026-10", children: [] }] };
  const draft = { goals: [goal] } as never;
  const task = describePart(draft, { path: "goals.0.tasks.0", name: "A", reason: "x" });
  assert.deepEqual([task.goal, task.kind, task.month], ["Casa", "task", "2026-10"]);
  assert.equal(describePart(draft, { path: "goals.0.tasks.0.children.1", name: "B", reason: "x" }).kind, "subtask");
  assert.equal(describePart(draft, { path: "goals.0.commitments.0", name: "C", reason: "x" }).kind, "commitment");
});

test("the result is kept, read back and cleared; junk reads as nothing", () => {
  const result = { goals: 3, updated: 1, parts: [{ name: "A", goal: "Casa", kind: "task" as const, month: "2026-10", reason: "import.errors.noteShape" }] };
  saveCreated(result);
  assert.deepEqual(readCreated(), result);
  clearCreated();
  assert.equal(readCreated(), null);
  memory.set("pulsar.import-created", "{nope");
  assert.equal(readCreated(), null);
});

test("903: a stored result with no readable part reads as nothing", () => {
  memory.set("pulsar.import-created", JSON.stringify({ goals: 2, parts: [] }));
  assert.equal(readCreated(), null);
  memory.set("pulsar.import-created", JSON.stringify({ goals: 2, parts: [{ name: "x", goal: "g", kind: "nope", reason: "r" }] }));
  assert.equal(readCreated(), null);
  clearCreated();
});

test("903: a refused month is named by its month, and each reason reads as its own sentence", () => {
  const draft = { goals: [{ name: "Casa", tasks: [] }] } as never;
  const part = describePart(draft, { path: "goals.0.months.2", name: "2026-11", reason: "x" });
  assert.deepEqual([part.kind, part.month, part.name], ["month", "2026-11", "2026-11"]);
  assert.equal(reasonSentence("import.errors.cadenceCount"), "import.created.reasons.cadenceCount");
  assert.equal(reasonSentence("import.errors.cadenceWeekdays"), "import.created.reasons.cadenceWeekdays");
  assert.equal(reasonSentence("import.errors.quantityNoAmount"), "import.created.reasons.quantityNoAmount");
  assert.equal(reasonSentence("import.errors.noteShape"), "import.created.reasons.noteShape");
});
