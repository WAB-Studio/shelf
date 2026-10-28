import { createTranslator } from "next-intl";

import goal from "../../messages/es/goal.json";
import { monthOf } from "../plan/months";
import { monthOfTask, type Task } from "../plan/carry";
import { shiftDay } from "../validation/fact";
import { civilDayMonthShort } from "../zone";

// Read straight from the catalogue: the brief is built where the goal is drawn, outside any request.
const translate = createTranslator({ locale: "es", messages: { goal } });

// The days a brief looks back over, today included: the stretch a study plan's «día 1, día 2» lives in.
export const BRIEF_DAYS = 7;
// Beyond this many open tasks, or done ones, a list stops being a reminder and becomes the plan again.
export const BRIEF_NEXT = 10;
export const BRIEF_DONE = 15;
// A note runs to 100 000 characters; the brief carries its opening, on one line.
export const BRIEF_NOTE = 280;

export type BriefInput = {
  name: string;
  note: string | null;
  phases: { name: string; startsOn: string; endsOn: string }[];
  tasks: Task[];
  // This month's line, its figures already worded in the goal's unit; null without a planned amount.
  month: { reached: string; planned: string } | null;
  today: string;
};

// One line however the note was typed, cut on a whole character so an emoji never splits.
function oneLine(text: string | null | undefined): string | null {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  const chars = Array.from(flat);
  return chars.length > BRIEF_NOTE ? `${chars.slice(0, BRIEF_NOTE).join("").trimEnd()}…` : flat;
}

/**
 * What a new Claude chat needs to pick a goal up where the person left it: the goal, its note and phase,
 * what was done over the last days with each task's note, and what is still open this month, carried ones included.
 */
export function claudeBrief(input: BriefInput): string {
  const { name, note, phases, tasks, month, today } = input;
  const from = shiftDay(today, -(BRIEF_DAYS - 1));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const parentOf = (task: Task) => (task.parentId === null ? null : (byId.get(task.parentId) ?? null));
  const isParent = new Set(tasks.map((task) => task.parentId).filter((id): id is string => id !== null));

  const done = tasks
    .filter((task) => task.doneOn !== null && task.doneOn >= from && task.doneOn <= today)
    .sort((a, b) => (a.doneOn as string).localeCompare(b.doneOn as string));
  const thisMonth = monthOf(today);
  const next = tasks
    .filter((task) => {
      if (task.doneOn !== null || isParent.has(task.id)) return false;
      const own = monthOfTask(task, parentOf(task));
      return own !== null && own <= thisMonth;
    })
    .slice(0, BRIEF_NEXT);
  const phase = phases.find((p) => p.startsOn <= today && today <= p.endsOn);

  const lines = [translate("goal.claude.intro", { goal: name })];
  const goalNote = oneLine(note);
  if (goalNote) lines.push(translate("goal.claude.note", { note: goalNote }));
  if (phase) lines.push(translate("goal.claude.phase", { phase: phase.name, until: civilDayMonthShort(phase.endsOn) }));
  if (month) lines.push(translate("goal.claude.monthPlan", month));
  lines.push("");
  if (done.length === 0) lines.push(translate("goal.claude.noneDone"));
  else {
    lines.push(translate("goal.claude.doneTitle"));
    // The latest days win when the week was busier than the list holds.
    const shown = done.slice(-BRIEF_DONE);
    if (done.length > shown.length) lines.push(translate("goal.claude.moreDone", { count: done.length - shown.length }));
    for (const task of shown) {
      const values = { day: civilDayMonthShort(task.doneOn as string), task: task.name };
      const taskNote = oneLine(task.note);
      lines.push(
        taskNote
          ? translate("goal.claude.doneLineNote", { ...values, note: taskNote })
          : translate("goal.claude.doneLine", values),
      );
    }
  }
  lines.push("");
  if (next.length === 0) lines.push(translate("goal.claude.noneNext"));
  else {
    lines.push(translate("goal.claude.nextTitle"));
    for (const task of next) lines.push(translate("goal.claude.nextLine", { task: task.name }));
  }
  lines.push("", translate("goal.claude.ask", { today: civilDayMonthShort(today) }));

  return lines.join("\n");
}

// A new claude.ai chat with the brief already typed in its box; the person reads it and sends it.
export function claudeChatHref(brief: string): string {
  return `https://claude.ai/new?q=${encodeURIComponent(brief)}`;
}
