import { civilDateInZone } from "../zone";

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

export function buildTree(rows: TreeRow[]): Tree {
  const ids = new Set(rows.map((r) => r.id));
  const kids = new Map<string | null, TreeRow[]>();
  for (const r of rows) {
    const key = r.parentId !== null && ids.has(r.parentId) ? r.parentId : null;
    kids.set(key, [...(kids.get(key) ?? []), r]);
  }
  for (const list of kids.values()) {
    list.sort(
      (a, b) =>
        a.position - b.position ||
        (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  const order: TreeNode[] = [];
  const byId = new Map<string, TreeNode>();
  const visit = (r: TreeRow, ancestors: string[]): void => {
    if (byId.has(r.id)) return;
    const childRows = kids.get(r.id) ?? [];
    const depth = Math.min(ancestors.length, 2) as 0 | 1 | 2;
    const node: TreeNode = {
      ...r,
      depth,
      height: 0,
      level: depth === 0 ? (childRows.length > 0 ? "general" : null) : depth === 1 ? "large" : "small",
      ancestors: [...ancestors].reverse(),
      children: childRows.map((c) => c.id),
    };
    byId.set(r.id, node);
    order.push(node);
    for (const c of childRows) visit(c, [...ancestors, r.id]);
    node.height = Math.min(
      node.children.reduce((h, id) => Math.max(h, (byId.get(id)?.height ?? 0) + 1), 0),
      2,
    ) as 0 | 1 | 2;
  };
  for (const r of kids.get(null) ?? []) visit(r, []);
  return { order, byId };
}

export function branchOf(tree: Tree, id: string): string[] {
  const out: string[] = [];
  const walk = (cur: string): void => {
    out.push(cur);
    for (const c of tree.byId.get(cur)?.children ?? []) walk(c);
  };
  if (tree.byId.has(id)) walk(id);
  return out;
}

export function rootOf(tree: Tree, id: string): string {
  const ancestors = tree.byId.get(id)?.ancestors ?? [];
  return ancestors.length > 0 ? ancestors[ancestors.length - 1] : id;
}

// An archived goal adds nothing, unless the whole branch is archived.
export function spanStart(tree: Tree, id: string): string {
  const nodes = branchOf(tree, id).map((b) => tree.byId.get(b)!);
  const live = nodes.filter((n) => n.archivedAt === null);
  const days = (live.length > 0 ? live : nodes).map((n) => civilDateInZone(new Date(n.createdAt)));
  return days.reduce((a, b) => (b < a ? b : a));
}

export function rollUp(tree: Tree, own: Map<string, GoalMonths>): Map<string, RolledUp> {
  const up = new Map<string, RolledUp>();
  // Children come after their parent in preorder, so walking backwards sums bottom-up.
  for (let i = tree.order.length - 1; i >= 0; i--) {
    const node = tree.order[i];
    if (node.children.length === 0) continue;

    const contributors: { unit: string | null; months: Map<string, MonthFigure>; node: TreeNode }[] = [];
    for (const cid of node.children) {
      const child = tree.byId.get(cid)!;
      if (child.archivedAt !== null) continue;
      const rolled = up.get(cid);
      contributors.push(
        rolled
          ? { unit: rolled.unit, months: rolled.months, node: child }
          : { unit: child.measureUnit, months: own.get(cid)?.months ?? new Map(), node: child },
      );
    }

    const unit = node.measureUnit ?? contributors.find((c) => c.unit !== null)?.unit ?? null;
    const outOfUnit: RolledUp["outOfUnit"] = [];
    const sums = new Map<string, { planned: number | null; reached: number }>();
    const add = (month: string, planned: number | null, reached: number): void => {
      const cur = sums.get(month) ?? { planned: null, reached: 0 };
      sums.set(month, {
        planned: planned === null ? cur.planned : (cur.planned ?? 0) + planned,
        reached: cur.reached + reached,
      });
    };

    for (const c of contributors) {
      if (c.unit === null) continue;
      if (c.unit !== unit) {
        outOfUnit.push({ id: c.node.id, name: c.node.name, unit: c.unit });
        continue;
      }
      for (const [month, f] of c.months) add(month, f.planned, f.reached);
    }

    // Its own planned amounts stay stored and unread (RP-80).
    const mine = own.get(node.id);
    if (mine && (mine.unit === null || mine.unit === unit)) {
      for (const [month, f] of mine.months) add(month, null, f.reached);
    }

    const months = new Map<string, MonthFigure>();
    for (const [month, s] of sums) months.set(month, { planned: s.planned, reached: s.reached, ownBudget: false });
    up.set(node.id, { unit, months, outOfUnit });
  }
  return up;
}
