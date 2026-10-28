import { createTranslator } from "next-intl";

import goal from "../../messages/es/goal.json";
import { monthOf } from "../plan/months";
import { monthOfTask, type Task } from "../plan/carry";
import { civilDateToDate, civilDayMonthShort, dateToCivilDate } from "../zone";

// Read straight from the catalogue: the brief is built where the goal is drawn, outside any request.
const translate = createTranslator({ locale: "es", messages: { goal } });

// The days a brief looks back over, today included: the stretch a study plan's «día 1, día 2» lives in.
export const BRIEF_DAYS = 7;
// Beyond this many open tasks the list stops being a reminder and becomes the plan again.
export const BRIEF_NEXT = 10;
// A chat link longer than this is cut by some browsers; the brief keeps well under it.
const BRIEF_MAX = 6000;

export type BriefInput = {
  name: string;
  note: string | null;
  phases: { name: string; startsOn: string; endsOn: string }[];
  tasks: Task[];
  // This month's line, its figures already worded in the goal's unit; null without a planned amount.
  month: { reached: string; planned: string } | null;
  today: string;
};

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

/**
 * What a new Claude chat needs to pick a goal up where the person left it: the goal, its note and phase,
 * what was done over the last days with each task's note, and what is still open this month.
 */
export function claudeBrief(input: BriefInput): string {
  const { name, note, phases, tasks, month, today } = input;
  const from = shift(today, -(BRIEF_DAYS - 1));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const parentOf = (task: Task) => (task.parentId === null ? null : (byId.get(task.parentId) ?? null));
  const isParent = new Set(tasks.map((task) => task.parentId).filter((id): id is string => id !== null));

  const done = tasks
    .filter((task) => task.doneOn !== null && task.doneOn >= from && task.doneOn <= today)
    .sort((a, b) => (a.doneOn as string).localeCompare(b.doneOn as string));
  const thisMonth = monthOf(today);
  const next = tasks
    .filter((task) => task.doneOn === null && !isParent.has(task.id) && monthOfTask(task, parentOf(task)) === thisMonth)
    .slice(0, BRIEF_NEXT);
  const phase = phases.find((p) => p.startsOn <= today && today <= p.endsOn);

  const lines = [translate("goal.claude.intro", { goal: name })];
  if (note) lines.push(translate("goal.claude.note", { note: note.trim() }));
  if (phase) lines.push(translate("goal.claude.phase", { phase: phase.name, until: civilDayMonthShort(phase.endsOn) }));
  if (month) lines.push(translate("goal.claude.monthPlan", month));
  lines.push("");
  if (done.length === 0) lines.push(translate("goal.claude.noneDone"));
  else {
    lines.push(translate("goal.claude.doneTitle"));
    for (const task of done) {
      const values = { day: civilDayMonthShort(task.doneOn as string), task: task.name };
      lines.push(
        task.note
          ? translate("goal.claude.doneLineNote", { ...values, note: task.note.trim() })
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

  const brief = lines.join("\n");
  return brief.length > BRIEF_MAX ? brief.slice(0, BRIEF_MAX) : brief;
}

// A new claude.ai chat with the brief already typed in its box; the person reads it and sends it.
export function claudeChatHref(brief: string): string {
  return `https://claude.ai/new?q=${encodeURIComponent(brief)}`;
}
