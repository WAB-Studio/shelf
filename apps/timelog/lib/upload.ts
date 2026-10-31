import { z } from "zod";

import { addDays, civilDay, isCivilDay } from "@/lib/zone";

// Postgres refuses a NUL in text and jsonb; a control character is no app's name.
const name = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u, "a control character");

export const MAX_DAYS = 31;
const MAX_APPS = 500;
const MAX_SITES = 500;
const DAY_SECONDS = 86_400;

const appDay = z.object({
  app: name(120),
  seconds: z.number().int().min(1).max(DAY_SECONDS),
});

// A hostname and nothing a path, a query or a port could ride in on (RT-13); the uploader lower-cases it.
const siteDay = z.object({
  host: z.string().max(120).regex(/^[a-z0-9]([a-z0-9.-]{0,118}[a-z0-9])?$/, "not a hostname"),
  seconds: z.number().int().min(1).max(DAY_SECONDS),
});

// What `timelog-sync` sends (RT-01, RT-13, RT-14): per day, each app's seconds, optionally each site's and
// Claude Code's. A part left out leaves what the server has; an old uploader sends neither.
export function uploadSchema(today: string = civilDay()) {
  // A PC ahead of Bogotá may already be on tomorrow.
  const latest = addDays(today, 1);
  return z
    .object({
      device: name(80),
      days: z
        .array(
          z
            .object({
              day: z.string().refine(isCivilDay, "not a day").refine((day) => day <= latest, "a day not yet lived"),
              apps: z.array(appDay).max(MAX_APPS),
              sites: z.array(siteDay).max(MAX_SITES).optional(),
              claude_code_seconds: z.number().int().min(0).max(DAY_SECONDS).optional(),
            })
            .refine((entry) => new Set((entry.sites ?? []).map((one) => one.host)).size === (entry.sites ?? []).length, "a site twice in one day")
            .refine((entry) => (entry.sites ?? []).reduce((total, one) => total + one.seconds, 0) <= DAY_SECONDS, "more than a day of sites")
            .refine((entry) => new Set(entry.apps.map((one) => one.app)).size === entry.apps.length, "an app twice in one day")
            .refine((entry) => entry.apps.reduce((total, one) => total + one.seconds, 0) <= DAY_SECONDS, "more than a day"),
        )
        .min(1)
        .max(MAX_DAYS)
        .refine((days) => new Set(days.map((entry) => entry.day)).size === days.length, "a day twice"),
    })
    .strict();
}

export type Upload = z.infer<ReturnType<typeof uploadSchema>>;
