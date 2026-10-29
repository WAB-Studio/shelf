// What `month-across.ts` and `report.ts` read off the driver's own wire, and
// the barrier that proves a fan-out by call order instead of by timestamps.
//
// The barrier lives in the test process, in front of the pool: it holds the
// first `begin` the loader asks for before any connection is opened, so it
// takes no lock, no row and no statement on the shared stack and nobody else's
// read can wait on it. A fanned loader asks for the second transaction while
// the first is held and its statement reaches the debug log; a chained one
// never asks.
export type DebugCall = { at: number; connection: number; query: string; parameters: unknown[] };
export type PostgresFactory = (url: string, options?: Record<string, unknown>) => unknown;

const TYPE_FETCH_QUERY_TEXT =
  "select b.oid, b.typarray from pg_catalog.pg_type a left join pg_catalog.pg_type b " +
  "on b.oid = a.typelem where a.typcategory = 'a' group by b.oid, b.typarray order by b.oid";

export function normalized(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

export type Wire = { applicationStatements: number; connections: number };

// Application statements are what is left after each connection's bracket and
// its first-use type fetch.
export function readWire(calls: DebugCall[]): Wire {
  const byConnection = new Map<number, DebugCall[]>();
  for (const call of calls) byConnection.set(call.connection, [...(byConnection.get(call.connection) ?? []), call]);
  let applicationStatements = 0;
  for (const group of byConnection.values()) {
    applicationStatements += group.filter((call) => {
      const text = normalized(call.query);
      return !text.startsWith("begin") && text !== "commit" && text !== "rollback" && text !== TYPE_FETCH_QUERY_TEXT;
    }).length;
  }
  return { applicationStatements, connections: byConnection.size };
}

type Barrier = { taken: boolean; holding: boolean; release: () => void };

let armed: Barrier | null = null;

// Wraps the factory the loaders reach through `Module._load("postgres")`.
// `record` is the suite's own wire log. A single-connection pool is the
// suite's own pooler and is never held; the app's pool is `max: 8`.
export function wrapPostgres(real: PostgresFactory, record: (call: DebugCall) => void): PostgresFactory {
  return (url, options) => {
    const sql = real(url, {
      ...options,
      debug: (connection: number, query: string, parameters: unknown[]) => {
        record({ at: Date.now(), connection, query, parameters });
        // Nothing is sent while the first transaction is held, so any statement
        // here is the second transaction's.
        if (armed?.holding) armed.release();
      },
    }) as { begin: (...args: unknown[]) => Promise<unknown> };
    if (options?.max === 1) return sql;
    return new Proxy(sql, {
      get(target, property, receiver) {
        if (property !== "begin") return Reflect.get(target, property, receiver);
        return async (...args: unknown[]) => {
          const barrier = armed;
          if (barrier && !barrier.taken) {
            barrier.taken = true;
            barrier.holding = true;
            await new Promise<void>((resolve) => {
              barrier.release = resolve;
            });
            barrier.holding = false;
          }
          return target.begin(...args);
        };
      },
    });
  };
}

// Runs the loader with its first transaction held until the second one sends
// a statement. Returns true, or throws at the deadline.
export async function proveOverlap(run: () => Promise<unknown>, { deadlineMs }: { deadlineMs: number }): Promise<true> {
  const barrier: Barrier = { taken: false, holding: false, release: () => {} };
  armed = barrier;
  let timer: NodeJS.Timeout | undefined;
  const loader = run();
  loader.catch(() => {});
  try {
    const outcome = await Promise.race([
      loader.then(() => "done" as const),
      new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => resolve("deadline"), deadlineMs);
      }),
    ]);
    if (outcome === "deadline") {
      throw new Error("the second transaction never started while the first was held");
    }
    return true;
  } finally {
    clearTimeout(timer);
    armed = null;
    barrier.holding = false;
    barrier.release();
    await loader.catch(() => {});
  }
}
