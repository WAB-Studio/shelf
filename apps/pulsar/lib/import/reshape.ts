import type { Correction, ImportDraft } from "./draft";

const TASK_AT = /^goals\.(\d+)\.tasks\.(\d+)$/;
const IN_TASK = /^goals\.(\d+)\.tasks\.(\d+)(\..+)?$/;

/**
 * The draft with what the person decided about the corrections that move tasks: a task the second pass
 * sent to a goal below goes there unless declined, and a task made of a note line (903c) goes back to the
 * note when declined. Both are applied after every other correction, in the draft's own paths.
 *
 * `pathOf` carries a path of the draft as stored to the path it has once moved, because a task that left
 * its goal shifts the ones after it: the review draws, and hangs its corrections, on the moved paths.
 */
export function reshapeTasks(
  draft: ImportDraft,
  corrections: Correction[],
  declined: ReadonlySet<string>,
): { draft: ImportDraft; pathOf: (path: string) => string } {
  const next = structuredClone(draft);
  const first = new Map<string, number>();
  next.goals.forEach((goal, g) => {
    if (!first.has(goal.key)) first.set(goal.key, g);
  });

  const removed = new Set<string>();
  for (const c of corrections) {
    if (c.code !== "lineToTask" || !declined.has(c.id)) continue;
    const at = TASK_AT.exec(c.at);
    if (!at || !next.goals[Number(at[1])]?.tasks[Number(at[2])]) continue;
    removed.add(`${at[1]}.${at[2]}`);
    const goal = next.goals[Number(at[1])];
    const line = Number(c.values?.line);
    goal.note = goal.note === null ? c.said : `${goal.note}\n${c.said}`;
    if (Number.isInteger(line)) goal.noteSrc = [...goal.noteSrc, { from: line, to: line }].sort((a, b) => a.from - b.from);
  }

  const moves = new Map<string, number>();
  for (const c of corrections) {
    if (c.code !== "taskMoved" || declined.has(c.id)) continue;
    const at = TASK_AT.exec(c.at);
    const to = first.get(c.values?.to ?? "");
    if (!at || to === undefined || to === Number(at[1])) continue;
    const key = `${at[1]}.${at[2]}`;
    if (removed.has(key) || !next.goals[Number(at[1])]?.tasks[Number(at[2])]) continue;
    moves.set(key, to);
  }

  const where = new Map<string, { g: number; t: number }>();
  const kept = next.goals.map((goal, g) =>
    goal.tasks.filter((task, t) => {
      const key = `${g}.${t}`;
      return !removed.has(key) && !moves.has(key);
    }),
  );
  // Positions among the kept tasks of each goal, then the moved ones after them.
  next.goals.forEach((goal, g) => {
    let place = 0;
    goal.tasks.forEach((_, t) => {
      const key = `${g}.${t}`;
      if (!removed.has(key) && !moves.has(key)) where.set(key, { g, t: place++ });
    });
  });
  for (const [key, to] of moves) {
    const [g, t] = key.split(".").map(Number);
    where.set(key, { g: to, t: kept[to].length });
    kept[to].push(next.goals[g].tasks[t]);
  }
  next.goals.forEach((goal, g) => {
    goal.tasks = kept[g];
  });

  const pathOf = (path: string): string => {
    const at = IN_TASK.exec(path);
    if (!at) return path;
    const key = `${at[1]}.${at[2]}`;
    if (removed.has(key)) return `goals.${at[1]}`;
    const place = where.get(key);
    return place ? `goals.${place.g}.tasks.${place.t}${at[3] ?? ""}` : path;
  };
  return { draft: next, pathOf };
}
