// The 25 messages the chat bench sends, mirroring docs/goallog/CHAT.md. A value written "$goal.english" is a
// key of SEED; run.ts swaps it for the id the seeded person holds before the answer is scored.

export type Arg = string | number | boolean | null | { includes: string };

export type Expected =
  | { kind: "proposal"; changes: { tool: string; args: Record<string, Arg> }[] }
  | { kind: "reply"; facts: string[] }
  | { kind: "none" };

export type TaskGroup = "question" | "single" | "two-step" | "refusal" | "missing";

export type BenchTask = { id: string; group: TaskGroup; message: string; expected: Expected };

// Time amounts are minutes (mcp.json): 2 h is 120, 25 h is 1500, 10 h is 600, 3 h is 180.
// What each benched person must hold. The main session seeds it (seed-goal.ts) and hands run.ts the ids.
// Run on a day of 2026-10: the messages name 2026 months without a year.
export const SEED = {
  "goal.english": "goal «Inglés», rhythm 20 h a month, measure hours, with the commitment com.class",
  "goal.fitness": "goal «Fitness», no measure, no horizon",
  "goal.house": "goal «Casa», measure hours (stored in minutes), no rhythm, no horizon",
  "com.class": "commitment «Clase de inglés», weekdays, tap, of goal.english",
  "task.maze": "one-off «Maze» in goal.english, planned in the plan for 2026-10, not fixed",
  "task.report": "one-off «Informe» with no day, no goal",
  "task.doc": "task «Documento» in goal.english, fixed to 2026-11",
  "phase.two": "phase 2 of goal.english, 2026-11-01 to 2026-11-30",
} as const;

const expectChanges = (...changes: { tool: string; args: Record<string, Arg> }[]): Expected => ({
  kind: "proposal",
  changes,
});

export const TASKS: readonly BenchTask[] = [
  { id: "q-today", group: "question", message: "¿Qué me toca hoy?", expected: { kind: "reply", facts: ["Clase de inglés"] } },
  {
    id: "q-month",
    group: "question",
    message: "¿Cómo voy en noviembre con Inglés?",
    expected: { kind: "reply", facts: ["Documento"] },
  },
  { id: "q-goal", group: "question", message: "¿Cómo va la meta de Inglés?", expected: { kind: "reply", facts: ["Inglés"] } },
  { id: "q-goals", group: "question", message: "¿Qué metas tengo?", expected: { kind: "reply", facts: ["Inglés", "Fitness", "Casa"] } },
  { id: "q-report", group: "question", message: "¿Cómo voy este mes en general?", expected: { kind: "reply", facts: ["Inglés"] } },
  {
    id: "q-loose",
    group: "question",
    message: "¿Qué tareas tengo sueltas esperando un día?",
    expected: { kind: "reply", facts: ["Informe"] },
  },

  {
    id: "s-fix",
    group: "single",
    message: "Pasa la tarea de Maze a noviembre",
    expected: expectChanges({ tool: "fix_task", args: { one_off_id: "$task.maze", month: "2026-11" } }),
  },
  {
    id: "s-schedule",
    group: "single",
    message: "Pon el Informe para el 2026-10-27",
    expected: expectChanges({ tool: "schedule_task", args: { one_off_id: "$task.report", day: "2026-10-27" } }),
  },
  {
    id: "s-create-task",
    group: "single",
    message: "Agrega la tarea «Pasaporte» a Casa, de 2 horas",
    expected: expectChanges({ tool: "create_task", args: { name: { includes: "Pasaporte" }, goal_id: "$goal.house", estimate: 120 } }),
  },
  {
    id: "s-declare",
    group: "single",
    message: "Hice la clase de inglés hoy",
    expected: expectChanges({ tool: "declare_fact", args: { commitment_id: "$com.class" } }),
  },
  {
    id: "s-complete",
    group: "single",
    message: "Ya terminé el Informe",
    expected: expectChanges({ tool: "complete_task", args: { one_off_id: "$task.report" } }),
  },
  {
    id: "s-rename",
    group: "single",
    message: "Renombra la meta Fitness a Salud",
    expected: expectChanges({ tool: "rename_goal", args: { goal_id: "$goal.fitness", name: "Salud" } }),
  },
  {
    id: "s-horizon",
    group: "single",
    message: "Mueve el final de Casa al 2027-03-31",
    expected: expectChanges({ tool: "move_horizon", args: { goal_id: "$goal.house", horizon: "2027-03-31" } }),
  },
  {
    id: "s-month-amount",
    group: "single",
    message: "Ponle 25 horas a Inglés en noviembre",
    expected: expectChanges({ tool: "set_month_amount", args: { goal_id: "$goal.english", month: "2026-11", amount: 1500 } }),
  },
  {
    id: "s-rhythm",
    group: "single",
    message: "El ritmo de Casa es de 10 horas al mes",
    expected: expectChanges({ tool: "set_rhythm", args: { goal_id: "$goal.house", amount: 600 } }),
  },
  {
    id: "s-note",
    group: "single",
    message: "Anota en el Informe: entregar con la portada nueva",
    expected: expectChanges({ tool: "set_task_note", args: { one_off_id: "$task.report", note: { includes: "portada" } } }),
  },

  {
    id: "t-create-goal",
    group: "two-step",
    message: "Crea la meta Viaje y agrégale una tarea «Reservar vuelo»",
    expected: expectChanges({ tool: "create_goal", args: { name: { includes: "Viaje" } } }),
  },
  {
    id: "t-fix-note",
    group: "two-step",
    message: "Pasa Maze a noviembre y anota que depende del Informe",
    expected: expectChanges(
      { tool: "fix_task", args: { one_off_id: "$task.maze", month: "2026-11" } },
      { tool: "set_task_note", args: { one_off_id: "$task.maze", note: { includes: "Informe" } } },
    ),
  },
  {
    id: "t-rename-horizon",
    group: "two-step",
    message: "Renombra Casa a Hogar y mueve su final al 2027-06-30",
    expected: expectChanges(
      { tool: "rename_goal", args: { goal_id: "$goal.house", name: "Hogar" } },
      { tool: "move_horizon", args: { goal_id: "$goal.house", horizon: "2027-06-30" } },
    ),
  },

  { id: "r-delete", group: "refusal", message: "Borra la tarea Maze", expected: { kind: "none" } },
  { id: "r-archive", group: "refusal", message: "Archiva la meta Fitness", expected: { kind: "none" } },
  { id: "r-undo", group: "refusal", message: "Desmarca la clase de inglés de ayer", expected: { kind: "none" } },

  {
    id: "m-estimate",
    group: "single",
    message: "Ponle 3 horas de estimación a Maze",
    expected: expectChanges({ tool: "set_task_estimate", args: { one_off_id: "$task.maze", estimate: 180 } }),
  },
  {
    id: "m-phase",
    group: "single",
    message: "Cambia la fase 2 de Inglés para que termine el 2026-12-15",
    expected: expectChanges({ tool: "edit_phase", args: { phase_id: "$phase.two", ends_on: "2026-12-15" } }),
  },
  { id: "m-move-task", group: "missing", message: "Pasa la tarea Maze a la meta Fitness", expected: { kind: "none" } },
];
