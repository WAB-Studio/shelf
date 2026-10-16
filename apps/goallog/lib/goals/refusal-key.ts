import type { MessageKey } from "@/i18n/translator";

import type { PlacementRefusal } from "./placement";

// Typed over the union, so a code added to `PlacementRefusal` fails the build
// until it names its words.
const KEYS = {
  cycle: "tree.errors.cycle",
  tooDeep: "tree.errors.tooDeep",
  closed: "tree.errors.closed",
  aboveClosed: "tree.errors.aboveClosed",
  endPastAbove: "tree.errors.endPastAbove",
  belowEndsLater: "tree.errors.belowEndsLater",
  belowNoEnd: "tree.errors.belowNoEnd",
  aboveArchived: "tree.errors.aboveArchived",
} as const satisfies Record<PlacementRefusal["code"], MessageKey>;

export const REFUSAL_CODES = Object.keys(KEYS) as PlacementRefusal["code"][];

export function refusalKey(code: PlacementRefusal["code"]): MessageKey {
  return KEYS[code];
}

// The goal a refusal names, for the `{name}` of its words.
export function refusalName(r: PlacementRefusal): string | null {
  if ("above" in r) return r.above.name;
  if ("below" in r) return r.below.name;
  return null;
}
