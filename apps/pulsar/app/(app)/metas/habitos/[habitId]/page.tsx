import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { HabitScreen } from "@/components/habit/habit-screen";
import { loadHabit } from "@/lib/queries/habit";
import { getPerson } from "@/lib/session";

// Static per route: no title reads a habit or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("habit");
  return { title: t("title") };
}

// `HabitoPantalla` (RP-105): the auth gate, the one query and the way back.
// Only `?volver=/mes` is followed; anything else returns to /metas.
export default async function HabitPage({
  params,
  searchParams,
}: {
  params: Promise<{ habitId: string }>;
  searchParams: Promise<{ volver?: string | string[]; todo?: string | string[] }>;
}) {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const { habitId } = await params;
  const { volver, todo } = await searchParams;
  const [habit, nav] = await Promise.all([loadHabit(habitId), getTranslations("common.nav")]);
  if (!habit) notFound();

  const toMonth = volver === "/mes";
  const back = toMonth ? { href: "/mes", place: nav("month") } : { href: "/metas", place: nav("goals") };
  const base = `/metas/habitos/${habit.id}`;
  const seeAllHref = toMonth ? `${base}?volver=/mes&todo=1` : `${base}?todo=1`;
  const seeLessHref = toMonth ? `${base}?volver=/mes` : base;
  return <HabitScreen habit={habit} back={back} seeAllHref={seeAllHref} seeLessHref={seeLessHref} all={todo === "1"} />;
}
