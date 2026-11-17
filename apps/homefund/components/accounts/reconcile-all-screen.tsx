"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { toast } from "sonner";

import { reconcileAccountsAction } from "@/app/actions/account-reconciliations";
import {
  AmountField,
  Button,
  Card,
  EmptyState,
  Field,
  FieldControl,
  FieldDescription,
  FieldError,
  FieldLabel,
  Flex,
  Money,
  ScreenHeader,
  Spinner,
  Text,
  TextLink,
} from "@/components/ui";
import { useRouter } from "@/i18n/navigation";
import { nameCarriesHolder } from "@/lib/account-detail";
import { civilDateToDate, todayInBogota } from "@/lib/dates";
import type { CurrencyCode } from "@/lib/currency";
import type { Locale } from "@/lib/locales";
import { amountToInput, parseAmount } from "@/lib/money";
import { useActionErrorToast, type MessageKey } from "@/lib/use-action-toast";
import { checkRealAmount, flipsSign } from "@/lib/validation/account-reconciliation";

export type ReconcileAllRow = {
  id: string;
  name: string;
  kind: "asset" | "liability";
  currency: CurrencyCode;
  // The figure HomeFund derives for today, the ledger's own sign: a debt is negative.
  derivedCents: number;
  institution: string | null;
  lastFour: string | null;
  holderName: string | null;
  // Days since the last count, or since the account was added when it was never counted.
  ageDays: number;
  never: boolean;
};

// A refusal sits under the row it names; the other rows keep what was typed.
type Refusal = { accountId: string; text: string };

type Cupo = { open: boolean; total: string; available: string };

const NO_CUPO: Cupo = { open: false, total: "", available: "" };

export function ReconcileAllScreen({ rows }: { rows: ReconcileAllRow[] }) {
  const t = useTranslations("accounts");
  const tKey = useTranslations();
  const router = useRouter();
  const locale = useLocale() as Locale;
  const format = useFormatter();
  const onActionError = useActionErrorToast();

  const [typed, setTyped] = useState<Record<string, string>>({});
  const [cupos, setCupos] = useState<Record<string, Cupo>>({});
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const reconcile = useAction(reconcileAccountsAction, {
    onSuccess({ data }) {
      if (data?.ok) {
        toast.success(t("reconcileAllDone", { count: data.rows.length }));
        router.push("/settings/accounts");
        return;
      }

      const named = data?.date
        ? format.dateTime(civilDateToDate(data.date), { day: "numeric", month: "short" })
        : "";
      const messageKey = data?.messageKey ?? "errors.reconcileFailed";
      setRefusal({
        accountId: data?.accountId ?? "",
        text:
          messageKey === "errors.reconcileStale"
            ? t("reconcileAllStale")
            : tKey(messageKey as MessageKey, { date: named }),
      });
      // The derived figures are read again, so the gaps on screen are the ones a retry would book.
      if (messageKey === "errors.reconcileStale") router.refresh();
    },
    onError: onActionError,
  });

  if (rows.length === 0) {
    return (
      <Flex direction="column" gap="4">
        <ScreenHeader
          title={t("reconcileAllTitle")}
          back={{ href: "/settings/accounts", label: t("reconcileAllBack") }}
        />
        <EmptyState
          variant="filtered"
          title={t("reconcileAllEmptyTitle")}
          description={t("reconcileAllEmptyDescription")}
          action={<TextLink href="/settings/accounts">{t("reconcileAllBack")}</TextLink>}
        />
      </Flex>
    );
  }

  const checks = new Map(
    rows.map((row) => [
      row.id,
      (typed[row.id] ?? "").trim() === "" ? null : checkRealAmount(typed[row.id], row.currency),
    ]),
  );
  const ready = rows.filter((row) => checks.get(row.id)?.ok);
  const invalid = rows.some((row) => checks.get(row.id)?.ok === false);
  const pending = reconcile.isPending;

  function setFigure(id: string, value: string) {
    setRefusal(null);
    setTyped((current) => ({ ...current, [id]: value }));
  }

  // The helper writes the debt of today into the field the person can still correct: total limit minus available.
  function setCupo(row: ReconcileAllRow, patch: Partial<Cupo>) {
    const next = { ...(cupos[row.id] ?? NO_CUPO), ...patch };
    setCupos((current) => ({ ...current, [row.id]: next }));
    const [total, available] = [parseAmount(next.total), parseAmount(next.available)];
    if (total === null || available === null) return;

    const owed = total - available;
    setFigure(row.id, `${owed < 0 ? "-" : ""}${amountToInput(Math.abs(owed), row.currency, locale)}`);
  }

  function submit() {
    setRefusal(null);
    reconcile.execute({
      reconciledOn: todayInBogota(),
      items: ready.map((row) => ({
        accountId: row.id,
        realAmount: typed[row.id],
        expectedDerivedCents: row.derivedCents,
      })),
    });
  }

  return (
    <Flex direction="column" gap="4">
      <ScreenHeader
        title={t("reconcileAllTitle")}
        meta={t("reconcileAllIntro")}
        metaWraps
        back={{ href: "/settings/accounts", label: t("reconcileAllBack") }}
      />

      <Flex direction="column" gap="3">
        {rows.map((row) => {
          const liability = row.kind === "liability";
          const check = checks.get(row.id) ?? null;
          const cupo = cupos[row.id] ?? NO_CUPO;
          const parts = [
            row.institution,
            row.lastFour ? t("lastFourDetail", { digits: row.lastFour }) : null,
            row.holderName && !nameCarriesHolder(row.name, row.holderName)
              ? t("holderOf", { name: row.holderName })
              : null,
          ].filter((part): part is string => Boolean(part));

          // The gap in the field's frame: what was typed minus «Según HomeFund», a debt in what is owed.
          const counted = check?.ok ? (liability && check.cents !== 0 ? -check.cents : check.cents) : null;
          const gap = counted === null ? null : counted - row.derivedCents;
          const fieldGap = gap === null ? null : liability ? -gap : gap;
          const slip = counted !== null && flipsSign(counted, row.derivedCents);
          const refused = refusal?.accountId === row.id ? refusal.text : undefined;

          return (
            <Card key={row.id}>
              <Flex direction="column" gap="3">
                <Flex justify="between" align="start" gap="3">
                  <Flex direction="column" gap="1" minWidth="0">
                    <Text size="3" weight="bold" truncate>
                      {row.name}
                    </Text>
                    {parts.length > 0 && (
                      <Text size="2" color="gray" truncate>
                        {parts.join(" · ")}
                      </Text>
                    )}
                    <Text size="2" color="gray">
                      {row.never
                        ? t("reconcileAgeNever")
                        : row.ageDays === 0
                          ? t("reconcileAgeToday")
                          : t("reconcileAgeDays", { days: row.ageDays })}
                    </Text>
                  </Flex>
                  <Flex direction="column" align="end" gap="1">
                    <Text size="2" color="gray">
                      {t("reconcileDerived")}
                    </Text>
                    {/* In the field's frame: a debt in what is owed, a card's credit below zero. */}
                    <Money
                      minor={liability ? -row.derivedCents : row.derivedCents}
                      currency={row.currency}
                      tone="plain"
                      signed
                    />
                  </Flex>
                </Flex>

                <Field invalid={check?.ok === false || refused !== undefined}>
                  <FieldLabel htmlFor={`reconcile-all-${row.id}`}>
                    {t(liability ? "reconcileAllRealLiability" : "reconcileAllRealAsset")}
                  </FieldLabel>
                  <FieldControl tap>
                    <AmountField
                      id={`reconcile-all-${row.id}`}
                      size="3"
                      inputMode="text"
                      value={typed[row.id] ?? ""}
                      readOnly={pending}
                      onChange={(event) => setFigure(row.id, event.target.value)}
                    />
                  </FieldControl>
                  {liability && (
                    <FieldDescription>{t("reconcileAllHintLiability")}</FieldDescription>
                  )}
                  <FieldError
                    errors={
                      check?.ok === false ? [{ message: tKey(check.messageKey as MessageKey) }] : undefined
                    }
                  >
                    {refused}
                  </FieldError>
                </Field>

                {liability && (
                  <Flex direction="column" gap="2" align="start">
                    <Button
                      type="button"
                      variant="ghost"
                      size="2"
                      tap
                      aria-expanded={cupo.open}
                      onClick={() => setCupos((current) => ({ ...current, [row.id]: { ...cupo, open: !cupo.open } }))}
                    >
                      {t("reconcileAllCupoToggle")}
                    </Button>
                    {cupo.open && (
                      <Flex gap="3" wrap="wrap" width="100%">
                        <Field>
                          <FieldLabel htmlFor={`reconcile-all-total-${row.id}`}>
                            {t("reconcileAllCupoTotal")}
                          </FieldLabel>
                          <FieldControl tap>
                            <AmountField
                              id={`reconcile-all-total-${row.id}`}
                              size="3"
                              inputMode="text"
                              value={cupo.total}
                              readOnly={pending}
                              onChange={(event) => setCupo(row, { total: event.target.value })}
                            />
                          </FieldControl>
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={`reconcile-all-available-${row.id}`}>
                            {t("reconcileAllCupoAvailable")}
                          </FieldLabel>
                          <FieldControl tap>
                            <AmountField
                              id={`reconcile-all-available-${row.id}`}
                              size="3"
                              inputMode="text"
                              value={cupo.available}
                              readOnly={pending}
                              onChange={(event) => setCupo(row, { available: event.target.value })}
                            />
                          </FieldControl>
                        </Field>
                      </Flex>
                    )}
                  </Flex>
                )}

                {fieldGap !== null && gap !== null && (
                  <Flex direction="column" gap="1">
                    <Flex justify="between" align="center" gap="3">
                      <Text size="2">{t("reconcileGap")}</Text>
                      <Money
                        minor={fieldGap}
                        currency={row.currency}
                        signed="always"
                        tone={gap > 0 ? "income" : gap < 0 ? "expense" : "plain"}
                      />
                    </Flex>
                    {gap === 0 && (
                      <Text size="2" color="gray">
                        {t("reconcileBalanced")}
                      </Text>
                    )}
                    {slip && (
                      <Text size="2" color="gray">
                        {t("reconcileAllSlip")}
                      </Text>
                    )}
                  </Flex>
                )}
              </Flex>
            </Card>
          );
        })}
      </Flex>

      {ready.length === 0 && !invalid && (
        <Text size="2" color="gray">
          {t("reconcileAllNeedOne")}
        </Text>
      )}
      <Flex justify="end">
        <Button type="button" size="3" tap disabled={pending || invalid || ready.length === 0} onClick={submit}>
          {pending && <Spinner />}
          {pending ? t("reconcilePending") : t("reconcileAllSubmit", { count: ready.length })}
        </Button>
      </Flex>
    </Flex>
  );
}
