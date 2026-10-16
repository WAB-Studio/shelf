import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import type { DraftGoal, ImportDraft, ImportDraftV1 } from "./draft";
import { clearDraft, readDraft, readDraftV1, readSourceV1, readText, saveDraft, saveDraftV1, saveReview, saveReviewV1 } from "./draft-store";

const memory = new Map<string, string>();
(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
};

const draft = (amount = 720): ImportDraftV1 => ({
  goals: [
    {
      name: "IA aplicada",
      horizon: "2027-10-01",
      rhythm: null,
      measure: { name: "horas de estudio", unit: "minutos" },
      phases: [{ aim: "Evals", startsOn: "2026-10-01", endsOn: "2026-12-31" }],
      months: [{ month: "2026-10", amount }],
      commitments: [],
      tasks: [],
    },
  ],
});

beforeEach(() => memory.clear());

test("a text save reads back its text, unmarked null", () => {
  saveDraftV1({ via: "template", draft: draft(), source: "texto" });
  assert.equal(readSourceV1(), "texto");
  assert.equal(readDraftV1()?.unmarked, null);
});

test("a file save reads source null", () => {
  saveDraftV1({ via: "model", draft: draft() });
  assert.equal(readDraftV1()?.source, null);
  assert.equal(readSourceV1(), null);
});

test("saveReview keeps amounts, unmarked paths and the source", () => {
  saveDraftV1({ via: "template", draft: draft(), source: "texto" });
  saveReviewV1(draft(900), ["goals.0", "goals.0.tasks.1"]);
  const read = readDraftV1();
  assert.equal(read?.draft.goals[0].months[0].amount, 900);
  assert.deepEqual(read?.unmarked, ["goals.0", "goals.0.tasks.1"]);
  assert.equal(read?.source, "texto");
  assert.equal(read?.via, "template");
  assert.equal(readSourceV1(), "texto");
});

test("saveReview with [] reads [], never null", () => {
  saveDraftV1({ via: "template", draft: draft(), source: "t" });
  saveReviewV1(draft(), []);
  assert.deepEqual(readDraftV1()?.unmarked, []);
});

test("saveReview does nothing when nothing is stored", () => {
  saveReviewV1(draft(), ["a"]);
  assert.equal(memory.size, 0);
});

test("the older shape reads the defaults", () => {
  memory.set("pulsar.import-draft", JSON.stringify({ via: "template", draft: draft() }));
  const read = readDraftV1();
  assert.equal(read?.source, null);
  assert.equal(read?.unmarked, null);
});

test("a non-string unmarked entry is dropped", () => {
  memory.set("pulsar.import-draft", JSON.stringify({ via: "model", draft: draft(), source: null, unmarked: ["a", 3, null, "b"] }));
  assert.deepEqual(readDraftV1()?.unmarked, ["a", "b"]);
});

test("clearDraft then readSource is null", () => {
  saveDraftV1({ via: "template", draft: draft(), source: "t" });
  clearDraft();
  assert.equal(readSourceV1(), null);
});

test("a draft with an unknown field reads null", () => {
  const bad = { goals: [{ ...draft().goals[0], extra: 1 }] };
  memory.set("pulsar.import-draft", JSON.stringify({ via: "template", draft: bad, source: null, unmarked: null }));
  assert.equal(readDraftV1(), null);
});

test("a file save reads back its name, and no text", () => {
  saveDraftV1({ via: "model", draft: draft(), sourceName: "plan-2027.md" });
  const read = readDraftV1();
  assert.equal(read?.sourceName, "plan-2027.md");
  assert.equal(read?.source, null);
});

test("a text save carries no file name", () => {
  saveDraftV1({ via: "template", draft: draft(), source: "texto" });
  assert.equal(readDraftV1()?.sourceName, null);
});

test("saveReview keeps the file name", () => {
  saveDraftV1({ via: "model", draft: draft(), sourceName: "plan-2027.md" });
  saveReviewV1(draft(900), ["goals.0"]);
  assert.equal(readDraftV1()?.sourceName, "plan-2027.md");
});

test("a stored file name that is no string reads null, and the older shape without one reads null", () => {
  memory.set("pulsar.import-draft", JSON.stringify({ via: "model", draft: draft(), sourceName: 3 }));
  assert.equal(readDraftV1()?.sourceName, null);
  memory.set("pulsar.import-draft", JSON.stringify({ via: "model", draft: draft() }));
  assert.equal(readDraftV1()?.sourceName, null);
});

// ---- version 2

const goal2 = (amount = 720): DraftGoal => ({
  key: "g1",
  parent: null,
  name: "IA aplicada",
  horizon: "2027-10-01",
  measure: { name: "horas", unit: "minutos" },
  rhythm: null,
  note: "contexto",
  noteSrc: [{ from: 2, to: 3 }],
  src: [{ from: 1, to: 1 }],
  phases: [],
  months: [{ month: "2026-10", amount, src: [] }],
  commitments: [],
  rules: [],
  tasks: [],
});
const draft2 = (amount = 720): ImportDraft => ({ version: 2, goals: [goal2(amount)] });
const source = { kind: "lines" as const, lines: ["a", "b", "c"] };
const base = { via: "model" as const, draft: draft2(), corrections: [], notices: [], source };

test("v2: a save reads back whole, unmarked null and nothing declined", () => {
  saveDraft({ ...base, sourceName: "plan.md" });
  const read = readDraft();
  assert.equal(read?.version, 2);
  assert.equal(read?.via, "model");
  assert.deepEqual(read?.draft, draft2());
  assert.deepEqual(read?.source, source);
  assert.equal(read?.sourceName, "plan.md");
  assert.equal(read?.unmarked, null);
  assert.deepEqual(read?.declined, []);
});

test("v2: the workbook is a way in", () => {
  saveDraft({ ...base, via: "workbook" });
  assert.equal(readDraft()?.via, "workbook");
});

test("v2: saveReview keeps the draft, the unmarked paths and the declined corrections", () => {
  saveDraft({ ...base, corrections: [{ id: "goals.0:nameShortened", at: "goals.0", code: "nameShortened", said: "s", proposed: "p", declined: "leavesOut" }] });
  saveReview(draft2(900), ["goals.0.tasks.1"], ["goals.0:nameShortened"]);
  const read = readDraft();
  assert.equal(read?.draft.goals[0].months[0].amount, 900);
  assert.deepEqual(read?.unmarked, ["goals.0.tasks.1"]);
  assert.deepEqual(read?.declined, ["goals.0:nameShortened"]);
  assert.equal(read?.corrections.length, 1);
  assert.deepEqual(read?.source, source);
});

test("906: saveReview given corrections keeps those, so an edit that settled one stays settled on reload", () => {
  saveDraft({ ...base, corrections: [{ id: "goals.0:nameShortened", at: "goals.0", code: "nameShortened", said: "s", proposed: "p", declined: "leavesOut" }] });
  saveReview(draft2(), [], [], []);
  assert.deepEqual(readDraft()?.corrections, []);
});

test("v2: a value without version 2 reads null, the older shape included", () => {
  memory.set("pulsar.import-draft", JSON.stringify({ via: "template", draft: { goals: [] }, source: null, unmarked: null }));
  assert.equal(readDraft(), null);
  const v1: ImportDraftV1 = { goals: [] };
  memory.set("pulsar.import-draft", JSON.stringify({ via: "model", draft: v1 }));
  assert.equal(readDraft(), null);
  saveDraft(base);
  const stored = JSON.parse(memory.get("pulsar.import-draft") ?? "{}") as Record<string, unknown>;
  memory.set("pulsar.import-draft", JSON.stringify({ ...stored, version: 1 }));
  assert.equal(readDraft(), null);
});

test("v2: a draft the schema refuses reads null", () => {
  saveDraft(base);
  const stored = JSON.parse(memory.get("pulsar.import-draft") ?? "{}") as { draft: { goals: unknown[] } };
  memory.set("pulsar.import-draft", JSON.stringify({ ...stored, draft: { ...stored.draft, goals: [{ extra: 1 }] } }));
  assert.equal(readDraft(), null);
});

test("v2: a stored source that is no source reads null", () => {
  saveDraft(base);
  const stored = JSON.parse(memory.get("pulsar.import-draft") ?? "{}") as Record<string, unknown>;
  memory.set("pulsar.import-draft", JSON.stringify({ ...stored, source: "texto" }));
  assert.equal(readDraft(), null);
});

test("v2: saveReview does nothing when nothing is stored, and a v1 save is no v2 read", () => {
  saveReview(draft2(), [], []);
  assert.equal(memory.size, 0);
  saveDraftV1({ via: "template", draft: { goals: [] } as ImportDraftV1, source: "t" });
  assert.equal(readDraft(), null);
  assert.equal(readSourceV1(), null);
});

test("v2: the box gets back the text as written; a file leaves it empty; a draft stored with no text falls back to its lines", () => {
  saveDraft({ ...base, text: "- Cuentas\n  nota: x" });
  assert.equal(readText(), "- Cuentas\n  nota: x");
  saveDraft({ ...base, sourceName: "plan.txt", text: null });
  assert.equal(readText(), null);
  saveDraft(base);
  const stored = JSON.parse(memory.get("pulsar.import-draft") ?? "{}") as Record<string, unknown>;
  delete stored.text;
  memory.set("pulsar.import-draft", JSON.stringify(stored));
  assert.equal(readText(), "a\nb\nc");
  assert.equal(readDraft()?.text, undefined);
});

// ---- 903: what a stored draft of an unexpected shape reads as.

const v2goal = (over: Partial<DraftGoal> = {}): DraftGoal => ({
  key: "g1", parent: null, name: "Meta", horizon: "2027-10-01", measure: null, rhythm: null, note: null, noteSrc: [], src: [],
  phases: [], months: [], commitments: [], rules: [], tasks: [], ...over,
});
const stored2 = (over: Record<string, unknown> = {}) => ({
  version: 2, via: "model", draft: { version: 2, goals: [v2goal()] }, corrections: [], notices: [],
  source: { kind: "lines", lines: ["a"] }, sourceName: null, unmarked: null, declined: [], ...over,
});
const put = (value: unknown) => memory.set("pulsar.import-draft", JSON.stringify(value));

test("903: a stored draft read back by every way it can have been read, and by none other", () => {
  for (const via of ["template", "workbook", "model"]) {
    put(stored2({ via }));
    assert.equal(readDraft()?.via, via, via);
  }
  put(stored2({ via: "pdf" }));
  assert.equal(readDraft(), null);
  put(stored2({ version: 1 }));
  assert.equal(readDraft(), null);
});

test("903: a draft the schema refuses, or a source of an unknown kind, reads as nothing", () => {
  put(stored2({ draft: { version: 2, goals: [{ name: "x" }] } }));
  assert.equal(readDraft(), null);
  put(stored2({ source: { kind: "pdf", lines: null } }));
  assert.equal(readDraft(), null);
  put(stored2({ source: { kind: "lines", lines: "texto" } }));
  assert.equal(readDraft(), null);
  put(stored2({ source: null }));
  assert.equal(readDraft(), null);
});

test("903: a source of parts or rows with no lines is kept", () => {
  put(stored2({ source: { kind: "parts", lines: null } }));
  assert.deepEqual(readDraft()?.source, { kind: "parts", lines: null });
  put(stored2({ source: { kind: "rows", lines: null } }));
  assert.deepEqual(readDraft()?.source, { kind: "rows", lines: null });
});

test("903: the lists read back keep what is the right kind and drop the rest", () => {
  put(stored2({ unmarked: ["goals.0", 3, null], declined: ["a", {}, "b"], corrections: [{ id: "x" }, null, 5], notices: [null, { at: "y" }] }));
  const read = readDraft();
  assert.deepEqual(read?.unmarked, ["goals.0"]);
  assert.deepEqual(read?.declined, ["a", "b"]);
  assert.equal(read?.corrections.length, 1);
  assert.equal(read?.notices.length, 1);
});

// ---- 992 (RP-122): a plan written in the template or the workbook is saved as written.

const fix = (id: string, code: "monthSumDiffers" | "monthOverRhythm" | "nameShortened", declined: "keepsPlan" | "leavesOut") =>
  ({ id, at: id.split(":")[0], code, said: "s", proposed: "p", declined }) as const;
const A = fix("goals.0.months.0:monthSumDiffers", "monthSumDiffers", "keepsPlan");
const B = fix("goals.0.months.1:monthOverRhythm", "monthOverRhythm", "keepsPlan");
const C = fix("goals.0:nameShortened", "nameShortened", "leavesOut");

test("992 K7: a template save starts with every one of its corrections declined, in their order", () => {
  saveDraft({ ...base, via: "template", corrections: [A, B] });
  assert.deepEqual(readDraft()?.declined, [A.id, B.id]);
  assert.equal(readDraft()?.corrections.length, 2);
});

test("992 K7: a workbook save starts with every correction declined too", () => {
  saveDraft({ ...base, via: "workbook", corrections: [A, B] });
  assert.deepEqual(readDraft()?.declined, [A.id, B.id]);
});

test("992 K7: a model save starts with none declined, whatever it proposes", () => {
  saveDraft({ ...base, via: "model", corrections: [A, B, C] });
  assert.deepEqual(readDraft()?.declined, []);
});

test("992 K7: all of a template's corrections are declined, the kind that leaves a part out as well as the kind that keeps the plan", () => {
  saveDraft({ ...base, via: "template", corrections: [A, C, B] });
  assert.deepEqual(readDraft()?.declined, [A.id, C.id, B.id]);
});

test("992 K7: a template with no corrections declines nothing, and a later review keeps the declined list it saves", () => {
  saveDraft({ ...base, via: "template", corrections: [] });
  assert.deepEqual(readDraft()?.declined, []);
  saveDraft({ ...base, via: "template", corrections: [A, B] });
  saveReview(draft2(), [], [B.id]);
  assert.deepEqual(readDraft()?.declined, [B.id]);
});
