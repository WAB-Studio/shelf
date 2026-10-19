// A pool the app's `@/db/client` adopts through `globalThis.sql`, which can
// hold one transaction open just before its commit while a second act runs
// against the same rows. Two real transactions interleave on the database;
// nothing about the act's statements is read or asserted here, only whether
// the second waited on the first and what both left behind.
import postgres from "postgres";

type Tx = postgres.TransactionSql;
type Fn = (tx: Tx) => Promise<unknown>;

export type Hold = { pid: number; release: () => void };

export type HeldDoor = {
  sql: postgres.Sql;
  /** Transactions opened on this pool since the last `resetBegins`. */
  begins(): number;
  resetBegins(): void;
  /** The next transaction that writes a row is held before its commit. */
  holdNextWrite(): Promise<Hold>;
  /** Drops a hold no transaction took. */
  disarm(): void;
};

// A statement that writes a row, anywhere in its text (a CTE's `update … set` too).
const WRITES = /\b(insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i;

export function heldDoor(url: string): HeldDoor {
  const real = postgres(url, { prepare: false, max: 8 });
  let begins = 0;
  let armed: ((hold: Hold) => void) | null = null;

  function watch(tx: Tx, wrote: () => void): Tx {
    return new Proxy(tx, {
      get(target, property, receiver) {
        if (property === "unsafe") {
          return (query: string, ...rest: unknown[]) => {
            if (WRITES.test(query)) wrote();
            return (target.unsafe as (...args: unknown[]) => unknown)(query, ...rest);
          };
        }
        if (property === "savepoint") {
          return (...args: unknown[]) => {
            const fn = args.pop() as Fn;
            return (target.savepoint as (...a: unknown[]) => Promise<unknown>)(...args, (inner: Tx) =>
              fn(watch(inner, wrote)),
            );
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  const sql = new Proxy(real, {
    get(target, property, receiver) {
      if (property !== "begin") return Reflect.get(target, property, receiver);
      return (...args: unknown[]) => {
        begins += 1;
        const fn = args.pop() as Fn;
        return (target.begin as (...a: unknown[]) => Promise<unknown>)(...args, async (tx: Tx) => {
          let wrote = false;
          const result = await fn(watch(tx, () => void (wrote = true)));
          const hand = armed;
          if (wrote && hand) {
            armed = null;
            const [{ pid }] = await tx.unsafe<{ pid: number }[]>("select pg_backend_pid() as pid");
            await new Promise<void>((release) => hand({ pid, release }));
          }
          return result;
        });
      };
    },
  });

  return {
    sql,
    begins: () => begins,
    resetBegins: () => void (begins = 0),
    holdNextWrite: () =>
      new Promise<Hold>((resolve) => {
        armed = resolve;
      }),
    disarm: () => void (armed = null),
  };
}

export type Settled<T> = { value: T; error?: undefined } | { value?: undefined; error: unknown };

const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

/**
 * Runs `first` until its writing transaction is about to commit, then runs
 * `second`. The first is let go once the second waits on it (Postgres says
 * so in `pg_blocking_pids`) or once the second is done without waiting.
 */
export async function interleave<A, B>(
  door: HeldDoor,
  admin: postgres.Sql,
  first: () => Promise<A>,
  second: () => Promise<B>,
  { deadlineMs = 15_000 } = {},
): Promise<{ first: Settled<A>; second: Settled<B>; secondWaited: boolean }> {
  const held = door.holdNextWrite();
  const a = settle(first());
  const hold = await Promise.race([
    held,
    a.then((outcome) => {
      door.disarm();
      throw new Error(`the first act ended without a held write: ${String(outcome.error ?? JSON.stringify(outcome.value))}`);
    }),
  ]);

  let secondDone = false;
  const b = settle(second()).finally(() => void (secondDone = true));
  const deadline = Date.now() + deadlineMs;
  let secondWaited = false;
  try {
    while (!secondDone) {
      const [{ blocked }] = await admin<{ blocked: boolean }[]>`
        select exists (
          select 1 from pg_stat_activity where ${hold.pid}::int = any(pg_blocking_pids(pid))
        ) as blocked`;
      if (blocked) {
        secondWaited = true;
        break;
      }
      if (Date.now() > deadline) throw new Error("the second act neither finished nor waited on the first");
    }
  } finally {
    hold.release();
  }
  return { first: await a, second: await b, secondWaited };
}
