"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { deferPurchaseAction, undeferPurchaseAction } from "@/app/actions/deferrals";
import {
  Button,
  Dialog,
  Field,
  FieldControl,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  Panel,
  PanelBlock,
  PanelRow,
  Spinner,
  Text,
  TextField,
} from "@/components/ui";
import type { DeferralRow } from "@/db/queries/deferrals";
import type { CurrencyCode } from "@/lib/currency";
import { useMoneyText } from "@/lib/use-privacy";
import { useActionErrorToast } from "@/lib/use-action-toast";
import { deferPurchaseSchema, type DeferPurchaseInput } from "@/lib/validation/deferral";

/**
 * What a deferred purchase reads as: «Cuota 3 de 36 · $ 12.345 al mes», or «Extinguida». The balance
 * never moves with it (RF-136).
 */
export function useDeferralLine() {
  const moneyText = useMoneyText();
  const t = useTranslations("deferrals");
  const locale = useLocale();

  return (row: DeferralRow) =>
    row.status.state === "extinguished"
      ? t("extinguished")
      : t("step", {
          current: row.status.current,
          total: row.status.total,
          amount: moneyText(row.status.shareCents, row.currency as CurrencyCode, locale),
        });
}

/**
 * The movement's own say on its deferral: «Diferir en cuotas» on a purchase of a liability, and
 * «Quitar diferido» once a person confirmed one. Nothing is deferred without that confirmation.
 */
export function DeferralControl({
  transactionId,
  deferral,
  canDefer,
}: {
  transactionId: string;
  deferral: DeferralRow | null;
  canDefer: boolean;
}) {
  const t = useTranslations("deferrals");
  const line = useDeferralLine();
  const onActionError = useActionErrorToast();
  const [open, setOpen] = useState(false);

  const remove = useAction(undeferPurchaseAction, {
    onSuccess: () => toast.success(t("removed")),
    onError: onActionError,
  });

  if (!canDefer && !deferral) return null;

  return (
    <Panel title={t("title")}>
      <PanelBlock>
        <Flex align="center" justify="between" gap="3" wrap="wrap">
          {deferral ? <Text size="3">{line(deferral)}</Text> : <Text size="2" color="gray">{t("dialogBody")}</Text>}
          {canDefer && deferral && (
            <Button
              type="button"
              variant="soft"
              color="gray"
              disabled={remove.isPending}
              onClick={() => remove.execute({ transactionId })}
            >
              {remove.isPending && <Spinner />}
              {t("remove")}
            </Button>
          )}
          {canDefer && !deferral && (
            <Button type="button" variant="soft" onClick={() => setOpen(true)}>
              {t("action")}
            </Button>
          )}
        </Flex>
      </PanelBlock>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Content>
          <Dialog.Title>{t("dialogTitle")}</Dialog.Title>
          {/* Closing unmounts the content, so the count is born empty on every opening. */}
          <DeferForm transactionId={transactionId} onDone={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Root>
    </Panel>
  );
}

function DeferForm({ transactionId, onDone }: { transactionId: string; onDone: () => void }) {
  const t = useTranslations("deferrals");
  const tKey = useTranslations();
  const onActionError = useActionErrorToast();

  const form = useForm<DeferPurchaseInput>({
    resolver: zodResolver(deferPurchaseSchema),
    defaultValues: { transactionId },
  });

  const defer = useAction(deferPurchaseAction, {
    onSuccess() {
      toast.success(t("saved"));
      onDone();
    },
    onError: onActionError,
  });

  return (
    <form onSubmit={form.handleSubmit((values) => defer.execute(values))} noValidate>
      <FieldGroup>
        <Text size="2" color="gray">
          {t("dialogBody")}
        </Text>
        <Field invalid={!!form.formState.errors.instalments}>
          <FieldLabel htmlFor="deferral-instalments">{t("instalmentsLabel")}</FieldLabel>
          <FieldControl>
            <TextField.Root
              {...form.register("instalments", { valueAsNumber: true })}
              id="deferral-instalments"
              size="3"
              type="number"
              inputMode="numeric"
              autoFocus
              disabled={defer.isPending}
            />
          </FieldControl>
          <FieldMessage error={form.formState.errors.instalments} />
        </Field>
        <Field>
          <Flex gap="3" justify="end">
            <Dialog.Close>
              <Button type="button" variant="soft" color="gray" disabled={defer.isPending}>
                {tKey("common.cancel")}
              </Button>
            </Dialog.Close>
            <Button type="submit" disabled={defer.isPending}>
              {defer.isPending && <Spinner />}
              {t("save")}
            </Button>
          </Flex>
        </Field>
      </FieldGroup>
    </form>
  );
}

/**
 * The debt detail's «Compras diferidas»: each purchase with its instalment, or «Extinguida». Each
 * row leads to the movement, where the deferral is removed.
 */
export function DeferredPurchases({ rows }: { rows: DeferralRow[] }) {
  const moneyText = useMoneyText();
  const t = useTranslations("deferrals");
  const line = useDeferralLine();
  const locale = useLocale();

  return (
    <Panel title={t("title")}>
      {rows.map((row) => (
        <PanelRow
          key={row.id}
          href={`/movements/${row.transactionId}`}
          columns="minmax(0, 1fr) auto"
          cells={[
            {
              key: "purchase",
              content: row.description ?? moneyText(row.amountCents, row.currency as CurrencyCode, locale),
            },
            { key: "step", content: line(row), align: "end" },
          ]}
        />
      ))}
    </Panel>
  );
}
