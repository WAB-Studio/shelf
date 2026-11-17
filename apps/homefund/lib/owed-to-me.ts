// What other people owe the person, computed and never stored (decision 2 of 2026-11-17). Two sources: a credit
// somebody else pays (RF-216), whose figure is what the payer still owes in capital, and a person «se le cobra»
// (RF-242), whose figure is what was spent for them less what they returned. Pure, so the query and the tests share it.

export type OwedLineKind = "opening" | "payment" | "other" | "spent" | "returned";

// One line of a breakdown; `cents` is signed by what it does to the figure: what grows it above zero, what shrinks it below.
export type OwedLine = {
  kind: OwedLineKind;
  occurredOn: string | null;
  cents: number;
  description: string | null;
  transactionId: string | null;
};

export type OwedPerson = {
  // «credit:<link id>» or «person:<label id>»: one stable key per row.
  key: string;
  name: string;
  currency: string;
  cents: number;
  source: "credit" | "person";
  // The person's label when the figure comes from «se le cobra»; null for a credit.
  labelId: string | null;
  breakdown: OwedLine[];
};

export type OwedCurrency = { currency: string; totalCents: number; people: OwedPerson[] };

/** What a person «se le cobra» still owes: what was spent for them less what they returned. */
export function owedByPerson(lines: OwedLine[]): number {
  return lines.reduce((sum, line) => sum + line.cents, 0);
}

/**
 * A credit's lines: the opening, each payment the payer sent and, when the receivable's balance holds more than
 * the opening less the payments, «other» so the lines always add up to the balance.
 */
export function creditLines(opening: { cents: number; on: string }, payments: { on: string; cents: number }[], balanceCents: number): OwedLine[] {
  const lines: OwedLine[] = [{ kind: "opening", occurredOn: opening.on, cents: opening.cents, description: null, transactionId: null }];
  for (const payment of payments) {
    lines.push({ kind: "payment", occurredOn: payment.on, cents: -payment.cents, description: null, transactionId: null });
  }
  const other = balanceCents - owedByPerson(lines);
  if (other !== 0) lines.push({ kind: "other", occurredOn: null, cents: other, description: null, transactionId: null });
  return lines;
}

/** Groups people by currency, never summing across currencies (RF-124); the largest owed first, currencies in order. */
export function groupOwed(people: OwedPerson[]): OwedCurrency[] {
  const byCurrency = new Map<string, OwedPerson[]>();
  for (const person of people) {
    byCurrency.set(person.currency, [...(byCurrency.get(person.currency) ?? []), person]);
  }
  return [...byCurrency]
    .map(([currency, list]) => {
      const owing = list.filter((person) => person.cents > 0).sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
      return { currency, totalCents: owing.reduce((sum, person) => sum + person.cents, 0), people: owing };
    })
    .filter((group) => group.people.length > 0)
    .sort((a, b) => a.currency.localeCompare(b.currency));
}
