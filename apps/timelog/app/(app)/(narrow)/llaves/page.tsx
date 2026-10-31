import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { KeysPanel } from "@/components/screens/keys-panel";
import { Stack, Title } from "@/components/ui";
import { env } from "@/lib/env";
import { listKeys } from "@/lib/queries";
import { calendarWords } from "@/lib/words";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("time.keys");
  return { title: t("title") };
}

export default async function KeysPage() {
  const [keys, words, t] = await Promise.all([listKeys(), calendarWords(), getTranslations("time.keys")]);
  return (
    <Stack gap={4}>
      <Title>{t("title")}</Title>
      <KeysPanel
        siteUrl={env.NEXT_PUBLIC_SITE_URL}
        keys={keys.map((key) => ({ id: key.id, name: key.name, revoked: key.revoked, when: key.lastUsedAt ? words.moment(key.lastUsedAt) : null }))}
      />
    </Stack>
  );
}
