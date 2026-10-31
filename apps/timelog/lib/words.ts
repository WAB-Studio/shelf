import "server-only";

import { getLocale, getTranslations } from "next-intl/server";

import { readableApps } from "@/lib/app-names";
import type { DurationWords } from "@/lib/duration";
import { briefDuration, durationParts, formatDuration, heatFigure } from "@/lib/duration";
import type { AppTime } from "@/lib/queries";
import { weekdayIndex } from "@/lib/week";
import { TIME_ZONE } from "@/lib/zone";

// Built once per language: a formatter per call is a native allocation per key on «Llaves».
const MOMENT = {
  es: new Intl.DateTimeFormat("es-CO", { timeZone: TIME_ZONE, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }),
  en: new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }),
};

const CLOCK = {
  es: new Intl.DateTimeFormat("es-CO", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" }),
  en: new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" }),
};

const dayOfMonth = (day: string) => Number(day.slice(8, 10));

// The calendar words and the duration a screen reads, from the catalogue.
export async function calendarWords() {
  const [common, time, locale] = await Promise.all([getTranslations("common"), getTranslations("time"), getLocale()]);
  const months = common.raw("months") as string[];
  const monthsShort = common.raw("monthsShort") as string[];
  const weekdays = common.raw("weekdays") as string[];
  const weekdaysInitial = common.raw("weekdaysInitial") as string[];
  const weekdaysShort = common.raw("weekdaysShort") as string[];
  const words: DurationWords = {
    hours: time("duration.hours"),
    minutes: time("duration.minutes"),
    underMinute: time("duration.underMinute"),
  };

  return {
    duration: (seconds: number) => formatDuration(seconds, words),
    durationParts: (seconds: number) => durationParts(seconds, words),
    brief: (seconds: number) => briefDuration(seconds, words),
    heat: (seconds: number) => heatFigure(seconds, words, { hours: time("duration.tinyHours"), minutes: time("duration.tinyMinutes") }),
    // The day's apps under their readable names, system noise as «Sistema».
    apps: (apps: AppTime[]) => readableApps(apps, time("system")),
    system: time("system"),
    // «hace 5 min» by the clock now.
    ago: (at: Date) => {
      const minutes = Math.max(0, Math.floor((Date.now() - at.getTime()) / 60_000));
      if (minutes < 1) return time("duration.ago.now");
      if (minutes < 60) return time("duration.ago.minutes", { n: minutes });
      if (minutes < 1440) return time("duration.ago.hours", { n: Math.floor(minutes / 60) });
      return time("duration.ago.days", { n: Math.floor(minutes / 1440) });
    },
    weekday: (day: string) => weekdays[weekdayIndex(day)],
    weekdayInitial: (day: string) => weekdaysInitial[weekdayIndex(day)],
    weekdayShort: (day: string) => weekdaysShort[weekdayIndex(day)],
    month: (day: string) => months[Number(day.slice(5, 7)) - 1],
    dayOfMonth,
    // «26 oct», «Oct 26»
    dayShort: (day: string) => common("dayShort", { day: dayOfMonth(day), month: monthsShort[Number(day.slice(5, 7)) - 1] }),
    // «9:14 p. m.» on Bogotá's clock.
    clock: (at: Date) => CLOCK[locale === "en" ? "en" : "es"].format(at),
    // «28 oct, 9:14 p. m.» on Bogotá's clock.
    moment: (at: Date) => MOMENT[locale === "en" ? "en" : "es"].format(at),
  };
}
