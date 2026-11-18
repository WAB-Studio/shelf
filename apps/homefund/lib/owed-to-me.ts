// What other people owe the person, computed and never stored (decision 2 of 2026-11-17). Two sources: a credit
// somebody else pays (RF-216), whose figure is the capital the loan still owes (what the bank says is left, RF-301),
// and a person «se le cobra» (RF-242), whose figure is what they already owed, plus what was spent for them, less what they returned. Pure, so the
// query and the tests share it.

// `opening` is what a person already owed before any movement here (RF-319), dated by the day it counts from.
export type OwedLineKind = "capital" | "opening" | "spent" | "returned";

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
  // A credit with a payment schedule: what its unpaid cuotas ask with interest and insurance, and how many they are.
  withInterest: { cents: number; count: number } | null;
};

export type OwedCurrency = { currency: string; totalCents: number; people: OwedPerson[] };

/** What a person «se le cobra» still owes: what they already owed plus what was spent for them, less what they returned. */
export function owedByPerson(lines: OwedLine[]): number {
  return lines.reduce((sum, line) => sum + line.cents, 0);
}

/** A credit's one line: the capital the loan still owes, which is the whole figure. */
export function creditLines(capitalCents: number): OwedLine[] {
  return [{ kind: "capital", occurredOn: null, cents: capitalCents, description: null, transactionId: null }];
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
