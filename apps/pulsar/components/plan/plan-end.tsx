"use client";

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";

import { MoveEndSheet } from "@/components/plan/move-end-sheet";
import { RhythmSheet } from "@/components/plan/rhythm-sheet";
import { TaskSheet } from "@/components/plan/task-sheet";
import { Button, Flex, Row, Text } from "@/components/ui";
import { Figure, useTimeWords } from "@/components/ui/figure";
import { dayBefore } from "@/lib/day/weeks";
import type { PlanInput } from "@/lib/plan/roadmap";
import { formatQuantity } from "@/lib/units/time";
import { civilDateWithYear } from "@/lib/zone";

/**
 * `RoadmapPasaElFinal`'s two offers (RP-53): raise the rhythm to the one that
 * meets the end, or move the end to the plan's in one tap.
 */
export function PlanEnd({
  goalId,
  goalName,
  unit,
  plan,
  meets,
  planEnd,
  moveTo,
}: {
  goalId: string;
  goalName: string;
  unit: string | null;
  plan: PlanInput;
  // The rhythm that reaches the goal's end; null when none does.
  meets: number | null;
  // The day the plan ends, and the horizon that holds it.
  planEnd: string;
  moveTo: string;
}) {
  const t = useTranslations();
  const words = useTimeWords();
  const [open, setOpen] = useState(false);

  return (
    <Flex direction="column" gap="3">
      {unit && meets !== null ? (
        <RhythmSheet
          goalId={goalId}
          goalName={goalName}
          unit={unit}
          plan={plan}
          initial={meets}
          name={t("roadmap.pasaElFinal.raise")}
          meta={t.rich("roadmap.pasaElFinal.raiseHint", {
            hours: formatQuantity(meets, unit, words),
            fig: (chunks) => <Figure variant="meta" value={chunks} />,
          })}
        />
      ) : null}
      <Row
        card
        rule={false}
        name={t("roadmap.pasaElFinal.moveEnd")}
        meta={t.rich("roadmap.pasaElFinal.moveEndHint", {
          date: civilDateWithYear(planEnd),
          fig: (chunks) => <Figure variant="meta" value={chunks} />,
        })}
        metaVariant="sentence"
        trailing={<ChevronRight size={20} aria-hidden />}
        onClick={() => setOpen(true)}
      />
      <MoveEndSheet goalId={goalId} from={dayBefore(plan.horizon)} to={planEnd} moveTo={moveTo} open={open} onOpenChange={setOpen} />
      <Text as="p" variant="sentence">
        {t("roadmap.pasaElFinal.removeTasks")}
      </Text>
    </Flex>
  );
}

/** The plan's footer (RP-55): «Añadir una tarea» opens `RoadmapTareaNueva`. */
export function AddTask({
  goalId,
  goalName,
  unit,
  months,
  variant,
}: {
  goalId: string;
  goalName: string;
  unit: string | null;
  months: string[];
  // Outline while the rhythm form's own solid act is on screen: one per screen.
  variant: "solid" | "outline";
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>{t("roadmap.plan.addTask")}</Button>
      <TaskSheet
        mode="create"
        goalId={goalId}
        goalName={goalName}
        unit={unit}
        fixedMonth={null}
        planMonth={null}
        months={months}
        done={false}
        kind="task"
        canDelete={false}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
