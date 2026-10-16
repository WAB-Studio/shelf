"use client";

import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { ScrollText, SlidersHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { AuditTable, type AuditTableRow } from "@/components/audit/audit-table";
import {
  Button,
  Card,
  EmptyState,
  FilterField,
  Flex,
  Heading,
  IconButton,
  Select,
  TextField,
} from "@/components/ui";
import type { AuditFilterOptions, AuditLogRow } from "@/db/queries/audit-log";
import { usePathname, useRouter } from "@/i18n/navigation";

type AuditFilters = {
  entity: string | null;
  actor: string | null;
  from: string | null;
  to: string | null;
  page: number;
};

// A Radix Select item may not carry an empty value, so the "any" option rides
// this sentinel and maps back to null the moment it is picked.
const ANY = "all";

// Paging runs in Postgres, so no client row model beyond the core one is needed.
const features = tableFeatures({});
const columnHelper = createColumnHelper<typeof features, AuditLogRow>();
const columns = columnHelper.columns([columnHelper.accessor("id", {})]);

/**
 * The read-only audit trail (RF-53): the entity, actor and date-range filters
 * rewrite the URL query so the log is narrowed in Postgres and the view stays
 * shareable. The SELECT policy already bounds every row to the caller's scope,
 * and no control here mutates a row — the log answers only to its trigger (RF-44).
 */
export function AuditScreen({
  rows,
  total,
  pageSize,
  options,
  filters,
}: {
  rows: AuditLogRow[];
  total: number;
  pageSize: number;
  options: AuditFilterOptions;
  filters: AuditFilters;
}) {
  const t = useTranslations("audit");
  const pathname = usePathname();
  const router = useRouter();

  const [showFilters, setShowFilters] = useState(false);

  const table = useTable({ features, data: rows, columns });
  const pageRows = table.getRowModel().rows.map((row) => row.original);

  // A display name per audited table; an entity outside the known set reads its
  // raw table name, so a new trigger never leaves a blank cell.
  const entityLabels: Record<string, string> = {
    app_users: t("entities.app_users"),
    groups: t("entities.groups"),
    group_members: t("entities.group_members"),
    accounts: t("entities.accounts"),
    categories: t("entities.categories"),
    transactions: t("entities.transactions"),
    transaction_splits: t("entities.transaction_splits"),
    labels: t("entities.labels"),
    transaction_labels: t("entities.transaction_labels"),
    budgets: t("entities.budgets"),
    planned_payments: t("entities.planned_payments"),
    recurring_rules: t("entities.recurring_rules"),
    savings_goals: t("entities.savings_goals"),
    goal_contributions: t("entities.goal_contributions"),
    debt_terms: t("entities.debt_terms"),
    installment_plans: t("entities.installment_plans"),
    installment_lines: t("entities.installment_lines"),
    account_statements: t("entities.account_statements"),
    webhook_credentials: t("entities.webhook_credentials"),
  };

  const actionLabels: Record<AuditLogRow["action"], string> = {
    INSERT: t("actions.insert"),
    UPDATE: t("actions.update"),
    DELETE: t("actions.delete"),
  };

  const actorNames = new Map(options.actors.map((a) => [a.userId, a.name]));

  // A null actor marks a system write; an id outside the roster reads raw.
  function actorLabel(actorUserId: string | null): string {
    if (actorUserId === null) return t("systemActor");
    return actorNames.get(actorUserId) ?? actorUserId;
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const tableRows: AuditTableRow[] = pageRows.map((row) => ({
    id: row.id,
    occurredAt: row.occurredAt,
    entity: entityLabels[row.entity] ?? row.entity,
    action: row.action,
    actionLabel: actionLabels[row.action],
    actor: actorLabel(row.actorUserId),
    recordId: row.recordId,
  }));

  const filtersActive = Boolean(
    filters.entity || filters.actor || filters.from || filters.to,
  );

  // Only the well-formed values ride the query; a cleared field drops its key so
  // the URL never carries an empty parameter, and page 1 stays implicit.
  function toQuery(next: AuditFilters): Record<string, string> {
    const query: Record<string, string> = {};
    if (next.entity) query.entity = next.entity;
    if (next.actor) query.actor = next.actor;
    if (next.from) query.from = next.from;
    if (next.to) query.to = next.to;
    if (next.page > 1) query.page = String(next.page);
    return query;
  }

  // A filter change resets to the first page; only paging keeps the current one.
  function updateFilters(patch: Partial<AuditFilters>) {
    router.push(
      { pathname, query: toQuery({ ...filters, ...patch, page: 1 }) },
      { scroll: false },
    );
  }

  function goToPage(page: number) {
    router.push(
      { pathname, query: toQuery({ ...filters, page }) },
      { scroll: false },
    );
  }

  function clearFilters() {
    router.push({ pathname, query: {} }, { scroll: false });
  }

  return (
    <Flex direction="column" gap="4">
      <Flex justify="between" align="center" gap="3">
        <Heading size="5">{t("title")}</Heading>
        <IconButton
          type="button"
          variant={showFilters || filtersActive ? "soft" : "ghost"}
          color="gray"
          size="3"
          aria-label={t("filtersLabel")}
          aria-expanded={showFilters}
          onClick={() => setShowFilters((open) => !open)}
        >
          <SlidersHorizontal size={18} />
        </IconButton>
      </Flex>

      {showFilters && (
        <Card>
          <Flex direction="column" gap="3">
            <FilterField label={t("entityLabel")}>
              {(id) => (
                <Select.Root
                  value={filters.entity ?? ANY}
                  onValueChange={(value) =>
                    updateFilters({ entity: value === ANY ? null : value })
                  }
                >
                  <Select.Trigger id={id} />
                  <Select.Content position="popper">
                    <Select.Item value={ANY}>{t("allEntities")}</Select.Item>
                    {options.entities.map((entity) => (
                      <Select.Item key={entity} value={entity}>
                        {entityLabels[entity] ?? entity}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              )}
            </FilterField>

            <FilterField label={t("actorLabel")}>
              {(id) => (
                <Select.Root
                  value={filters.actor ?? ANY}
                  onValueChange={(value) =>
                    updateFilters({ actor: value === ANY ? null : value })
                  }
                >
                  <Select.Trigger id={id} />
                  <Select.Content position="popper">
                    <Select.Item value={ANY}>{t("allActors")}</Select.Item>
                    {options.actors.map((actor) => (
                      <Select.Item key={actor.userId} value={actor.userId}>
                        {actor.name}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              )}
            </FilterField>

            <Flex gap="3" wrap="wrap">
              <FilterField label={t("rangeFrom")}>
                {(id) => (
                  <TextField.Root
                    id={id}
                    type="date"
                    value={filters.from ?? ""}
                    onChange={(event) =>
                      updateFilters({ from: event.target.value || null })
                    }
                  />
                )}
              </FilterField>
              <FilterField label={t("rangeTo")}>
                {(id) => (
                  <TextField.Root
                    id={id}
                    type="date"
                    value={filters.to ?? ""}
                    onChange={(event) =>
                      updateFilters({ to: event.target.value || null })
                    }
                  />
                )}
              </FilterField>
            </Flex>

            {filtersActive && (
              <Button
                type="button"
                variant="soft"
                color="gray"
                onClick={clearFilters}
              >
                {t("clearFilters")}
              </Button>
            )}
          </Flex>
        </Card>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={<ScrollText size={40} strokeWidth={1.6} />}
          title={t("emptyTitle")}
          description={t("emptyDescription")}
          action={
            filtersActive ? (
              <Button type="button" mt="2" onClick={clearFilters}>
                {t("clearFilters")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <AuditTable
          rows={tableRows}
          page={filters.page}
          pageCount={pageCount}
          onPrev={() => goToPage(filters.page - 1)}
          onNext={() => goToPage(filters.page + 1)}
        />
      )}
    </Flex>
  );
}
