import assert from "node:assert/strict";
import test from "node:test";

import { check } from "./check";
import { decide, type DraftGoal, type DraftTask, type ImportDraft } from "./draft";

const task = (over: Partial<DraftTask> = {}): DraftTask => ({
  name: "Leer",
  month: "2026-10",
  estimate: null,
  note: null,
  noteSrc: [],
  src: [],
  week: null,
  rule: null,
  children: [],
  ...over,
});
const goal = (over: Partial<DraftGoal> = {}): DraftGoal => ({
  key: "g1",
  parent: null,
  name: "IA aplicada",
  horizon: "2027-10-01",
  measure: { name: "horas", unit: "minutos" },
  rhythm: null,
  note: null,
  noteSrc: [],
  src: [],
  phases: [],
  months: [],
  commitments: [],
  rules: [],
  tasks: [],
  ...over,
});
const draft = (...goals: DraftGoal[]): ImportDraft => ({ version: 2, goals });
const H = (n: number) => n * 60;

test("a month whose tasks sum to other than its amount proposes the sum", () => {
  const d = draft(
    goal({
      months: [{ month: "2026-10", amount: H(40), src: [] }],
      tasks: [task({ estimate: H(20) }), task({ estimate: H(20) }), task({ estimate: H(3) })],
    }),
  );
  const { corrections } = check(d);
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].code, "monthSumDiffers");
  assert.equal(corrections[0].at, "goals.0.months.0");
  assert.equal(corrections[0].said, String(H(40)));
  assert.equal(corrections[0].proposed, String(H(43)));
  assert.equal(corrections[0].declined, "keepsPlan");
  assert.equal(decide(d, corrections, new Set()).goals[0].months[0].amount, H(43));
  assert.equal(decide(d, corrections, new Set([corrections[0].id])).goals[0].months[0].amount, H(40));
});

test("a month whose tasks sum to its amount, or a month with no estimates, says nothing", () => {
  const d = draft(
    goal({
      months: [{ month: "2026-10", amount: H(5), src: [] }, { month: "2026-11", amount: H(9), src: [] }],
      tasks: [task({ estimate: H(2) }), task({ children: [{ name: "c", estimate: H(3), note: null, noteSrc: [], src: [], rule: null }] }), task({ month: "2026-11" })],
    }),
  );
  assert.deepEqual(check(d).corrections, []);
});

test("a month with a rhythm, no amount and tasks above it proposes the sum as its amount", () => {
  const d = draft(goal({ rhythm: H(20), tasks: [task({ estimate: H(16) }), task({ estimate: H(10) })] }));
  const { corrections } = check(d);
  assert.deepEqual(corrections.map((c) => c.code), ["monthOverRhythm"]);
  assert.equal(corrections[0].proposed, String(H(26)));
  assert.equal(corrections[0].values?.month, "2026-10");
  assert.deepEqual(decide(d, corrections, new Set()).goals[0].months, [{ month: "2026-10", amount: H(26), src: [] }]);
  assert.deepEqual(decide(d, corrections, new Set([corrections[0].id])).goals[0].months, []);
  const within = draft(goal({ rhythm: H(20), tasks: [task({ estimate: H(20) })] }));
  assert.deepEqual(check(within).corrections, []);
});

test("a rule the plan sets and a week with none of it is a notice naming the week", () => {
  const rules = [{ id: "ingles", label: "Inglés", perWeek: H(3) }];
  const d = draft(
    goal({
      rules,
      tasks: [
        task({ estimate: H(3), week: "2026-W41", rule: "ingles" }),
        task({ estimate: H(2), week: "2026-W42", rule: null }),
        task({ estimate: H(1), week: "2026-W43", rule: "ingles" }),
      ],
    }),
  );
  const { notices } = check(d);
  assert.deepEqual(notices.map((n) => [n.code, n.values.week]), [["weekRuleBroken", "2026-W42"], ["weekRuleBroken", "2026-W43"]]);
  assert.equal(notices[0].values.rule, "Inglés");
});

test("a sub-task carries a rule its task does not", () => {
  const rules = [{ id: "ingles", label: "Inglés", perWeek: H(3) }];
  const d = draft(
    goal({
      rules,
      tasks: [task({ week: "2026-W41", children: [{ name: "c", estimate: H(3), note: null, noteSrc: [], src: [], rule: "ingles" }] })],
    }),
  );
  assert.deepEqual(check(d).notices, []);
});

test("a goal with goals inside is not checked for months", () => {
  const d = draft(goal({ key: "g1", tasks: [task({ estimate: H(5) })], months: [{ month: "2026-10", amount: H(1), src: [] }] }), goal({ key: "g2", parent: "g1" }));
  assert.deepEqual(check(d).corrections, []);
});
