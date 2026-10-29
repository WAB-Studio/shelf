import { GOAL_NOTE_MAX } from "@/lib/validation/plan";

import { cleanLine } from "./clean";
import { srcLines, TASK_NOTE_MAX, WHOLE_GOAL, type ImportDraft, type Source, type Src } from "./draft";

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

// A line as the note may carry it: clean text, spaces collapsed.
function flat(text: string): string {
  return cleanLine(text).replace(/\s+/g, " ").trim();
}

// Whether the note carries each line's text, in the note's words and not only as its tail.
function inNote(note: string | null, texts: string[]): boolean[] {
  if (note === null) return texts.map(() => false);
  // A repeated line is held as many times as the note repeats it.
  const noteLines = new Map<string, number>();
  for (const line of note.split("\n").map(flat)) noteLines.set(line, (noteLines.get(line) ?? 0) + 1);
  const whole = flat(note.replace(/\n/g, " "));
  return texts.map((text) => {
    const line = flat(text);
    if (line === "") return false;
    const left = noteLines.get(line);
    if (left !== undefined) {
      noteLines.set(line, Math.max(left - 1, 0));
      return left > 0;
    }
    return line.length >= 20 && whole.includes(line);
  });
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
  const notes = (path: string, ranges: Src[], note: string | null, cap: number) => {
    const why = out(`${path}.note`);
    const numbers = inside(ranges);
    const held = lines === null ? numbers.map(() => true) : inNote(note, numbers.map((n) => lines[n - 1]));
    // The note is filled in order and stops at the first line that does not fit: that one and the ones after are noteFull.
    let cut = false;
    numbers.forEach((n, i) => {
      if (why !== null) mark(n).reasons.push(why);
      else if (held[i]) mark(n).notes = true;
      else {
        if (!cut && (note?.length ?? 0) + 1 + (lines?.[n - 1].trim().length ?? 0) > cap) cut = true;
        mark(n).reasons.push(cut ? "noteFull" : "notPlaced");
      }
    });
  };

  draft.goals.forEach((goal, g) => {
    const at = `goals.${g}`;
    covers(at, goal.src);
    notes(at, goal.noteSrc, goal.note, GOAL_NOTE_MAX);
    goal.phases.forEach((part, i) => covers(`${at}.phases.${i}`, part.src));
    goal.months.forEach((part, i) => covers(`${at}.months.${i}`, part.src));
    goal.commitments.forEach((part, i) => covers(`${at}.commitments.${i}`, part.src));
    goal.tasks.forEach((task, t) => {
      const taskAt = `${at}.tasks.${t}`;
      covers(taskAt, task.src);
      notes(taskAt, task.noteSrc, task.note, TASK_NOTE_MAX);
      task.children.forEach((child, c) => {
        covers(`${taskAt}.children.${c}`, child.src);
        notes(`${taskAt}.children.${c}`, child.noteSrc, child.note, TASK_NOTE_MAX);
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

// RP-96: every line the model left out goes, as written and in the text's order, to the end of the
// note of the general goal (the first with none above it). A line that no longer fits under the
// goal-note ceiling is named in `noteSrc` all the same, so the count calls it out as `noteFull`.
export function placeLeftovers(draft: ImportDraft, source: Source): ImportDraft {
  const lines = source.lines;
  const root = draft.goals.findIndex((goal) => goal.parent === null);
  if (lines === null || root < 0) return draft;
  const left = coverage(draft, source, new Set(), new Set()).outLines.map((entry) => entry.line);
  if (left.length === 0) return draft;
  let note = draft.goals[root].note ?? "";
  let room = true;
  left.forEach((n, i) => {
    const text = cleanLine(lines[n - 1]);
    const joined = note === "" ? text : `${note}${i === 0 ? "\n\n" : "\n"}${text}`;
    if (room && joined.length <= GOAL_NOTE_MAX) note = joined;
    else room = false;
  });
  const goals = draft.goals.map((goal, g) =>
    g === root ? { ...goal, note: note === "" ? null : note, noteSrc: [...goal.noteSrc, ...left.map((n) => ({ from: n, to: n }))] } : goal,
  );
  return { ...draft, goals };
}

// RP-130: the goal whose note holds every line with text of a section the model could not read, or
// null when any of them is out (cut by the ceiling, refused, or no general goal took it). `out` is
// the review's own out lines, so the line and the count never read different drafts.
export function sectionHolder(
  draft: ImportDraft,
  section: { from: number; to: number },
  source: Source,
  out: { line: number }[] = coverage(draft, source, new Set(), new Set()).outLines,
): { goalName: string } | null {
  const lines = source.lines;
  if (lines === null) return null;
  const mine = srcLines([{ from: section.from, to: section.to }], lines.length).filter((n) => lines[n - 1].trim() !== "");
  if (mine.length === 0) return null;
  const cut = new Set(out.map((entry) => entry.line));
  if (mine.some((n) => cut.has(n))) return null;
  const goal = draft.goals.find((candidate) => {
    const held = new Set(srcLines(candidate.noteSrc, lines.length));
    return mine.every((n) => held.has(n));
  });
  return goal ? { goalName: goal.name } : null;
}
