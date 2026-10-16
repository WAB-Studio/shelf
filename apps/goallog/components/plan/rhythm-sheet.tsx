"use client";

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";

import { Row, Sheet } from "@/components/ui";
import type { PlanInput } from "@/lib/plan/roadmap";
import { isTimeUnit } from "@/lib/units/time";

import { RhythmForm } from "./rhythm-form";

/**
 * `RoadmapRitmoHoja` (RP-50): a card row that opens the rhythm form in a sheet,
 * prefilled with `initial` — the goal's rhythm, or the one «Subir el ritmo»
 * names.
 */
export function RhythmSheet({
  goalId,
  goalName,
  unit,
  plan,
  initial,
  name,
  meta,
  trailing,
}: {
  goalId: string;
  goalName: string;
  unit: string;
  plan: PlanInput;
  initial: number | null;
  // The card row's own words: its name, the line under it, and what sits at
  // its end (a chevron when absent).
  name: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Row
        card
        rule={false}
        name={name}
        meta={meta}
        metaVariant="sentence"
        trailing={trailing ?? <ChevronRight size={20} aria-hidden />}
        onClick={() => setOpen(true)}
      />
      <Sheet
        open={open}
        onOpenChange={setOpen}
        label={t("roadmap.ritmo.eyebrow", { goal: goalName })}
        title={isTimeUnit(unit) ? t("roadmap.ritmo.title") : t("roadmap.ritmo.titleOther", { unit })}
      >
        {open ? (
          <RhythmForm
            sheet
            goalId={goalId}
            unit={unit}
            plan={plan}
            initial={initial}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </Sheet>
    </>
  );
}
