// M8 (RP-86, RNP-13): a model call the import route could not settle is
// logged with its claim and the error's name, and the person's reply does not
// change. `POST /importar/leer` runs as the exported function; the seam is the
// spend module (`@/lib/import/spend`), whose claims answer fixed ids and whose
// settle throws on demand, so no row and no model is touched. The model read
// is the stub `PULSAR_MODEL_STUB` already serves, and the second pass and a
// read that fails are replaced in `@/lib/import/arrange` and `@/lib/import/model`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { dirname, resolve } from "node:path";
import { before, beforeEach, test } from "node:test";

const READ_CLAIM = "read-claim";
const FOLLOW_CLAIM = "follow-claim";

class SettleError extends Error {
  override name = "SettleError";
}

// What the seam does in the current test.
const seam = {
  failSettleOf: null as string | null,
  arrangeThrows: false,
  readThrows: false,
  settled: [] as string[],
  reached: 0,
};

function overriding(real: Record<string, unknown>, overrides: () => Record<string, unknown>) {
  return new Proxy(real, {
    get(target, property, receiver) {
      const own = overrides();
      return typeof property === "string" && property in own ? own[property] : Reflect.get(target, property, receiver);
    },
  });
}

function installStubs(): void {
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "server-only") return {};
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (request === "next/cache") return { revalidatePath() {} };
    if (request === "@/lib/import/spend") {
      const real = originalLoad(request, parent, isMain) as Record<string, unknown>;
      return overriding(real, () => ({
        claimModelCall: async () => ({ id: READ_CLAIM }),
        claimFollowUp: async () => ({ id: FOLLOW_CLAIM }),
        appCapReached: async () => false,
        settleModelCall: async (id: string) => {
          seam.reached += 1;
          seam.settled.push(id);
          if (seam.failSettleOf === id) throw new SettleError("the settle could not be written");
        },
      }));
    }
    if (request === "@/lib/import/arrange") {
      const real = originalLoad(request, parent, isMain) as Record<string, unknown>;
      return overriding(real, () =>
        seam.arrangeThrows
          ? {
              arrangeWanted: () => true,
              proposeMoves: async () => {
                throw new Error("the second pass failed");
              },
            }
          : {},
      );
    }
    if (request === "@/lib/import/model") {
      const real = originalLoad(request, parent, isMain) as Record<string, unknown>;
      return overriding(real, () => ({
        modelAvailable: () => true,
        ...(seam.readThrows && {
          readPlan: () => {
            throw new Error("the read failed before it began");
          },
        }),
      }));
    }
    return originalLoad(request, parent, isMain);
  };
}

const STUB_FILE = resolve(process.cwd(), `private/import-settle-stub-${process.env.HARNESS_LANE ?? "1"}.json`);

let route: typeof import("@/app/importar/leer/route");
let session: typeof import("@/lib/session");
const person = { id: randomUUID(), email: "m8-import-settle@example.invalid" };

type Line = Record<string, unknown>;

async function read(): Promise<Line[]> {
  const form = new FormData();
  form.set("text", "un plan cualquiera");
  const request = new Request("http://localhost/importar/leer", { method: "POST", body: form }) as unknown as Parameters<
    typeof route.POST
  >[0];
  const response = await session.actAs(person as never, () => route.POST(request));
  assert.equal(response.status, 200);
  const text = await response.text();
  return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Line);
}

async function withLog<T>(run: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    return { result: await run(), logged };
  } finally {
    console.error = original;
  }
}

before(async () => {
  installStubs();
  const { env } = (await import("@/lib/env")) as unknown as { env: Record<string, string | undefined> };
  mkdirSync(dirname(STUB_FILE), { recursive: true });
  writeFileSync(
    STUB_FILE,
    JSON.stringify({
      goals: [
        {
          key: "g1",
          parent: null,
          name: "IA aplicada",
          horizon: "2027-10-01",
          measure: { name: "horas de estudio", unit: "minutos" },
          rate: null,
          noteSrc: [],
          noteText: null,
          src: [{ from: 1, to: 1 }],
          phases: [],
          months: [],
          commitments: [],
          rules: [],
          tasks: [],
        },
      ],
    }),
  );
  env.PULSAR_MODEL_STUB = `draft:${STUB_FILE}`;
  env.OPENAI_API_KEY = "sk-never-sent";
  session = await import("@/lib/session");
  route = await import("@/app/importar/leer/route");
});

beforeEach(() => {
  seam.failSettleOf = null;
  seam.arrangeThrows = false;
  seam.readThrows = false;
  seam.settled = [];
  seam.reached = 0;
});

test("the second pass's settle that throws is logged with its claim and the error's name; the reply is the same", async () => {
  seam.arrangeThrows = true;
  const control = await read();
  assert.deepEqual(seam.settled, [READ_CLAIM, FOLLOW_CLAIM], "the seam settles both claims");
  seam.settled = [];
  seam.failSettleOf = FOLLOW_CLAIM;
  const { result: lines, logged } = await withLog(read);
  assert.deepEqual(seam.settled, [READ_CLAIM, FOLLOW_CLAIM], "the follow-up settle was attempted");
  assert.deepEqual(lines, control);
  assert.deepEqual(logged, [["import settle failed", FOLLOW_CLAIM, "SettleError"]]);
});

test("a failed read's settle that throws is logged with its claim and the error's name; the reply is the same", async () => {
  seam.readThrows = true;
  const control = await read();
  assert.deepEqual(control.at(-1), { error: "import.errors.modelFailed" });
  assert.deepEqual(seam.settled, [READ_CLAIM], "the seam settles the read's claim");
  seam.settled = [];
  seam.failSettleOf = READ_CLAIM;
  const { result: lines, logged } = await withLog(read);
  assert.deepEqual(seam.settled, [READ_CLAIM], "the read's settle was attempted");
  assert.deepEqual(lines, control);
  assert.deepEqual(logged, [["import settle failed", READ_CLAIM, "SettleError"]]);
});
