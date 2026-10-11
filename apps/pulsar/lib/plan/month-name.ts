const monthFormat = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" });

/** «diciembre de 2027»: the year always. */
export function monthNameWithYear(month: string): string {
  return `${monthFormat.format(new Date(`${month.slice(0, 7)}-01T12:00:00Z`))} de ${month.slice(0, 4)}`;
}

/** «diciembre», or «diciembre de 2027» when it is not this year's. */
export function monthName(month: string, thisYear: string): string {
  const name = monthFormat.format(new Date(`${month.slice(0, 7)}-01T12:00:00Z`));
  return month.slice(0, 4) === thisYear ? name : `${name} de ${month.slice(0, 4)}`;
}
