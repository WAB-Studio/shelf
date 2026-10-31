import { z } from "zod";

import { addDays, civilDay, isCivilDay } from "@/lib/zone";

// Postgres refuses a NUL in text and jsonb; a control character is no app's name.
const name = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u, "a control character");

export const MAX_DAYS = 31;
const MAX_APPS = 500;
const MAX_SITES = 500;
const MAX_WINDOWS = 200;
const MAX_PAGES = 300;
const MAX_SESSIONS = 100;
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

// A window title inside one app (RT-18).
const windowDay = z.object({
  app: name(120),
  title: name(300),
  seconds: z.number().int().min(1).max(DAY_SECONDS),
});

const HOST = /^[a-z0-9]([a-z0-9.-]{0,118}[a-z0-9])?$/;

// A page: its address without credentials, query and fragment, whose host is the `host` it comes under (RT-18).
const pageDay = z
  .object({
    host: z.string().max(120).regex(HOST, "not a hostname"),
    url: z.string().max(500).regex(/^https?:\/\/[^?#\s]+$/, "not a bare address").regex(/^[^\p{Cc}]+$/u, "a control character"),
    title: z.string().trim().max(300).regex(/^[^\p{Cc}]*$/u, "a control character"),
    seconds: z.number().int().min(1).max(DAY_SECONDS),
  })
  .refine(
    (page) => {
      try {
        return new URL(page.url).hostname.replace(/^www\./, "") === page.host;
      } catch {
        return false;
      }
    },
    "an address under another host",
  );

// A Claude Code session on that day (RT-19): ids and times, never a message.
const claudeSession = z
  .object({
    session: name(80),
    project: name(200),
    first: z.iso.datetime(),
    last: z.iso.datetime(),
    seconds: z.number().int().min(1).max(DAY_SECONDS),
  })
  .refine((one) => one.first <= one.last, "ends before it starts");

const total = (rows: { seconds: number }[] | undefined) => (rows ?? []).reduce((sum, one) => sum + one.seconds, 0);
const distinct = (keys: string[] | undefined) => new Set(keys).size === (keys ?? []).length;

// What `timelog-sync` sends (RT-13, RT-14, RT-16..RT-19): per day, each app's seconds, and optionally its windows,
// sites, pages, Claude Code's seconds and sessions. A part left out leaves what the server has; an old uploader sends none.
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
              windows: z.array(windowDay).max(MAX_WINDOWS).optional(),
              pages: z.array(pageDay).max(MAX_PAGES).optional(),
              claude_sessions: z.array(claudeSession).max(MAX_SESSIONS).optional(),
            })
            .refine((entry) => distinct(entry.windows?.map((one) => `${one.app}\n${one.title}`)), "a window twice in one day")
            .refine((entry) => total(entry.windows) <= DAY_SECONDS, "more than a day of windows")
            .refine((entry) => distinct(entry.pages?.map((one) => `${one.url}\n${one.title}`)), "a page twice in one day")
            .refine((entry) => total(entry.pages) <= DAY_SECONDS, "more than a day of pages")
            .refine((entry) => distinct(entry.claude_sessions?.map((one) => one.session)), "a session twice in one day")
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
