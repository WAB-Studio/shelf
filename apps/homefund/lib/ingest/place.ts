// What Nominatim's `reverse` (jsonv2) answers that a place line reads: the feature's own name and the
// address parts it split the coordinates into. Everything is optional, and every string is outside data.
export type NominatimReverse = {
  name?: unknown;
  category?: unknown;
  address?: Record<string, unknown>;
};

const MAX_PLACE_LENGTH = 120;
// A feature of these kinds is the street or the area the address already names, not a business.
const NOT_A_BUSINESS = new Set(["highway", "place", "boundary", "landuse", "natural", "waterway"]);

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters and runs of space go: the line is shown to a person and read by a model.
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

function first(address: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const text = clean(address[key]);
    if (text !== null) return text;
  }
  return null;
}

/**
 * A short line for where a purchase was made: the business if the point is one, then the road, the
 * neighbourhood and the city («Éxito, Calle 80, Engativá, Bogotá»). Null when the answer names nothing.
 */
export function formatPlace(reverse: NominatimReverse): string | null {
  const address = reverse.address ?? {};
  const category = typeof reverse.category === "string" ? reverse.category : "";
  const business = NOT_A_BUSINESS.has(category) ? null : clean(reverse.name);

  const parts = [
    business,
    first(address, ["road", "pedestrian", "footway"]),
    first(address, ["suburb", "neighbourhood", "quarter", "city_district"]),
    first(address, ["city", "town", "village", "municipality"]),
  ];

  const seen = new Set<string>();
  const line = parts
    .filter((part): part is string => part !== null)
    .filter((part) => {
      const key = part.toLocaleLowerCase("es");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(", ");

  return line === "" ? null : line.slice(0, MAX_PLACE_LENGTH);
}
