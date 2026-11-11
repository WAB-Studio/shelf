// Device-scoped «hide amounts» choice (RF-174): no React, so the hook and any plain
// module read the same source. Storage is touched here and nowhere else.
import type { CurrencyCode } from "@/lib/currency";
import type { Locale } from "@/lib/locales";
import { formatCompactMoney, formatMoney } from "@/lib/money";

export const PRIVACY_STORAGE_KEY = "hide-amounts";

// What stands where the digits were: the currency mark and the spacing stay.
export const AMOUNT_MASK = "••••••";

// Private-use marks a Server Component wraps a figure in, so a client can find it in
// a sentence that was written before it knew whether to hide it.
const FIGURE_START = "";
const FIGURE_END = "";
const FIGURE_PATTERN = /([^]*)/g;
const DIGITS_PATTERN = /\d[\d.,\s  ]*\d|\d/;

const listeners = new Set<() => void>();

// Visible when nothing is stored or storage throws.
export function readStoredHidden(): boolean {
  try {
    return localStorage.getItem(PRIVACY_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeStoredHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(PRIVACY_STORAGE_KEY, "1");
    else localStorage.removeItem(PRIVACY_STORAGE_KEY);
  } catch {
    // Storage unavailable; the choice holds for this page's life only.
  }
  for (const listener of listeners) listener();
}

export function subscribeToPrivacy(listener: () => void): () => void {
  listeners.add(listener);

  // Another tab wrote the storage key.
  const onStorage = (event: StorageEvent) => {
    if (event.key === PRIVACY_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

// Swaps the digits of an already-drawn figure for the mask, keeping the rest.
export function maskFigure(figure: string): string {
  return DIGITS_PATTERN.test(figure) ? figure.replace(DIGITS_PATTERN, AMOUNT_MASK) : figure;
}

export function formatMoneyMasked(
  minor: number,
  currency: CurrencyCode,
  locale: Locale,
  hidden: boolean,
): string {
  const figure = formatMoney(minor, currency, locale);
  return hidden ? maskFigure(figure) : figure;
}

export function formatCompactMoneyMasked(
  minor: number,
  currency: CurrencyCode,
  locale: Locale,
  hidden: boolean,
): string {
  const figure = formatCompactMoney(minor, currency, locale);
  return hidden ? maskFigure(figure) : figure;
}

// A figure drawn on the server, tagged so `revealFigures` can hide it on the client.
export function tagFigure(figure: string): string {
  return `${FIGURE_START}${figure}${FIGURE_END}`;
}

// Strips the tags from a sentence, masking each tagged figure when hidden.
export function revealFigures(text: string, hidden: boolean): string {
  return text.replace(FIGURE_PATTERN, (_, figure: string) => (hidden ? maskFigure(figure) : figure));
}
