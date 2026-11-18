// A category for a typed phrase from what the person already did, then from the names everyone gives a
// common spend (RF-273). Pure: it reads a list the form already holds and decides nothing the person cannot change.

type NamedCategory = { id: string; name: string };

// What a person typed before and the category it ended up in, newest first.
export type PhraseMemory = { text: string; categoryId: string };

// Fold case and accents, so «Droguería» and «drogueria» are one word.
export function foldWord(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

// What a phrase names, and the words a category of that kind goes by. A category is chosen by one of
// its own names containing one of the candidates, in the order listed.
const COMMON_MERCHANTS: { words: string[]; categories: string[] }[] = [
  {
    words: ["netflix", "spotify", "disney", "hbo", "youtube", "amazon prime", "apple music"],
    categories: ["suscripcion", "streaming", "entretenimiento", "ocio"],
  },
  { words: ["uber", "didi", "cabify", "indriver", "taxi"], categories: ["transporte", "taxi"] },
  {
    words: ["almuerzo", "desayuno", "cena", "comida", "restaurante", "domicilio", "rappi"],
    categories: ["restaurante", "comida", "alimentacion"],
  },
  { words: ["gasolina", "combustible", "tanqueo"], categories: ["gasolina", "combustible", "transporte"] },
  {
    words: ["farmacia", "drogueria", "droguerias", "cruz verde", "farmatodo", "medicina"],
    categories: ["farmacia", "salud", "medicina"],
  },
];

// Words that say nothing about where the money went.
const STOP_WORDS = new Set(["compra", "pago", "pagos", "para", "gasto", "cuenta", "tarjeta", "mercado"]);

const MIN_WORD_LENGTH = 4;

function wordsOf(text: string): string[] {
  return (foldWord(text).match(/[a-z]+/g) ?? []).filter(
    (word) => word.length >= MIN_WORD_LENGTH && !STOP_WORDS.has(word),
  );
}

// The category of the person's most recent phrase that shares a word with this one.
export function categoryFromMemory(
  text: string,
  memory: readonly PhraseMemory[],
  categories: readonly NamedCategory[],
): string | null {
  const wanted = new Set(wordsOf(text));
  if (wanted.size === 0) return null;
  const offered = new Set(categories.map((category) => category.id));

  for (const entry of memory) {
    if (!offered.has(entry.categoryId)) continue;
    if (wordsOf(entry.text).some((word) => wanted.has(word))) return entry.categoryId;
  }
  return null;
}

// The category a well-known spend belongs to, when the person has one named like it.
export function categoryFromMerchant(
  text: string,
  categories: readonly NamedCategory[],
): string | null {
  const folded = foldWord(text);
  const merchant = COMMON_MERCHANTS.find((entry) =>
    entry.words.some((word) => new RegExp(`(?<![a-z])${word}(?![a-z])`).test(folded)),
  );
  if (!merchant) return null;

  for (const candidate of merchant.categories) {
    const found = categories.find((category) => foldWord(category.name).includes(candidate));
    if (found) return found.id;
  }
  return null;
}
