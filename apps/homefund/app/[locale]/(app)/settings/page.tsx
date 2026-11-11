import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { SettingsScreen } from "@/components/fund/settings-screen";
import { Page } from "@/components/ui";
import { getUserGroup } from "@/db/queries/groups";
import { requireUser } from "@/db/session";
import { routing } from "@/i18n/routing";
import { KEEP_SIGNED_IN_KEY } from "@/lib/auth/inactivity";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { choiceOfDays } from "@/lib/validation/session";

export async function generateMetadata(
  props: PageProps<"/[locale]/settings">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "nav" });

  return { title: t("settings") };
}

export default async function SettingsPage(
  props: PageProps<"/[locale]/settings">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  // Miembros only exists inside a fund (RF-55), so the list is built from the
  // caller's group; the auth guard rides beside that read, never ahead of it.
  // The stored value, read from Auth: the token's claims carry a new limit only after the proxy's next refresh.
  const [, group, stored] = await Promise.all([
    requireUser(),
    getUserGroup(),
    createSupabaseServerClient().then((supabase) => supabase.auth.getUser()),
  ]);
  const days = stored.data.user?.user_metadata?.[KEEP_SIGNED_IN_KEY];
  const keepSignedIn = choiceOfDays(typeof days === "number" && days > 0 ? days : null);

  return (
    <Page gutter="flush-md">
      <SettingsScreen hasGroup={group !== null} keepSignedIn={keepSignedIn} />
    </Page>
  );
}
