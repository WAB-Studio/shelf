import "server-only";

import { TIME_ZONE } from "@/lib/locales";

// A public, keyless quote (RNF-13): the request carries the two ISO codes and
// nothing about the fund or the person asking. A person still confirms the
// figure before anything is booked (RF-122) — this only proposes one.
const ENDPOINT = "https://open.er-api.com/v6/latest/";
const TIMEOUT_MS = 4000;

export type RateQuote = {
  rate: number;
  asOf: string;
};

type ErApiResponse = {
  result?: string;
  time_last_update_utc?: string;
  rates?: Record<string, number>;
};

// The source's own as-of instant, read as a Bogotá calendar day (RNF-06). A
// response that carries no timestamp still names today, since a daily rate has
// no other day to stand for.
function asOfDate(header: string | undefined): string {
  const parsed = header ? new Date(header) : null;
  const instant = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(instant);
}

/**
 * A proposed rate between two ISO currency codes, or `null` when the source is
 * down, too slow to answer or does not cover one of the two (RF-122). Never
 * throws: every caller already has a form that saves without it.
 */
export async function fetchRate(
  from: string,
  to: string,
): Promise<RateQuote | null> {
  if (from === to) return { rate: 1, asOf: asOfDate(undefined) };

  try {
    const response = await fetch(`${ENDPOINT}${from}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as ErApiResponse;
    if (body.result !== "success" || !body.rates) return null;

    const rate = body.rates[to];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      return null;
    }

    return { rate, asOf: asOfDate(body.time_last_update_utc) };
  } catch {
    // A DNS failure, a timed-out signal or a body that is not JSON: every one
    // of them leaves the field for a person to fill in by hand.
    return null;
  }
}
