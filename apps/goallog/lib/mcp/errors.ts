import { createTranslator } from "next-intl";

import chat from "../../messages/es/chat.json";
import connections from "../../messages/es/connections.json";
import day from "../../messages/es/day.json";
import goal from "../../messages/es/goal.json";
import importMessages from "../../messages/es/import.json";
import mcp from "../../messages/es/mcp.json";
import month from "../../messages/es/month.json";
import oauth from "../../messages/es/oauth.json";
import plan from "../../messages/es/plan.json";
import roadmap from "../../messages/es/roadmap.json";
import tree from "../../messages/es/tree.json";
import units from "../../messages/es/units.json";
import { formatCount, formatQuantity } from "../units/time";
import { civilDayMonthShort } from "../zone";

// The request config belongs to a request; a tool answers outside one, so the
// catalogue is read here directly, in the one locale there is.
const messages = { chat, connections, day, goal, import: importMessages, mcp, month, oauth, plan, roadmap, tree };
const translate = createTranslator({ locale: "es", messages });
// The words `shape.ts` reads a time in, so a refusal's quantity reads like the tool's amounts.
const unitWords = createTranslator({ locale: "es", messages: { units } });
const WORDS = {
  h: (h: string) => unitWords("units.h", { h }),
  min: (min: string) => unitWords("units.min", { min }),
  join: (h: string, min: string) => unitWords("units.join", { h, min }),
};

const KEY = /^[A-Za-z]+\.errors\.[A-Za-z]+$/;

function hasSentence(key: string): boolean {
  if (!KEY.test(key)) return false;
  const [namespace, ...path] = key.split(".");
  let node: unknown = (messages as Record<string, unknown>)[namespace];
  for (const part of path) {
    if (typeof node !== "object" || node === null) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string";
}

function overrideOf(tool: string, key: string): string | undefined {
  const table = mcp.errors.byTool as Record<string, string>;
  return Object.hasOwn(table, `${tool}:${key}`) ? table[`${tool}:${key}`] : Object.hasOwn(table, `*:${key}`) ? table[`*:${key}`] : undefined;
}

// What an act's error key says, in Spanish. The key survives beside it so a
// caller can branch on it; an unknown one is `mcp.errors.unknown`, never an
// echo of its input. `values` fills a refusal's `{name}`, `{date}` (RP-56) and `{quantity}`.
// With a `tool`, `mcp.errors.byTool["<tool>:<key>"]` then `["*:<key>"]` say what to fix.
export function errorOf(
  key: string,
  values?: { name?: string; date?: string; quantity?: number; unit?: string | null },
  tool?: string,
): { key: string; message: string } {
  if (!hasSentence(key)) return { key: "mcp.errors.unknown", message: translate("mcp.errors.unknown") };
  const byTool = tool === undefined ? undefined : overrideOf(tool, key);
  if (byTool !== undefined) return { key, message: byTool };
  const filled: Record<string, string> = {};
  if (values?.name !== undefined) filled.name = values.name;
  if (values?.date !== undefined) filled.date = `${civilDayMonthShort(values.date)} ${values.date.slice(0, 4)}`;
  if (values?.quantity !== undefined) {
    filled.quantity = values.unit ? formatQuantity(values.quantity, values.unit, WORDS) : formatCount(values.quantity);
  }
  const name = key as Parameters<typeof translate>[0];
  return { key, message: Object.keys(filled).length > 0 ? translate(name, filled) : translate(name) };
}
