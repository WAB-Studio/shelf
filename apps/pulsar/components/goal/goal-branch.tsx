"use client";

import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Row } from "@/components/ui";

export type BranchGoal = {
  id: string;
  parentId: string | null;
  depth: 0 | 1 | 2;
  // Its level of the tree draws arrows, so it keeps the arrow's slot.
  slot: boolean;
  holds: boolean;
  name: string;
  meta: ReactNode;
  narrowMetaAbove?: ReactNode;
  wideMeta?: ReactNode;
  wideTrailing?: ReactNode;
};

/**
 * `JerarquiaArbol` (RP-81): the open goals in tree order. Folding lives in
 * this screen alone — nothing is stored and no request leaves — so a reload
 * draws every branch open again.
 */
export function GoalBranch({
  goals,
  foldLabel,
  unfoldLabel,
}: {
  goals: BranchGoal[];
  foldLabel: string;
  unfoldLabel: string;
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const parentOf = new Map(goals.map((goal) => [goal.id, goal.parentId]));
  const hidden = (goal: BranchGoal) => {
    for (let up = goal.parentId; up; up = parentOf.get(up) ?? null) {
      if (folded.has(up)) return true;
    }
    return false;
  };
  const toggle = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const chevron = <ChevronRight size={16} strokeWidth={1.5} aria-hidden />;

  return goals
    .filter((goal) => !hidden(goal))
    .map((goal) => {
      const expanded = !folded.has(goal.id);
      return (
        <Row
          key={goal.id}
          href={`/metas/${goal.id}`}
          level={goal.depth}
          foldSlot={goal.slot}
          fold={
            goal.holds
              ? { expanded, label: expanded ? foldLabel : unfoldLabel, onToggle: () => toggle(goal.id) }
              : undefined
          }
          name={goal.name}
          meta={goal.meta}
          metaVariant="sentence"
          narrowMetaAbove={goal.narrowMetaAbove}
          wideMeta={goal.wideMeta}
          wideTrailing={goal.wideTrailing}
          trailing={chevron}
        />
      );
    });
}
