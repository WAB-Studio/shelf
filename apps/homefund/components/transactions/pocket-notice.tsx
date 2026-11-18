"use client";

import { InfoIcon } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";

import { Callout } from "@/components/ui";
import type { CurrencyCode } from "@/lib/currency";
import type { Locale } from "@/lib/locales";
import type { PocketCover } from "@/lib/pocket-cover";
import { signPrefix } from "@/lib/money";
import { useMoneyText } from "@/lib/use-privacy";

// What a movement will draw from an account's pockets, as one phrase: «$300.000 de Viajes y $50.000 de
// Casa». Null when it draws nothing. The movement form and the debt payment dialog say it the same way (RF-276).
export function usePocketList(plan: PocketCover | null, currency: CurrencyCode): string | null {
  const t = useTranslations("transactions");
  const format = useFormatter();
  const locale = useLocale() as Locale;
  const moneyText = useMoneyText();

  if (!plan) return null;
  return format.list(
    plan.takes.map((take) => t("pocketTake", { amount: moneyText(take.cents, currency, locale), name: take.name })),
  );
}

// Said before saving, never after: the database takes it from the pockets on its own (RF-249).
export function PocketNotice({ list }: { list: string }) {
  const t = useTranslations("transactions");

  return (
    <Callout.Root color="amber" variant="soft" role="status">
      <Callout.Icon>
        <InfoIcon size={16} />
      </Callout.Icon>
      <Callout.Text>{t("pocketNotice", { list })}</Callout.Text>
    </Callout.Root>
  );
}

// The account would end below zero even after its pockets give what they can; the person may still confirm.
export function OverdraftNotice({
  accountName,
  balanceCents,
  currency,
}: {
  accountName: string;
  balanceCents: number;
  currency: CurrencyCode;
}) {
  const t = useTranslations("transactions");
  const locale = useLocale() as Locale;
  const moneyText = useMoneyText();

  return (
    <Callout.Root color="amber" variant="soft" role="status">
      <Callout.Icon>
        <InfoIcon size={16} />
      </Callout.Icon>
      <Callout.Text>
        {t("overdraftNotice", { account: accountName, amount: `${signPrefix(balanceCents)}${moneyText(balanceCents, currency, locale)}` })}
      </Callout.Text>
    </Callout.Root>
  );
}
