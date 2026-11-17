"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { OwedBreakdownDialog } from "@/components/accounts/owed-breakdown-dialog";
import { Button, Flex, Heading, Money, Text } from "@/components/ui";
import type { CurrencyCode } from "@/lib/currency";
import type { OwedCurrency, OwedPerson } from "@/lib/owed-to-me";

/**
 * Cuentas' «Te deben»: the same rows as Inicio's line, one per person and currency, each with what it comes from
 * and a figure that opens its breakdown. Nothing when nobody owes the person: an empty section is noise.
 */
export function OwedToMeSection({ owed }: { owed: OwedCurrency[] }) {
  const t = useTranslations("owedToMe");
  const [open, setOpen] = useState<OwedPerson | null>(null);
  if (owed.length === 0) return null;

  return (
    <Flex direction="column" gap="2" role="region" aria-label={t("sectionTitle")}>
        <Heading as="h2" size="3">
          {t("sectionTitle")}
        </Heading>
        {owed.flatMap((group) => group.people).map((person) => (
          <Flex key={person.key} align="center" justify="between" gap="4" py="2">
            <Flex direction="column">
              <Text size="2" weight="medium">
                {person.name}
              </Text>
              <Text size="1" color="gray">
                {t(person.source === "credit" ? "sourceCredit" : "sourcePerson")}
              </Text>
            </Flex>
            <Button type="button" variant="ghost" size="2" tap={false} aria-label={t("openFor", { person: person.name })} onClick={() => setOpen(person)}>
              <Money minor={person.cents} currency={person.currency as CurrencyCode} tone="plain" size="inherit" signed={false} />
            </Button>
          </Flex>
        ))}
        {open && <OwedBreakdownDialog person={open} onOpenChange={(next) => !next && setOpen(null)} />}
    </Flex>
  );
}
