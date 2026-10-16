import { doneDayOf, type PlanInput } from "./roadmap";

/**
 * The plan a goal's first rhythm leaves (RP-50): a top-level task fixed to a
 * month and not done returns to the plan, as the server's `rel` update does.
 * `released` counts those tasks.
 */
export function releasedPlan(plan: PlanInput): { plan: PlanInput; released: number } {
  let released = 0;
  const tasks = plan.tasks.map((task) => {
    if (task.parentId !== null || task.plannedMonth === null) return task;
    const children = plan.tasks.filter((other) => other.parentId === task.id);
    if (doneDayOf(task, children) !== null) return task;
    released += 1;
    return { ...task, plannedMonth: null, inPlan: true };
  });
  return { plan: { ...plan, tasks }, released };
}
