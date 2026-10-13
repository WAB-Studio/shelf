import { cleanLine, taskFromLine } from "./clean";
import { srcLines, type Correction, type DraftGoal, type DraftTask, type ImportDraft, type Source, type Src } from "./draft";

// Consecutive line numbers as ranges, in order.
function rangesOf(numbers: number[]): Src[] {
  const out: Src[] = [];
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last.to === n - 1) last.to = n;
    else out.push({ from: n, to: n });
  }
  return out;
}

// The note without the first line that reads `text`, with the blank runs it leaves closed.
function withoutLine(note: string | null, text: string): string | null {
  if (note === null) return null;
  const lines = note.split("\n");
  const at = lines.findIndex((line) => line.trim() === text);
  if (at < 0) return note;
  lines.splice(at, 1);
  const rest = lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
  return rest === "" ? null : rest;
}

/**
 * RP-96: a line a goal's note holds that is a task — a box, «HECHO», and with `onlyDone` off a duration
 * first — becomes the goal's task and leaves the note, so it is never written twice. A line marked done
 * (`- [x]`, «HECHO el <fecha>») is a task already done on that day. The task sits in this month, the
 * earliest a goal's month can be; its done day is kept apart. Lines a task or a sub-task holds stay their steps.
 */
export function linesToTasks(
  draft: ImportDraft,
  source: Source,
  today: string,
  options: { onlyDone: boolean },
): { draft: ImportDraft; corrections: Correction[] } {
  const lines = source.lines;
  const corrections: Correction[] = [];
  if (lines === null) return { draft, corrections };
  const month = today.slice(0, 7);

  const goals = draft.goals.map((goal): DraftGoal => {
    const tasks: DraftTask[] = [];
    let note = goal.note;
    const taken = new Set<number>();
    for (const n of srcLines(goal.noteSrc, lines.length)) {
      const line = lines[n - 1];
      if (line.trim() === "") continue;
      const found = taskFromLine(line, today);
      if (found === null || (options.onlyDone && found.doneOn === null)) continue;
      taken.add(n);
      note = withoutLine(note, cleanLine(line));
      const doneMonth = found.doneOn === null ? month : found.doneOn.slice(0, 7);
      tasks.push({
        name: found.name,
        month: doneMonth > month ? doneMonth : month,
        estimate: found.minutes,
        note: found.note,
        noteSrc: [],
        src: [{ from: n, to: n }],
        week: null,
        rule: null,
        ...(found.doneOn === null ? {} : { doneOn: found.doneOn }),
        children: [],
      });
    }
    if (taken.size === 0) return goal;
    return {
      ...goal,
      note,
      noteSrc: rangesOf(srcLines(goal.noteSrc, lines.length).filter((n) => !taken.has(n))),
      tasks: [...goal.tasks, ...tasks],
    };
  });
  return { draft: { ...draft, goals }, corrections };
}
