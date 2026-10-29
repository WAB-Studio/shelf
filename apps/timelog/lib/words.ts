import "server-only";

import { getTranslations } from "next-intl/server";

import type { DurationWords } from "@/lib/duration";
import { formatDuration } from "@/lib/duration";
import { weekdayIndex } from "@/lib/week";
import { TIME_ZONE } from "@/lib/zone";

// Built once: a formatter per call is a native allocation per key on «Llaves».
const MOMENT = new Intl.DateTimeFormat("es-CO", { timeZone: TIME_ZONE, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

const dayOfMonth = (day: string) => Number(day.slice(8, 10));

// The calendar words and the duration a screen reads, from the catalogue.
export async function calendarWords() {
  const [common, time] = await Promise.all([getTranslations("common"), getTranslations("time")]);
  const months = common.raw("months") as string[];
  const monthsShort = common.raw("monthsShort") as string[];
  const weekdays = common.raw("weekdays") as string[];
  const weekdaysShort = common.raw("weekdaysShort") as string[];
  const words: DurationWords = {
    hours: time("duration.hours"),
    minutes: time("duration.minutes"),
    underMinute: time("duration.underMinute"),
  };

  return {
    duration: (seconds: number) => formatDuration(seconds, words),
    weekday: (day: string) => weekdays[weekdayIndex(day)],
    weekdayShort: (day: string) => weekdaysShort[weekdayIndex(day)],
    month: (day: string) => months[Number(day.slice(5, 7)) - 1],
    dayOfMonth,
    // «26 oct»
    dayShort: (day: string) => `${dayOfMonth(day)} ${monthsShort[Number(day.slice(5, 7)) - 1]}`,
    // «28 oct, 9:14 p. m.» on Bogotá's clock.
    moment: (at: Date) => MOMENT.format(at),
  };
}
