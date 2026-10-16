import { getTranslations } from "next-intl/server";

import { BottomNav } from "@/components/ui";

import { civilDateShort, todayInZone } from "@/lib/zone";

import AppNotFound from "./(app)/not-found";

/**
 * Any URL this app does not route at all, `/no-existe` included, and a
 * `notFound()` with no nearer boundary. Outside `app/(app)/layout.tsx`, so the
 * nav is drawn here by hand; `AppNotFound` marks no tab. Inside the app,
 * `app/(app)/not-found.tsx` takes over and the layout's nav is the only one.
 */
export default async function NotFound() {
  const nav = await getTranslations("common.nav");
  const common = await getTranslations("common");
  const theme = await getTranslations("day.theme");

  return (
    <>
      <AppNotFound />
      <BottomNav
        labels={{ today: nav("today"), week: nav("week"), month: nav("month"), goals: nav("goals") }}
        appName={common("appName")}
        date={civilDateShort(todayInZone())}
        theme={{ toLightLabel: theme("toLight"), toDarkLabel: theme("toDark") }}
      />
    </>
  );
}
