// A warning rides beside what the tool wrote: the web allows each of these, so none refuses, but each says
// the money model's rule so Claude fixes the row with the person instead of leaving it wrong.
export type McpWarning = {
  code: "debtAsExpense" | "loanAsIncome" | "savingsAsExpense" | "debtLikeCategory";
  message: string;
  // The person's own liabilities, by id, a debt payment would go to; absent when they have none.
  liabilities?: { id: string; name: string; subtype: string }[];
  // The statement lines or inbox deliveries the warning is about, when it names several.
  lines?: number[];
  deliveryIds?: string[];
};

// Lowercase and without accents, so «Préstamo» and «prestamo» read alike.
const plain = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// What a debt is called: the word alone in a category, a payment or a disbursement in a description.
const DEBT_WORDS = /\b(deudas?|prestamos?|credito|creditos|tarjetas?|libranza)\b/;
const DEBT_DESCRIPTION =
  /\b(deuda|prestamo|desembolso|libranza|por cobrar|me debe|le debo|(pago|pagos|abono|cuota|cancelacion)( de| a| la| del)* (tarjeta|credito|prestamo|libranza|deuda)|cuota (de|del) (credito|prestamo|libranza|tarjeta))\b/;
const SAVINGS = /\bahorros?\b/;

/** Whether a category's name reads as a debt or a saving, which the model keeps as accounts. */
export function debtLikeName(name: string): boolean {
  const text = plain(name);
  return DEBT_WORDS.test(text) || SAVINGS.test(text) || /\btraslados?\b/.test(text);
}

// One movement or line to judge: its direction, what it says and the categories it sits in.
export type Probe = { kind: "expense" | "income"; description: string | null; categoryIds: string[]; line?: number; deliveryId?: string };

// The warning a movement earns by what it says and the categories it sits in, or none.
export function codeOf(probe: Probe, labels: ReadonlyMap<string, string>): McpWarning["code"] | null {
  const said = plain(probe.description ?? "");
  const categories = probe.categoryIds.map((id) => plain(labels.get(id) ?? ""));
  const debt = DEBT_DESCRIPTION.test(said) || categories.some((label) => DEBT_WORDS.test(label));
  if (probe.kind === "income") return debt ? "loanAsIncome" : null;
  if (debt) return "debtAsExpense";
  return SAVINGS.test(said) || categories.some((label) => SAVINGS.test(label)) ? "savingsAsExpense" : null;
}

// An account for what another person owes the person: a receivable, or a name that says «Me debe …». That is a
// person's «Ya te debía», a forPerson expense or a fromPerson income, never an account (RF-319).
export function personOwesAccount(subtype: string, name: string): boolean {
  return subtype === "receivable" || /^\s*me\s+debe\b/.test(plain(name));
}
