export const LIST_TAIL = 12;

// Rows keep their order; a long list shows its last `LIST_TAIL` unless asked for all.
export function tailOf<T>(rows: readonly T[], all: boolean): { shown: T[]; hidden: number } {
  if (all || rows.length <= LIST_TAIL) return { shown: [...rows], hidden: 0 };
  return { shown: rows.slice(-LIST_TAIL), hidden: rows.length - LIST_TAIL };
}
