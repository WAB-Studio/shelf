import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { BottomNav } from "@/components/ui";
import { listGoals } from "@/lib/queries/goal";
import { getPerson } from "@/lib/session";
import { CLOCK_META, civilDateShort, clockOverride, todayInZone } from "@/lib/zone";

/**
 * The signed-in shell: the day, `/metas/**` and nothing else — `/entrar` and
 * `/auth/confirm` sit outside this group, so `app/layout.tsx` (the real root
 * layout) never calls a dynamic API and `/entrar` stays `○ static`. Every
 * page under here still runs its own `getPerson()` gate and its own
 * `redirect("/entrar")`; this layout only decides whether the nav draws,
 * never who may pass.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  // No round trip: `getPerson` is `cache()`-wrapped (`lib/session.ts`), so
  // this pays the same one JWT read every page under here already does.
  const person = await getPerson();
  // The rail names the open goals; a failed read draws it without them.
  const [goals, t, common, theme, tree] = await Promise.all([
    person ? listGoals().catch(() => []) : [],
    getTranslations("common.nav"),
    getTranslations("common"),
    getTranslations("day.theme"),
    getTranslations("tree"),
  ]);

  // `listGoals` is in the tree's preorder: a goal sits one level under its parent.
  const depths = new Map<string, 0 | 1 | 2>();
  const holders = new Set(goals.flatMap((goal) => (goal.parentId ? [goal.parentId] : [])));
  const rail = goals.map((goal) => {
    const parentDepth = goal.parentId ? depths.get(goal.parentId) : undefined;
    const depth = (parentDepth === undefined ? 0 : Math.min(parentDepth + 1, 2)) as 0 | 1 | 2;
    depths.set(goal.id, depth);
    return {
      id: goal.id,
      name: goal.name,
      parentId: goal.parentId,
      depth,
      holds: holders.has(goal.id),
      foldLabel: tree("list.foldNamed", { name: goal.name }),
      unfoldLabel: tree("list.unfoldNamed", { name: goal.name }),
    };
  });

  // Only a pinned test clock draws it; React hoists it into `<head>`.
  const pinned = clockOverride(process.env);

  return (
    <>
      {pinned ? <meta name={CLOCK_META} content={pinned} /> : null}
      {children}
      {person ? (
        <BottomNav
          labels={{ today: t("today"), week: t("week"), month: t("month"), goals: t("goals") }}
          appName={common("appName")}
          goals={rail}
          goalsSectionLabel={t("goalsSection")}
          date={civilDateShort(todayInZone())}
          theme={{ toLightLabel: theme("toLight"), toDarkLabel: theme("toDark") }}
        />
      ) : null}
    </>
  );
}
