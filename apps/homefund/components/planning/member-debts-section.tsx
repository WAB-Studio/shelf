"use client";

import { Plus, X } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { toast } from "sonner";

import { deleteMemberDebtAction } from "@/app/actions/member-debts";
import { MemberDebtDialog, type MemberDebtDraft } from "@/components/planning/member-debt-dialog";
import { Button, Card, ConfirmDialog, EmptyState, Flex, Heading, Money, Text } from "@/components/ui";
import type { MemberDebtsData } from "@/db/queries/member-debts";
import { isOfferedCurrency } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";
import type { Locale } from "@/lib/locales";
import { memberDebtStates, type MemberDebtBalance, type MemberDebtEntry, type MemberDebtState } from "@/lib/member-debts";
import { useActionErrorToast } from "@/lib/use-action-toast";
import { useMoneyText } from "@/lib/use-privacy";

// One card per pair of members and currency that has entries, settled or not, keyed apart from who owes whom.
type Pair = {
  key: string;
  names: [string, string];
  balance: MemberDebtBalance | null;
  entries: MemberDebtEntry[];
};

function pairKey(a: string, b: string, currency: string): string {
  return a < b ? `${a}:${b}:${currency}` : `${b}:${a}:${currency}`;
}

function pairsOf(data: MemberDebtsData): Pair[] {
  const pairs = new Map<string, Pair>();
  for (const entry of data.entries) {
    const key = pairKey(entry.debtorMemberId, entry.creditorMemberId, entry.currency);
    const pair = pairs.get(key) ?? { key, names: [entry.debtorName, entry.creditorName], balance: null, entries: [] };
    pair.entries.push(entry);
    pairs.set(key, pair);
  }
  for (const balance of data.balances) {
    const pair = pairs.get(pairKey(balance.debtorMemberId, balance.creditorMemberId, balance.currency));
    if (pair) pair.balance = balance;
  }
  // What is still owed first, largest first; settled pairs after.
  return [...pairs.values()].sort((a, b) => (b.balance?.pendingCents ?? -1) - (a.balance?.pendingCents ?? -1));
}

/** «Entre miembros» (RF-183): what each pair in the fund still owes, its entries, and the two ways to add one. */
export function MemberDebtsSection({ data }: { data: MemberDebtsData }) {
  const t = useTranslations("memberDebts");
  const [draft, setDraft] = useState<MemberDebtDraft | null>(null);
  const [openPair, setOpenPair] = useState<string | null>(null);
  const canRecordDebt = data.members.length > 1;
  const pairs = pairsOf(data);
  const states = memberDebtStates(data.entries);
  const settledDebts = data.entries.filter((entry) => states.get(entry.id)?.status === "settled");
  const [showSettled, setShowSettled] = useState(false);

  return (
    <Flex direction="column" gap="3">
      <Flex justify="between" align="center" gap="2" wrap="wrap">
        <Heading as="h2" size="4">
          {t("title")}
        </Heading>
        <Flex gap="2" wrap="wrap">
          {canRecordDebt && (
            <Button type="button" variant="surface" color="gray" onClick={() => setDraft({ kind: "debt" })}>
              <Plus size={15} />
              {t("recordDebt")}
            </Button>
          )}
          {data.balances.length > 0 && (
            <Button type="button" variant="surface" color="gray" onClick={() => setDraft({ kind: "payment" })}>
              <Plus size={15} />
              {t("recordPayment")}
            </Button>
          )}
        </Flex>
      </Flex>

      {data.entries.length === 0 && <EmptyState variant="filtered" title={canRecordDebt ? t("empty") : t("alone")} />}
      {data.entries.length > 0 && data.balances.length === 0 && (
        <Text size="3" weight="medium">
          {t("allSquare")}
        </Text>
      )}
      {pairs.map((pair) => (
        <PairCard
          key={pair.key}
          pair={pair}
          states={states}
          open={openPair === pair.key}
          onToggle={() => setOpenPair(openPair === pair.key ? null : pair.key)}
          onPay={(balance) =>
            setDraft({
              kind: "payment",
              debtor: { id: balance.debtorMemberId, name: balance.debtorName },
              creditor: { id: balance.creditorMemberId, name: balance.creditorName },
              currency: isOfferedCurrency(balance.currency) ? balance.currency : undefined,
            })
          }
        />
      ))}

      {settledDebts.length > 0 && (
        <Flex direction="column" gap="2">
          <Flex>
            <Button type="button" variant="ghost" color="gray" onClick={() => setShowSettled(!showSettled)} aria-expanded={showSettled}>
              {showSettled ? t("hideSettled") : t("showSettled", { count: settledDebts.length })}
            </Button>
          </Flex>
          {showSettled && (
            <Card>
              <Flex direction="column" gap="2">
                {settledDebts.map((entry) => (
                  <EntryRow key={entry.id} entry={entry} state={states.get(entry.id)} />
                ))}
              </Flex>
            </Card>
          )}
        </Flex>
      )}

      <MemberDebtDialog
        draft={draft}
        members={data.members}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
      />
    </Flex>
  );
}

function PairCard({
  pair,
  states,
  open,
  onToggle,
  onPay,
}: {
  pair: Pair;
  states: Map<string, MemberDebtState>;
  open: boolean;
  onToggle: () => void;
  onPay: (balance: MemberDebtBalance) => void;
}) {
  const t = useTranslations("memberDebts");
  const moneyText = useMoneyText();
  const locale = useLocale() as Locale;
  const { balance } = pair;
  // Settled debts wait in «Saldadas»; what is left here is what still moves the pair.
  const shown = pair.entries.filter((entry) => states.get(entry.id)?.status !== "settled");

  return (
    <Card>
      <Flex direction="column" gap="3">
        <Text size="3" weight="medium" wrap="pretty">
          {balance
            ? t("owes", {
                debtor: balance.debtorName,
                amount: moneyText(balance.pendingCents, balance.currency, locale),
                creditor: balance.creditorName,
              })
            : t("settled", { first: pair.names[0], second: pair.names[1] })}
        </Text>
        <Flex gap="2" justify="end" wrap="wrap">
          {shown.length > 0 && (
            <Button type="button" variant="ghost" color="gray" onClick={onToggle} aria-expanded={open}>
              {open ? t("hideEntries") : t("showEntries", { count: shown.length })}
            </Button>
          )}
          {balance && (
            <Button type="button" variant="soft" onClick={() => onPay(balance)}>
              {t("recordPayment")}
            </Button>
          )}
        </Flex>
        {open && (
          <Flex direction="column" gap="2">
            {shown.map((entry) => (
              <EntryRow key={entry.id} entry={entry} state={states.get(entry.id)} />
            ))}
          </Flex>
        )}
      </Flex>
    </Card>
  );
}

function statusText(
  state: MemberDebtState,
  entry: MemberDebtEntry,
  t: ReturnType<typeof useTranslations<"memberDebts">>,
  money: (minor: number) => string,
  day: (date: string) => string,
): string {
  const amount = money(entry.amountCents);
  if (state.status === "settled") return t("settledOn", { date: day(state.settledOn ?? entry.occurredOn) });
  if (state.status === "partial") return t("partial", { remaining: money(state.remainingCents), amount });
  return t("pending", { amount });
}

function EntryRow({ entry, state }: { entry: MemberDebtEntry; state?: MemberDebtState }) {
  const t = useTranslations("memberDebts");
  const moneyText = useMoneyText();
  const locale = useLocale() as Locale;
  const tKey = useTranslations();
  const format = useFormatter();
  const onActionError = useActionErrorToast();
  const [confirming, setConfirming] = useState(false);
  const remove = useAction(deleteMemberDebtAction, {
    onSuccess() {
      toast.success(t("deleted"));
      setConfirming(false);
    },
    onError: onActionError,
  });
  const date = format.dateTime(civilDateToDate(entry.occurredOn), { day: "numeric", month: "short", year: "numeric" });
  const day = (value: string) => format.dateTime(civilDateToDate(value), { day: "numeric", month: "short", year: "numeric" });
  const status =
    entry.kind === "debt" && state ? statusText(state, entry, t, (minor) => moneyText(minor, entry.currency, locale), day) : null;
  const who =
    entry.kind === "debt"
      ? t("debtLine", { debtor: entry.debtorName, creditor: entry.creditorName })
      : t("paymentLine", { debtor: entry.debtorName, creditor: entry.creditorName });

  return (
    <Flex gap="3" align="start" justify="between">
      <Flex direction="column" minWidth="0">
        <Text size="2" weight="medium" wrap="pretty">
          {who}
        </Text>
        <Text size="1" color="gray" wrap="pretty">
          {entry.description ? `${date} · ${entry.description}` : date}
        </Text>
        {status && (
          <Text size="1" color={state?.status === "settled" ? "green" : "gray"} wrap="pretty">
            {status}
          </Text>
        )}
      </Flex>
      <Flex align="center" gap="2" flexShrink="0">
        <Money minor={entry.amountCents} currency={entry.currency} signed={false} tone={entry.kind === "payment" ? "credit" : "plain"} />
        <Button type="button" variant="ghost" color="gray" aria-label={t("delete")} onClick={() => setConfirming(true)}>
          <X size={14} />
        </Button>
      </Flex>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("deleteTitle")}
        description={t("deleteDescription")}
        cancelLabel={tKey("common.cancel")}
        confirmLabel={t("delete")}
        tone="danger"
        pending={remove.isPending}
        onConfirm={() => remove.execute({ id: entry.id })}
      />
    </Flex>
  );
}
