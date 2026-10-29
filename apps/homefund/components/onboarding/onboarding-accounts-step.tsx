"use client";

import { Plus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { AccountFormDialog } from "@/components/accounts/account-form-dialog";
import {
  Badge,
  Button,
  Card,
  Flex,
  Text,
} from "@/components/ui";
import type { AccountRow } from "@/db/queries/accounts";
import { Link as LocaleLink } from "@/i18n/navigation";
import { formatMoney } from "@/lib/money";

// The list is the server's `accounts` prop: `createAccountAction` calls
// `refresh()`, so a new account re-renders here without any client copy.
export function OnboardingAccountsStep({
  accounts,
}: {
  accounts: AccountRow[];
  groupName: string | null;
}) {
  const t = useTranslations("onboarding.accountsStep");
  // The add trigger reuses the accounts label, like the dialog's own fields.
  const tAccounts = useTranslations("accounts");

  // The dialog only ever creates here; the flow has no edit path.
  const [open, setOpen] = useState(false);

  return (
    <Flex direction="column" gap={{ initial: "4", md: "5" }}>
      <Button
        type="button"
        size={{ initial: "3", md: "4" }}
        variant="soft"
        onClick={() => setOpen(true)}
      >
        <Plus size={16} />
        {tAccounts("add")}
      </Button>

      {accounts.length > 0 && (
        <Flex direction="column" gap="2">
          <Text size="1" weight="bold" color="gray">
            {t("added")}
          </Text>
          <Flex direction="column" gap="2">
            {accounts.map((account) => (
              <AddedAccountCard key={account.id} account={account} />
            ))}
          </Flex>
        </Flex>
      )}

      <Button asChild size={{ initial: "3", md: "4" }}>
        <LocaleLink href="/onboarding/invite">{t("continue")}</LocaleLink>
      </Button>

      <AccountFormDialog
        hasGroup
        open={open}
        onOpenChange={setOpen}
      />
    </Flex>
  );
}

function AddedAccountCard({ account }: { account: AccountRow }) {
  const t = useTranslations("accounts");
  const locale = useLocale();

  return (
    <Card>
      <Flex justify="between" align="center" gap="3">
        <Flex align="center" gap="2" wrap="wrap" minWidth="0">
          <Text weight="medium">{account.name}</Text>
          <Badge color={account.kind === "liability" ? "red" : "green"}>
            {t(account.kind === "liability" ? "kindLiability" : "kindAsset")}
          </Badge>
        </Flex>
        {/* The entered opening figure, never a derived balance: no movement
            exists yet on this screen. Drawn in the account's own currency
            (RF-121, RF-125), which a named format cannot do: one carries a fixed
            currency and no locale. `formatMoney` takes the magnitude, and the
            badge beside it is what says which side the account is on. */}
        <Text weight="medium">
          {formatMoney(
            account.initialBalanceCents,
            account.settlementCurrency,
            locale,
          )}
        </Text>
      </Flex>
    </Card>
  );
}
