import type { Correction, DraftGoal, DraftTask, ImportDraft, Notice } from "./draft";

// What a task asks of its month: its own estimate, or its sub-tasks'.
function taskTotal(task: DraftTask): number {
  return task.children.length > 0 ? task.children.reduce((sum, child) => sum + (child.estimate ?? 0), 0) : (task.estimate ?? 0);
}

const hasFigure = (task: DraftTask) => task.estimate !== null || task.children.some((child) => child.estimate !== null);

function monthChecks(goal: DraftGoal, at: string, corrections: Correction[]): void {
  const sums = new Map<string, number>();
  for (const task of goal.tasks) {
    if (hasFigure(task)) sums.set(task.month, (sums.get(task.month) ?? 0) + taskTotal(task));
  }
  for (const [month, sum] of [...sums].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const index = goal.months.findIndex((entry) => entry.month === month);
    if (index >= 0) {
      const amount = goal.months[index].amount;
      if (amount !== sum) {
        const path = `${at}.months.${index}`;
        corrections.push({ id: `${path}:monthSumDiffers`, at: path, code: "monthSumDiffers", said: String(amount), proposed: String(sum), values: { month }, declined: "keepsPlan" });
      }
    } else if (goal.rhythm !== null && sum > goal.rhythm) {
      const path = `${at}.rhythm`;
      corrections.push({ id: `${path}:monthOverRhythm`, at: path, code: "monthOverRhythm", said: String(goal.rhythm), proposed: String(sum), values: { month }, declined: "keepsPlan" });
    }
  }
}

function ruleChecks(goal: DraftGoal, at: string, notices: Notice[]): void {
  const weeks = [...new Set(goal.tasks.flatMap((task) => (task.week === null ? [] : [task.week])))].sort();
  for (const rule of goal.rules) {
    if (rule.perWeek <= 0) continue;
    for (const week of weeks) {
      let found = 0;
      for (const task of goal.tasks) {
        if (task.week !== week) continue;
        if (task.children.length === 0) found += (task.rule ?? null) === rule.id ? (task.estimate ?? 0) : 0;
        else for (const child of task.children) found += (child.rule ?? task.rule) === rule.id ? (child.estimate ?? 0) : 0;
      }
      if (found < rule.perWeek) {
        notices.push({ at, code: "weekRuleBroken", values: { rule: rule.label, week, expected: String(rule.perWeek), found: String(found) } });
      }
    }
  }
}

// RP-86's third step: the plan against itself. A correction is a proposal the person accepts or
// declines; a notice only says what does not add up.
export function check(draft: ImportDraft): { corrections: Correction[]; notices: Notice[] } {
  const corrections: Correction[] = [];
  const notices: Notice[] = [];
  const holders = new Set(draft.goals.flatMap((goal) => (goal.parent === null ? [] : [goal.parent])));
  draft.goals.forEach((goal, g) => {
    if (holders.has(goal.key)) return;
    monthChecks(goal, `goals.${g}`, corrections);
    ruleChecks(goal, `goals.${g}`, notices);
  });
  return { corrections, notices };
}
