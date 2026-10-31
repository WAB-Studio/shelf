import { SPANISH_FREQUENCY_WORDS } from "./spanish-frequency";

// Articles, prepositions, pronouns and conjunctions: in «poner en duda» the word that places it is «poner».
const FUNCTION_WORDS = new Set(
  (
    "el la los las un una unos unas lo al del de a en con por para sin sobre entre hasta desde hacia contra " +
    "y e o u ni que si como cuando donde se me te le les nos os mi tu su sus mis tus este esta esto ese esa eso " +
    "algo alguien uno una cual cuyo no ya muy más menos"
  ).split(" "),
);

let rankByWord: Map<string, number> | null = null;

function ranks(): Map<string, number> {
  if (rankByWord === null) {
    rankByWord = new Map(SPANISH_FREQUENCY_WORDS.split("\n").map((word, rank) => [word, rank]));
  }
  return rankByWord;
}

// A phrase is a looser fit than one word: «sin color» stays behind «pálido» though «color» is common.
const PHRASE_PENALTY = 100_000;

// The rank of the commonest content word in a translation, behind every known single word when it is a
// phrase, or Infinity when the list knows none of its words.
export function translationRank(translation: string): number {
  const table = ranks();
  let best = Infinity;
  let bestOfAll = Infinity;
  const tokens = translation.toLowerCase().match(/\p{L}+/gu) ?? [];
  for (const word of tokens) {
    const rank = table.get(word) ?? Infinity;
    bestOfAll = Math.min(bestOfAll, rank);
    if (!FUNCTION_WORDS.has(word)) best = Math.min(best, rank);
  }
  // «lo» and «la» are the commonest words there are, yet say nothing about which sense of «it» is meant:
  // a translation made only of function words keeps the dictionary's place, ahead of the ranked ones.
  if (best === Infinity && bestOfAll !== Infinity) return -1;
  return tokens.length > 1 ? best + PHRASE_PENALTY : best;
}

// Commonest first; words the list does not know keep their dictionary order after the known ones.
export function orderTranslations(translations: readonly string[]): readonly string[] {
  return translations
    .map((translation, position) => ({ translation, position, rank: translationRank(translation) }))
    .sort((a, b) => (a.rank === b.rank ? a.position - b.position : a.rank - b.rank))
    .map((item) => item.translation);
}
