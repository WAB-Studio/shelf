import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { ConnectionsScreen, type ConnectionRow, type ConnectionStamp } from "@/components/connections/connections-screen";
import { env } from "@/lib/env";
import { listAccessTokens } from "@/lib/queries/tokens";
import { getPerson } from "@/lib/session";
import { civilDateInZone, civilDayMonthShort, timeInZone, todayInZone } from "@/lib/zone";

const dayOf = (instant: string) => {
  const day = civilDateInZone(new Date(instant));
  return `${civilDayMonthShort(day)} ${day.slice(0, 4)}`;
};

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("connections") };
}

// The auth gate and the list; the screen words each row. The key a person just
// made is not here: it lives in the screen's state and nowhere a render reaches.
export default async function ConnectionsPage() {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const tokens = await listAccessTokens();

  const today = todayInZone();
  const stamp = (instant: string): ConnectionStamp => {
    const day = civilDateInZone(new Date(instant));
    return { today: day === today, date: dayOf(instant), time: timeInZone(instant) };
  };

  const rows: ConnectionRow[] = tokens.map((token) => ({
    id: token.id,
    kind: token.kind,
    name: token.name,
    revoked: token.revokedAt !== null,
    revokedAt: token.revokedAt ? stamp(token.revokedAt) : null,
    expiredAt: token.expiredAt ? stamp(token.expiredAt) : null,
    created: stamp(token.createdAt),
    used: token.lastUsedAt ? stamp(token.lastUsedAt) : null,
    returnHost: token.returnHost,
    folded: token.folded,
  }));

  return <ConnectionsScreen rows={rows} siteUrl={env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "")} />;
}
