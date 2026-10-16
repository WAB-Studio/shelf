import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { TaskForm } from "@/components/month/task-form";
import { loadGoal } from "@/lib/queries/goal";
import { getPerson } from "@/lib/session";

const monthFormat = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" });

/**
 * `TareaNueva`, `SubtareaNueva`, `TareaSinMedida` (RP-30, RP-31): the auth gate
 * and what the form needs of one goal read by `loadGoal`. A closed month, a
 * closed goal and a `?padre=` that is not a sub-taskable parent of this month
 * answer `notFound()` — the screens draw no way in to them, so a direct visit
 * is refused the way `fases/nueva` refuses an archived goal.
 */
// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("newTask") };
}

export default async function NewTaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ goalId: string; mes: string }>;
  searchParams: Promise<{ padre?: string | string[] }>;
}) {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const { goalId, mes } = await params;
  const { padre } = await searchParams;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) notFound();
  if (Array.isArray(padre)) notFound();

  const goal = await loadGoal(goalId);
  if (!goal) notFound();
  if (goal.archivedAt || goal.endedOn) notFound();
  const row = goal.months.find((entry) => entry.month === `${mes}-01`);
  if (!row || row.past) notFound();

  let parent: { id: string; name: string; childTotal: number } | null = null;
  if (padre !== undefined) {
    const found = goal.tasks.find((task) => task.id === padre);
    if (
      !found ||
      found.parentId !== null ||
      found.plannedMonth?.slice(0, 7) !== mes ||
      found.day !== null ||
      found.estimate !== null ||
      found.doneOn !== null
    ) {
      notFound();
    }
    const children = goal.tasks.filter((task) => task.parentId === found.id);
    parent = {
      id: found.id,
      name: found.name,
      childTotal: children.reduce((total, child) => total + (child.estimate ?? 0), 0),
    };
  }

  return (
    <TaskForm
      // Saving a parent navigates here from the same form: remount it, or its typed name and checkbox ride along.
      key={parent?.id ?? "new"}
      goalId={goal.id}
      goalName={goal.name}
      unit={goal.measureUnit}
      month={mes}
      monthName={monthFormat.format(new Date(`${mes}-01T12:00:00Z`))}
      parent={parent}
    />
  );
}
