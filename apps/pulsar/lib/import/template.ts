import { isTimeUnit, parseTime, storedMeasure } from "@/lib/units/time";

import { GOAL_NAME_MAX, GOAL_NOTE_MAX } from "@/lib/validation/plan";

import { importDraftSchema, type ImportDraft, type ImportDraftV1, type Source, type Src } from "./draft";

// The grammar is docs/pulsar/PLANTILLA.md's.
export const TEMPLATE_HEADER = "pulsar · plantilla 2";
export const TEMPLATE_HEADER_V1 = "pulsar · plantilla 1";

// A template's goals: the version 1 file holds 12, the version 2 file 40.
const GOALS_MAX = { 1: 12, 2: 40 } as const;
const DEPTH_MAX = 2;

export type TemplateResult =
  | { matched: false }
  | { matched: true; draft: ImportDraft }
  | { matched: true; error: TemplateError; errors: TemplateError[]; cut: boolean };

// `cut` means the reading stopped at a head line or the first line, so `errors` holds that one alone.
// `expected` says what the line should have been; `unit` fills the sentence that names the goal's own.
export type TemplateError = { line: number; expected: FormCode; unit?: string };

type Goal = ImportDraftV1["goals"][number];
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
  monthReal: "import.errors.form.monthReal",
  monthUnit: "import.errors.form.monthUnit",
  monthTime: "import.errors.form.monthTime",
  monthWhole: "import.errors.form.monthWhole",
  commitment: "import.errors.form.commitment",
  commitmentUnit: "import.errors.form.commitmentUnit",
  commitmentTime: "import.errors.form.commitmentTime",
  cadenceTilde: "import.errors.form.cadenceTilde",
  cadenceWeekCap: "import.errors.form.cadenceWeekCap",
  cadenceMonthCap: "import.errors.form.cadenceMonthCap",
  rhythmTime: "import.errors.form.rhythmTime",
  taskTime: "import.errors.form.taskTime",
  taskUnit: "import.errors.form.taskUnit",
  estimateNotTime: "import.errors.estimateNotTime",
  task: "import.errors.form.task",
  child: "import.errors.form.child",
  note: "import.errors.form.note",
  inside: "inside",
  insideUnknown: "insideUnknown",
  insideTooDeep: "insideTooDeep",
  goalNameRepeated: "goalNameRepeated",
  goalNote: "goalNote",
} as const;

// The 22 forms of version 1 are catalogue keys; the five of version 2 are bare codes that 883 puts into words.
export type FormCode = (typeof FORMS)[keyof typeof FORMS];

// A month-shaped «AAAA-MM» whose month is not 01 to 12 gets its own sentence, not the form's.
const formOfMonth = (month: string, form: FormCode): FormCode => {
  const shaped = /^\d{4}-(\d{2})$/.exec(month);
  return shaped && (Number(shaped[1]) < 1 || Number(shaped[1]) > 12) ? FORMS.monthReal : form;
};

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

// A rhythm outside time: a whole number, alone or followed by the measure's unit in its plural or singular.
function parseRhythmUnits(text: string, unit: string): number | null {
  const t = text.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const plural = unit.trim().toLowerCase();
  const singular = plural.length > 1 && plural.endsWith("s") ? plural.slice(0, -1) : plural;
  const m = /^(\d+)\s+(\S.*)$/.exec(t);
  return m && [plural, singular].includes(m[2].trim().toLowerCase()) ? Number(m[1]) : null;
}

// What a cadence cannot be, told apart from one that is no cadence at all: it reads once its accents are
// put on, or it asks for more times than the week or the month has days (RP-12).
function cadenceFault(text: string): FormCode | null {
  const t = text.trim().toLowerCase();
  const accented = t.replace(/\bdia(s?)\b/, "día$1");
  if (accented !== t && parseCadence(accented) !== null) return FORMS.cadenceTilde;
  const week = /^(\d+) (?:vez|veces) por semana$/.exec(t);
  if (week && Number(week[1]) > 7) return FORMS.cadenceWeekCap;
  const month = /^(\d+) (?:vez|veces) al mes$/.exec(t);
  if (month && Number(month[1]) > 31) return FORMS.cadenceMonthCap;
  return null;
}

type Spot = { line: number; expected: FormCode };

// The parts of a goal that its head lines write.
const HEAD_FIELDS = new Set(["name", "horizon", "measure", "rhythm"]);

// A head line the reader cannot take stops the reading: nothing below it is judged.
function cut(line: number, expected: FormCode): TemplateResult {
  const error: TemplateError = { line, expected };
  return { matched: true, error, errors: [error], cut: true };
}

// Where each part of a goal was written: its line, and the `nota:` lines under it.
type TaskMeta = { line: number; noteLines: number[]; children: { line: number; noteLines: number[] }[] };
type GoalMeta = {
  parent: number | null;
  depth: number;
  insideLine: number | null;
  lines: number[];
  noteLines: number[];
  noteTexts: string[];
  phases: number[];
  months: number[];
  commitments: number[];
  tasks: TaskMeta[];
};

// Consecutive lines make one range.
function toRanges(lines: number[]): Src[] {
  const out: Src[] = [];
  for (const n of [...new Set(lines)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last.to === n - 1) last.to = n;
    else out.push({ from: n, to: n });
  }
  return out;
}

// The schema judges at most 12 goals at a time; a longer file is judged in slices, and its count is the reader's.
function validate(goals: Goal[]): { issues: { path: string[] }[]; data: Goal[] } {
  const issues: { path: string[] }[] = [];
  const data: Goal[] = [];
  for (let at = 0; at < goals.length; at += GOALS_MAX[1]) {
    const parsed = importDraftSchema.safeParse({ goals: goals.slice(at, at + GOALS_MAX[1]) });
    if (parsed.success) data.push(...parsed.data.goals);
    else {
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String);
        if (path.length < 2) continue;
        path[1] = String(Number(path[1]) + at);
        issues.push({ path });
      }
    }
  }
  return { issues, data };
}

const NOTE_LINE = /^( {2}| {4}|)nota:(?: (.*))?$/;

// The text as the coverage count reads it: a `nota:` line is its text, so a note equals the lines it came from.
export function templateSource(text: string): Source {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.trimEnd());
  return { kind: "lines", lines: lines.map((l) => { const m = NOTE_LINE.exec(l); return m ? (m[2] ?? "") : l; }) };
}

export function parseTemplate(text: string): TemplateResult {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.trimEnd());
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first === -1) return { matched: false };
  if (lines[first] !== TEMPLATE_HEADER && lines[first] !== TEMPLATE_HEADER_V1) {
    return lines[first].startsWith("pulsar ·") ? cut(first + 1, FORMS.firstLine) : { matched: false };
  }
  const version = lines[first] === TEMPLATE_HEADER ? 2 : 1;

  const errors: TemplateError[] = [];
  const report = (line: number, expected: FormCode, unit?: string) => {
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
  const metas: GoalMeta[] = [];
  const nameAt = new Map<string, number>();
  let section: Section | null = null;
  let lastTask: Task | null = null;
  let lastTaskPath = "";
  // Where a `nota:` line may land: the task just read, or its latest sub-task.
  let noteOwner: { depth: 2 | 4; into: { note?: string | null }; lines: number[] } | null = null;
  // Whether the line just read was `medida:`, the only place `ritmo:` may follow.
  let afterMeasure = false;
  // After a bad `## ` line, its items are not read: each would repeat one mistake.
  let skipping = false;
  // A broken task or sub-task keeps the lines under it from being read as another's.
  let brokenTask = false;
  let brokenChild = false;

  // The topmost broken head line of the goals read so far, judged by the schema.
  const schemaHead = (): Spot | null => {
    let top: Spot | null = null;
    for (const issue of validate(goals).issues) {
      const path = issue.path;
      const spot = HEAD_FIELDS.has(path[2]) ? spots.get(path.slice(0, 3).join(".")) : undefined;
      if (spot && (top === null || spot.line < top.line)) top = spot;
    }
    return top;
  };
  // An inline cut yields to a head line the schema saw, which always sits above it.
  const stop = (line: number, expected: FormCode): TemplateResult => {
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
    const meta = metas[g] as GoalMeta | undefined;
    const at = `goals.${g}`;

    if (line.startsWith("# ")) {
      const name = line.slice(2).trim();
      goals.push({ name, horizon: null, measure: null, rhythm: null, phases: [], months: [], commitments: [], tasks: [] });
      spots.set(`goals.${g + 1}`, { line: n, expected: FORMS.goal });
      metas.push({
        parent: null, depth: 0, insideLine: null, lines: g === -1 ? [first + 1, n] : [n], noteLines: [], noteTexts: [],
        phases: [], months: [], commitments: [], tasks: [],
      });
      if (goals.length === GOALS_MAX[version] + 1) report(n, FORMS.goal);
      if (nameAt.has(name)) report(n, FORMS.goalNameRepeated);
      else nameAt.set(name, g + 1);
      if (name.length > GOAL_NAME_MAX) spots.set(`goals.${g + 1}.name`, { line: n, expected: FORMS.goalLong });
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
      // In time the amount reads as hours or minutes; in any other unit it is a whole number of that unit.
      const given = goal.measure === null ? null : /^ritmo: (.+)$/.exec(line);
      const amount =
        followsMeasure && section === null && given && goal.measure
          ? isTimeUnit(goal.measure.unit)
            ? parseTime(given[1])
            : parseRhythmUnits(given[1], goal.measure.unit)
          : null;
      if (amount === null) {
        const expected =
          goal.measure === null
            ? FORMS.rhythmUnit
            : followsMeasure && section === null
              ? isTimeUnit(goal.measure.unit) ? FORMS.rhythmTime : FORMS.rhythmAmount
              : FORMS.rhythmPlace;
        report(n, expected);
        continue;
      }
      goal.rhythm = amount;
      meta!.lines.push(n);
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
      noteOwner.lines.push(n);
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
        meta!.lines.push(n);
        spots.set(`${at}.horizon`, { line: n, expected: FORMS.horizon });
        continue;
      }
      const measure = /^medida: (.+?) · (.+)$/.exec(line);
      if (measure) {
        goal.measure = { name: measure[1].trim(), unit: storedMeasure(measure[2].trim(), null).unit };
        spots.set(`${at}.measure`, { line: n, expected: FORMS.measure });
        meta!.lines.push(n);
        afterMeasure = true;
        continue;
      }
      if (version === 2 && !skipping) {
        const inside = line.startsWith("dentro de:") ? /^dentro de: (.+)$/.exec(line) : null;
        if (line.startsWith("dentro de:") && !inside) {
          report(n, FORMS.inside);
          meta!.lines.push(n);
          continue;
        }
        if (inside) {
          meta!.lines.push(n);
          const above = nameAt.get(inside[1].trim());
          if (meta!.insideLine !== null) report(n, FORMS.inside);
          else if (above === undefined || above >= g) report(n, FORMS.insideUnknown);
          else if (metas[above].depth >= DEPTH_MAX) report(n, FORMS.insideTooDeep);
          else {
            meta!.parent = above;
            meta!.depth = metas[above].depth + 1;
          }
          meta!.insideLine ??= n;
          continue;
        }
        const goalNote = /^nota:(?: (.*))?$/.exec(line);
        if (goalNote) {
          meta!.noteLines.push(n);
          meta!.noteTexts.push(goalNote[1] ?? "");
          continue;
        }
      }
      if (line.startsWith("medida:")) return stop(n, FORMS.measure);
      if (line.startsWith("horizonte:")) return stop(n, FORMS.horizon);
    }

    if (line.startsWith("## ")) {
      meta!.lines.push(n);
      const next = SECTIONS[line as keyof typeof SECTIONS];
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
    if (version === 2 && section !== null && /^nota:(?: .*)?$/.test(line)) {
      report(n, FORMS.note);
      continue;
    }
    if (section === null) {
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
      const childMeta = { line: n, noteLines: [] as number[] };
      meta!.tasks[meta!.tasks.length - 1].children.push(childMeta);
      spots.set(`${lastTaskPath}.children.${index}`, { line: n, expected: FORMS.child });
      noteOwner = { depth: 4, into: lastTask.children[index], lines: childMeta.noteLines };
      continue;
    }

    const item = /^- (.+)$/.exec(line);
    if (!item) {
      report(n, section === "tasks" && /^\s+- /.test(line) ? FORMS.child : FORMS[singular(section)]);
      continue;
    }
    const parts = item[1].split(" · ").map((p) => p.trim());
    const spot = (key: string, expected: FormCode) => spots.set(`${at}.${key}.${goal[section!].length - 1}`, { line: n, expected });

    if (section === "phases") {
      const m = /^(\d{4}-\d{2}-\d{2}) a (\d{4}-\d{2}-\d{2}) · (.+)$/.exec(item[1]);
      if (!m) {
        report(n, FORMS.phase);
        continue;
      }
      goal.phases.push({ startsOn: m[1], endsOn: m[2], aim: m[3].trim() });
      meta!.phases.push(n);
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
      meta!.months.push(n);
      spot("months", formOfMonth(parts[0], FORMS.month));
    } else if (section === "commitments") {
      const cadence = parts.length === 3 ? parseCadence(parts[1]) : null;
      if (cadence === null) {
        report(n, (parts.length === 3 && cadenceFault(parts[1])) || FORMS.commitment);
        continue;
      }
      const capped = parts.length === 3 ? cadenceFault(parts[1]) : null;
      if (capped) {
        report(n, capped);
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
      meta!.commitments.push(n);
      spot("commitments", FORMS.commitment);
    } else {
      const stray = !timeUnit && goal.measure !== null && parts.length > 2 && isFigure(parts[1]);
      const amount = parts.length > 2 ? parseAmount(parts[1], timeUnit) : null;
      // A figure with a unit that is not the goal's: the sentence names the unit that goes. A bare figure or the goal's own unit keeps its sentence.
      const taskUnit = goal.measure === null || parts.length < 3 ? null : goal.measure.unit;
      const figured = taskUnit !== null && amount === null && /^\d+\s*\S/.test(parts[1]) && (timeUnit || parseUnitAmount(parts[1], taskUnit) === null);
      if (figured) {
        report(n, timeUnit ? FORMS.taskTime : FORMS.taskUnit, taskUnit!);
        if (!stray) {
          lastTask = null;
          noteOwner = null;
          brokenTask = true;
          continue;
        }
      } else if (stray) report(n, FORMS.estimateNotTime);
      if (parts.length < 2 || (parts.length > 2 && amount === null && !stray && !figured)) {
        report(n, FORMS.task);
        lastTask = null;
        noteOwner = null;
        brokenTask = true;
        continue;
      }
      brokenTask = false;
      brokenChild = false;
      const task: Task = {
        month: parts[0],
        name: parts.length > 2 ? parts.slice(2).join(" · ") : parts[1],
        estimate: stray ? null : amount,
        children: [],
      };
      goal.tasks.push(task);
      const taskMeta: TaskMeta = { line: n, noteLines: [], children: [] };
      meta!.tasks.push(taskMeta);
      lastTask = task;
      noteOwner = { depth: 2, into: task, lines: taskMeta.noteLines };
      lastTaskPath = `${at}.tasks.${goal.tasks.length - 1}`;
      spot("tasks", formOfMonth(parts[0], FORMS.task));
    }
  }

  if (goals.length === 0) return cut(first + 2, FORMS.goal);

  // A goal's note is its `nota:` lines, whole and trimmed; over the ceiling it is the first line's error.
  const notes = metas.map((m) => m.noteTexts.join("\n").trim());
  notes.forEach((note, i) => {
    if (note.length > GOAL_NOTE_MAX) report(metas[i].noteLines[0], FORMS.goalNote);
  });

  const { issues, data } = validate(goals);
  if (issues.length === 0 && errors.length === 0) {
    const keys = goals.map((_, i) => `g${i + 1}`);
    const at = (lines: number[]) => toRanges(lines);
    const draft: ImportDraft = {
      version: 2,
      goals: data.map((g, i) => {
        const m = metas[i];
        return {
          key: keys[i],
          parent: m.parent === null ? null : keys[m.parent],
          name: g.name,
          horizon: g.horizon,
          measure: g.measure,
          rhythm: g.rhythm,
          note: notes[i] === "" ? null : notes[i],
          noteSrc: at(m.noteLines),
          src: at(m.lines),
          phases: g.phases.map((p, k) => ({ ...p, src: at([m.phases[k]]) })),
          months: g.months.map((p, k) => ({ ...p, src: at([m.months[k]]) })),
          commitments: g.commitments.map((p, k) => ({ ...p, src: at([m.commitments[k]]) })),
          rules: [],
          tasks: g.tasks.map((t, k) => ({
            name: t.name,
            month: t.month,
            estimate: t.estimate,
            note: t.note ?? null,
            noteSrc: at(m.tasks[k].noteLines),
            src: at([m.tasks[k].line]),
            week: null,
            rule: null,
            children: t.children.map((c, j) => ({
              name: c.name,
              estimate: c.estimate,
              note: c.note ?? null,
              noteSrc: at(m.tasks[k].children[j].noteLines),
              src: at([m.tasks[k].children[j].line]),
              rule: null,
            })),
          })),
        };
      }),
    };
    return { matched: true, draft };
  }

  // The nearest enclosing item names the line: a path is walked up until a
  // part of the draft written on some line matches.
  const head: Spot[] = [];
  for (const issue of issues) {
    const path = issue.path;
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
  return finish();
}

// The one-layer draft the callers of version 1 still read, until 885 and 886 move them to version 2.
export function parseTemplateV1(text: string): { matched: false } | { matched: true; draft: ImportDraftV1 } | Extract<TemplateResult, { error: TemplateError }> {
  const result = parseTemplate(text);
  if (!("draft" in result)) return result;
  // A part with `nota:` lines has a note, null when they were all blank; one with none has no key.
  const noted = <T extends { note: string | null; noteSrc: Src[] }>(part: T) => (part.noteSrc.length === 0 ? {} : { note: part.note });
  return {
    matched: true,
    draft: {
      goals: result.draft.goals.map((g) => ({
        name: g.name,
        horizon: g.horizon,
        measure: g.measure,
        rhythm: g.rhythm,
        phases: g.phases.map((p) => ({ aim: p.aim, startsOn: p.startsOn, endsOn: p.endsOn })),
        months: g.months.map((p) => ({ month: p.month, amount: p.amount })),
        commitments: g.commitments.map((p) => ({
          name: p.name,
          cadenceKind: p.cadenceKind,
          cadenceWeekdays: p.cadenceWeekdays,
          cadenceN: p.cadenceN,
          satisfaction: p.satisfaction,
          targetQuantity: p.targetQuantity,
          unit: p.unit,
        })),
        tasks: g.tasks.map((t) => ({
          name: t.name,
          month: t.month,
          estimate: t.estimate,
          ...noted(t),
          children: t.children.map((c) => ({ name: c.name, estimate: c.estimate, ...noted(c) })),
        })),
      })),
    },
  };
}

function singular(section: Section): "phase" | "month" | "commitment" | "task" {
  return section === "phases" ? "phase" : section === "months" ? "month" : section === "commitments" ? "commitment" : "task";
}
