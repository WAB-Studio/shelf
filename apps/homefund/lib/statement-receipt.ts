// A bank prints one line per charge and, on most statements, a reference or authorization number beside it. A
// receipt a chat or a photo gave has neither: loaded line by line it makes one movement per product (RF-248).
// This many expense lines on one day, none with a reference, is read as one.
export const RECEIPT_LINES = 5;

type ReceiptRow = { line: number; date: string; amountCents: number; reference?: string; counterAccountId?: string };

/** The first line of a day that reads as a receipt split into products, or null when no day does. */
export function receiptLikeLine(rows: readonly ReceiptRow[]): number | null {
  const byDay = new Map<string, number[]>();
  for (const row of rows) {
    if (row.amountCents >= 0 || row.reference !== undefined || row.counterAccountId !== undefined) continue;
    byDay.set(row.date, [...(byDay.get(row.date) ?? []), row.line]);
  }
  const days = [...byDay.values()].filter((lines) => lines.length >= RECEIPT_LINES);
  return days.length === 0 ? null : Math.min(...days.map((lines) => Math.min(...lines)));
}
