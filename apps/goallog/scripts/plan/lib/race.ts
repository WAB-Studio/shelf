// What `lock-plan-writers.ts` and `receipts-plan.ts` share: a person signed in
// through `actAs`, the app's own pool behind a gate, and `interleave`, which
// drives two acts into the same instant for real.
//
// The gate holds the first act's transaction open after its last statement and
// before its commit. The second act then runs against that uncommitted write:
// an act that takes the person's lock queues behind it, one that does not reads
// a snapshot without it. The gate opens when the second act finishes or is
// seen waiting on the first act's backend, never after a fixed sleep.
import Module from "node:module";

import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "../../mcp/lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

export type { Person };

type Hold = { reached: (pid: number) => void; gate: Promise<void> };

let armed: Hold | null = null;

// The admin's rows come back as a plain array: postgres.js answers a `Result`, an Array subclass,
// and `assert.deepEqual(rows, [])` under `assert/strict` compares prototypes, so an empty read
// would never equal `[]`.
// `owner` stays raw for the setup and the cleanup, whose helpers nest fragments and call `sql(value)`.
const owner = adminSql();
export const admin = new Proxy(owner, {
  apply(target, self, args) {
    return Promise.resolve(Reflect.apply(target, self, args) as Promise<unknown[]>).then((rows) => Array.from(rows));
  },
}) as postgres.Sql;
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 6 });

const gated = new Proxy(door, {
  get(target, property, receiver) {
    if (property !== "begin") return Reflect.get(target, property, receiver);
    return (...args: unknown[]) => {
      const hold = armed;
      armed = null;
      const begin = target.begin as (...a: unknown[]) => Promise<unknown>;
      if (!hold) return begin.apply(target, args);
      const fn = args[args.length - 1] as (tx: postgres.TransactionSql) => Promise<unknown>;
      return begin.apply(target, [
        ...args.slice(0, -1),
        async (tx: postgres.TransactionSql) => {
          try {
            const out = await fn(tx);
            const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
            hold.reached(pid);
            await hold.gate;
            return out;
          } catch (error) {
            hold.reached(-1);
            throw error;
          }
        },
      ]);
    };
  },
});
(globalThis as unknown as { sql: unknown }).sql = gated;

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (request === "next/cache") return { revalidatePath() {} };
    return originalLoad(request, parent, isMain);
  };
}

export type Acts = {
  plan: typeof import("@/app/actions/plan");
  budgets: typeof import("@/app/actions/budgets");
  roadmap: typeof import("@/app/actions/roadmap");
  session: typeof import("@/lib/session");
};

export async function open(count: number): Promise<{ acts: Acts; people: Person[] }> {
  installStubs();
  const acts: Acts = {
    plan: await import("@/app/actions/plan"),
    budgets: await import("@/app/actions/budgets"),
    roadmap: await import("@/app/actions/roadmap"),
    session: await import("@/lib/session"),
  };
  const runId = await openCheckRun(owner);
  const people = await createPeople(owner, runId, door, count);
  return { acts, people };
}

export async function close(people: Person[]): Promise<void> {
  try {
    for (const person of people) {
      await owner`delete from goals.write_receipts where user_id = ${person.id}`;
      await owner`update goals.goals set parent_id = null where user_id = ${person.id}`;
      await owner`delete from goals.goals where user_id = ${person.id}`;
    }
    await dropPeople(owner);
  } finally {
    await door.end();
    await owner.end();
  }
}

export function actor(acts: Acts, person: Person) {
  const resolved = { id: person.id, email: person.email } as ResolvedPerson;
  return <T>(fn: () => Promise<T>) => acts.session.actAs(resolved, fn);
}

export type Interleaved<A, B> = { first: A; second: B; secondWaited: boolean };

/**
 * Runs `first` until its transaction has written everything and not committed,
 * then `second` beside it. Opens the gate once `second` has answered or is
 * blocked by `first`'s backend.
 */
export async function interleave<A, B>(
  first: () => Promise<A>,
  second: () => Promise<B>,
  { deadlineMs = 5000 }: { deadlineMs?: number } = {},
): Promise<Interleaved<A, B>> {
  let reached!: (pid: number) => void;
  const atCommit = new Promise<number>((resolve) => (reached = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  armed = { reached, gate };

  const a = first();
  a.catch(() => {});
  const pid = await Promise.race([atCommit, a.then(() => -1, () => -1)]);
  armed = null;
  if (pid < 0) {
    release();
    throw new Error(`the first act never reached its commit: ${JSON.stringify(await a.catch((e) => String(e)))}`);
  }

  let settled = false;
  const b = second();
  b.then(
    () => (settled = true),
    () => (settled = true),
  );
  let secondWaited = false;
  const deadline = Date.now() + deadlineMs;
  try {
    while (!settled && Date.now() < deadline) {
      const [{ blocked }] = await admin<{ blocked: number }[]>`
        select count(*)::int as blocked from pg_stat_activity where ${pid}::int = any(pg_blocking_pids(pid))`;
      if (blocked > 0) {
        secondWaited = true;
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    release();
  }
  return { first: await a, second: await b, secondWaited };
}
