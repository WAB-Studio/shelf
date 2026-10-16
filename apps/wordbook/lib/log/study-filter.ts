import type { StudyRow } from "./summary";

// The registro's filter (RL-63): which study rows a typed text leaves.

export function normaliseQuery(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// One haystack per row, built once: a row object is immutable once the
// summary hands it out, and the filter runs on every keystroke.
const haystacks = new WeakMap<StudyRow, string[]>();

function haystackOf(row: StudyRow): string[] {
  const seen = haystacks.get(row);
  if (seen) return seen;
  const built = [
    row.key,
    row.display,
    ...row.forms.map((form) => form.text),
    row.lastTranslation ?? "",
  ].map(normaliseQuery);
  haystacks.set(row, built);
  return built;
}

export function filterStudyRows(rows: StudyRow[], query: string): StudyRow[] {
  const needle = normaliseQuery(query);
  if (needle === "") return rows;
  return rows.filter((row) => haystackOf(row).some((field) => field.includes(needle)));
}

// Last text typed in this tab session, so the back link from a word can
// return to the filtered list; module memory dies with a reload on purpose.
let lastFilter = "";

export function rememberFilter(text: string): void {
  lastFilter = text;
}

export function recalledFilter(): string {
  return lastFilter;
}
