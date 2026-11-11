"use client";

import { useCallback, useSyncExternalStore } from "react";

import type { CurrencyCode } from "@/lib/currency";
import type { Locale } from "@/lib/locales";
import {
  formatCompactMoneyMasked,
  formatMoneyMasked,
  readStoredHidden,
  revealFigures,
  subscribeToPrivacy,
  writeStoredHidden,
} from "@/lib/privacy";

// The server and the hydration pass both draw visible; the stored choice lands
// right after mount, so no markup differs between the two.
function getServerSnapshot(): boolean {
  return false;
}

export function usePrivacy() {
  const hidden = useSyncExternalStore(subscribeToPrivacy, readStoredHidden, getServerSnapshot);
  const toggle = useCallback(() => writeStoredHidden(!readStoredHidden()), []);
  return { hidden, toggle };
}

// `formatMoney`'s own signature, so a call site swaps one name for the other.
export function useMoneyText() {
  const { hidden } = usePrivacy();
  return useCallback(
    (minor: number, currency: CurrencyCode, locale: Locale) =>
      formatMoneyMasked(minor, currency, locale, hidden),
    [hidden],
  );
}

export function useCompactMoneyText() {
  const { hidden } = usePrivacy();
  return useCallback(
    (minor: number, currency: CurrencyCode, locale: Locale) =>
      formatCompactMoneyMasked(minor, currency, locale, hidden),
    [hidden],
  );
}

// For text a Server Component wrote with `tagFigure` around its figures.
export function useFigureText() {
  const { hidden } = usePrivacy();
  return useCallback((text: string) => revealFigures(text, hidden), [hidden]);
}

