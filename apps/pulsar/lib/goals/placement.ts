import { branchOf } from "./tree";
import type { Tree, TreeNode } from "./tree";

type GoalRef = { id: string; name: string; horizon: string };
export type PlacementRefusal =
  | { code: "cycle" }
  | { code: "tooDeep" }
  | { code: "closed" }
  | { code: "aboveClosed"; above: GoalRef }
  | { code: "endPastAbove"; above: GoalRef }
  | { code: "belowEndsLater"; below: GoalRef }
  | { code: "aboveArchived"; above: GoalRef };

const refOf = (n: TreeNode): GoalRef => ({ id: n.id, name: n.name, horizon: n.horizon });
const isClosed = (n: TreeNode, today: string): boolean => n.archivedAt !== null || n.horizon <= today;

export function createInsideRefusal(t: Tree, aboveId: string, horizon: string, today: string): PlacementRefusal | null {
  const above = t.byId.get(aboveId);
  if (!above) return null;
  if (above.depth >= 2) return { code: "tooDeep" };
  if (isClosed(above, today)) return { code: "aboveClosed", above: refOf(above) };
  if (horizon > above.horizon) return { code: "endPastAbove", above: refOf(above) };
  return null;
}

export function moveRefusal(t: Tree, goalId: string, aboveId: string | null, today: string): PlacementRefusal | null {
  if (aboveId === null) return null;
  const goal = t.byId.get(goalId);
  const above = t.byId.get(aboveId);
  if (!goal || !above) return null;
  if (branchOf(t, goalId).includes(aboveId)) return { code: "cycle" };
  if (above.depth + 1 + goal.height > 2) return { code: "tooDeep" };
  if (isClosed(goal, today)) return { code: "closed" };
  if (isClosed(above, today)) return { code: "aboveClosed", above: refOf(above) };
  if (goal.horizon > above.horizon) return { code: "endPastAbove", above: refOf(above) };
  return null;
}

export function horizonTreeRefusal(t: Tree, goalId: string, horizon: string): PlacementRefusal | null {
  const goal = t.byId.get(goalId);
  if (!goal) return null;
  let latest: TreeNode | null = null;
  for (const id of branchOf(t, goalId).slice(1)) {
    const n = t.byId.get(id)!;
    if (n.horizon > horizon && (latest === null || n.horizon > latest.horizon)) latest = n;
  }
  if (latest) return { code: "belowEndsLater", below: refOf(latest) };
  const above = goal.parentId === null ? undefined : t.byId.get(goal.parentId);
  if (above && horizon > above.horizon) return { code: "endPastAbove", above: refOf(above) };
  return null;
}

export function reopenRefusal(t: Tree, goalId: string): PlacementRefusal | null {
  const goal = t.byId.get(goalId);
  if (!goal) return null;
  for (const id of goal.ancestors) {
    const a = t.byId.get(id)!;
    if (a.archivedAt !== null) return { code: "aboveArchived", above: refOf(a) };
  }
  return null;
}

export function moveTargets(t: Tree, goalId: string, today: string): { id: string; refusal: PlacementRefusal | null }[] {
  return t.order.map((n) => ({ id: n.id, refusal: moveRefusal(t, goalId, n.id, today) }));
}
