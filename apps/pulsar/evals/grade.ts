import type { ChatAnswer } from "@/lib/chat/model";
import type { PlanReading } from "@/lib/import/model";

// Deterministic graders: a returned string is one failure, an empty list is a pass.

const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
export const matches = (pattern: RegExp, text: string): boolean => pattern.test(text) || pattern.test(fold(text));

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// ---------------------------------------------------------------- import

// An amount in the plan's own unit: `h` means the plan wrote hours, and a goal measured in
// minutes may carry the same figure times sixty.
export type Figure = [amount: number, unit?: "h"];

export type GoalExpect = {
  name: RegExp;
  unit?: RegExp;
  parent?: RegExp | null;
  horizon?: string | null;
  months?: Array<[month: string, ...Figure]>;
  tasks?: RegExp[];
  estimates?: Array<[task: RegExp, ...Figure]>;
  commitments?: Array<{ name: RegExp; kind?: string; n?: number }>;
  rules?: number[];
  rate?: { amount: number; unit?: string; per?: "week" | "month" };
};

export type ImportExpect = {
  status?: "ok" | "empty";
  goals?: GoalExpect[];
  minGoals?: number;
  maxGoals?: number;
  maxDepth?: number;
  // Source lines holding these fragments must end inside some `src`.
  mustCover?: string[];
  // Share of non-blank lines that may sit in no part (context the plan is not).
  uncoveredMax?: number;
  // Figures the text states in words or derives, beyond its digits.
  allowedNumbers?: number[];
  noEstimates?: boolean;
};

type Raw = Extract<PlanReading, { status: "ok" }>["raw"];
type RawGoal = Raw["goals"][number];
type Range = { from: number; to: number };

const taskNodes = (goal: RawGoal) => goal.tasks.flatMap((task) => [task, ...task.children]);

function figureMatches(found: number, unit: string | null | undefined, [amount, hours]: Figure): boolean {
  if (found === amount) return true;
  return hours === "h" && /min/i.test(unit ?? "") && found === amount * 60;
}

function sourceNumbers(text: string): Set<number> {
  const out = new Set<number>();
  for (const token of text.match(/\d+(?:[.,]\d+)?/g) ?? []) {
    const value = Number(token.replace(",", "."));
    out.add(Math.round(value));
    out.add(Math.floor(value));
    out.add(Math.round(value * 60));
    for (const part of token.split(/[.,]/)) out.add(Number(part));
  }
  return out;
}

function coverage(raw: Raw): Set<number> {
  const covered = new Set<number>();
  const take = (ranges: Range[]) => {
    for (const { from, to } of ranges) for (let line = from; line <= to; line++) covered.add(line);
  };
  for (const goal of raw.goals) {
    take(goal.src);
    take(goal.noteSrc);
    for (const part of [...goal.phases, ...goal.months, ...goal.commitments]) take(part.src);
    for (const task of taskNodes(goal)) {
      take(task.src);
      take(task.noteSrc);
    }
  }
  return covered;
}

function depthOf(goal: RawGoal, byKey: Map<string, RawGoal>): number {
  let depth = 1;
  let at: RawGoal | undefined = goal;
  const seen = new Set<string>();
  while (at && at.parent !== null && !seen.has(at.key)) {
    seen.add(at.key);
    at = byKey.get(at.parent);
    depth += 1;
  }
  return depth;
}

function gradeGoal(expect: GoalExpect, raw: Raw): string[] {
  const label = String(expect.name);
  const goal = raw.goals.find((candidate) => matches(expect.name, candidate.name));
  if (!goal) return [`no goal named ${label}`];
  const fails: string[] = [];
  const unit = goal.measure?.unit;
  if (expect.unit && !(goal.measure && matches(expect.unit, `${goal.measure.name} ${goal.measure.unit}`))) {
    fails.push(`${label}: measure ${JSON.stringify(goal.measure)} is not ${expect.unit}`);
  }
  if (expect.parent !== undefined) {
    const parent = goal.parent === null ? null : raw.goals.find((candidate) => candidate.key === goal.parent);
    if (expect.parent === null ? parent !== null : !parent || !matches(expect.parent, parent.name)) {
      fails.push(`${label}: parent is ${parent ? parent.name : "none"}`);
    }
  }
  if (expect.horizon !== undefined && goal.horizon !== expect.horizon) {
    fails.push(`${label}: horizon ${goal.horizon} is not ${expect.horizon}`);
  }
  for (const [month, ...figure] of expect.months ?? []) {
    const row = goal.months.find((candidate) => candidate.month === month);
    if (!row) fails.push(`${label}: month ${month} missing`);
    else if (!figureMatches(row.amount, unit, figure as Figure)) fails.push(`${label}: ${month} is ${row.amount}, not ${figure[0]}`);
  }
  for (const pattern of expect.tasks ?? []) {
    if (!taskNodes(goal).some((task) => matches(pattern, task.name))) fails.push(`${label}: no task ${pattern}`);
  }
  for (const [pattern, ...figure] of expect.estimates ?? []) {
    const task = taskNodes(goal).find((candidate) => matches(pattern, candidate.name));
    if (!task) fails.push(`${label}: no task ${pattern}`);
    else if (task.estimate === null || !figureMatches(task.estimate, unit, figure as Figure)) {
      fails.push(`${label}: task ${pattern} estimate ${task.estimate}, not ${figure[0]}`);
    }
  }
  for (const want of expect.commitments ?? []) {
    const found = goal.commitments.find((candidate) => matches(want.name, candidate.name));
    if (!found) fails.push(`${label}: no commitment ${want.name}`);
    else {
      if (want.kind && found.cadenceKind !== want.kind) fails.push(`${label}: ${found.name} is ${found.cadenceKind}, not ${want.kind}`);
      if (want.n !== undefined && found.cadenceN !== want.n) fails.push(`${label}: ${found.name} cadenceN ${found.cadenceN}, not ${want.n}`);
    }
  }
  for (const perWeek of expect.rules ?? []) {
    if (!goal.rules.some((rule) => rule.perWeek === perWeek || rule.perWeek === perWeek * 60)) fails.push(`${label}: no rule of ${perWeek} a week`);
  }
  if (expect.rate) {
    const { rate } = goal;
    if (!rate) fails.push(`${label}: no rate`);
    else {
      const amount = expect.rate.unit === "hours" && rate.unit === "minutes" ? rate.amount / 60 : rate.amount;
      if (amount !== expect.rate.amount) fails.push(`${label}: rate ${rate.amount} ${rate.unit}`);
      if (expect.rate.per && rate.per !== expect.rate.per) fails.push(`${label}: rate per ${rate.per}`);
    }
  }
  return fails;
}

export function gradeImport(reading: PlanReading, text: string, expect: ImportExpect): string[] {
  const want = expect.status ?? "ok";
  if (want === "empty") return reading.status === "empty" ? [] : [`expected no plan, got ${reading.status}`];
  if (reading.status !== "ok") return [`status ${reading.status}`];
  const { raw } = reading;
  const fails: string[] = [];

  const byKey = new Map(raw.goals.map((goal) => [goal.key, goal] as const));
  if (byKey.size !== raw.goals.length) fails.push("duplicate goal keys");
  for (const goal of raw.goals) {
    if (goal.parent !== null && !byKey.has(goal.parent)) fails.push(`goal ${goal.name}: parent ${goal.parent} does not exist`);
    if (goal.horizon !== null && !DAY.test(goal.horizon)) fails.push(`goal ${goal.name}: horizon ${goal.horizon} is no date`);
    for (const row of goal.months) if (!MONTH.test(row.month)) fails.push(`goal ${goal.name}: month ${row.month}`);
    for (const task of goal.tasks) {
      if (!MONTH.test(task.month)) fails.push(`task ${task.name}: month ${task.month}`);
      if (task.children.length > 0 && task.estimate !== null) fails.push(`task ${task.name}: hours on a task with sub-tasks`);
    }
    for (const phase of goal.phases) if (!DAY.test(phase.startsOn) || !DAY.test(phase.endsOn)) fails.push(`phase ${phase.aim}: dates`);
    if (depthOf(goal, byKey) > (expect.maxDepth ?? 3)) fails.push(`goal ${goal.name}: deeper than ${expect.maxDepth ?? 3}`);
  }
  if (expect.minGoals !== undefined && raw.goals.length < expect.minGoals) fails.push(`${raw.goals.length} goals, at least ${expect.minGoals}`);
  if (expect.maxGoals !== undefined && raw.goals.length > expect.maxGoals) fails.push(`${raw.goals.length} goals, at most ${expect.maxGoals}`);
  for (const goal of expect.goals ?? []) fails.push(...gradeGoal(goal, raw));

  const known = sourceNumbers(text);
  for (const extra of expect.allowedNumbers ?? []) known.add(extra);
  for (const goal of raw.goals) {
    const figures: Array<[string, number | null]> = [
      ...goal.months.map((row) => [`${goal.name} ${row.month}`, row.amount] as [string, number]),
      ...goal.rules.map((rule) => [`${goal.name} rule`, rule.perWeek] as [string, number]),
      ...goal.commitments.flatMap((c) => [[`${c.name} target`, c.targetQuantity], [`${c.name} cadence`, c.cadenceN]] as Array<[string, number | null]>),
      ...taskNodes(goal).map((task) => [`task ${task.name}`, task.estimate] as [string, number | null]),
    ];
    if (goal.rate) figures.push([`${goal.name} rate`, goal.rate.amount]);
    const monthSums = new Map<string, number>();
    for (const task of goal.tasks) {
      const sum = task.children.length > 0 ? task.children.reduce((s, c) => s + (c.estimate ?? 0), 0) : (task.estimate ?? 0);
      monthSums.set(task.month, (monthSums.get(task.month) ?? 0) + sum);
    }
    const total = [...monthSums.values()].reduce((s, v) => s + v, 0);
    for (const [label, value] of figures) {
      if (value === null || known.has(value)) continue;
      if (label.startsWith("task ") && goal.tasks.some((t) => t.children.length > 0 && label === `task ${t.name}`)) continue;
      if ([...monthSums.values()].includes(value) || value === total) continue;
      fails.push(`invented figure ${value} at ${label}`);
    }
    if (expect.noEstimates && taskNodes(goal).some((task) => task.estimate !== null)) fails.push(`${goal.name}: estimates in a plan with none`);
  }
  if (expect.noEstimates && raw.goals.some((goal) => goal.months.length > 0 || goal.rate !== null)) fails.push("months or rate in a plan with no figures");

  const lines = text.split(/\r?\n/);
  const covered = coverage(raw);
  const blank = (index: number) => lines[index].trim() === "";
  const lost = lines.map((_, index) => index).filter((index) => !blank(index) && !covered.has(index + 1));
  const total = lines.filter((_, index) => !blank(index)).length;
  if (lost.length / Math.max(total, 1) > (expect.uncoveredMax ?? 0.25)) {
    fails.push(`${lost.length} of ${total} lines in no part (lines ${lost.slice(0, 8).map((i) => i + 1).join(",")})`);
  }
  for (const fragment of expect.mustCover ?? []) {
    const index = lines.findIndex((line) => line.includes(fragment));
    if (index < 0) fails.push(`case bug: no line holds «${fragment}»`);
    else if (!covered.has(index + 1)) fails.push(`line ${index + 1} «${fragment}» lost (RP-96)`);
  }
  return fails;
}

// ------------------------------------------------------------------ chat

export type ChatExpect = {
  // Reads the model must make.
  reads?: string[];
  // The writes proposed, by tool, in any order; `check` returns a failure or null.
  changes?: Array<{ tool: string; check?: (input: Record<string, unknown>) => string | null }>;
  noChanges?: boolean;
  replyHas?: RegExp[];
  replyLacks?: RegExp[];
  // A change of this tool must not appear, whatever else does.
  never?: Array<{ tool: string; when?: (input: Record<string, unknown>) => boolean }>;
};

const ID_KEYS = /(^|_)id$/;
const CLAIMS_DONE = /\bya (qued[oó]|lo (hice|cambi[eé]|marqu[eé]|cre[eé]|agregu[eé]|renombr[eé]))|\bhecho,? (ya )?(est[aá]|qued[oó])/i;

export function gradeChat(answer: ChatAnswer, reads: string[], knownIds: ReadonlySet<string>, expect: ChatExpect): string[] {
  if (answer.status !== "ok") return [`status ${answer.status}`];
  const fails: string[] = [];
  const { reply, changes } = answer;

  for (const tool of expect.reads ?? []) if (!reads.includes(tool)) fails.push(`never read with ${tool} (read: ${reads.join(",") || "nothing"})`);
  if (CLAIMS_DONE.test(reply)) fails.push("the reply says a change is done; it is only proposed");
  for (const pattern of expect.replyHas ?? []) if (!matches(pattern, reply)) fails.push(`reply lacks ${pattern}`);
  for (const pattern of expect.replyLacks ?? []) if (matches(pattern, reply)) fails.push(`reply has ${pattern}`);

  for (const change of changes) {
    for (const [key, value] of Object.entries(change.input)) {
      if (ID_KEYS.test(key) && typeof value === "string" && !knownIds.has(value)) fails.push(`${change.tool}: invented ${key} ${value}`);
      if (/month$/.test(key) && typeof value === "string" && !MONTH.test(value)) fails.push(`${change.tool}: ${key} ${value} is no YYYY-MM`);
      if (/^(day|horizon|starts_on|ends_on)$/.test(key) && typeof value === "string" && !DAY.test(value)) fails.push(`${change.tool}: ${key} ${value} is no YYYY-MM-DD`);
    }
  }
  for (const rule of expect.never ?? []) {
    if (changes.some((change) => change.tool === rule.tool && (rule.when?.(change.input) ?? true))) fails.push(`proposed ${rule.tool}`);
  }
  if (expect.noChanges && changes.length > 0) fails.push(`proposed ${changes.map((c) => c.tool).join(",")}, expected nothing`);
  if (expect.changes) {
    const left = [...changes];
    for (const want of expect.changes) {
      const at = left.findIndex((change) => change.tool === want.tool && (want.check?.(change.input) ?? null) === null);
      if (at >= 0) left.splice(at, 1);
      else {
        const same = left.find((change) => change.tool === want.tool);
        fails.push(same ? `${want.tool}: ${want.check?.(same.input)}` : `no ${want.tool} proposed (got ${changes.map((c) => c.tool).join(",") || "none"})`);
      }
    }
    if (left.length > 0) fails.push(`unexpected ${left.map((c) => c.tool).join(",")}`);
  }
  return fails;
}
