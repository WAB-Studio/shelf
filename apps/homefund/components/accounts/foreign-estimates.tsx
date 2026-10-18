"use client";

import { useFormatter, useTranslations } from "next-intl";
import { Fragment } from "react";

import { SettlementRow } from "@/components/planning/settlement-row";
import {
  Button,
  Dialog,
  Flex,
  Heading,
  Money,
  Text,
} from "@/components/ui";
import type { AccountRow } from "@/db/queries/accounts";
import type { AccountPendingSettlement } from "@/db/queries/debt-statements";
import { civilDateToDate } from "@/lib/dates";

export type BilledTarget = {
  account: AccountRow;
  movement: AccountPendingSettlement;
};

/**
 * The purchases in another currency an asset account has not had billed yet
 * (RF-123, RF-137), drawn on the account's own card. Nothing is drawn when there
 * are none. «Confirmar monto» is offered only where the policies would admit the
 * write; a reader sees the figures alone.
 */
export function ForeignEstimates({
  account,
  pending,
  onConfirm,
}: {
  account: AccountRow;
  pending: AccountPendingSettlement[];
  onConfirm: (target: BilledTarget) => void;
}) {
  const t = useTranslations("debts.settlement");
  const format = useFormatter();

  if (pending.length === 0) return null;

  return (
    <Flex direction="column" gap="2">
      <Heading as="h3" size="2">
        {t("title")}
      </Heading>
      {pending.map((movement) => {
        const occurred = format.dateTime(civilDateToDate(movement.occurredAt), {
          day: "numeric",
          month: "short",
        });

        return (
          <Fragment key={movement.id}>
            <Flex justify="between" align="center" gap="3">
              <Text size="2" weight="medium" truncate>
                {movement.description === null
                  ? occurred
                  : `${movement.description} · ${occurred}`}
              </Text>
              <Text size="2" color="gray">
                <Money
                  minor={movement.amountCents}
                  currency={movement.currency}
                  signed={false}
                  size="inherit"
                />
              </Text>
            </Flex>
            <Flex justify="between" align="center" gap="3">
              <Text size="2" color="gray">
                {t("estimate")}
              </Text>
              <Text size="2" color="gray">
                <Money
                  minor={movement.counterAmountCents}
                  currency={account.settlementCurrency}
                  estimate
                  signed={false}
                  size="inherit"
                />
              </Text>
            </Flex>
            {account.canWrite && (
              <Flex>
                <Button
                  type="button"
                  variant="soft"
                  onClick={() => onConfirm({ account, movement })}
                >
                  {t("confirm")}
                </Button>
              </Flex>
            )}
          </Fragment>
        );
      })}
    </Flex>
  );
}

/**
 * The debts screen's row body in a dialog: «Gastado», «Estimado», the billed
 * field and the rate. Saving closes it; a refusal stays under the field.
 */
export function BilledAmountDialog({
  target,
  onClose,
}: {
  target: BilledTarget;
  onClose: () => void;
}) {
  const t = useTranslations("debts.settlement");
  const tKey = useTranslations();

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content>
        <Dialog.Title>{t("confirm")}</Dialog.Title>
        <Dialog.Description size="2" color="gray">
          {target.account.name}
        </Dialog.Description>
        <SettlementRow
          movement={target.movement}
          accountId={target.account.id}
          currency={target.account.settlementCurrency}
          canWrite={target.account.canWrite}
          hint
          onSaved={onClose}
        />
        <Flex justify="end">
          <Dialog.Close>
            <Button type="button" variant="ghost" color="gray">
              {tKey("common.cancel")}
            </Button>
          </Dialog.Close>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
