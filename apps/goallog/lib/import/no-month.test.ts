// M14, Q2 (a): a task the plan gives no month. The model may leave it null; in a goal with a rhythm
// the rhythm places it, in a goal without one the review proposes the current month (accepted by
// default) and a declined proposal leaves the task out with its reason (RP-90).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { check } from "./check";
import { placeLeftovers } from "./coverage";
import { decide, draftRefusals, normalize, rawDraftSchema, type Correction, type RawDraft, type Source } from "./draft";
import { linesToTasks } from "./line-tasks";
import { todayInZone } from "@/lib/zone";

const catalogue = JSON.parse(readFileSync(new URL("../../messages/es/import.json", import.meta.url), "utf8"));
const TODAY = todayInZone();
const THIS_MONTH = TODAY.slice(0, 7);
const NEXT_YEAR = `${Number(TODAY.slice(0, 4)) + 1}-${TODAY.slice(5, 7)}-01`;
const NEXT_MONTH = (() => {
  const [y, m] = THIS_MONTH.split("-").map(Number);
  const i = y * 12 + m;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
})();

const source: Source = { kind: "lines", lines: ["# Plan", "- Leer", "- Escribir"] };
const rawTask = (name: string, month: string | null, line: number): RawDraft["goals"][number]["tasks"][number] => ({
  name,
  month: month as string,
  estimate: null,
  week: null,
  rule: null,
  noteSrc: [],
  noteText: null,
  src: [{ from: line, to: line }],
  children: [],
});
const rawGoal = (over: Partial<RawDraft["goals"][number]> = {}): RawDraft["goals"][number] => ({
  key: "g1",
  parent: null,
  name: "IA aplicada",
  horizon: NEXT_YEAR,
  measure: null,
  rate: null,
  noteSrc: [],
  noteText: null,
  src: [{ from: 1, to: 1 }],
  phases: [],
  months: [],
  commitments: [],
  rules: [],
  tasks: [rawTask("Leer", null, 2), rawTask("Escribir", NEXT_MONTH, 3)],
  ...over,
});
const withRhythm = () => rawGoal({ measure: { name: "estudio", unit: "horas" }, rate: { amount: 12, unit: "hours", per: "month" } });

// The route's own order: normalize, place the leftovers, lines to tasks, the check over the plan as it stands.
function read(raw: RawDraft) {
  const normalized = normalize(raw, source);
  const placed = placeLeftovers(normalized.draft, source);
  const lined = linesToTasks(placed, source, TODAY, { onlyDone: false });
  const checked = check(decide(lined.draft, [], new Set()));
  return { draft: lined.draft, corrections: [...normalized.corrections, ...lined.corrections, ...checked.corrections] };
}
const monthCorrection = (corrections: Correction[], at = "goals.0.tasks.0") => corrections.filter((c) => c.at === at && c.proposed === THIS_MONTH);
const taskRefusals = (draft: Parameters<typeof draftRefusals>[0], at = "goals.0.tasks.0") => draftRefusals(draft, TODAY).filter((r) => r.path === at);

test("the model's answer may leave a task's month null", () => {
  const parsed = rawDraftSchema.safeParse({ goals: [withRhythm()] });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test("a task month that is not text or null is still refused", () => {
  const goal = rawGoal();
  (goal.tasks[0] as { month: unknown }).month = 7;
  assert.equal(rawDraftSchema.safeParse({ goals: [goal] }).success, false);
});

test("the model is shown a month it may leave null, and still must name the key", async () => {
  const { rawDraftStrictSchema } = await import("./model");
  const task = (rawDraftStrictSchema as any).properties.goals.items.properties.tasks.items; // eslint-disable-line @typescript-eslint/no-explicit-any
  const month = task.properties.month;
  const types: string[] = month.anyOf ? month.anyOf.map((branch: { type: string }) => branch.type) : [].concat(month.type);
  assert.ok(types.includes("null") && types.includes("string"), `month types: ${types}`);
  assert.ok(task.required.includes("month"), "strict mode names every key");
});

test("in a goal with a rhythm a null month proposes nothing and refuses nothing: the rhythm places the task", () => {
  const { draft, corrections } = read({ goals: [withRhythm()] });
  assert.equal(draft.goals[0].rhythm, 720);
  assert.deepEqual(corrections.filter((c) => c.at === "goals.0.tasks.0"), []);
  const decided = decide(draft, corrections, new Set());
  assert.deepEqual(taskRefusals(decided), []);
  assert.deepEqual(draftRefusals(decided, TODAY), []);
});

test("in a goal with no rhythm a null month proposes the current month, once, as a correction that leaves the task out when declined", () => {
  const { corrections } = read({ goals: [rawGoal()] });
  const found = monthCorrection(corrections);
  assert.equal(found.length, 1, JSON.stringify(corrections));
  assert.equal(found[0].declined, "leavesOut");
  assert.match(found[0].id, /^goals\.0\.tasks\.0:/);
});

test("accepted by default: with nothing declined the task lands in the current month and nothing is refused", () => {
  const { draft, corrections } = read({ goals: [rawGoal()] });
  const decided = decide(draft, corrections, new Set());
  assert.equal(decided.goals[0].tasks[0].month, THIS_MONTH);
  assert.equal(decided.goals[0].tasks[1].month, NEXT_MONTH);
  assert.deepEqual(draftRefusals(decided, TODAY), []);
});

test("declined: the task is refused by name with a reason the catalogue has, and the dated task stays", () => {
  const { draft, corrections } = read({ goals: [rawGoal()] });
  const [correction] = monthCorrection(corrections);
  const decided = decide(draft, corrections, new Set([correction.id]));
  const refusals = taskRefusals(decided);
  assert.equal(refusals.length, 1, JSON.stringify(draftRefusals(decided, TODAY)));
  const leaf = refusals[0].key.split(".").slice(1).reduce((node: any, part) => node?.[part], catalogue); // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(typeof leaf, "string", `${refusals[0].key} is no message in messages/es/import.json`);
  assert.deepEqual(taskRefusals(decided, "goals.0.tasks.1"), []);
});

test("declining the month of one task does not touch another monthless task", () => {
  const goal = rawGoal({ tasks: [rawTask("Leer", null, 2), rawTask("Escribir", null, 3)] });
  const { draft, corrections } = read({ goals: [goal] });
  const first = monthCorrection(corrections, "goals.0.tasks.0")[0];
  const second = monthCorrection(corrections, "goals.0.tasks.1")[0];
  assert.ok(first && second);
  const decided = decide(draft, corrections, new Set([first.id]));
  assert.equal(taskRefusals(decided, "goals.0.tasks.0").length, 1);
  assert.deepEqual(taskRefusals(decided, "goals.0.tasks.1"), []);
  assert.equal(decided.goals[0].tasks[1].month, THIS_MONTH);
});

test("a task that carries a month in a goal with no rhythm gets no month correction", () => {
  const goal = rawGoal({ tasks: [rawTask("Leer", NEXT_MONTH, 2), rawTask("Escribir", NEXT_MONTH, 3)] });
  const { corrections } = read({ goals: [goal] });
  assert.deepEqual(corrections.filter((c) => c.at.startsWith("goals.0.tasks.")), []);
});

test("the review words the correction «el plan no le da mes → <mes>»", () => {
  const { corrections } = read({ goals: [rawGoal()] });
  const [correction] = monthCorrection(corrections);
  const words = catalogue.review?.correction?.[correction.code];
  assert.ok(words, `no review.correction.${correction.code} in messages/es/import.json`);
  assert.equal(typeof words.said, "string");
  assert.equal(typeof words.proposed, "string");
  assert.match(`${words.said} ${words.proposed} ${words.why}`, /el plan no le da mes/i);
});
