import { formatPlace, type NominatimReverse } from "@/lib/ingest/place";

// OpenStreetMap's public reverse geocoder: no key, and its usage policy asks for an identifying
// User-Agent naming the app, nothing about the person. The base URL is overridable so a suite can point
// it at a stub; no test reaches the real service.
const DEFAULT_BASE_URL = "https://nominatim.openstreetmap.org";
const USER_AGENT = "HomeFund/1.0";
const TIMEOUT_MS = 2000;

/**
 * The readable place for a pair of coordinates, or null when the service is down, slow, refuses or
 * answers nothing usable. Never throws: the delivery is already stored without it (RF-320).
 */
export async function reverseGeocode(
  latitude: number,
  longitude: number,
  { baseUrl = process.env.GEOCODER_URL ?? DEFAULT_BASE_URL, fetchImpl = fetch }: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const url = new URL("/reverse", baseUrl);
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
