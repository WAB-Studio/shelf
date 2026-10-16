import type { CSSProperties } from "react";
import { useLocale } from "next-intl";

import type { CurrencyCode } from "@/lib/currency";
import { formatMoney } from "@/lib/money";

// The ledger's minus is U+2212, never the hyphen a keyboard types (SPEC-A3).
const MINUS = "−";

// U+2248, the mark a figure the issuer has not billed yet carries (RF-123).
const APPROXIMATELY = "≈";

export type MoneyTone = "expense" | "income" | "transfer" | "plain";

const TONE_COLOR: Record<MoneyTone, string | undefined> = {
  income: "var(--accent-11)",
  expense: "var(--gray-12)",
  transfer: "var(--gray-11)",
  // Inherits the surrounding ink, so a tile or a heading keeps its own colour.
  plain: undefined,
};

const SIZE_STYLE = {
  row: { fontSize: "13.5px", fontWeight: 600 },
  figure: { fontSize: "23px", fontWeight: 700, letterSpacing: "-0.025em" },
  // The one figure a detail screen is built around (SPEC-A3).
  hero: { fontSize: "40px", fontWeight: 700, letterSpacing: "-0.03em" },
  // Takes the surrounding type, for a heading or a chip that already sets it and
  // re-sizes itself across breakpoints.
  inherit: {},
} satisfies Record<string, CSSProperties>;

export type MoneyProps = {
  // The amount as the column keeps it, in hundredths of the currency's major
  // unit, whatever the currency (RNF-05).
  minor: number;
  // Required, and with no fallback behind it: a figure no caller gave a currency
  // to is a row that does not know which one it is in, and guessing the
  // settlement currency is what let one draw without saying so (RF-124).
  currency: CurrencyCode;
  tone?: MoneyTone;
  size?: "row" | "figure" | "hero" | "inherit";
  // "always" reads the stored sign whatever the tone, «+» included: a figure
  // that is neither income nor expense but still moves the balance (RF-138).
  signed?: boolean | "always";
  // Marks the figure as what a person expects to be billed, not what was
  // billed (RF-123). No screen writes that mark itself.
  estimate?: boolean;
};

/**
 * The one place an amount turns into a figure (RF-125, RF-121, RNF-05). The
 * stored integer in, the currency's own figure out — no screen divides by the
 * stored scale, none writes the currency's mark and none writes its own sign.
 */
export function Money({
  minor: amountMinor,
  currency,
  tone = "plain",
  size = "row",
  signed = true,
  estimate = false,
}: MoneyProps) {
  const locale = useLocale();

  // A movement's sign comes from the accounts it touches, which is what its tone
  // says; a plain figure has no tone to read it from, so a signed one carries the
  // sign it stores — a balance below zero is an overdraft, not an amount. A zero
  // total reads without a sign whatever its tone.
  const sign =
    !signed || amountMinor === 0
      ? ""
      : signed === "always"
        ? amountMinor < 0
          ? MINUS
          : "+"
        : tone === "income"
        ? "+"
        : tone === "expense"
          ? MINUS
          : amountMinor < 0
            ? MINUS
            : "";

  return (
    <span
      style={{
        ...SIZE_STYLE[size],
        color: TONE_COLOR[tone],
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      }}
    >
      {estimate ? `${APPROXIMATELY} ` : ""}
      {sign}
      {formatMoney(amountMinor, currency, locale)}
    </span>
  );
}
