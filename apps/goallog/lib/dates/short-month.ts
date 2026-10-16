const SHORT_MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

// «sep»: three letters from a fixed table, because ICU's own short form is
// «sept» for September. Takes `YYYY-MM-DD` or `YYYY-MM`.
export function shortMonth(civilDate: string): string {
  return SHORT_MONTHS[Number(civilDate.slice(5, 7)) - 1];
}
