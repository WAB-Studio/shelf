// What a person's own movements teach about a counterparty's category (RF-210). It is read from the
// movements themselves, never kept in a table of its own, so accepting a proposal under another category
// and editing a movement's category both teach it with no extra step. It is pure: no DB, no async.

// Two movements are the whole vote. One agreeing pair is evidence (the same bar RF-94 sets for a merchant);
// a single movement counts only when it is the only history; a disagreeing pair is no answer, and the next
// movement that agrees with the newer one settles it again, so unlike an `ambiguous` merchant it recovers.
const AGREEMENT = 2;

// How far back the lookup reads. Rent and yearly subscriptions repeat inside it; a counterparty last seen
// longer ago says little about today.
export const LEARNED_WINDOW_MONTHS = 24;

// A key shorter than this names no one («a», «d»); one longer is a whole message, which would match every
// message from one bank that names no counterparty.
export const LEARNED_KEY_MIN_LENGTH = 3;
export const LEARNED_KEY_MAX_LENGTH = 60;

// The categories of the counterparty's most recent movements, newest first; only the first two vote.
export function agreedCategory(recent: readonly string[]): string | null {
  const voters = recent.slice(0, AGREEMENT);
  if (voters.length === 0) return null;

  return voters.every((categoryId) => categoryId === voters[0]) ? voters[0] : null;
}

// A history-learned proposal is stored with the source `merchant` (the counterparty's memory) and no
// trusted merchant behind it: the source's CHECK has no value of its own for it, and a trusted merchant
// always states its own.
export function categoryFromHistory(delivery: {
  categorySource: string | null;
  merchantState: "learning" | "trusted" | "ambiguous" | null;
}): boolean {
  return delivery.categorySource === "merchant" && delivery.merchantState !== "trusted";
}

// What a merchant's own name says about its category when nothing the person did has taught it yet (RF-280):
// the words a bank prints and the categories every fund starts with. A person's own history, and a merchant they
// trusted, always speak before this; it only fills a gap where the proposal would otherwise have no category or
// the key's blanket default. Each row names the categories to try, in order, by the name the person sees.
const KEYWORD_CATEGORIES: readonly { kind: "expense" | "income"; words: readonly string[]; names: readonly string[] }[] = [
  {
    kind: "expense",
    words: ["exito", "jumbo", "carulla", "d1", "ara", "olimpica", "makro", "pricesmart", "surtimax", "supermercado", "mercado", "tienda"],
    names: ["mercado", "groceries"],
  },
  {
    kind: "expense",
    words: ["rappi", "restaurante", "pizza", "pizzeria", "burger", "kfc", "mcdonalds", "crepes", "corral", "cafe", "domicilio", "ifood", "frisby", "subway"],
    names: ["restaurantes", "eating out", "ocio"],
  },
  {
    kind: "expense",
    words: ["terpel", "texaco", "primax", "biomax", "esso", "gasolina", "combustible"],
    names: ["combustible", "fuel", "transporte"],
  },
  {
    kind: "expense",
    words: ["uber", "didi", "cabify", "indriver", "beat", "taxi", "transmilenio", "peaje", "parqueadero", "metro"],
    names: ["transporte", "transport"],
  },
  {
    kind: "expense",
    words: ["farmatodo", "drogueria", "farmacia", "locatel", "cruz verde", "clinica", "colsanitas", "medico", "odontologia"],
    names: ["salud", "health"],
  },
  {
    kind: "expense",
    words: ["netflix", "spotify", "disney", "hbo", "youtube", "prime video", "apple com", "google one", "anthropic", "openai"],
    names: ["suscripciones", "subscriptions", "ocio"],
  },
  {
    kind: "expense",
    words: ["epm", "codensa", "enel", "acueducto", "vanti", "gas natural", "claro", "movistar", "tigo", "etb"],
    names: ["servicios", "utilities"],
  },
  { kind: "expense", words: ["veterinaria", "petco"], names: ["mascotas", "pets"] },
  { kind: "expense", words: ["peluqueria", "barberia"], names: ["cuidado personal", "personal care"] },
  { kind: "expense", words: ["universidad", "colegio", "curso"], names: ["educacion", "education"] },
  { kind: "income", words: ["nomina", "salario", "sueldo"], names: ["salario", "salary"] },
  { kind: "income", words: ["reembolso"], names: ["reembolsos", "reimbursements"] },
];

function plain(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The person's own category a merchant's name points at, among those of the movement's kind; null when none fits. */
export function keywordCategory(
  merchantLabel: string | null,
  kind: "expense" | "income",
  categories: readonly { id: string; name: string; kind: string }[],
): string | null {
  if (merchantLabel === null) return null;

  const label = ` ${plain(merchantLabel)} `;
  for (const row of KEYWORD_CATEGORIES) {
    if (row.kind !== kind || !row.words.some((word) => label.includes(` ${word} `))) continue;

    for (const name of row.names) {
      const found = categories.find((category) => category.kind === kind && plain(category.name) === name);
      if (found) return found.id;
    }
  }
  return null;
}
