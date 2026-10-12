import type { Tree } from "./tree";

type GoalRef = { id: string; name: string; horizon: string };
export type PlacementRefusal =
  | { code: "cycle" }
  | { code: "tooDeep" }
  | { code: "closed" }
  | { code: "aboveClosed"; above: GoalRef }
  | { code: "endPastAbove"; above: GoalRef }
  | { code: "belowEndsLater"; below: GoalRef }
  | { code: "aboveArchived"; above: GoalRef };

const stub = (): never => {
  throw new Error("not implemented");
};
export function createInsideRefusal(_t: Tree, _aboveId: string, _horizon: string, _today: string): PlacementRefusal | null {
  return stub();
}
export function moveRefusal(_t: Tree, _goalId: string, _aboveId: string | null, _today: string): PlacementRefusal | null {
  return stub();
}
export function horizonTreeRefusal(_t: Tree, _goalId: string, _horizon: string): PlacementRefusal | null {
  return stub();
}
export function reopenRefusal(_t: Tree, _goalId: string): PlacementRefusal | null {
  return stub();
}
export function moveTargets(_t: Tree, _goalId: string, _today: string): { id: string; refusal: PlacementRefusal | null }[] {
  return stub();
}
