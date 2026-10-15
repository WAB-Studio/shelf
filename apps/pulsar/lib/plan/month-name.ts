const monthFormat = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" });
const monthYearFormat = new Intl.DateTimeFormat("es", { month: "long", year: "numeric", timeZone: "UTC" });

const instant = (month: string) => new Date(`${month.slice(0, 7)}-01T12:00:00Z`);

/** «diciembre de 2027»: the year always. */
export function monthNameWithYear(month: string): string {
  return monthYearFormat.format(instant(month));
}

/** «diciembre», or «diciembre de 2027» when it is not this year's. */
export function monthName(month: string, thisYear: string): string {
  return (month.slice(0, 4) === thisYear ? monthFormat : monthYearFormat).format(instant(month));
}
