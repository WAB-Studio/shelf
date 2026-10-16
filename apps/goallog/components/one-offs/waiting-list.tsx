"use client";

import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button, Flex, Section, Text, TextLink } from "@/components/ui";

import { DaylessRow } from "./dayless-row";

export type WaitingItem = {
  id: string;
  name: string;
  goalName?: string;
  note: string | null;
  // Present for a scheduled one-off: its day and that day in words.
  scheduled?: { day: string; label: string };
};

export type WaitingListProps = {
  dayless: WaitingItem[];
  scheduled: WaitingItem[];
};

/**
 * The groups of `/sueltas` and the line that says where a done one went
 * (`SueltasProgramadasHecha.dc.html`). The line lives here, not in a row: the
 * row leaves the list the moment it is done.
 */
export function WaitingList({ dayless, scheduled }: WaitingListProps) {
  const t = useTranslations();
  const [doneName, setDoneName] = useState<string | null>(null);

  const feminine = t.raw("goal.countWordsFeminine") as string[];
  const masculine = t.raw("goal.countWords") as string[];
  const word = (count: number) => feminine[count] ?? masculine[count] ?? String(count);

  function group(items: WaitingItem[]) {
    return items.map((item) => (
      <DaylessRow
        key={item.id}
        oneOffId={item.id}
        name={item.name}
        goalName={item.goalName}
        note={item.note}
        scheduled={item.scheduled}
        onDone={setDoneName}
      />
    ));
  }

  return (
    <Flex direction="column" gap={{ initial: "6", md: "7" }}>
      {doneName ? (
        <Flex role="status" align="center" justify="between" gap="2">
          <Text as="p" variant="sentence">
            {t("oneOffs.done", { name: doneName })}
          </Text>
          <TextLink href="/">{t("oneOffs.seeToday")}</TextLink>
        </Flex>
      ) : null}
      {dayless.length === 0 && scheduled.length === 0 ? (
        <Section as="div">
          <Text as="p" variant="sentence">
            {t("oneOffs.empty")}
          </Text>
          <Button asChild block variant="outline">
            <Link href="/">{t("oneOffs.emptyToToday")}</Link>
          </Button>
        </Section>
      ) : null}
      {dayless.length > 0 ? (
        <Section label={t("oneOffs.daylessGroup", { count: word(dayless.length) })}>
          {group(dayless)}
        </Section>
      ) : null}
      {scheduled.length > 0 ? (
        <Section
          label={t(scheduled.length === 1 ? "oneOffs.scheduledGroupOne" : "oneOffs.scheduledGroupMany", {
            count: word(scheduled.length),
          })}
        >
          {group(scheduled)}
        </Section>
      ) : null}
    </Flex>
  );
}
