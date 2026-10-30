"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { toast } from "sonner";

import { completeCounterpartyAction } from "@/app/actions/transactions";
import {
  Button,
  Card,
  Field,
  FieldControl,
  FieldDescription,
  FieldLabel,
  Flex,
  Heading,
  Money,
  Select,
  Text,
} from "@/components/ui";
import type { AccountRow } from "@/db/queries/accounts";
import type { AwaitingCounterpartyRow } from "@/db/queries/transactions";
import { civilDateToDate } from "@/lib/dates";
import { useActionErrorToast } from "@/lib/use-action-toast";

// RF-133: a movement with one known side already counts in every balance; naming the other account
// completes it, and the action teaches the pattern behind it (RF-135).
function AwaitingCard({ row, accounts }: { row: AwaitingCounterpartyRow; accounts: AccountRow[] }) {
  const t = useTranslations("ingest.awaiting");
  const format = useFormatter();
  const onError = useActionErrorToast();
  const known = row.missingSide === "from" ? row.toAccountId : row.fromAccountId;
  const offered = accounts.filter((account) => account.id !== known && account.canWrite);
  // A remembered account prefills the choice and never completes on its own (RF-135).
  const [accountId, setAccountId] = useState(row.proposedAccountId ?? "");
  const complete = useAction(completeCounterpartyAction, {
    onSuccess: () => toast.success(t("completed")),
    onError,
  });
  const knownName = accounts.find((account) => account.id === known)?.name ?? "";
  const selectId = `awaiting-${row.id}`;

  return (
    <Card>
      <Flex direction="column" gap="3">
        <Flex justify="between" align="start" gap="3">
          <Flex direction="column" gap="1">
            <Text weight="medium">{row.description ?? t("noDescription")}</Text>
            <Text size="2" color="gray">
              {t(row.missingSide === "from" ? "intoKnown" : "outOfKnown", {
                account: knownName,
                date: format.dateTime(civilDateToDate(row.occurredAt), { dateStyle: "medium" }),
              })}
            </Text>
          </Flex>
          <Money minor={row.amountCents} currency={row.currency} signed={false} />
        </Flex>
        <Field>
          <FieldLabel htmlFor={selectId}>{t(row.missingSide === "from" ? "fromLabel" : "toLabel")}</FieldLabel>
          <Select.Root value={accountId || undefined} onValueChange={setAccountId} disabled={complete.isPending}>
            <FieldControl>
              <Select.Trigger id={selectId} placeholder={t("pick")} />
            </FieldControl>
            <Select.Content position="popper">
              {offered.map((account) => (
                <Select.Item key={account.id} value={account.id}>
                  {account.name}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          {row.proposedAccountId !== null && accountId === row.proposedAccountId && (
            <FieldDescription>{t("proposed")}</FieldDescription>
          )}
        </Field>
        <Flex justify="end">
          <Button
            type="button"
            loading={complete.isPending}
            disabled={accountId === ""}
            onClick={() => complete.execute({ transactionId: row.id, accountId })}
          >
            {t("complete")}
          </Button>
        </Flex>
      </Flex>
    </Card>
  );
}

export function AwaitingCounterparty({ rows, accounts }: { rows: AwaitingCounterpartyRow[]; accounts: AccountRow[] }) {
  const t = useTranslations("ingest.awaiting");
  if (rows.length === 0) return null;
  return (
    <Flex direction="column" gap="3">
      <Flex direction="column" gap="1">
        <Heading size="4">{t("title", { count: rows.length })}</Heading>
        <Text size="2" color="gray">
          {t("description")}
        </Text>
      </Flex>
      {rows.map((row) => (
        <AwaitingCard key={row.id} row={row} accounts={accounts} />
      ))}
    </Flex>
  );
}
