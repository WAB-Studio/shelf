import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { SettingsScreen } from "@/components/fund/settings-screen";
import { Page } from "@/components/ui";
import { getUserGroup } from "@/db/queries/groups";
import { requireUser } from "@/db/session";
import { routing } from "@/i18n/routing";
import { keepDaysFromClaims } from "@/lib/auth/inactivity";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { KEEP_SIGNED_IN_CHOICES, type KeepSignedInChoice } from "@/lib/validation/session";

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
  const [, group] = await Promise.all([requireUser(), getUserGroup()]);

  // The proxy already refreshed the token, so this reads the claims without a round trip.
  const claims = (await (await createSupabaseServerClient()).auth.getClaims()).data?.claims;
  const days = String(keepDaysFromClaims(claims));
  const keepSignedIn = (KEEP_SIGNED_IN_CHOICES as readonly string[]).includes(days) ? (days as KeepSignedInChoice) : "always";

  return (
    <Page gutter="flush-md">
      <SettingsScreen hasGroup={group !== null} keepSignedIn={keepSignedIn} />
    </Page>
  );
}
