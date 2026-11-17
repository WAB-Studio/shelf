"use client";

import { useTranslations } from "next-intl";
import { Fragment, useState } from "react";

import { OwedBreakdownDialog } from "@/components/accounts/owed-breakdown-dialog";
import { Button, Card, Flex, Money, Text } from "@/components/ui";
import type { CurrencyCode } from "@/lib/currency";
import type { OwedCurrency, OwedPerson } from "@/lib/owed-to-me";

// A person's name and figure as one button that opens where the figure comes from.
function PersonButton({ person, onOpen }: { person: OwedPerson; onOpen: (person: OwedPerson) => void }) {
  const t = useTranslations("owedToMe");

  return (
    <Button type="button" variant="ghost" size="1" tap={false} aria-label={t("openFor", { person: person.name })} onClick={() => onOpen(person)}>
      {person.name} <Money minor={person.cents} currency={person.currency as CurrencyCode} tone="plain" size="inherit" signed={false} />
    </Button>
  );
}

/**
 * Inicio's «Te deben $X: John $Y · Carlos $Z»: one line per currency, since two never add up (RF-124), and each
 * name opens its breakdown. Nothing when nobody owes the person.
 */
export function OwedToMeLine({ owed }: { owed: OwedCurrency[] }) {
  const t = useTranslations("owedToMe");
  const [open, setOpen] = useState<OwedPerson | null>(null);
  if (owed.length === 0) return null;

  return (
    <Card>
      <Flex direction="column" gap="2">
        {owed.map((group) => (
          <Text key={group.currency} size="2" weight="medium">
            {t.rich("lineTotal", {
              total: () => <Money minor={group.totalCents} currency={group.currency as CurrencyCode} tone="plain" size="inherit" signed={false} />,
            })}
            {": "}
            {group.people.map((person, index) => (
              <Fragment key={person.key}>
                {index > 0 && " · "}
                <PersonButton person={person} onOpen={setOpen} />
              </Fragment>
            ))}
          </Text>
        ))}
      </Flex>
      {open && <OwedBreakdownDialog person={open} onOpenChange={(next) => !next && setOpen(null)} />}
    </Card>
  );
}
