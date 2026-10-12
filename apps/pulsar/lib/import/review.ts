import { buildTree, type Level } from "@/lib/goals/tree";

import { coverage, outness } from "./coverage";
import {
  decide,
  draftRefusals,
  withoutStrayEstimates,
  type Correction,
  type DraftRefusal,
  type DraftGoal,
  type ImportDraft,
  type Notice,
} from "./draft";
import type { StoredDraft } from "./draft-store";

export type ReviewNode = {
  path: string;
  // A goal with goals inside is a "group"; the rest of a goal's parts hang under it.
  kind: "goal" | "group" | "phase" | "month" | "commitment" | "task" | "subTask" | "rhythm" | "note";
  depth: 0 | 1 | 2 | 3 | 4;
  level: Level | null;
  label: string;
  figure: { amount: number; unit: string } | null;
  marked: boolean;
  markable: boolean;
  refusal: DraftRefusal | null;
  corrections: Correction[];
  notices: Notice[];
};

// What `confirmImport` is sent: the marked parts alone, none a refusal names, and no goal whose
// parent is out. A part's unmarked sub-parts go with it.
export function markedDraft(draft: ImportDraft, unmarked: ReadonlySet<string>, refused: ReadonlySet<string>): ImportDraft {
  const out = outness(draft, unmarked, refused);
  const goals = draft.goals.flatMap((goal, g): DraftGoal[] => {
    const at = `goals.${g}`;
    if (out(at) !== null) return [];
    const kept = (path: string) => out(path) === null;
    return [
      {
        ...goal,
        rhythm: kept(`${at}.rhythm`) ? goal.rhythm : null,
        note: kept(`${at}.note`) ? goal.note : null,
        phases: goal.phases.filter((_, p) => kept(`${at}.phases.${p}`)),
        months: goal.months.filter((_, m) => kept(`${at}.months.${m}`)),
        commitments: goal.commitments.filter((_, c) => kept(`${at}.commitments.${c}`)),
        tasks: goal.tasks.flatMap((task, t) => {
          const taskAt = `${at}.tasks.${t}`;
          if (!kept(taskAt)) return [];
          return [
            {
              ...task,
              note: kept(`${taskAt}.note`) ? task.note : null,
              children: task.children
                .filter((_, c) => kept(`${taskAt}.children.${c}`))
                .map((child, c) => ({ ...child, note: kept(`${taskAt}.children.${c}.note`) ? child.note : null })),
            },
          ];
        }),
      },
    ];
  });
  return { ...draft, goals };
}

// A copy of the draft with one part changed: a name, an amount or a month, at the part's path.
export function edit(draft: ImportDraft, path: string, change: { name: string } | { amount: number } | { month: string }): ImportDraft {
  const next = structuredClone(draft);
  const p = path.split(".");
  const goal = next.goals[Number(p[1])];
  if (!goal) return next;
  if (p.length === 2) {
    if ("name" in change) goal.name = change.name;
  } else if (p[2] === "rhythm") {
    if ("amount" in change) goal.rhythm = change.amount;
  } else if (p[2] === "months") {
    const entry = goal.months[Number(p[3])];
    if (entry && "amount" in change) entry.amount = change.amount;
    if (entry && "month" in change) entry.month = change.month;
  } else if (p[2] === "phases") {
    const entry = goal.phases[Number(p[3])];
    if (entry && "name" in change) entry.aim = change.name;
  } else if (p[2] === "commitments") {
    const entry = goal.commitments[Number(p[3])];
    if (entry && "name" in change) entry.name = change.name;
  } else if (p[2] === "tasks") {
    const task = goal.tasks[Number(p[3])];
    const target = p[4] === "children" ? task?.children[Number(p[5])] : task;
    if (target && "name" in change) target.name = change.name;
    if (target && "amount" in change) target.estimate = change.amount;
    if (task && p[4] !== "children" && "month" in change) task.month = change.month;
  }
  return next;
}

// Accents count: «Inglés» and «Ingles» differ, but one «é» composed or decomposed is the same.
const nameKey = (name: string) => name.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("es");

const WRITTEN = new Set<ReviewNode["kind"]>(["goal", "group", "phase", "month", "commitment", "task", "subTask"]);

// The review of a stored draft: the tree to draw, what the person is sent to confirm and what the
// plan's lines came to. The corrections the person declined are undone, the check's proposals they
// did not decline are applied, and a goal an open goal already names starts unmarked.
export function reviewTree(stored: StoredDraft, today: string, openGoalNames: string[]) {
  const work = withoutStrayEstimates(decide(stored.draft, stored.corrections, new Set(stored.declined)));
  const refusals = draftRefusals(work, today);
  const refused = new Set(refusals.map((refusal) => refusal.path));
  const open = new Set(openGoalNames.map(nameKey));
  const unmarked: ReadonlySet<string> = new Set(
    stored.unmarked ?? work.goals.flatMap((goal, g) => (open.has(nameKey(goal.name)) ? [`goals.${g}`] : [])),
  );
  const out = outness(work, unmarked, refused);
  const blocked = outness(work, new Set(), refused);

  const index = new Map<string, number>();
  work.goals.forEach((goal, g) => {
    if (!index.has(goal.key)) index.set(goal.key, g);
  });
  const rows = work.goals.map((goal, g) => {
    const p = goal.parent === null ? undefined : index.get(goal.parent);
    return {
      id: String(g),
      parentId: p !== undefined && p < g ? String(p) : null,
      position: g,
      createdAt: "",
      name: goal.name,
      horizon: goal.horizon,
      archivedAt: null,
      measureUnit: goal.measure?.unit ?? null,
    };
  });
  const tree = buildTree(rows);

  const wholeRefusal = (at: string) => refusals.find((r) => r.path === at || (r.path.startsWith(`${at}.`) && /\.(horizon|parent|name|measure)$/.test(r.path) && r.path.split(".").length === 3));
  const nodes: ReviewNode[] = [];
  const push = (node: Omit<ReviewNode, "marked" | "markable" | "refusal" | "corrections" | "notices" | "level"> & { level?: Level | null; refusal?: DraftRefusal | null }) => {
    nodes.push({
      level: null,
      refusal: refusals.find((r) => r.path === node.path) ?? null,
      ...node,
      marked: out(node.path) === null,
      markable: blocked(node.path) === null,
      corrections: [],
      notices: [],
    });
  };

  for (const treeNode of tree.order) {
    const g = Number(treeNode.id);
    const goal = work.goals[g];
    const at = `goals.${g}`;
    const d = treeNode.depth;
    const unit = goal.measure?.unit ?? "";
    push({ path: at, kind: treeNode.children.length > 0 ? "group" : "goal", depth: d, level: treeNode.level, label: goal.name, figure: null, refusal: wholeRefusal(at) ?? null });
    if (goal.rhythm !== null) push({ path: `${at}.rhythm`, kind: "rhythm", depth: (d + 1) as 1, label: "", figure: { amount: goal.rhythm, unit } });
    if (goal.note !== null) push({ path: `${at}.note`, kind: "note", depth: (d + 1) as 1, label: goal.note, figure: null });
    goal.phases.forEach((phase, i) => push({ path: `${at}.phases.${i}`, kind: "phase", depth: (d + 1) as 1, label: phase.aim, figure: null }));
    goal.months.forEach((entry, i) => push({ path: `${at}.months.${i}`, kind: "month", depth: (d + 1) as 1, label: entry.month, figure: { amount: entry.amount, unit } }));
    goal.commitments.forEach((entry, i) => push({ path: `${at}.commitments.${i}`, kind: "commitment", depth: (d + 1) as 1, label: entry.name, figure: null }));
    goal.tasks.forEach((task, t) => {
      const taskAt = `${at}.tasks.${t}`;
      push({ path: taskAt, kind: "task", depth: (d + 1) as 1, label: task.name, figure: task.estimate === null ? null : { amount: task.estimate, unit } });
      task.children.forEach((child, c) =>
        push({ path: `${taskAt}.children.${c}`, kind: "subTask", depth: (d + 2) as 2, label: child.name, figure: child.estimate === null ? null : { amount: child.estimate, unit } }),
      );
    });
  }

  // A correction or a notice sits on the node it names, or on the nearest one above it.
  const paths = new Set(nodes.map((n) => n.path));
  const nodeAt = (at: string) => {
    const parts = at.split(".");
    while (parts.length > 1 && !paths.has(parts.join("."))) parts.pop();
    return nodes.find((n) => n.path === parts.join("."));
  };
  for (const correction of stored.corrections) nodeAt(correction.at)?.corrections.push(correction);
  for (const notice of stored.notices) nodeAt(notice.at)?.notices.push(notice);

  const toSend = markedDraft(work, unmarked, refused);
  const createCount = toSend.goals.reduce(
    (n, goal) => n + 1 + goal.phases.length + goal.months.length + goal.commitments.length + goal.tasks.reduce((m, task) => m + 1 + task.children.length, 0),
    0,
  );
  return {
    nodes,
    createCount,
    nothingWritable: !nodes.some((n) => WRITTEN.has(n.kind) && n.markable),
    coverage: coverage(work, stored.source, unmarked, refused),
    toSend,
  };
}
