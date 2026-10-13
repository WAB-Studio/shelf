// The section of the person's own text a line sits in: the nearest heading at or above it.
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;

export type Sectioned<T> = { heading: string | null; lines: T[] };

// Groups lines by the heading that precedes each, in the order the headings first appear.
// Two sections that share a title stay two groups. Lines above any heading share one group with a null heading.
// Returns null when the text has no heading at all or no text is known: nothing to group by.
export function bySection<T extends { line: number }>(items: T[], sourceLines: string[] | null): Sectioned<T>[] | null {
  if (sourceLines === null) return null;
  const headingAt: (number | null)[] = [];
  let current: number | null = null;
  let any = false;
  sourceLines.forEach((text, i) => {
    if (HEADING.test(text)) {
      current = i + 1;
      any = true;
    }
    headingAt[i + 1] = current;
  });
  if (!any) return null;
  const groups = new Map<number | null, Sectioned<T>>();
  for (const item of items) {
    const at = headingAt[item.line] ?? null;
    let group = groups.get(at);
    if (!group) {
      const text = at === null ? null : sourceLines[at - 1].match(HEADING)?.[1].trim() || null;
      groups.set(at, (group = { heading: text, lines: [] }));
    }
    group.lines.push(item);
  }
  return [...groups.values()];
}
