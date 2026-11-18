"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { OwedBreakdownDialog } from "@/components/accounts/owed-breakdown-dialog";
import { WIDTHS } from "@/components/accounts/accounts-table";
import { Box, Button, Card, DataTable, Flex, Money, Text, type DataColumn } from "@/components/ui";
import { useMoneyText } from "@/lib/use-privacy";
import type { CurrencyCode } from "@/lib/currency";
import type { Locale } from "@/lib/locales";
import type { OwedCurrency, OwedPerson } from "@/lib/owed-to-me";

/**
 * Cuentas' «Te deben»: the same rows as Inicio's line, one per person and currency, each with what it comes from
 * and a figure that opens its breakdown. A band of the accounts table's own language on the desktop and cards on
 * the phone (RF-318). Nothing when nobody owes the person: an empty section is noise.
 */
export function OwedToMeSection({ owed }: { owed: OwedCurrency[] }) {
  const t = useTranslations("owedToMe");
  const tAccounts = useTranslations("accounts");
  const locale = useLocale() as Locale;
  const moneyText = useMoneyText();
  const [open, setOpen] = useState<OwedPerson | null>(null);
  if (owed.length === 0) return null;

  const people = owed.flatMap((group) => group.people);

  const detail = (person: OwedPerson) => (
    <>
      <Text size="2" color="gray">
        {t(person.source === "credit" ? "sourceCredit" : person.breakdown.every((line) => line.kind === "opening") ? "sourceOpening" : "sourcePerson")}
      </Text>
      {person.withInterest !== null && (
        <Text size="2" color="gray">
          {t("withInterest", {
            amount: moneyText(person.withInterest.cents, person.currency as CurrencyCode, locale),
            count: person.withInterest.count,
          })}
        </Text>
      )}
    </>
  );

  const figure = (person: OwedPerson) => (
    <Button
      type="button"
      variant="ghost"
      color="gray"
      highContrast
      inline
      aria-label={t("openFor", { person: person.name })}
      onClick={() => setOpen(person)}
    >
      <Money minor={person.cents} currency={person.currency as CurrencyCode} tone="plain" signed={false} />
    </Button>
  );

  const columns: DataColumn<OwedPerson>[] = [
    {
      key: "name",
      header: tAccounts("nameLabel"),
      width: WIDTHS.name,
      cell: (person) => (
        <Flex direction="column" gap="1" minWidth="0">
          <Text size="2" weight="medium" truncate>
            {person.name}
          </Text>
          {detail(person)}
        </Flex>
      ),
    },
    { key: "balance", header: tAccounts("balanceLabel"), width: WIDTHS.balance, align: "end", numeric: true, cell: figure },
    { key: "menu", header: "", width: WIDTHS.menu, cell: () => null },
  ];

  return (
    <>
      <Box role="region" aria-label={t("sectionTitle")} display={{ initial: "none", lg: "block" }}>
        <DataTable
          label={t("sectionTitle")}
          columns={columns}
          sections={[{ key: "owed", label: t("sectionTitle"), rows: people }]}
          rowKey={(person) => person.key}
        />
      </Box>
      <Box role="region" aria-label={t("sectionTitle")} display={{ initial: "block", lg: "none" }}>
        <Flex direction="column" gap="3">
          <Text size="2" weight="bold" color="gray">
            {t("sectionTitle")}
          </Text>
          {people.map((person) => (
            <Card key={person.key}>
              <Flex justify="between" align="start" gap="3">
                <Flex direction="column" gap="1" flexGrow="1" minWidth="0">
                  <Text weight="medium">{person.name}</Text>
                  {detail(person)}
                </Flex>
                {figure(person)}
              </Flex>
            </Card>
          ))}
        </Flex>
      </Box>
      {open && <OwedBreakdownDialog person={open} onOpenChange={(next) => !next && setOpen(null)} />}
    </>
  );
}
