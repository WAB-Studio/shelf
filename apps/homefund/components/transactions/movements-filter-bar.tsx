"use client";

import { useFormatter, useTranslations } from "next-intl";

import {
  FilterBar,
  FilterChip,
  FilterDate,
  FilterSelect,
} from "@/components/ui";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";
import { civilDateToDate } from "@/lib/dates";

// The type filter's value, mirrored one-to-one onto the `?type=` query and, on
// the server, onto the movement's generated kind (RF-19, RF-23).
export type MovementType = "all" | "expense" | "income" | "transfer";

export type MovementsFilters = {
  type: MovementType;
  from: string | null;
  to: string | null;
  member: string | null;
  account: string | null;
  category: string | null;
  label: string | null;
  // The deep-link flag: kept through any other change so the filtered view stays
  // put until the user clears it (RF-31).
  unreviewed: boolean;
  // The recurring rule that generated a row, entered by link from that rule's
  // own menu (RF-127).
  rule: string | null;
};

// A Radix Select item may not carry an empty value, so the "any" option rides
// this sentinel and maps back to null the moment it is picked.
const ANY = "all";

// One narrowing already applied, named by the value it holds and paired with the
// patch that drops it.
type ActiveChip = { key: string; label: string; clear: Partial<MovementsFilters> };

/**
 * The laptop's filter row (RF-23, RF-89, RF-31): a labelled control per filter,
 * then a chip per narrowing already applied. Nothing is stored here — the caller
 * receives a whole new filter set and writes it to the URL, so a filtered view
 * stays shareable and the rows are narrowed in Postgres.
 */
export function MovementsFilterBar({
  filters,
  options,
  ruleName,
  onChange,
}: {
  filters: MovementsFilters;
  options: TransactionFormOptions;
  ruleName: string | null;
  onChange: (next: MovementsFilters) => void;
}) {
  const t = useTranslations("transactions");
  const format = useFormatter();

  function set(patch: Partial<MovementsFilters>) {
    onChange({ ...filters, ...patch });
  }

  // A subcategory rides beside its parent, so one flat list serves both the
  // select and the chip that names the pick.
  const categories = options.categories.flatMap((category) => [
    { id: category.id, name: category.name },
    ...category.children.map((child) => ({ id: child.id, name: child.name })),
  ]);

  const types: { value: MovementType; label: string }[] = [
    { value: "all", label: t("filterAll") },
    { value: "expense", label: t("filterExpenses") },
    { value: "income", label: t("filterIncome") },
    { value: "transfer", label: t("filterTransfers") },
  ];

  function chipDate(value: string, key: "chipFrom" | "chipTo"): string {
    return t(key, {
      date: format.dateTime(civilDateToDate(value), {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    });
  }

  const named = (list: { id: string; name: string }[], id: string) =>
    list.find((one) => one.id === id)?.name ?? id;

  const chips: ActiveChip[] = [];
  if (filters.type !== "all") {
    chips.push({
      key: "type",
      label: types.find((one) => one.value === filters.type)?.label ?? filters.type,
      clear: { type: "all" },
    });
  }
  if (filters.account) {
    chips.push({
      key: "account",
      label: named(options.accounts, filters.account),
      clear: { account: null },
    });
  }
  if (filters.category) {
    chips.push({
      key: "category",
      label: named(categories, filters.category),
      clear: { category: null },
    });
  }
  if (filters.label) {
    chips.push({
      key: "label",
      label: named(options.labels, filters.label),
      clear: { label: null },
    });
  }
  if (filters.member) {
    const member = options.members.find((one) => one.userId === filters.member);
    chips.push({
      key: "member",
      label: member?.name ?? filters.member,
      clear: { member: null },
    });
  }
  if (filters.from) {
    chips.push({
      key: "from",
      label: chipDate(filters.from, "chipFrom"),
      clear: { from: null },
    });
  }
  if (filters.to) {
    chips.push({
      key: "to",
      label: chipDate(filters.to, "chipTo"),
      clear: { to: null },
    });
  }
  // The dashboard's deep link is the only way this one is ever set, so the chip
  // is also the only way back out of it (RF-31).
  if (filters.unreviewed) {
    chips.push({
      key: "unreviewed",
      label: t("unreviewedFilter"),
      clear: { unreviewed: false },
    });
  }
  // A rule's own row is the only way in, so the chip is the only way out — no
  // selector lists every rule, which would cost a round trip on every load.
  if (filters.rule) {
    chips.push({
      key: "rule",
      label: ruleName ?? t("ruleFilter"),
      clear: { rule: null },
    });
  }

  return (
    <FilterBar>
      <FilterSelect
        label={t("typeLabel")}
        value={filters.type}
        onValueChange={(value) => set({ type: value as MovementType })}
        items={types}
        width={150}
      />

      <FilterSelect
        label={t("accountLabel")}
        value={filters.account ?? ANY}
        onValueChange={(value) => set({ account: value === ANY ? null : value })}
        items={[
          { value: ANY, label: t("allAccounts") },
          ...options.accounts.map((account) => ({
            value: account.id,
            label: account.name,
          })),
        ]}
        width={200}
      />

      <FilterSelect
        label={t("categoryLabel")}
        value={filters.category ?? ANY}
        onValueChange={(value) => set({ category: value === ANY ? null : value })}
        items={[
          { value: ANY, label: t("allCategories") },
          ...categories.map((category) => ({
            value: category.id,
            label: category.name,
          })),
        ]}
        width={200}
      />

      {/* The ledger spans both scopes, so the read filter offers every label —
          unlike the write pickers, which narrow to one (RF-89). */}
      {options.labels.length > 0 && (
        <FilterSelect
          label={t("labelFilterLabel")}
          value={filters.label ?? ANY}
          onValueChange={(value) => set({ label: value === ANY ? null : value })}
          items={[
            { value: ANY, label: t("allLabels") },
            ...options.labels.map((label) => ({
              value: label.id,
              label: label.name,
            })),
          ]}
          width={180}
        />
      )}

      {options.members.length > 0 && (
        <FilterSelect
          label={t("createdBy")}
          value={filters.member ?? ANY}
          onValueChange={(value) => set({ member: value === ANY ? null : value })}
          items={[
            { value: ANY, label: t("allMembers") },
            ...options.members.map((member) => ({
              value: member.userId,
              label: member.name,
            })),
          ]}
          width={180}
        />
      )}

      <FilterDate
        label={t("rangeFrom")}
        value={filters.from ?? ""}
        onValueChange={(value) => set({ from: value || null })}
      />

      <FilterDate
        label={t("rangeTo")}
        value={filters.to ?? ""}
        onValueChange={(value) => set({ to: value || null })}
      />

      {chips.map((chip) => (
        <FilterChip
          key={chip.key}
          label={chip.label}
          active
          onRemove={() => set(chip.clear)}
        />
      ))}
    </FilterBar>
  );
}
