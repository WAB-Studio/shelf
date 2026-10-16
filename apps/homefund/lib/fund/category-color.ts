// One entry per node SEED_CATEGORIES seeds — parent and child alike, 23 of
// them (D8: a child used to copy its parent's colour instead of drawing its
// own, so the palette only had to cover the 15 parents). Ordered so no two
// neighbours read as the same colour: redmean(a, b) — the low-cost RGB stand-in
// for perceptual distance, weighted by mean red per the ITU/W3C formula — stays
// above 130 for every adjacent pair here (worst case 232), well clear of the 88
// that made #F97316 and #F59E0B read as one orange.
export const CATEGORY_COLORS = [
  "#78716C",
  "#DC2626",
  "#06B6D4",
  "#E11D48",
  "#0EA5E9",
  "#F97316",
  "#3B82F6",
  "#EAB308",
  "#0369A1",
  "#F59E0B",
  "#6366F1",
  "#84CC16",
  "#D946EF",
  "#22C55E",
  "#F43F5E",
  "#14B8A6",
  "#EC4899",
  "#10B981",
  "#A855F7",
  "#16A34A",
  "#8B5CF6",
  "#A16207",
  "#64748B",
] as const;

// The first unused colour, or a deterministic wrap once every colour is taken.
// `color` is an unconstrained `text()` column, so a stored value may differ
// from the palette only in case; the comparison ignores it, the return never does.
export function nextCategoryColor(used: readonly string[]): string {
  const usedUpper = used.map((color) => color.toUpperCase());
  const free = CATEGORY_COLORS.find((color) => !usedUpper.includes(color));
  return free ?? CATEGORY_COLORS[used.length % CATEGORY_COLORS.length];
}
