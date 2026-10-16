import type { ImportDraftV1 } from "./draft";
import { nameKey } from "./review";

type DraftGoal = ImportDraftV1["goals"][number];
type DraftCommitment = DraftGoal["commitments"][number];

export type Cadence = { kind: DraftCommitment["cadenceKind"]; weekdays: number[] | null; n: number | null };

// What 1020 reads of an open goal: all the import compares, nothing it writes.
export type GoalSnapshot = {
  id: string;
  name: string;
  horizon: string | null;
  note: string | null;
  measure: { name: string; unit: string } | null;
  measureFed: boolean;
  rhythm: number | null;
  months: { month: string; amount: number }[];
  phases: { id: string; aim: string; startsOn: string; endsOn: string }[];
  commitments: {
    id: string;
    name: string;
    cadence: Cadence;
    satisfaction: "tap" | "quantity";
    target: number | null;
    unit: string | null;
    hasFacts: boolean;
  }[];
  tasks: {
    id: string;
    name: string;
    estimate: number | null;
    month: string;
    done: boolean;
    children: { id: string; name: string; done: boolean }[];
  }[];
};

// Nothing here removes: a part the plan omits is only counted in `stays`.
export type Difference =
  | { kind: "horizon"; to: string }
  | { kind: "note"; to: string }
  | { kind: "measure"; name: string; unit: string; kept: "fed" | null }
  | { kind: "rhythm"; to: number }
  | { kind: "month"; month: string; amount: number }
  | { kind: "phaseAdded"; aim: string; startsOn: string; endsOn: string }
  | { kind: "phaseChanged"; aim: string; startsOn: string; endsOn: string }
  | { kind: "commitmentAdded"; name: string }
  | { kind: "commitmentChanged"; name: string }
  | { kind: "commitmentReplaced"; name: string }
  | { kind: "taskAdded"; name: string }
  | { kind: "taskChanged"; name: string }
  | { kind: "subTaskAdded"; name: string; task: string }
  | { kind: "stays"; count: number };

export type GoalMatch = { g: number; match: GoalSnapshot | "ambiguous" | null };

// One open goal of the name is the one to update; two are not guessed between.
export function matchGoals(draft: ImportDraftV1, snapshots: GoalSnapshot[]): GoalMatch[] {
  const byName = new Map<string, GoalSnapshot[]>();
  for (const snapshot of snapshots) {
    const key = nameKey(snapshot.name);
    byName.set(key, [...(byName.get(key) ?? []), snapshot]);
  }
  return draft.goals.map((goal, g) => {
    const same = byName.get(nameKey(goal.name)) ?? [];
    return { g, match: same.length === 0 ? null : same.length === 1 ? same[0] : "ambiguous" };
  });
}

function sameCadence(a: Cadence, b: Cadence): boolean {
  const days = (c: Cadence) => [...(c.weekdays ?? [])].sort((x, y) => x - y).join(",");
  return a.kind === b.kind && a.n === b.n && days(a) === days(b);
}

const monthKey = (month: string) => month.slice(0, 7);

// Every change the import would apply to `snapshot`. A part the plan leaves alone is no difference.
export function differences(draftGoal: DraftGoal, snapshot: GoalSnapshot, today: string): Difference[] {
  const out: Difference[] = [];

  if (draftGoal.horizon !== null && draftGoal.horizon !== snapshot.horizon) {
    out.push({ kind: "horizon", to: draftGoal.horizon });
  }

  const note = (draftGoal as { note?: string | null }).note;
  if (typeof note === "string" && note !== (snapshot.note ?? "")) out.push({ kind: "note", to: note });

  const measure = draftGoal.measure;
  if (measure !== null && (snapshot.measure?.name !== measure.name || snapshot.measure?.unit !== measure.unit)) {
    out.push({ kind: "measure", name: measure.name, unit: measure.unit, kept: snapshot.measureFed ? "fed" : null });
  }

  if (draftGoal.rhythm !== null && draftGoal.rhythm !== snapshot.rhythm) {
    out.push({ kind: "rhythm", to: draftGoal.rhythm });
  }

  const current = monthKey(today);
  for (const entry of draftGoal.months) {
    if (monthKey(entry.month) < current) continue;
    const have = snapshot.months.find((m) => monthKey(m.month) === monthKey(entry.month));
    if (have?.amount !== entry.amount) out.push({ kind: "month", month: monthKey(entry.month), amount: entry.amount });
  }

  for (const phase of draftGoal.phases) {
    const have = snapshot.phases.find((p) => nameKey(p.aim) === nameKey(phase.aim));
    if (!have) out.push({ kind: "phaseAdded", aim: phase.aim, startsOn: phase.startsOn, endsOn: phase.endsOn });
    else if (have.startsOn !== phase.startsOn || have.endsOn !== phase.endsOn) {
      out.push({ kind: "phaseChanged", aim: phase.aim, startsOn: phase.startsOn, endsOn: phase.endsOn });
    }
  }

  for (const commitment of draftGoal.commitments) {
    const have = snapshot.commitments.find((c) => nameKey(c.name) === nameKey(commitment.name));
    if (!have) {
      out.push({ kind: "commitmentAdded", name: commitment.name });
      continue;
    }
    const cadence: Cadence = {
      kind: commitment.cadenceKind,
      weekdays: commitment.cadenceWeekdays,
      n: commitment.cadenceN,
    };
    if (sameCadence(cadence, have.cadence)) continue;
    out.push({ kind: have.hasFacts ? "commitmentReplaced" : "commitmentChanged", name: commitment.name });
  }

  for (const task of draftGoal.tasks) {
    const have = snapshot.tasks.find((t) => nameKey(t.name) === nameKey(task.name));
    if (!have) {
      out.push({ kind: "taskAdded", name: task.name });
      continue;
    }
    if (have.done) continue;
    if (have.estimate !== task.estimate || monthKey(have.month) !== monthKey(task.month)) {
      out.push({ kind: "taskChanged", name: task.name });
    }
    for (const child of task.children) {
      if (!have.children.some((c) => nameKey(c.name) === nameKey(child.name))) {
        out.push({ kind: "subTaskAdded", name: child.name, task: task.name });
      }
    }
  }

  const named = <T>(items: T[], pick: (item: T) => string) => new Set(items.map((item) => nameKey(pick(item))));
  const plan = {
    phases: named(draftGoal.phases, (p) => p.aim),
    commitments: named(draftGoal.commitments, (c) => c.name),
    tasks: named(draftGoal.tasks, (t) => t.name),
  };
  const omitted =
    snapshot.phases.filter((p) => !plan.phases.has(nameKey(p.aim))).length +
    snapshot.commitments.filter((c) => !plan.commitments.has(nameKey(c.name))).length +
    snapshot.tasks.filter((t) => !plan.tasks.has(nameKey(t.name))).length;
  if (omitted > 0) out.push({ kind: "stays", count: omitted });

  return out;
}

// Whether the import writes anything: `stays` alone writes nothing.
export function changesAnything(list: Difference[]): boolean {
  return list.some((d) => d.kind !== "stays");
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

// The same differences in any order give the same string: the server compares it with the review's.
export function fingerprint(list: Difference[]): string {
  return list.map(stable).sort().join("\n");
}
