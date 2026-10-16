"use client";

import type { ReactNode } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Fragment, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";

import { recordBilledAmountAction } from "@/app/actions/debt-settlement";
import { deleteInstallmentPlanAction } from "@/app/actions/installment-plans";
import { DebtPaymentDialog } from "@/components/planning/debt-payment-dialog";
import { InstallmentPlanDialog } from "@/components/planning/installment-plan-dialog";
import { StatementsSection } from "@/components/planning/statements-section";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Field,
  FieldControl,
  FieldLabel,
  FieldMessage,
  Flex,
  Heading,
  Link,
  Money,
  Panel,
  RowMenu,
  ScreenHeader,
  Separator,
  Spinner,
  StatTiles,
  Text,
  TextField,
  type DataColumn,
} from "@/components/ui";
import type { DebtDetailData } from "@/db/queries/debt-detail";
import type { PendingSettlement } from "@/db/queries/debt-statements";
import type {
  InstallmentPlanLine,
  InstallmentPlanRow,
} from "@/db/queries/installment-plans";
import { Link as LocaleLink } from "@/i18n/navigation";
import { minorUnitExponent, type CurrencyCode } from "@/lib/currency";
import { civilDateToDate, todayInBogota } from "@/lib/dates";
import { deriveRate, formatMoney, parseAmount } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  recordBilledAmountSchema,
  type RecordBilledAmountInput,
} from "@/lib/validation/debt-settlement";

// The em dash a cell or a tile with nothing to name reads as (SPEC-A3), not a
// word a translator would ever change.
const NO_VALUE = "—";

// The tracks of the two tables, both dense enough to read a whole plan at once.
const LINE_WIDTHS = {
  seq: "88px",
  dueDate: "110px",
  amount: "140px",
  status: "120px",
  movement: "minmax(0, 1fr)",
} as const;

// A currency with decimals needs the keypad that types one (RF-121).
function amountInputMode(currency: CurrencyCode): "decimal" | "numeric" {
  return minorUnitExponent(currency) > 0 ? "decimal" : "numeric";
}

/**
 * One liability read in full (RF-16, RF-81, RF-82, RF-129): its derived saldo over
 * the four figures it owes against, a table per installment plan with the dated
 * lines and the movement that settled each, and its statement history under the
 * open period. Every figure arrives derived from the server — the stored
 * statement balances are read exactly as they were frozen at their cut-off, and
 * no interest is recomputed here. A caller the policies would refuse is offered
 * no action at all (`canWrite`).
 */
export function DebtDetailScreen({ data }: { data: DebtDetailData }) {
  const t = useTranslations("installments");
  const tDebts = useTranslations("debts");
  const tKey = useTranslations();
  const format = useFormatter();
  const locale = useLocale();
  const onActionError = useActionErrorToast();

  const {
    account,
    terms,
    plans,
    statements,
    currentStatement,
    pendingSettlements,
    canWrite,
    payFrom,
  } = data;

  // The currency the card bills in: the cupo, the minimum and the interest are
  // all read in it, and it is the one a statement is cut in (RF-121).
  const currency = account.settlementCurrency;

  const [dialog, setDialog] = useState<"pay" | "plan" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<InstallmentPlanRow | null>(
    null,
  );

  const remove = useAction(deleteInstallmentPlanAction, {
    onSuccess() {
      toast.success(t("planDeleted"));
      setDeleteTarget(null);
    },
    onError: onActionError,
  });

  // The magnitude the liability owes in the currency it bills in, off the balance
  // the view derives from movements; a debt reads without a sign.
  const owedCents = Math.abs(account.balanceCents);

  // What the plans still owe: the unpaid lines the server summed, never a
  // stored figure (RF-82).
  const pendingCents = plans.reduce((sum, plan) => sum + plan.pendingCents, 0);

  // The limit less what is owed, the pair the overview states for the list; with
  // no limit there is no cupo, which is not the same as a cupo of zero (RF-117).
  const availableCreditCents =
    terms?.creditLimitCents == null ? null : terms.creditLimitCents - owedCents;

  function shortDate(date: string): string {
    return format.dateTime(civilDateToDate(date), {
      day: "numeric",
      month: "short",
    });
  }

  const tiles = [
    {
      key: "balance",
      label: tDebts("tableBalance"),
      // One figure per currency the card holds, never their sum (RF-124): what
      // was spent in dollars sits beside what the issuer has already billed.
      value: (
        <Flex direction="column">
          {account.balances.map((pocket) => (
            <Money
              key={pocket.currency}
              minor={Math.abs(pocket.balanceCents)}
              currency={pocket.currency}
              signed={false}
              size="inherit"
            />
          ))}
        </Flex>
      ),
    },
    {
      key: "pending",
      label: t("tilePending"),
      value:
        plans.length === 0 ? (
          NO_VALUE
        ) : (
          <Money
            minor={pendingCents}
            currency={currency}
            signed={false}
            size="inherit"
          />
        ),
    },
    {
      key: "nextPayment",
      label: tDebts("tileNextPayment"),
      // The open period's own minimum, derived by the server on the live
      // balance; a debt with no due day names no next payment.
      value:
        currentStatement === null || currentStatement.nextDueDate === null ? (
          NO_VALUE
        ) : (
          <Money
            minor={currentStatement.minimumPaymentCents}
            currency={currency}
            signed={false}
            size="inherit"
          />
        ),
      note:
        currentStatement?.nextDueDate == null
          ? undefined
          : shortDate(currentStatement.nextDueDate),
    },
    {
      key: "availableCredit",
      label: tDebts("tileAvailableCredit"),
      value:
        availableCreditCents === null ? (
          NO_VALUE
        ) : (
          <Money
            minor={availableCreditCents}
            currency={currency}
            signed={false}
            size="inherit"
          />
        ),
      note:
        terms?.creditLimitCents == null
          ? undefined
          : tDebts("tileAvailableCreditNote", {
              // JSX cannot travel through `t()`, so the one path from a stored
              // integer to a figure is called straight (RF-121).
              amount: formatMoney(terms.creditLimitCents, currency, locale),
            }),
    },
  ];

  const newPlanButton = (
    <Button
      type="button"
      variant="surface"
      color="gray"
      onClick={() => setDialog("plan")}
    >
      <Plus size={15} />
      {tDebts("rowNewPlan")}
    </Button>
  );

  return (
    <Flex direction="column" gap="4">
      <ScreenHeader
        title={account.name}
        meta={
          <Money
            minor={owedCents}
            currency={currency}
            signed={false}
            size="inherit"
          />
        }
        back={{ href: "/planning/debts", label: tDebts("title") }}
        actions={
          // Exactly what the policies would admit: a reader is offered neither
          // the abono nor the plan, and no row menu below offers the delete.
          canWrite && (
            <>
              <Button
                type="button"
                variant="surface"
                color="gray"
                onClick={() => setDialog("pay")}
              >
                {tDebts("rowPay")}
              </Button>
              {newPlanButton}
            </>
          )
        }
      />

      <StatTiles tiles={tiles} />

      <Flex direction="column" px={{ initial: "0", md: "6" }}>
        <Heading as="h2" size="3">
          {t("plansTitle")}
        </Heading>
      </Flex>

      {plans.length === 0 ? (
        <EmptyState
          variant="filtered"
          title={t("plansEmpty")}
          action={canWrite ? newPlanButton : undefined}
        />
      ) : (
        plans.map((plan) => (
          <PlanTable
            key={plan.id}
            plan={plan}
            currency={currency}
            canWrite={canWrite}
            onDelete={() => setDeleteTarget(plan)}
          />
        ))
      )}

      <SettlementSection
        accountId={account.id}
        currency={currency}
        pending={pendingSettlements}
        canWrite={canWrite}
      />

      {/* The period nobody has cut yet: live figures, and never one of the
          snapshots below (RF-129). */}
      {currentStatement !== null && (
        <Flex direction="column" px={{ initial: "0", md: "6" }}>
          <Panel title={t("currentPeriod")}>
            <Flex direction="column" px="4" py="1">
              <Fact
                label={t("periodStart")}
                value={shortDate(currentStatement.periodStart)}
              />
              <Separator size="4" />
              <Fact
                label={t("statementBalance")}
                value={
                  <Money
                    minor={Math.abs(currentStatement.balanceCents)}
                    currency={currency}
                    signed={false}
                    size="inherit"
                  />
                }
              />
              <Separator size="4" />
              <Fact
                label={t("statementMinimum")}
                value={
                  <Money
                    minor={currentStatement.minimumPaymentCents}
                    currency={currency}
                    signed={false}
                    size="inherit"
                  />
                }
              />
              {currentStatement.nextCutOffDate !== null && (
                <>
                  <Separator size="4" />
                  <Fact
                    label={t("statementCutOff")}
                    value={shortDate(currentStatement.nextCutOffDate)}
                  />
                </>
              )}
              {currentStatement.nextDueDate !== null && (
                <>
                  <Separator size="4" />
                  <Fact
                    label={t("statementDueDate")}
                    value={shortDate(currentStatement.nextDueDate)}
                  />
                </>
              )}
            </Flex>
          </Panel>
        </Flex>
      )}

      <StatementsSection
        account={{
          id: account.id,
          name: account.name,
          kind: "liability",
          nextPeriodStart: currentStatement?.periodStart ?? todayInBogota(),
        }}
        currency={currency}
        statements={statements}
        canWrite={canWrite}
      />

      {dialog === "pay" && (
        <DebtPaymentDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          debt={{
            accountId: account.id,
            name: account.name,
            owedCents,
          }}
          currency={currency}
          payFrom={payFrom}
        />
      )}

      {dialog === "plan" && (
        <InstallmentPlanDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          account={{ id: account.id, name: account.name }}
          currency={currency}
        />
      )}

      {deleteTarget !== null && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          title={t("deleteTitle")}
          // Names both halves of what a delete does: the lines go, and the
          // movements that paid some of them stay, unlinked.
          description={t("deleteDescription", {
            count: deleteTarget.lines.length,
          })}
          confirmLabel={tKey("common.delete")}
          cancelLabel={tKey("common.cancel")}
          pending={remove.isPending}
          onConfirm={() => remove.execute({ planId: deleteTarget.id })}
        />
      )}
    </Flex>
  );
}

// One line of the open period: what it is on the left, what it says on the right.
function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Flex align="center" justify="between" gap="4" py="3">
      <Text size="2" color="gray">
        {label}
      </Text>
      <Text size="2" weight="medium" align="right">
        {value}
      </Text>
    </Flex>
  );
}

/**
 * One plan's dated lines (RF-81, RF-82). A line reads paid exactly when a
 * movement is linked to it, and that movement is reachable from the row; the
 * total states the pending the server summed over the unpaid lines. The menu
 * offers only the delete — a plan has no edit form.
 */
function PlanTable({
  plan,
  currency,
  canWrite,
  onDelete,
}: {
  plan: InstallmentPlanRow;
  // A plan schedules the balance the card bills, so its lines read in that
  // currency and never in the one a purchase happened in.
  currency: CurrencyCode;
  canWrite: boolean;
  onDelete: () => void;
}) {
  const t = useTranslations("installments");
  const tKey = useTranslations();
  const format = useFormatter();

  // The merchant is what a person recognises; the description is the fallback,
  // and a plan that names neither still has to be addressable.
  const title = plan.merchant || plan.description || t("planUntitled");
  const paid = plan.lines.filter(
    (line) => line.paidTransactionId !== null,
  ).length;

  const columns: DataColumn<InstallmentPlanLine>[] = [
    {
      key: "seq",
      header: t("tableSeq"),
      width: LINE_WIDTHS.seq,
      numeric: true,
      cell: (line) => <Text size="2">{line.seq}</Text>,
    },
    {
      key: "dueDate",
      header: t("tableDueDate"),
      width: LINE_WIDTHS.dueDate,
      numeric: true,
      cell: (line) => (
        <Text size="2" color="gray">
          {format.dateTime(civilDateToDate(line.dueDate), {
            day: "numeric",
            month: "short",
          })}
        </Text>
      ),
    },
    {
      key: "amount",
      header: t("tableAmount"),
      width: LINE_WIDTHS.amount,
      align: "end",
      numeric: true,
      cell: (line) => (
        <Money
          minor={line.amountCents}
          currency={currency}
          signed={false}
        />
      ),
    },
    {
      key: "status",
      header: t("tableStatus"),
      width: LINE_WIDTHS.status,
      cell: (line) =>
        line.paidTransactionId === null ? (
          <Text size="2" color="gray">
            {t("statusPending")}
          </Text>
        ) : (
          <Badge color="jade" variant="soft" radius="full">
            {t("statusPaid")}
          </Badge>
        ),
    },
    {
      key: "movement",
      header: t("tableMovement"),
      width: LINE_WIDTHS.movement,
      cell: (line) =>
        line.paidTransactionId === null ? (
          <Text size="2" color="gray">
            {NO_VALUE}
          </Text>
        ) : (
          <Link asChild size="2">
            <LocaleLink href={`/movements/${line.paidTransactionId}`}>
              {t("viewMovement")}
            </LocaleLink>
          </Link>
        ),
    },
  ];

  return (
    <DataTable
      label={title}
      caption={
        <>
          <Flex direction="column" minWidth="0">
            <Text size="2" weight="medium" truncate>
              {title}
            </Text>
            <Text size="1" color="gray">
              {t("planPosition", { paid, total: plan.lines.length })}
            </Text>
          </Flex>
          {canWrite && (
            <RowMenu
              rowName={title}
              items={[
                {
                  key: "delete",
                  label: tKey("common.delete"),
                  tone: "danger",
                  onSelect: onDelete,
                },
              ]}
            />
          )}
        </>
      }
      columns={columns}
      rows={plan.lines}
      rowKey={(line) => line.id}
      total={[
        <Text key="label" size="2" color="gray">
          {t("tablePending")}
        </Text>,
        null,
        <Money
          key="pending"
          minor={plan.pendingCents}
          currency={currency}
          signed={false}
        />,
      ]}
    />
  );
}

/**
 * The purchases the issuer has not billed yet (RF-123): what was spent, in the
 * currency it was spent in, beside what a person expects it to cost, marked an
 * estimate. A row leaves the list the moment the billed amount lands — the mark
 * is what moves the amount from the foreign pocket to the settlement one, and the
 * derived balance does the moving, never this screen.
 */
function SettlementSection({
  accountId,
  currency,
  pending,
  canWrite,
}: {
  accountId: string;
  currency: CurrencyCode;
  pending: PendingSettlement[];
  canWrite: boolean;
}) {
  const t = useTranslations("debts.settlement");

  return (
    <>
      <Flex direction="column" px={{ initial: "0", md: "6" }}>
        <Heading as="h2" size="3">
          {t("title")}
        </Heading>
      </Flex>

      {pending.length === 0 ? (
        <EmptyState variant="filtered" title={t("empty")} />
      ) : (
        <Flex direction="column" px={{ initial: "0", md: "6" }}>
          <Panel title={t("pending")}>
            <Flex direction="column" px="4" py="1">
              {pending.map((movement, index) => (
                <Fragment key={movement.id}>
                  {index > 0 && <Separator size="4" />}
                  <SettlementRow
                    movement={movement}
                    accountId={accountId}
                    currency={currency}
                    canWrite={canWrite}
                  />
                </Fragment>
              ))}
            </Flex>
          </Panel>
        </Flex>
      )}
    </>
  );
}

/**
 * One purchase waiting for its statement. The rate is the quotient of the two
 * amounts on the row and is stored nowhere (RF-122); it follows the figure being
 * typed as soon as that reads as an amount, so the tasa on screen always divides
 * the two cifras beside it.
 */
function SettlementRow({
  movement,
  accountId,
  currency,
  canWrite,
}: {
  movement: PendingSettlement;
  accountId: string;
  currency: CurrencyCode;
  canWrite: boolean;
}) {
  const t = useTranslations("debts.settlement");
  const format = useFormatter();
  const onActionError = useActionErrorToast();

  const form = useForm<RecordBilledAmountInput>({
    resolver: zodResolver(recordBilledAmountSchema),
    defaultValues: {
      transactionId: movement.id,
      accountId,
      // What the typed string is read in, and what the write refuses to differ
      // from: the same schema validates both ends (RNF-10).
      currency,
      billedAmount: "",
    },
  });

  const save = useAction(recordBilledAmountAction, {
    onSuccess() {
      toast.success(t("saved"), { description: t("replacedEstimate") });
    },
    onError: onActionError,
  });

  const typed = useWatch({ control: form.control, name: "billedAmount" });

  // Both integers are in the scale the columns keep, which is what `deriveRate`
  // divides: the rate is their quotient and lands in no column of its own.
  const spentCents = movement.amountCents;
  const billedCents = parseAmount(typed) ?? movement.counterAmountCents;
  const rate = deriveRate(spentCents, movement.currency, billedCents, currency);

  const occurred = format.dateTime(civilDateToDate(movement.occurredAt), {
    day: "numeric",
    month: "short",
  });

  return (
    <Flex direction="column" gap="2" py="3">
      <Flex align="center" justify="between" gap="4">
        <Text size="2" weight="medium" truncate>
          {movement.description ?? occurred}
        </Text>
        {movement.description !== null && (
          <Text size="2" color="gray">
            {occurred}
          </Text>
        )}
      </Flex>

      <Flex align="center" justify="between" gap="4">
        <Text size="2" color="gray">
          {t("spent")}
        </Text>
        <Text size="2" weight="medium">
          <Money
            minor={spentCents}
            currency={movement.currency}
            signed={false}
            size="inherit"
          />
        </Text>
      </Flex>

      <Flex align="center" justify="between" gap="4">
        <Text size="2" color="gray">
          {t("estimate")}
        </Text>
        <Text size="2" weight="medium">
          <Money
            minor={movement.counterAmountCents}
            currency={currency}
            estimate
            signed={false}
            size="inherit"
          />
        </Text>
      </Flex>

      <Flex align="center" justify="between" gap="4">
        <Text size="2" color="gray">
          {t("rate")}
        </Text>
        <Text size="2" weight="medium">
          {format.number(rate, { maximumFractionDigits: 2 })}
        </Text>
      </Flex>

      {/* Exactly what the policies would admit: a reader sees the two figures and
          is offered no field to replace one with. */}
      {canWrite && (
        <form
          onSubmit={form.handleSubmit((values) => save.execute(values))}
          noValidate
        >
          <Controller
            name="billedAmount"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor={`billed-${movement.id}`}>
                  {t("billedLabel")}
                </FieldLabel>
                <FieldControl>
                  <TextField.Root
                    {...field}
                    id={`billed-${movement.id}`}
                    size="3"
                    inputMode={amountInputMode(currency)}
                    disabled={save.isPending}
                  />
                </FieldControl>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
          <Flex justify="end" pt="2">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Spinner />}
              {t("save")}
            </Button>
          </Flex>
        </form>
      )}
    </Flex>
  );
}
