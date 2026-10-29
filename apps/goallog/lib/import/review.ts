import { horizonTreeRefusal } from "@/lib/goals/placement";
import { refusalKey } from "@/lib/goals/refusal-key";
import { buildTree, type Level } from "@/lib/goals/tree";
import { dayBefore } from "@/lib/day/weeks";
import { createGoalSchema } from "@/lib/validation/plan";

import { coverage, outness } from "./coverage";
import {
  decideWithPaths,
  draftRefusals,
  withCutPhases,
  withoutStrayEstimates,
  type Correction,
  type CorrectionCode,
  type DraftRefusal,
  type DraftGoal,
  type ImportDraft,
  type Notice,
} from "./draft";
import { changesAnything, differences, fingerprint, matchGoals, phaseCrossing, type Difference, type GoalSnapshot } from "./differences";
import type { StoredDraft } from "./draft-store";

export type ReviewNode = {
  path: string;
  // A goal with goals inside is a "group"; the rest of a goal's parts hang under it.
  kind: "goal" | "group" | "phase" | "month" | "commitment" | "task" | "subTask" | "rhythm" | "note";
  depth: 0 | 1 | 2 | 3 | 4;
  level: Level | null;
  label: string;
  figure: { amount: number; unit: string } | null;
  // The day a task the plan marked done was done; null on every other node.
  doneOn: string | null;
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

export type Cadence = { kind: DraftGoal["commitments"][number]["cadenceKind"]; weekdays: number[]; n: number | null };

export type EditChange =
  | { name: string }
  | { amount: number }
  | { month: string }
  | { horizon: string | null }
  | { cadence: Cadence };

// A copy of the draft with one part changed, at the part's path: a name, an amount or a month, a goal's
// horizon, a commitment's cadence. The cadence keeps the table's shape: days on `weekdays` alone, a count on
// the counted kinds alone.
export function edit(draft: ImportDraft, path: string, change: EditChange): ImportDraft {
  const next = structuredClone(draft);
  const p = path.split(".");
  const goal = next.goals[Number(p[1])];
  if (!goal) return next;
  if (p.length === 2) {
    if ("name" in change) goal.name = change.name;
    if ("horizon" in change) goal.horizon = change.horizon;
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
    if (entry && "amount" in change && entry.satisfaction === "quantity") entry.targetQuantity = change.amount;
    if (entry && "cadence" in change) {
      const { kind, weekdays, n } = change.cadence;
      entry.cadenceKind = kind;
      entry.cadenceWeekdays = kind === "weekdays" ? [...new Set(weekdays)].sort((a, b) => a - b) : null;
      entry.cadenceN = kind === "daily" || kind === "weekdays" ? null : n;
    }
  } else if (p[2] === "tasks") {
    const task = goal.tasks[Number(p[3])];
    const target = p[4] === "children" ? task?.children[Number(p[5])] : task;
    if (target && "name" in change) target.name = change.name;
    if (target && "amount" in change) target.estimate = change.amount;
    if (task && p[4] !== "children" && "month" in change) task.month = change.month;
  }
  return next;
}

// What a person's own edit settles: the corrections about the same cadence or the same end no longer stand,
// or declining them would put the plan's value back over theirs.
export function editedCorrections(corrections: Correction[], path: string, change: EditChange): Correction[] {
  const overridden: CorrectionCode[] = "cadence" in change ? ["cadenceClamped", "cadenceToWeekdays"] : "horizon" in change ? ["endWithinAbove"] : [];
  return corrections.filter((c) => !(c.at === path && overridden.includes(c.code)));
}

// Why a goal's end cannot be `horizon`, as a catalogue key and its values, or null: the form's own rule, a day
// already gone, and the goals around it. The tree is the draft's own, so a goal inside that ends later is named.
export function goalHorizonRefusal(draft: ImportDraft, g: number, horizon: string | null, today: string): { key: string; values: Record<string, string> } | null {
  if (horizon !== null) {
    const issue = createGoalSchema.shape.horizon.safeParse(horizon);
    if (!issue.success) return { key: issue.error.issues[0].message, values: {} };
    if (horizon <= today) return { key: "import.errors.horizonPast", values: {} };
  }
  const first = new Map<string, number>();
  draft.goals.forEach((goal, i) => {
    if (!first.has(goal.key)) first.set(goal.key, i);
  });
  const rows = draft.goals.map((goal, i) => {
    const p = goal.parent === null ? undefined : first.get(goal.parent);
    return {
      id: String(i),
      parentId: p !== undefined && p < i ? String(p) : null,
      position: i,
      createdAt: "",
      name: goal.name,
      horizon: i === g ? horizon : goal.horizon,
      archivedAt: null,
      measureUnit: null,
    };
  });
  const refusal = horizonTreeRefusal(buildTree(rows), String(g), horizon);
  if (!refusal) return null;
  const named = "above" in refusal ? refusal.above : "below" in refusal ? refusal.below : null;
  return { key: refusalKey(refusal.code), values: named ? { name: named.name, date: named.horizon === null ? "" : dayBefore(named.horizon) } : {} };
}

const WEEKDAY_WORDS: [RegExp, number][] = [
  [/lunes/i, 1],
  [/martes/i, 2],
  [/mi[eé]rcoles/i, 3],
  [/jueves/i, 4],
  [/viernes/i, 5],
  [/s[aá]bado/i, 6],
  [/domingo/i, 7],
];

// The weekdays a plan line names, as written, in the order it writes them.
export function weekdaysIn(text: string): { word: string; day: number }[] {
  const found: { word: string; day: number; at: number }[] = [];
  for (const [pattern, day] of WEEKDAY_WORDS) {
    const match = new RegExp(`\\b${pattern.source}\\b`, "i").exec(text);
    if (match) found.push({ word: match[0], day, at: match.index });
  }
  return found.sort((a, b) => a.at - b.at).map(({ word, day }) => ({ word, day }));
}

// Accents count: «Inglés» and «Ingles» differ, but one «é» composed or decomposed is the same.
export const nameKey = (name: string) => name.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("es");

const TASK_KEY = /^goals\.(\d+)\.tasks\.(\d+)(\..+)?$/;

// The unmarked paths, which are paths of the review as drawn, for the review drawn once `declined` is the
// decision: a move taken or undone changes where its task lies.
export function remapUnmarked(stored: StoredDraft, declined: ReadonlySet<string>, unmarked: string[]): string[] {
  const now = decideWithPaths(stored.draft, stored.corrections, new Set(stored.declined)).pathOf;
  const next = decideWithPaths(stored.draft, stored.corrections, declined).pathOf;
  const back = new Map<string, string>();
  stored.draft.goals.forEach((goal, g) =>
    goal.tasks.forEach((_, t) => {
      const at = `goals.${g}.tasks.${t}`;
      const there = now(at);
      if (TASK_KEY.test(there)) back.set(there, at);
    }),
  );
  return unmarked.map((path) => {
    const hit = TASK_KEY.exec(path);
    const own = hit ? back.get(`goals.${hit[1]}.tasks.${hit[2]}`) : undefined;
    return own === undefined ? path : next(`${own}${hit![3] ?? ""}`);
  });
}

// The paths of the parts of a matched goal the import leaves exactly as they are: nothing to mark in or out, since an
// import never removes. `changes` holds each goal's differences, keyed by its place in the draft as drawn.
function unchangedParts(
  work: ImportDraft,
  matched: ReadonlyMap<number, GoalSnapshot>,
  changes: ReadonlyMap<number, Difference[]>,
  crosses: ReadonlyMap<string, string>,
): Set<string> {
  const out = new Set<string>();
  for (const g of matched.keys()) {
    const list = changes.get(g);
    if (!list) continue;
    const goal = work.goals[g];
    const at = `goals.${g}`;
    const named = (kinds: Difference["kind"][], name: string) => list.some((d) => kinds.includes(d.kind) && "name" in d && nameKey(d.name) === nameKey(name));
    if (!list.some((d) => d.kind === "rhythm")) out.add(`${at}.rhythm`);
    goal.phases.forEach((phase, i) => {
      const touched = list.some((d) => (d.kind === "phaseAdded" || d.kind === "phaseChanged" || d.kind === "phaseOverlaps") && nameKey(d.aim) === nameKey(phase.aim));
      if (!touched && !crosses.has(`${at}.phases.${i}`)) out.add(`${at}.phases.${i}`);
    });
    goal.months.forEach((entry, i) => {
      if (!list.some((d) => d.kind === "month" && d.month === entry.month.slice(0, 7))) out.add(`${at}.months.${i}`);
    });
    goal.commitments.forEach((entry, i) => {
      if (!named(["commitmentAdded", "commitmentChanged", "commitmentReplaced"], entry.name)) out.add(`${at}.commitments.${i}`);
    });
    goal.tasks.forEach((task, t) => {
      const added = named(["taskAdded"], task.name);
      if (!added && !named(["taskMoved", "taskResized"], task.name)) out.add(`${at}.tasks.${t}`);
      task.children.forEach((child, c) => {
        const fresh = list.some((d) => d.kind === "subTaskAdded" && nameKey(d.name) === nameKey(child.name) && nameKey(d.task) === nameKey(task.name));
        if (!added && !fresh) out.add(`${at}.tasks.${t}.children.${c}`);
      });
    });
  }
  return out;
}

const WRITTEN = new Set<ReviewNode["kind"]>(["goal", "group", "phase", "month", "commitment", "task", "subTask"]);

// The review of a stored draft: the tree to draw, what the person is sent to confirm and what the
// plan's lines came to. The corrections the person declined are undone, the check's proposals they
// did not decline are applied, a goal one open goal names is drawn as an update (RP-130), and a goal
// two open goals name starts unmarked: the import cannot choose between them.
export function reviewTree(stored: StoredDraft, today: string, snapshots: GoalSnapshot[]) {
  const decided = decideWithPaths(stored.draft, stored.corrections, new Set(stored.declined));
  const work = withoutStrayEstimates(decided.draft);
  // A correction is drawn where its part now lies: a task the second pass moved has gone to another goal.
  const corrections = stored.corrections.map((c) => ({ ...c, at: decided.pathOf(c.at) }));
  const refusals = draftRefusals(work, today);
  const refused = new Set(refusals.map((refusal) => refusal.path));
  const matches = matchGoals(work, snapshots);
  // A phase the plan puts across one the goal has: it starts unmarked, as does a goal two open goals name.
  const crosses = new Map<string, string>();
  for (const { g, match } of matches) {
    if (match === null || match === "ambiguous") continue;
    work.goals[g].phases.forEach((phase, p) => {
      const crossed = phaseCrossing(phase, work.goals[g].phases, match.phases, today);
      if (crossed !== null) crosses.set(`goals.${g}.phases.${p}`, crossed);
    });
  }
  const unmarked: ReadonlySet<string> = new Set(
    stored.unmarked ?? [...matches.flatMap(({ g, match }) => (match === "ambiguous" ? [`goals.${g}`] : [])), ...crosses.keys()],
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
  const push = (node: Omit<ReviewNode, "marked" | "markable" | "refusal" | "corrections" | "notices" | "level" | "doneOn"> & { level?: Level | null; refusal?: DraftRefusal | null; doneOn?: string | null }) => {
    nodes.push({
      level: null,
      doneOn: null,
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
      push({ path: taskAt, kind: "task", depth: (d + 1) as 1, label: task.name, figure: task.estimate === null ? null : { amount: task.estimate, unit }, doneOn: task.doneOn ?? null });
      task.children.forEach((child, c) =>
        push({ path: `${taskAt}.children.${c}`, kind: "subTask", depth: (d + 2) as 2, label: child.name, figure: child.estimate === null ? null : { amount: child.estimate, unit }, doneOn: child.doneOn ?? null }),
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
  for (const correction of corrections) nodeAt(correction.at)?.corrections.push(correction);
  for (const notice of stored.notices) nodeAt(notice.at)?.notices.push(notice);

  const toSend = markedDraft(work, unmarked, refused);

  // The updates ride on the draft the server compares: the one with its phases cut, and the goals the person
  // left in, so a goal's index here is its place among them.
  const cut = withCutPhases(toSend, today);
  const kept = work.goals.flatMap((_, g) => (out(`goals.${g}`) === null ? [g] : []));
  const matched = new Map<number, GoalSnapshot>();
  const ambiguous = new Set<number>();
  for (const { g, match } of matches) {
    if (match === "ambiguous") ambiguous.add(g);
    else if (match !== null) matched.set(g, match);
  }
  const changes = new Map<number, Difference[]>();
  const updates: { g: number; goalId: string; fingerprint: string }[] = [];
  let matchedKept = 0;
  kept.forEach((g, sent) => {
    const snapshot = matched.get(g);
    if (!snapshot) return;
    matchedKept += 1;
    const list = differences(cut.goals[sent], snapshot, today);
    changes.set(g, list);
    // A goal the plan leaves as it is is neither updated nor counted: the server leaves it alone.
    if (changesAnything(list)) updates.push({ g: sent, goalId: snapshot.id, fingerprint: fingerprint(list) });
  });
  const unchanged = unchangedParts(work, matched, changes, crosses);
  // The goal's place in the draft as drawn, for a refusal that names its place in the draft sent.
  const drawnAt = (sent: number) => kept[sent];
  const createCount = toSend.goals.reduce(
    (n, goal) => n + 1 + goal.phases.length + goal.months.length + goal.commitments.length + goal.tasks.reduce((m, task) => m + 1 + task.children.length, 0),
    0,
  );
  return {
    nodes,
    corrections,
    work,
    unmarked,
    refused,
    createCount,
    creating: toSend.goals.length - matchedKept,
    unchanged,
    crosses,
    matched,
    ambiguous,
    changes,
    updates,
    drawnAt,
    nothingWritable: !nodes.some((n) => WRITTEN.has(n.kind) && n.markable),
    coverage: coverage(work, stored.source, unmarked, refused),
    toSend,
  };
}
