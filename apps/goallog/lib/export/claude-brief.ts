import { createTranslator } from "next-intl";

import goal from "../../messages/es/goal.json";
import type { Task } from "../plan/carry";
import { addDaysToCivilDate, civilDayMonthShort } from "../zone";

// Read straight from the catalogue: the brief is built where the goal is drawn, outside any request.
const translate = createTranslator({ locale: "es", messages: { goal } });

// The days a brief looks back over, today included: the stretch a study plan's «día 1, día 2» lives in.
const BRIEF_DAYS = 7;
// Beyond this many open tasks, or done ones, a list stops being a reminder and becomes the plan again.
export const BRIEF_NEXT = 10;
export const BRIEF_DONE = 15;
// A note runs to 100 000 characters; the brief carries its opening, on one line.
export const BRIEF_NOTE = 280;

export type BriefInput = {
  name: string;
  note: string | null;
  // The phase today falls in, as `phaseOn` finds it.
  phase: { name: string; endsOn: string } | null;
  // Every task of the goal: the done list is read from it.
  tasks: Task[];
  // What is still open this month, in the order the screen lists it (`planMonthList`, carried ones first).
  open: string[];
  // This month's line, its figures already worded in the goal's unit; null without a planned amount.
  month: { reached: string; planned: string } | null;
  today: string;
  // The commitments marked on a day (day, commitment's name): done too, though no task carries them.
  marked?: { day: string; name: string }[];
};

// One line however the note was typed, cut on a whole character so an emoji never splits.
function oneLine(text: string | null | undefined): string | null {
  // A whole note can be 100 000 characters: the cut comes first, with room for the spaces it may fold.
  const flat = (text ?? "").slice(0, BRIEF_NOTE * 4).replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  const chars = Array.from(flat);
  return chars.length > BRIEF_NOTE ? `${chars.slice(0, BRIEF_NOTE).join("").trimEnd()}…` : flat;
}

/**
 * What a new Claude chat needs to pick a goal up where the person left it: the goal, its note and phase,
 * what was done over the last days with each task's note, and what is still open this month.
 */
export function claudeBrief(input: BriefInput): string {
  const { name, note, phase, tasks, open, month, today, marked = [] } = input;
  const from = addDaysToCivilDate(today, -(BRIEF_DAYS - 1));
  const done = tasks
    .filter((task): task is Task & { doneOn: string } => task.doneOn !== null && task.doneOn >= from && task.doneOn <= today)
    .sort((a, b) => a.doneOn.localeCompare(b.doneOn));
  const habits = marked.filter((fact) => fact.day >= from && fact.day <= today);
  const next = open.slice(0, BRIEF_NEXT);

  const lines = [translate("goal.claude.intro", { goal: name })];
  const goalNote = oneLine(note);
  if (goalNote) lines.push(translate("goal.claude.note", { note: goalNote }));
  if (phase) lines.push(translate("goal.claude.phase", { phase: phase.name.trim().replace(/[.,;:!\s]+$/, ""), until: civilDayMonthShort(phase.endsOn) }));
  if (month) lines.push(translate("goal.claude.monthPlan", month));
  lines.push("");
  if (done.length === 0 && habits.length === 0) lines.push(translate("goal.claude.noneDone"));
  else {
    lines.push(translate("goal.claude.doneTitle"));
    // The latest days win when the week was busier than the list holds.
    const shown = done.slice(-BRIEF_DONE);
    if (done.length > shown.length) lines.push(translate("goal.claude.moreDone", { count: done.length - shown.length }));
    for (const task of shown) {
      const values = { day: civilDayMonthShort(task.doneOn), task: task.name };
      const taskNote = oneLine(task.note);
      lines.push(
        taskNote
          ? translate("goal.claude.doneLineNote", { ...values, note: taskNote })
          : translate("goal.claude.doneLine", values),
      );
    }
  }
  if (habits.length > 0) {
    // One line a day and commitment: the same fact written twice reads once.
    const seen = new Set<string>();
    for (const fact of habits.sort((a, b) => a.day.localeCompare(b.day))) {
      const key = `${fact.day}|${fact.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(translate("goal.claude.doneLine", { day: civilDayMonthShort(fact.day), task: fact.name }));
    }
  }
  lines.push("");
  if (next.length === 0) lines.push(translate("goal.claude.noneNext"));
  else {
    lines.push(translate("goal.claude.nextTitle"));
    for (const task of next) lines.push(translate("goal.claude.nextLine", { task }));
  }
  lines.push("", translate("goal.claude.ask", { today: civilDayMonthShort(today) }));

  return lines.join("\n");
}

// A new claude.ai chat with the brief already typed in its box; the person reads it and sends it.
export const CLAUDE_NEW_CHAT = "https://claude.ai/new?q=";

export function claudeChatHref(brief: string): string {
  return `${CLAUDE_NEW_CHAT}${encodeURIComponent(brief)}`;
}
