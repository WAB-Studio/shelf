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
