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

// ---- 903

const under = (over: Partial<DraftGoal> = {}) =>
  draft(
    goal({ key: "g", parent: null, name: "General", tasks: [task()] }),
    goal({ key: "h", parent: "g", name: "Inglés", rhythm: H(13), tasks: [], ...over }),
  );

test("903: a goal with a rhythm and no tasks under a goal that has tasks is a notice naming both, and changes nothing", () => {
  const d = under({ note: "algo" });
  const { corrections, notices } = check(d);
  assert.deepEqual(corrections, []);
  assert.deepEqual(notices, [{ at: "goals.1", code: "rhythmWithoutTasks", values: { name: "Inglés", above: "General" } }]);
  const decided = decide(d, corrections, new Set());
  assert.equal(decided.goals[1].rhythm, H(13));
  assert.equal(decided.goals[1].note, "algo");
});

test("903: no word when the goal has tasks, has no rhythm, has no parent, or the goal above has none", () => {
  const codes = (d: ImportDraft) => check(d).notices.filter((n) => n.code === "rhythmWithoutTasks").length;
  assert.equal(codes(under({ tasks: [task()] })), 0);
  assert.equal(codes(under({ rhythm: null })), 0);
  assert.equal(codes(draft(goal({ rhythm: H(5) }))), 0);
  assert.equal(codes(draft(goal({ key: "g", tasks: [] }), goal({ key: "h", parent: "g", rhythm: H(5) }))), 0);
});

test("903: a holder with a rhythm is not asked about; the one named by key, not by position", () => {
  const d = draft(
    goal({ key: "other", name: "Otra", tasks: [] }),
    goal({ key: "g", name: "General", tasks: [task()] }),
    goal({ key: "h", parent: "g", rhythm: H(2), tasks: [] }),
  );
  const found = check(d).notices.filter((n) => n.code === "rhythmWithoutTasks");
  assert.deepEqual(found.map((n) => n.at), ["goals.2"]);
  assert.equal(found[0].values.above, "General");
});

test("903: a sub-task with no rule of its own counts toward its task's rule", () => {
  const rules = [{ id: "ingles", label: "Inglés", perWeek: H(3) }];
  const d = draft(
    goal({
      rules,
      tasks: [task({ week: "2026-W41", rule: "ingles", children: [{ name: "c", estimate: H(3), note: null, noteSrc: [], src: [], rule: null }] })],
    }),
  );
  assert.deepEqual(check(d).notices, []);
});

test("903: the corrections of two months come in month order, whatever order the tasks are in", () => {
  const d = draft(
    goal({
      months: [{ month: "2026-10", amount: H(1), src: [] }, { month: "2026-11", amount: H(1), src: [] }],
      tasks: [task({ month: "2026-11", estimate: H(2) }), task({ month: "2026-10", estimate: H(2) })],
    }),
  );
  assert.deepEqual(check(d).corrections.map((c) => c.values?.month), ["2026-10", "2026-11"]);
});
