// The number a bank message names and the saved recipient it points to (RF-189). Pure: no DB, no async.

// «a la cuenta *3203359119», «a la llave 3203359119», «a Nequi 3203359119»: where the money went.
const DESTINATION =
  /\ba\s+(?:la\s+)?(?:cuenta|llave|cel(?:ular)?|nequi|daviplata)\s+(?:de\s+)?\*?\s*(\d{4,20})(?!\d)/iu;

// «de 3203359119», «de la cuenta *6870»: where the money came from. «desde» and «de tu cuenta» never
// match: the first is the person's own account, which RF-97 resolves by its last four digits.
const SOURCE = /\bde\s+(?:la\s+cuenta\s+)?\*?\s*(\d{4,20})(?!\d)/iu;

export function extractNumber(text: string): string | null {
  return (DESTINATION.exec(text) ?? SOURCE.exec(text))?.[1] ?? null;
}

export type RecipientKind = "own_account" | "person" | "payee";

export type RecipientRule = {
  id: string;
  identifier: string;
  name: string;
  kind: RecipientKind;
  accountId: string | null;
  categoryId: string | null;
};

// A notice shows the whole number or its tail, so the stored number matches when it ends with the digits
// shown. Two matches are no match: guessing between two people is worse than asking.
export function matchRecipient<T extends Pick<RecipientRule, "identifier">>(
  extracted: string | null,
  recipients: readonly T[],
): T | null {
  if (extracted === null) return null;
  const found = recipients.filter((recipient) => recipient.identifier.endsWith(extracted));

  return found.length === 1 ? found[0] : null;
}

export type ProposalFacts = {
  direction: "income" | "expense" | null;
  accountId: string | null;
};

export type RecipientProposal = {
  direction: "income" | "expense" | "transfer" | null;
  accountId: string | null;
  toAccountId: string | null;
  // Set only by a payee; otherwise the interpreter's reading stands.
  categoryId: string | null;
  description: string;
};

// What a matched recipient makes of the proposal: an account of the person's, or a person with a debt
// account, is a transfer (the side the message does not name is the recipient's); a payee is an expense
// under its category; anyone else only renames the description. The caller keeps its own category when
// `categoryId` is null.
export function applyRecipient(facts: ProposalFacts, recipient: RecipientRule): RecipientProposal {
  const base: RecipientProposal = {
    direction: facts.direction,
    accountId: facts.accountId,
    toAccountId: null,
    categoryId: null,
    description: recipient.name,
  };
  const linked = recipient.kind !== "payee" && recipient.accountId !== null;
  if (linked && recipient.accountId !== facts.accountId) {
    return facts.direction === "income"
      ? { ...base, direction: "transfer", accountId: recipient.accountId, toAccountId: facts.accountId }
      : { ...base, direction: "transfer", accountId: facts.accountId, toAccountId: recipient.accountId };
  }
  if (recipient.kind === "payee" && facts.direction !== "income") {
    return { ...base, direction: "expense", categoryId: recipient.categoryId };
  }

  return base;
}
