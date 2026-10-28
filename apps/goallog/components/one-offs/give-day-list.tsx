import { getTranslations } from "next-intl/server";

import { Section } from "@/components/ui";
import type { DaylessOneOff } from "@/lib/queries/one-offs";

import { GiveDayRow } from "./give-day-row";

/**
 * «Sin día» on a coming week or month (RP-59, RP-142): a goal's tasks and the
 * loose ones that wait with no day, each with «Darle día». Nothing is drawn
 * when none waits.
 */
export async function GiveDayList({ tasks, suggest }: { tasks: DaylessOneOff[]; suggest: string }) {
  if (tasks.length === 0) return null;
  const t = await getTranslations();
  return (
    <Section as="div" label={t("oneOffs.daylessGroup")}>
      {tasks.map((task) => (
        <GiveDayRow
          // A step to another week keeps the row: the key carries the day it proposes.
          key={`${task.id}:${suggest}`}
          oneOffId={task.id}
          name={task.name}
          suggest={suggest}
          meta={task.goalName ? t("oneOffs.giveDay.goal", { goal: task.goalName }) : undefined}
        />
      ))}
    </Section>
  );
}
