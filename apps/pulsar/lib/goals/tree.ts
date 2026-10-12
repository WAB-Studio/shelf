export type TreeRow = {
  id: string;
  parentId: string | null;
  position: number;
  createdAt: string;
  name: string;
  horizon: string;
  archivedAt: string | null;
  measureUnit: string | null;
};
export type Level = "general" | "large" | "small";
export type TreeNode = TreeRow & {
  depth: 0 | 1 | 2;
  height: 0 | 1 | 2;
  level: Level | null;
  ancestors: string[];
  children: string[];
};
export type Tree = { order: TreeNode[]; byId: Map<string, TreeNode> };
export type MonthFigure = { planned: number | null; reached: number; ownBudget: boolean };
export type GoalMonths = { unit: string | null; months: Map<string, MonthFigure> };
export type RolledUp = {
  unit: string | null;
  months: Map<string, MonthFigure>;
  outOfUnit: { id: string; name: string; unit: string }[];
};

const stub = (): never => {
  throw new Error("not implemented");
};
export function buildTree(_rows: TreeRow[]): Tree {
  return stub();
}
export function branchOf(_tree: Tree, _id: string): string[] {
  return stub();
}
export function rootOf(_tree: Tree, _id: string): string {
  return stub();
}
export function spanStart(_tree: Tree, _id: string): string {
  return stub();
}
export function rollUp(_tree: Tree, _own: Map<string, GoalMonths>): Map<string, RolledUp> {
  return stub();
}
