import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { Consent } from "@/components/oauth/consent";
import { Invalid } from "@/components/oauth/invalid";
import { requireUser } from "@/db/session";
import { routing } from "@/i18n/routing";
import { env } from "@/lib/env";
import { servedOrigins } from "@/lib/oauth/hosts";
import { findClient } from "@/lib/oauth/grants";
import { redirectAllowed } from "@/lib/oauth/clients";
import { authorizationRequestSchema } from "@/lib/validation/oauth";

export async function generateMetadata(props: PageProps<"/[locale]/oauth/authorize">): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "oauth" });

  return { title: t("title") };
}

// A signed-out visit never gets here: the proxy sends it to the sign-in and brings it back with this query.
export default async function AuthorizePage(props: PageProps<"/[locale]/oauth/authorize">) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const parsed = authorizationRequestSchema(servedOrigins(env.NEXT_PUBLIC_SITE_URL)).safeParse(await props.searchParams);
  if (!parsed.success) return <Invalid />;

  const [user, client] = await Promise.all([requireUser(), findClient(parsed.data.client_id)]);
  if (!client || !redirectAllowed(client, parsed.data.redirect_uri)) return <Invalid />;

  return <Consent client={client.name} email={user.email} request={parsed.data} />;
}
