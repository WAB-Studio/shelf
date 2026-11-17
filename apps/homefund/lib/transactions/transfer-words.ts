// A transfer said in a person's words (RF-272): paying a loan, a card or a credit somebody else pays names
// what happened, never the accounts it moved between. Pure: it reads the account facts a list already holds.

export type TransferSide = {
  name: string;
  subtype: string;
  institution: string | null;
  // Set on the hidden «Me debe» of a credit somebody else pays: the payer.
  internalPersonName: string | null;
};

export type TransferWords =
  | { kind: "loanPayment"; name: string }
  | { kind: "cardPayment"; name: string }
  | { kind: "payerPaid"; name: string }
  | { kind: "between"; name: null };

/**
 * What a transfer between `from` and `to` is called. A transfer that touches no debt and no hidden account is
 * «between»: the caller writes its own accounts.
 */
export function transferWords(
  from: TransferSide | undefined,
  to: TransferSide | undefined,
): TransferWords {
  if (from?.internalPersonName) {
    return { kind: "payerPaid", name: from.internalPersonName };
  }
  if (to?.subtype === "loan") {
    return { kind: "loanPayment", name: to.institution || to.name };
  }
  if (to?.subtype === "card") {
    return { kind: "cardPayment", name: to.name };
  }
  return { kind: "between", name: null };
}

type Translate = (
  key: "kindTransfer" | "transferLoanPayment" | "transferCardPayment" | "transferPayerPaid",
  values?: { name: string },
) => string;

/** The directory's accounts as the sides `transferWords` reads, by id. */
export function transferSidesById(
  directory: readonly (TransferSide & { id: string })[],
): Map<string, TransferSide> {
  return new Map(directory.map((account) => [account.id, account]));
}

/** The title a transfer carries in a list: its words, or «Entre mis cuentas». */
export function transferTitle(words: TransferWords, t: Translate): string {
  switch (words.kind) {
    case "loanPayment":
      return t("transferLoanPayment", { name: words.name });
    case "cardPayment":
      return t("transferCardPayment", { name: words.name });
    case "payerPaid":
      return t("transferPayerPaid", { name: words.name });
    default:
      return t("kindTransfer");
  }
}

export type TransferNarration = {
  title: string;
  // The one account worth naming beside the title: where the money left from, or, for a payer's cuota, where it
  // landed. «Ahorros → Efectivo» for a plain move.
  account: string;
};

/** Every plain transfer of `rows`, in words, by movement id; reconciliation adjustments are none. */
export function narrateTransfers(
  rows: readonly {
    id: string;
    kind: string;
    reconciliationId: string | null;
    fromAccountId: string | null;
    toAccountId: string | null;
  }[],
  sides: Map<string, TransferSide>,
  accountNames: Map<string, string>,
  t: Translate,
): Map<string, TransferNarration> {
  const narration = new Map<string, TransferNarration>();
  for (const row of rows) {
    if (row.kind !== "transfer" || row.reconciliationId !== null) continue;
    const words = transferWords(
      row.fromAccountId ? sides.get(row.fromAccountId) : undefined,
      row.toAccountId ? sides.get(row.toAccountId) : undefined,
    );
    const nameOf = (id: string | null) => (id && accountNames.get(id)) || "";
    const account =
      words.kind === "payerPaid"
        ? nameOf(row.toAccountId)
        : words.kind === "between"
          ? `${nameOf(row.fromAccountId)} → ${nameOf(row.toAccountId)}`
          : nameOf(row.fromAccountId);
    narration.set(row.id, { title: transferTitle(words, t), account });
  }
  return narration;
}
