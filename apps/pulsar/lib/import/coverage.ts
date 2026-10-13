import { srcLines, WHOLE_GOAL, type ImportDraft, type Source, type Src } from "./draft";

export type OutReason = "notPlaced" | "unmarked" | "refused" | "noteFull";
type Why = "unmarked" | "refused";

// Why a part is not written, by its path: unmarked or refused itself, under a part that is, or
// inside a goal that is out whole (its own refusal, unmarked, or under one that is).
export function outness(draft: ImportDraft, unmarked: ReadonlySet<string>, refused: ReadonlySet<string>): (path: string) => Why | null {
  const first = new Map<string, number>();
  draft.goals.forEach((goal, g) => {
    if (!first.has(goal.key)) first.set(goal.key, g);
  });
  const goalWhy: (Why | null)[] = [];
  draft.goals.forEach((goal, g) => {
    const at = `goals.${g}`;
    const wholeRefused = [...refused].some((path) => path.startsWith(`${at}.`) && WHOLE_GOAL.test(path));
    const p = goal.parent === null ? undefined : first.get(goal.parent);
    goalWhy[g] = wholeRefused || refused.has(at) ? "refused" : unmarked.has(at) ? "unmarked" : p !== undefined && p < g ? goalWhy[p] : null;
  });
  return (path) => {
    const parts = path.split(".");
    const g = Number(parts[1]);
    if (goalWhy[g]) return goalWhy[g];
    for (let n = parts.length; n >= 2; n--) {
      const prefix = parts.slice(0, n).join(".");
      if (refused.has(prefix)) return "refused";
      if (unmarked.has(prefix)) return "unmarked";
    }
    return null;
  };
}

// How many of a note's lines the note holds: it was filled with whole lines, in order, from the top.
function lineCount(note: string | null, texts: string[]): number {
  if (note === null) return 0;
  for (let k = texts.length; k >= 1; k--) {
    const joined = texts.slice(0, k).join("\n").trim();
    if (joined !== "" && note.endsWith(joined)) return k;
  }
  return 0;
}

type Mark = { plan: boolean; notes: boolean; reasons: OutReason[] };

// RP-96: each line with text ends counted once, as plan, as note or as out with its reason.
export function coverage(
  draft: ImportDraft,
  source: Source,
  unmarked: ReadonlySet<string>,
  refused: ReadonlySet<string>,
): { kind: Source["kind"]; total: number; plan: number; notes: number; out: number; outLines: { line: number; text: string; reason: OutReason }[] } {
  const out = outness(draft, unmarked, refused);
  const lines = source.lines;
  const marks = new Map<number, Mark>();
  const mark = (n: number): Mark => {
    let m = marks.get(n);
    if (!m) marks.set(n, (m = { plan: false, notes: false, reasons: [] }));
    return m;
  };
  const inside = (ranges: Src[]) => (lines === null ? srcLines(ranges, Infinity) : srcLines(ranges, lines.length));

  const covers = (path: string, ranges: Src[]) => {
    const why = out(path);
    for (const n of inside(ranges)) {
      if (why === null) mark(n).plan = true;
      else mark(n).reasons.push(why);
    }
  };
  const notes = (path: string, ranges: Src[], note: string | null) => {
    const why = out(`${path}.note`);
    const numbers = inside(ranges);
    const fits = lines === null ? numbers.length : lineCount(note, numbers.map((n) => lines[n - 1]));
    numbers.forEach((n, i) => {
      if (why !== null) mark(n).reasons.push(why);
      else if (i < fits) mark(n).notes = true;
      else mark(n).reasons.push("noteFull");
    });
  };

  draft.goals.forEach((goal, g) => {
    const at = `goals.${g}`;
    covers(at, goal.src);
    notes(at, goal.noteSrc, goal.note);
    goal.phases.forEach((part, i) => covers(`${at}.phases.${i}`, part.src));
    goal.months.forEach((part, i) => covers(`${at}.months.${i}`, part.src));
    goal.commitments.forEach((part, i) => covers(`${at}.commitments.${i}`, part.src));
    goal.tasks.forEach((task, t) => {
      const taskAt = `${at}.tasks.${t}`;
      covers(taskAt, task.src);
      notes(taskAt, task.noteSrc, task.note);
      task.children.forEach((child, c) => {
        covers(`${taskAt}.children.${c}`, child.src);
        notes(`${taskAt}.children.${c}`, child.noteSrc, child.note);
      });
    });
  });

  const numbers = lines === null ? [...marks.keys()] : lines.flatMap((text, i) => (text.trim() === "" ? [] : [i + 1]));
  const outLines: { line: number; text: string; reason: OutReason }[] = [];
  let plan = 0;
  let noted = 0;
  for (const n of numbers.sort((a, b) => a - b)) {
    const m = marks.get(n);
    if (m?.plan) plan++;
    else if (m?.notes) noted++;
    else {
      const reasons = m?.reasons ?? [];
      const reason = reasons.includes("refused") ? "refused" : reasons.includes("unmarked") ? "unmarked" : reasons.includes("noteFull") ? "noteFull" : "notPlaced";
      outLines.push({ line: n, text: lines?.[n - 1] ?? "", reason });
    }
  }
  return { kind: source.kind, total: plan + noted + outLines.length, plan, notes: noted, out: outLines.length, outLines };
}
