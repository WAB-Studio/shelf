// The text goes to the model with its line number in front, so the answer can name the lines
// each part came from (`src`) and `normalize` can copy them literally.
export const splitLines = (text: string): string[] => text.split(/\r?\n/);

// `first` numbers a part of a longer text with the whole text's own line numbers.
export function numberLines(text: string, first = 1): string {
  return splitLines(text)
    .map((line, index) => `${first + index}|${line}`)
    .join("\n");
}

export const SYSTEM_PROMPT = [
  `You read a personal plan and write it into the given schema in three steps, in one answer.`,
  `Step 1, find: decide what is plan (goals, phases, months, weeks, commitments, tasks, steps, hours) and what is context ` +
    `(a diagnosis, costs, sources, a reading list). Leave the context out of the answer.`,
  `Step 2, arrange: put the plan into the app's shape under "goals", up to three levels of goals (a goal names its parent by key), ` +
    `phases, months, commitments, tasks with sub-tasks.`,
  `Step 3 is not yours: the app checks the plan against itself.`,
  `Put each task under the goal it serves: a goal with a rhythm or a month budget holds the tasks that fill it, and the goal above ` +
    `holds only the tasks that serve it as a whole.`,
  `Put every line of the plan in a part, in a note, or nowhere. Invent nothing: a figure, date or sentence the plan does not state ` +
    `is null where the schema allows it, and a part the plan does not mention is an empty array.`,
  `The text comes with a number before each line ("12|..."). Copy the line numbers a part came from into its "src", ` +
    `and the lines of its note into its "noteSrc"; never write a note's words yourself when lines exist. ` +
    `The steps of a task go in its noteSrc. For a file with no numbered lines, number its parts yourself and write a note's text in "noteText".`,
  `A name is 120 characters or fewer: shorten it and let its note keep the whole line.`,
  `Give hours only to a task with no sub-tasks. Measure a goal in hours when the plan counts hours, and write figures in the plan's own unit.`,
  `Write a rhythm the plan states as "rate": an amount, its unit and its period (per week or per month). ` +
    `Use "units" when the goal's measure is not time ("40 pages a month" with a measure in pages is 40 "units").`,
  `Write each week the plan lists as a task, with its sub-tasks where the plan writes them.`,
  `Write a rule the plan sets («3 hours of English every week») under "rules" with its quantity per week, and name it on the tasks it governs.`,
  `A commitment's cadence stays in range: times per week from 1 to 7.`,
  `Write every date as YYYY-MM-DD and every month as YYYY-MM. A task's month is null when the plan gives the task none: never invent one. A goal's horizon is the day after its last day; ` +
    `it is null when the plan sets no end for the goal. ` +
    `Keep the plan's own language for names.`,
].join(" ");

// The model has no clock: a year left out of a date is read against this line.
export function importSystemPrompt(today: string): string {
  return `${SYSTEM_PROMPT} Today is ${today} (America/Bogota); weeks run Monday to Sunday. A date the plan writes without a year is the latest such day not after today.`;
}
