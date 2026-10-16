import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { Page } from "@/components/ui";
import { WebhooksScreen } from "@/components/webhooks/webhooks-screen";
import {
  getWebhookCredentialOptions,
  listWebhookCredentials,
} from "@/db/queries/webhook-credentials";
import { routing } from "@/i18n/routing";
import { env } from "@/lib/env";

export async function generateMetadata(
  props: PageProps<"/[locale]/settings/webhooks">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "webhooks" });

  return { title: t("title") };
}

export default async function WebhooksPage(
  props: PageProps<"/[locale]/settings/webhooks">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const [credentials, options] = await Promise.all([
    listWebhookCredentials(),
    getWebhookCredentialOptions(),
  ]);

  // The proxy matcher excludes `/api`, so the ingest path carries no locale.
  const ingestUrl = new URL(
    "/api/webhooks/ingest",
    env.NEXT_PUBLIC_SITE_URL,
  ).toString();

  return (
    <Page>
      <WebhooksScreen
        credentials={credentials}
        options={options}
        ingestUrl={ingestUrl}
      />
    </Page>
  );
}
