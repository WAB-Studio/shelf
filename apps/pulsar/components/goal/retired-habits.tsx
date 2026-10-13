"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import { Row } from "@/components/ui";

export type RetiredHabit = { id: string; name: string; retiredLine: string };

/**
 * `HabitosRetirados` (RP-109): the group row under «Hábitos» and, unfolded, one
 * row per retired habit. Folding lives in this screen alone — nothing is stored,
 * so a reload folds it again.
 */
export function RetiredHabits({
  habits,
  label,
  foldLabel,
  unfoldLabel,
}: {
  habits: RetiredHabit[];
  label: string;
  foldLabel: string;
  unfoldLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const Arrow = open ? ChevronDown : ChevronRight;
  return (
    <>
      <Row
        name={label}
        leading={<Arrow size={16} strokeWidth={1.5} aria-hidden />}
        trailing={habits.length}
        aria-expanded={open}
        aria-label={open ? foldLabel : unfoldLabel}
        onClick={() => setOpen((current) => !current)}
      />
      {open
        ? habits.map((habit) => (
            <Row
              key={habit.id}
              href={`/metas/habitos/${habit.id}`}
              level={1}
              name={habit.name}
              meta={habit.retiredLine}
              metaVariant="sentence"
              trailing={<ChevronRight size={16} strokeWidth={1.5} aria-hidden />}
            />
          ))
        : null}
    </>
  );
}
