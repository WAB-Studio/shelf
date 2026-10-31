import type { Sense } from "./index-build";

// Kept apart from index-build.ts, whose frequency table is too heavy for a route that only reads a line.
// Labels that say nothing about how rare a sense is: its grammar, its region, its register short of slang.
// Any other label — a trade, a field, «slang», «dated» — marks a sense a reader meets seldom.
const NEUTRAL_LABELS = new Set([
  "transitive",
  "intransitive",
  "ambitransitive",
  "uncountable",
  "countable",
  "idiomatic",
  "idiom",
  "figuratively",
  "figurative",
  "by extension",
  "often",
  "usually",
  "sometimes",
  "or",
  "now",
  "in the plural",
  "chiefly",
  "formal",
  "informal",
  "US",
  "UK",
  "British",
  "American",
  "Canada",
  "North America",
  "_",
]);

// A definition that is only a pointer to another word, an initialism, or a species.
const POINTER_DEFINITION = /^(Initialism|Abbreviation|Acronym|Alternative|Synonym|Contraction|Clipping|Archaic)\b/;
const TAXON_DEFINITION = /\([A-Z][a-z]+ [a-z]+\)/;

/**
 * A sense the reader meets seldom: it carries a trade, field or register label (`informatics`, `slang`),
 * only points at another word (`Initialism of…`), or names a species. The dictionary lists these beside
 * the common sense without saying which is which: `bleak` leads with a river fish, `cup` with a trophy.
 */
export function isRareSense(sense: Sense): boolean {
  const definition = sense.definition;
  if (definition === null) return false;
  if (POINTER_DEFINITION.test(definition) || TAXON_DEFINITION.test(definition)) return true;
  const label = definition.match(/^\(([^)]*)\)/);
  if (label === null) return false;
  return label[1].split(/,\s*/).some((part) => !NEUTRAL_LABELS.has(part));
}

/**
 * The senses an answer stands on and the ones it folds behind a line. Nothing folds when every sense is
 * rare: the reader would meet an empty answer.
 */
export function splitRare(senses: readonly Sense[], compact = false): { shown: Sense[]; folded: Sense[] } {
  if (compact) return { shown: [...senses], folded: [] };
  const rare = senses.filter(isRareSense);
  const common = senses.filter((sense) => !isRareSense(sense));
  if (rare.length === 0 || common.length === 0) return { shown: [...senses], folded: [] };
  return { shown: common, folded: rare };
}
