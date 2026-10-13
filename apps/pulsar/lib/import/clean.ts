// An imported note is clean text (RP-88, RP-95): no list mark, no checkbox, no emphasis, no heading.
// The same reading finds the lines that are tasks already (a box, a duration, «HECHO»).

import { civilDateToDate, isCivilDate } from "@/lib/zone";

const NAME_MAX = 120;

// Up to 120 characters, ending on a whole word.
export function shortenName(full: string): string {
  if (full.length <= NAME_MAX) return full;
  const cut = full.slice(0, NAME_MAX);
  if (/\s/.test(full[NAME_MAX])) return cut.trimEnd();
  const space = cut.search(/\s\S*$/);
  return (space > 0 ? cut.slice(0, space) : cut).trimEnd();
}

const MARK = /^\s*(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/;
const HEADING = /^\s*#{1,6}\s+/;

export function cleanLine(line: string): string {
  return line
    .replace(HEADING, "")
    .replace(MARK, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
}

const MONTHS: Record<string, number> = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12 };
const SPANISH_DATE = /(\d{1,2})\s+(?:de\s+)?([a-záéíóú]{3,})\.?(?:\s+(?:de\s+)?(\d{4}))?/i;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

// A day the line names after «HECHO», or null; a date that does not exist reads as no date.
function dayAfter(text: string, today: string): string | null {
  const iso = ISO_DATE.exec(text)?.[0];
  if (iso !== undefined) return isCivilDate(iso) ? iso : null;
  const match = SPANISH_DATE.exec(text);
  if (!match) return null;
  const month = MONTHS[match[2].slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const year = match[3] ?? today.slice(0, 4);
  const day = `${year}-${String(month).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  if (!isCivilDate(day)) return null;
  // Round trip: «31 feb» must not roll into March.
  return civilDateToDate(day).toISOString().slice(0, 10) === day ? day : null;
}

const CHECKED = /^\s*[-*+]\s+\[[xX]\]/;
const DONE_WORD = /\bHECHO\b(.*)$/;

// Whether a line says its thing is done, and on which day: the day it names, else today, never after today.
export function doneMark(line: string, today: string): { on: string } | null {
  const word = DONE_WORD.exec(line);
  if (!CHECKED.test(line) && !word) return null;
  const named = word ? dayAfter(word[1], today) : null;
  return { on: named === null || named > today ? today : named };
}

const BOX = /^\s*[-*+]\s+\[[ xX]\]/;
const DURATION = /^(?:(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hora|horas)\b\.?)?\s*(?:(\d+)\s*(?:min|mins|minutos?)\b\.?)?/i;
// «10 h semanales» is a rate the plan sets, not the length of a task.
const RATE = /^(?:semanales?|mensuales?|diarias?|al mes|por semana|a la semana|por mes|\/)/i;

export type LineTask = { name: string; minutes: number | null; doneOn: string | null; note: string | null };

// The task a line stands for, or null when it is not task-shaped: a box, a duration first, or HECHO.
export function taskFromLine(line: string, today: string): LineTask | null {
  const done = doneMark(line, today);
  const boxed = BOX.test(line);
  let text = cleanLine(line);
  if (text === "") return null;

  const withoutDone = text.replace(/\s*✅?\s*\bHECHO\b.*$/, "").replace(/^✅\s*/, "");
  text = withoutDone.trim();

  let minutes: number | null = null;
  const duration = DURATION.exec(text);
  if (duration && (duration[1] !== undefined || duration[2] !== undefined)) {
    const rest = text.slice(duration[0].length).trimStart();
    if (!RATE.test(rest)) {
      minutes = Math.round(Number((duration[1] ?? "0").replace(",", ".")) * 60) + Number(duration[2] ?? 0);
      text = rest.replace(/^[·:\-–—]\s*/, "");
    } else if (!boxed && !done) return null;
  }
  if (minutes === null && !boxed && !done) return null;
  if (minutes === 0) minutes = null;

  const parenthesised = /^(.+?)\s*\(([^()]+)\)\s*[.:]?$/.exec(text);
  const full = (parenthesised ? `${parenthesised[1].trim()} · ${parenthesised[2].trim()}` : text).replace(/[\s.:]+$/, "").replace(/\s+/g, " ");
  if (full === "") return null;
  const name = shortenName(full);
  return { name, minutes, doneOn: done?.on ?? null, note: name !== full ? full : null };
}
