import { getTranslations } from "next-intl/server";

import { Section } from "@/components/ui";
import type { DaylessOneOff } from "@/lib/queries/one-offs";

import { GiveDayRow } from "./give-day-row";

/**
 * «Sin día» on a coming week or month (RP-59, RP-142): the one-offs that wait
 * with no day, each with «Darle día». Nothing is drawn when none waits.
 */
export async function GiveDayList({ tasks }: { tasks: DaylessOneOff[] }) {
  if (tasks.length === 0) return null;
  const t = await getTranslations();
  return (
    <Section as="div" label={t("oneOffs.daylessGroup")}>
      {tasks.map((task) => (
        <GiveDayRow key={task.id} oneOffId={task.id} name={task.name} />
      ))}
    </Section>
  );
}
