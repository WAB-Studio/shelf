import type { TimeWords } from "./time";

type RootTranslator = {
  (key: string, values?: Record<string, unknown>): string;
  has(key: string): boolean;
};

// The server's twin of `useTimeWords` (`components/ui/figure.tsx`): the same
// catalogue words, from the root translator `await getTranslations()` gives.
export function timeWordsOf(t: RootTranslator): TimeWords {
  return {
    h: (h) => t("units.h", { h }),
    min: (min) => t("units.min", { min }),
    join: (h, min) => t("units.join", { h, min }),
    unit: (unit, n) => {
      const word = unit.trim().toLowerCase();
      const key = `units.words.${word}`;
      return /^\p{L}+$/u.test(word) && t.has(key) ? t(key, { count: n }) : unit;
    },
  };
}
