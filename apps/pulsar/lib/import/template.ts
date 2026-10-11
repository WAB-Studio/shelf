import { isTimeUnit, parseTime, storedMeasure } from "@/lib/units/time";

import { GOAL_NAME_MAX } from "@/lib/validation/plan";

import { importDraftSchema, type ImportDraft } from "./draft";

// The grammar is docs/pulsar/PLANTILLA.md's.
export const TEMPLATE_HEADER = "pulsar · plantilla 1";

export type TemplateResult =
  | { matched: false }
  | { matched: true; draft: ImportDraft }
  | { matched: true; error: TemplateError; errors: TemplateError[]; cut: boolean };

// `cut` means the reading stopped at a head line or the first line, so `errors` holds that one alone.
// `expected` is a catalogue key; `unit` fills the sentence that names the goal's own.
export type TemplateError = { line: number; expected: string; unit?: string };

type Goal = ImportDraft["goals"][number];
type Commitment = Goal["commitments"][number];
type Task = Goal["tasks"][number];

// The form of a line, shown as `expected`: syntax, not prose.
const FORMS = {
  goal: "import.errors.form.goal",
  goalLong: "import.errors.form.goalLong",
  horizon: "import.errors.form.horizon",
  measure: "import.errors.form.measure",
  rhythmPlace: "import.errors.form.rhythmPlace",
  rhythmUnit: "import.errors.form.rhythmUnit",
  rhythmAmount: "import.errors.form.rhythmAmount",
  firstLine: "import.errors.form.firstLine",
  section: "import.errors.form.section",
  phase: "import.errors.form.phase",
  month: "import.errors.form.month",
  monthUnit: "import.errors.form.monthUnit",
  monthTime: "import.errors.form.monthTime",
  monthWhole: "import.errors.form.monthWhole",
  commitment: "import.errors.form.commitment",
  commitmentUnit: "import.errors.form.commitmentUnit",
  commitmentTime: "import.errors.form.commitmentTime",
  estimateNotTime: "import.errors.estimateNotTime",
  task: "import.errors.form.task",
  child: "import.errors.form.child",
  note: "import.errors.form.note",
} as const;

const SECTIONS = { "## Fases": "phases", "## Meses": "months", "## Compromisos": "commitments", "## Tareas": "tasks" } as const;
type Section = (typeof SECTIONS)[keyof typeof SECTIONS];

const WEEKDAYS: Record<string, number> = {
  lunes: 1, martes: 2, miércoles: 3, miercoles: 3, jueves: 4, viernes: 5,
  sábado: 6, sabado: 6, sábados: 6, sabados: 6, domingo: 7, domingos: 7,
};

type Cadence = Pick<Commitment, "cadenceKind" | "cadenceWeekdays" | "cadenceN">;

function parseCadence(text: string): Cadence | null {
  const t = text.trim().toLowerCase();
  if (t === "cada día" || t === "todos los días") {
    return { cadenceKind: "daily", cadenceWeekdays: null, cadenceN: null };
  }
  let m = /^cada (\d+) días?$/.exec(t);
  if (m) return { cadenceKind: "every_n_days", cadenceWeekdays: null, cadenceN: Number(m[1]) };
  m = /^(\d+) (?:vez|veces) por semana$/.exec(t);
  if (m) return { cadenceKind: "times_per_week", cadenceWeekdays: null, cadenceN: Number(m[1]) };
  m = /^(\d+) (?:vez|veces) al mes$/.exec(t);
  if (m) return { cadenceKind: "times_per_month", cadenceWeekdays: null, cadenceN: Number(m[1]) };
  const days = t.split(/\s*,\s*|\s+y\s+/).map((name) => WEEKDAYS[name]);
  if (days.length === 0 || days.some((d) => d === undefined)) return null;
  return { cadenceKind: "weekdays", cadenceWeekdays: [...new Set(days)].sort((a, b) => a - b), cadenceN: null };
}

// Minutes through `parseTime` for a time unit, else a whole number.
function parseAmount(text: string, timeUnit: boolean): number | null {
  const t = text.trim();
  if (timeUnit) return parseTime(t);
  return /^\d+$/.test(t) ? Number(t) : null;
}

// A month's amount may carry the goal's own unit: "8 km", "8km", "8 KM".
function parseUnitAmount(text: string, unit: string): number | null {
  const m = /^(\d+)\s*(\S.*)$/.exec(text.trim());
  return m && m[2].trim().toLowerCase() === unit.trim().toLowerCase() ? Number(m[1]) : null;
}

type Spot = { line: number; expected: string };

// The parts of a goal that its head lines write.
const HEAD_FIELDS = new Set(["name", "horizon", "measure", "rhythm"]);

// A head line the reader cannot take stops the reading: nothing below it is judged.
function cut(line: number, expected: string): TemplateResult {
  const error: TemplateError = { line, expected };
  return { matched: true, error, errors: [error], cut: true };
}

export function parseTemplate(text: string): TemplateResult {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.trimEnd());
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first === -1) return { matched: false };
  if (lines[first] !== TEMPLATE_HEADER) {
    return lines[first].startsWith("pulsar ·") ? cut(first + 1, FORMS.firstLine) : { matched: false };
  }

  const errors: TemplateError[] = [];
  const report = (line: number, expected: string, unit?: string) => {
    errors.push(unit === undefined ? { line, expected } : { line, expected, unit });
  };
  // One line says one thing; the list is in the text's order.
  const finish = (): TemplateResult => {
    const seen = new Set<number>();
    const list = errors.filter((e) => !seen.has(e.line) && seen.add(e.line)).sort((a, b) => a.line - b.line);
    return { matched: true, error: list[0], errors: list, cut: false };
  };
  // A goal measured in something else than time keeps no figure on a task.
  const isFigure = (text: string) => parseAmount(text, false) !== null || parseAmount(text, true) !== null;

  const goals: Goal[] = [];
  // Where each part of the draft was written, so a schema issue finds its line.
  const spots = new Map<string, Spot>();
  let section: Section | null = null;
  let lastTask: Task | null = null;
  let lastTaskPath = "";
  // Where a `nota:` line may land: the task just read, or its latest sub-task.
  let noteOwner: { depth: 2 | 4; into: { note?: string | null } } | null = null;
  let needsHorizon: { line: number } | null = null;
  // Whether the line just read was `medida:`, the only place `ritmo:` may follow.
  let afterMeasure = false;
  // After a bad `## ` line, its items are not read: each would repeat one mistake.
  let skipping = false;
  // A broken task or sub-task keeps the lines under it from being read as another's.
  let brokenTask = false;
  let brokenChild = false;

  // The topmost broken head line of the goals read so far, judged by the schema.
  const schemaHead = (): Spot | null => {
    const parsed = importDraftSchema.safeParse({ goals });
    if (parsed.success) return null;
    let top: Spot | null = null;
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String);
      const spot = HEAD_FIELDS.has(path[2]) ? spots.get(path.slice(0, 3).join(".")) : undefined;
      if (spot && (top === null || spot.line < top.line)) top = spot;
    }
    return top;
  };
  // An inline cut yields to a head line the schema saw, which always sits above it.
  const stop = (line: number, expected: string): TemplateResult => {
    const above = schemaHead();
    return above ? cut(above.line, above.expected) : cut(line, expected);
  };

  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    if (line.trim() === "") continue;
    const followsMeasure = afterMeasure;
    afterMeasure = false;
    const g = goals.length - 1;
    const goal = goals[g] as Goal | undefined;
    const at = `goals.${g}`;

    if (line.startsWith("# ")) {
      if (needsHorizon) return stop(needsHorizon.line, FORMS.horizon);
      const name = line.slice(2).trim();
      goals.push({ name, horizon: "", measure: null, rhythm: null, phases: [], months: [], commitments: [], tasks: [] });
      spots.set(`goals.${g + 1}`, { line: n, expected: FORMS.goal });
      if (name.length > GOAL_NAME_MAX) spots.set(`goals.${g + 1}.name`, { line: n, expected: FORMS.goalLong });
      needsHorizon = { line: n };
      section = null;
      skipping = false;
      brokenTask = false;
      brokenChild = false;
      lastTask = null;
      noteOwner = null;
      continue;
    }
    if (!goal) return stop(n, FORMS.goal);

    if (line.startsWith("ritmo:")) {
      const minutes = goal.measure !== null && isTimeUnit(goal.measure.unit) ? /^ritmo: (.+)$/.exec(line) : null;
      const amount = followsMeasure && section === null && minutes ? parseTime(minutes[1]) : null;
      if (amount === null) {
        const expected =
          goal.measure === null || !isTimeUnit(goal.measure.unit)
            ? FORMS.rhythmUnit
            : followsMeasure && section === null ? FORMS.rhythmAmount : FORMS.rhythmPlace;
        // Only a `ritmo:` among the head lines cuts; one under a section is a stray line like any other.
        if (section === null) return stop(n, expected);
        report(n, expected);
        continue;
      }
      goal.rhythm = amount;
      spots.set(`${at}.rhythm`, { line: n, expected: FORMS.rhythmPlace });
      continue;
    }

    const note = /^( {2}| {4})nota:(?: (.*))?$/.exec(line);
    if (note) {
      const depth = note[1].length as 2 | 4;
      if (skipping || brokenTask || (brokenChild && depth === 4)) continue;
      if (section !== "tasks" || noteOwner === null || noteOwner.depth !== depth) {
        report(n, FORMS.note);
        continue;
      }
      const into = noteOwner.into;
      into.note = into.note === undefined ? (note[2] ?? "") : `${into.note}\n${note[2] ?? ""}`;
      const key = `${depth === 2 ? lastTaskPath : `${lastTaskPath}.children.${lastTask!.children.length - 1}`}.note`;
      if (!spots.has(key)) spots.set(key, { line: n, expected: FORMS.note });
      continue;
    }

    if (section === null) {
      const horizon = /^horizonte: (\S+)$/.exec(line);
      if (horizon) {
        goal.horizon = horizon[1];
        spots.set(`${at}.horizon`, { line: n, expected: FORMS.horizon });
        needsHorizon = null;
        continue;
      }
      const measure = /^medida: (.+?) · (.+)$/.exec(line);
      if (measure) {
        goal.measure = { name: measure[1].trim(), unit: storedMeasure(measure[2].trim(), null).unit };
        spots.set(`${at}.measure`, { line: n, expected: FORMS.measure });
        afterMeasure = true;
        continue;
      }
      if (line.startsWith("medida:")) return stop(n, FORMS.measure);
      if (line.startsWith("horizonte:")) return stop(n, FORMS.horizon);
    }

    if (line.startsWith("## ")) {
      const next = SECTIONS[line as keyof typeof SECTIONS];
      if (needsHorizon) return stop(needsHorizon.line, FORMS.horizon);
      lastTask = null;
      noteOwner = null;
      brokenTask = false;
      brokenChild = false;
      if (!next) {
        report(n, FORMS.section);
        section = null;
        skipping = true;
        continue;
      }
      skipping = false;
      section = next;
      continue;
    }
    if (skipping) continue;
    if (section === null) {
      if (needsHorizon) return stop(n, FORMS.horizon);
      report(n, FORMS.section);
      continue;
    }

    const timeUnit = goal.measure !== null && isTimeUnit(goal.measure.unit);

    // A sub-task sits exactly two spaces in, under its task and nowhere else.
    const child = /^ {2}- (.+)$/.exec(line);
    if (child) {
      if (brokenTask) continue;
      if (section !== "tasks" || lastTask === null) {
        report(n, FORMS.task);
        continue;
      }
      const parts = child[1].split(" · ");
      const amount = parts.length > 1 ? parseAmount(parts[0], timeUnit) : null;
      // The figure is dropped, the line is still read: its name and its notes count.
      const stray = !timeUnit && goal.measure !== null && parts.length > 1 && isFigure(parts[0]);
      if (stray) report(n, FORMS.estimateNotTime);
      else if (parts.length > 1 && amount === null) {
        report(n, FORMS.child);
        noteOwner = null;
        brokenChild = true;
        continue;
      }
      brokenChild = false;
      const index = lastTask.children.length;
      lastTask.children.push({ name: parts.length > 1 ? parts.slice(1).join(" · ").trim() : parts[0].trim(), estimate: stray ? null : amount });
      spots.set(`${lastTaskPath}.children.${index}`, { line: n, expected: FORMS.child });
      noteOwner = { depth: 4, into: lastTask.children[index] };
      continue;
    }

    const item = /^- (.+)$/.exec(line);
    if (!item) {
      report(n, section === "tasks" && /^\s+- /.test(line) ? FORMS.child : FORMS[singular(section)]);
      continue;
    }
    const parts = item[1].split(" · ").map((p) => p.trim());
    const spot = (key: string, expected: string) => spots.set(`${at}.${key}.${goal[section!].length - 1}`, { line: n, expected });

    if (section === "phases") {
      const m = /^(\d{4}-\d{2}-\d{2}) a (\d{4}-\d{2}-\d{2}) · (.+)$/.exec(item[1]);
      if (!m) {
        report(n, FORMS.phase);
        continue;
      }
      goal.phases.push({ startsOn: m[1], endsOn: m[2], aim: m[3].trim() });
      spot("phases", FORMS.phase);
    } else if (section === "months") {
      const unit = goal.measure !== null && !timeUnit ? goal.measure.unit : null;
      const amount = parts.length === 2
        ? parseAmount(parts[1], timeUnit) ?? (unit === null ? null : parseUnitAmount(parts[1], unit))
        : null;
      if (amount === null) {
        // A decimal is a whole-number mistake; a number with another unit after it is a unit mistake.
        if (unit !== null && parts.length === 2 && /^\d+[.,]\d/.test(parts[1])) report(n, FORMS.monthWhole, unit);
        else if (parts.length === 2 && /^\d+\s*\S/.test(parts[1])) {
          if (unit !== null) report(n, FORMS.monthUnit, unit);
          else if (timeUnit) report(n, FORMS.monthTime, goal.measure!.unit);
          else report(n, FORMS.month);
        } else report(n, FORMS.month);
        continue;
      }
      goal.months.push({ month: parts[0], amount });
      spot("months", FORMS.month);
    } else if (section === "commitments") {
      const cadence = parts.length === 3 ? parseCadence(parts[1]) : null;
      if (cadence === null) {
        report(n, FORMS.commitment);
        continue;
      }
      const tap = parts[2].toLowerCase() === "toque";
      const unit = goal.measure !== null && !timeUnit ? goal.measure.unit : null;
      const target = tap
        ? null
        : goal.measure
          ? parseAmount(parts[2], timeUnit) ?? (unit === null ? null : parseUnitAmount(parts[2], unit))
          : null;
      if (!tap && target === null) {
        const figure = goal.measure !== null && /^\d+\s*\S/.test(parts[2]);
        if (figure && unit !== null) report(n, FORMS.commitmentUnit, unit);
        else if (figure) report(n, FORMS.commitmentTime, goal.measure!.unit);
        else report(n, FORMS.commitment);
        continue;
      }
      goal.commitments.push({
        name: parts[0],
        ...cadence,
        satisfaction: tap ? "tap" : "quantity",
        targetQuantity: target,
        unit: tap ? null : goal.measure!.unit,
      });
      spot("commitments", FORMS.commitment);
    } else {
      const stray = !timeUnit && goal.measure !== null && parts.length > 2 && isFigure(parts[1]);
      const amount = parts.length > 2 ? parseAmount(parts[1], timeUnit) : null;
      if (parts.length < 2 || (parts.length > 2 && amount === null && !stray)) {
        report(n, FORMS.task);
        lastTask = null;
        noteOwner = null;
        brokenTask = true;
        continue;
      }
      if (stray) report(n, FORMS.estimateNotTime);
      brokenTask = false;
      brokenChild = false;
      const task: Task = {
        month: parts[0],
        name: parts.length > 2 ? parts.slice(2).join(" · ") : parts[1],
        estimate: stray ? null : amount,
        children: [],
      };
      goal.tasks.push(task);
      lastTask = task;
      noteOwner = { depth: 2, into: task };
      lastTaskPath = `${at}.tasks.${goal.tasks.length - 1}`;
      spot("tasks", FORMS.task);
    }
  }

  if (needsHorizon) return stop(needsHorizon.line, FORMS.horizon);
  if (goals.length === 0) return cut(first + 2, FORMS.goal);

  const parsed = importDraftSchema.safeParse({ goals });
  if (parsed.success && errors.length === 0) return { matched: true, draft: parsed.data };

  // The nearest enclosing item names the line: a path is walked up until a
  // part of the draft written on some line matches.
  if (!parsed.success) {
    const head: Spot[] = [];
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String);
      let spot: Spot | undefined;
      for (let k = path.length; k >= 0 && !spot; k--) spot = spots.get(path.slice(0, k).join("."));
      spot ??= spots.get(`goals.${goals.length - 1}`)!;
      if (HEAD_FIELDS.has(path[2])) head.push(spot);
      report(spot.line, spot.expected);
    }
    if (head.length > 0) {
      const [earliest] = head.sort((a, b) => a.line - b.line);
      return cut(earliest.line, earliest.expected);
    }
  }
  return finish();
}

function singular(section: Section): "phase" | "month" | "commitment" | "task" {
  return section === "phases" ? "phase" : section === "months" ? "month" : section === "commitments" ? "commitment" : "task";
}
