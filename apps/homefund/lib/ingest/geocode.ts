import { formatPlace, type NominatimReverse } from "@/lib/ingest/place";

// OpenStreetMap's public reverse geocoder: no key, and its usage policy asks for an identifying
// User-Agent naming the app, nothing about the person. The base URL is overridable so a suite can point
// it at a stub; outside production the public service is never called, so no test or dev server reaches it.
const PUBLIC_BASE_URL = "https://nominatim.openstreetmap.org/";
const USER_AGENT = "HomeFund/1.0";
const TIMEOUT_MS = 2000;

/**
 * The readable place for a pair of coordinates, or null when the service is down, slow, refuses or
 * answers nothing usable. Never throws: the delivery is already stored without it (RF-320).
 */
export async function reverseGeocode(
  latitude: number,
  longitude: number,
  {
    baseUrl = process.env.GEOCODER_URL ?? (process.env.NODE_ENV === "production" ? PUBLIC_BASE_URL : undefined),
    fetchImpl = fetch,
  }: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  if (!baseUrl) return null;
  // Relative to the base with a trailing slash, so a path prefix on the base stays.
  const url = new URL("reverse", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  url.search = new URLSearchParams({
    format: "jsonv2",
    lat: String(latitude),
    lon: String(longitude),
    zoom: "18",
    "accept-language": "es",
  }).toString();

  try {
    const response = await fetchImpl(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return formatPlace((await response.json()) as NominatimReverse);
  } catch {
    return null;
  }
}
