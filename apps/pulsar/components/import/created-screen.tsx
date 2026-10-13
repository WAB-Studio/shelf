"use client";

import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { clearCreated, reasonSentence, type CreatedResult } from "@/lib/import/created-store";
import { civilDateToDate } from "@/lib/zone";
import { ActionBar, Button, Flex, Page, ScreenHeader, Section, Text } from "@/components/ui";
import type { MessageKey } from "@/i18n/translator";

/**
 * «Plan creado» (RP-90): what the confirm left out, one row per part with where it went and what
 * to do. No row is marked: the parts are fixed by hand in their goal, so there is nothing to choose.
 */
export function CreatedScreen({ result }: { result: CreatedResult }) {
  const t = useTranslations();
  const format = useFormatter();
  const monthWord = (month: string) => format.dateTime(civilDateToDate(`${month}-01`), { month: "long", timeZone: "UTC" });

  return (
    <Page width="full">
      <ScreenHeader title={t("import.created.title")} eyebrow={t("import.created.eyebrow")} />
      <Flex direction="column" gap="6">
        <Text as="p" variant="sentence" tone="ink">
          {t("import.created.count", { goals: result.goals, parts: result.parts.length })}
        </Text>
        <Section label={t("import.created.section")}>
          <Flex direction="column" gap="5">
            <Text as="p" variant="sentence" tone="muted">
              {t("import.created.hint")}
            </Text>
            {result.parts.map((part, i) => (
              <Flex key={`${part.goal}-${part.kind}-${part.name}-${i}`} direction="column" gap="1">
                <Text as="span" variant="body" tone="muted">
                  {part.name}
                </Text>
                <Text as="span" variant="meta" tone="secondary">
                  {[part.goal, t(`import.created.kinds.${part.kind}`), part.month ? monthWord(part.month.slice(0, 7)) : null].filter(Boolean).join(" · ")}
                </Text>
                <Text as="span" variant="sentence" tone="ink">
                  {t(reasonSentence(part.reason) as MessageKey)}
                </Text>
              </Flex>
            ))}
          </Flex>
        </Section>
        <ActionBar>
          <Button asChild block>
            <Link href="/metas" onClick={clearCreated}>
              {t("import.created.goTo")}
            </Link>
          </Button>
        </ActionBar>
      </Flex>
    </Page>
  );
}
