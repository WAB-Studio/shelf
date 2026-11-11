import type { SheetEntity } from "@/lib/spreadsheet/schema";

// The tabs a person reads, in reading order, transactions first. The rest follow in
// `SHEET_ENTITIES` order. The import matches sheets by tab name, never by position,
// so this order is free to differ from the import's.
export const READING_ORDER: readonly SheetEntity[] = [
  "transactions",
  "accounts",
  "categories",
  "budgets",
  "goals",
  "debts",
];

// The sheets that only restore references (people, tags, schedules, contributions,
// statements). A full export hides them rather than dropping them: they stay in the
// file, so a re-import still finds them, but a person opening it sees none.
export const BACKGROUND_SHEETS: ReadonlySet<SheetEntity> = new Set([
  "members",
  "labels",
  "recurringRules",
  "goalContributions",
  "statements",
]);

// The cells that make a row «the same row» without a key column (RF-179): a name for what is
// named, the date, the accounts, the amount, the currency and the description for a movement.
// Entities absent here carry their own key (debts, statements).
const IDENTITY_COLUMNS: Partial<Record<SheetEntity, readonly string[]>> = {
  accounts: ["name"],
  members: ["name"],
  categories: ["parent", "name"],
  labels: ["name"],
  goals: ["name"],
  transactions: ["occurredAt", "fromAccount", "toAccount", "amount", "currency", "description"],
  recurringRules: ["nextRunOn", "fromAccount", "toAccount", "amount", "description", "category"],
  budgets: ["category", "account", "label", "placement", "period"],
  goalContributions: ["contributedOn", "goal", "amount"],
};

export const CATEGORY_PATH_SEPARATOR = " › ";

// The key a matched row the fund holds without a key of its own is given: the commit leaves
// such a row as it is.
export const HELD_KEY_PREFIX = "held:";

function identityOf(columns: readonly string[], record: Record<string, unknown>): string {
  return JSON.stringify(
    columns.map((key) => {
      const cell = record[key];
      if (typeof cell !== "string") return cell ?? null;
      const trimmed = cell.trim();
      return trimmed.length === 0 ? null : trimmed;
    }),
  );
}

// A row's identities as strings, strictest first, or none for an entity without one. Built
// from sheet cells on both sides of an import (the file's and the fund's own export), so the
// two agree by shape. A movement also answers to its identity without the currency, which a
// sheet may leave blank.
export function identityKeys(entity: SheetEntity, record: Record<string, unknown>): string[] {
  const columns = IDENTITY_COLUMNS[entity];
  if (columns === undefined) return [];
  const strict = identityOf(columns, record);
  if (entity !== "transactions") return [strict];
  const loose = identityOf(
    columns.filter((key) => key !== "currency"),
    record,
  );
  return [strict, loose];
}
