import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { pgCode } from "./db-error";

// The shape `DrizzleQueryError` actually throws (`errors.js`'s own
// constructor): the driver's `PostgresError` — the only object that ever
// carries `.code` — sits on `.cause`, not on the thrown error itself.
function wrappedError(code: string): unknown {
  return { message: "Failed query", cause: { code, message: "duplicate key value" } };
}

test("pgCode reads the SQLSTATE off a DrizzleQueryError's own .cause", () => {
  assert.equal(pgCode(wrappedError("23505")), "23505");
});

test("pgCode reads a bare error that already carries .code, no .cause to walk", () => {
  assert.equal(pgCode({ code: "22003" }), "22003");
});

test("pgCode returns undefined for an error with neither .code nor .cause", () => {
  assert.equal(pgCode(new Error("plain")), undefined);
});

test("pgCode returns undefined for a non-object, a string thrown as an error", () => {
  assert.equal(pgCode("not an error object"), undefined);
});

test("pgCode returns undefined for null", () => {
  assert.equal(pgCode(null), undefined);
});

// The actions run for real; only the two doors they reach through are
// replaced. `withGoalsDb` rejects the way drizzle does, the driver's error on
// `.cause` and nothing on the thrown object, so a catch that reads a bare
// `.code` lets it through and these turn red.
const PERSON_ID = "00000000-0000-4000-8000-000000000001";
let failure: unknown;

mock.module("@/lib/session", {
  namedExports: {
    getPerson: async () => ({ id: PERSON_ID }),
    withGoalsDb: async () => {
      throw failure;
    },
  },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => {} } });

const addCommitmentInput = {
  goalId: "11111111-1111-4111-8111-111111111111",
  name: "Caminar",
  cadenceKind: "daily",
  satisfaction: "tap",
} as const;
const declareFactInput = { commitmentId: "22222222-2222-4222-8222-222222222222" };

test("addCommitment maps a wrapped 22003 to valueOutOfRange instead of throwing", async () => {
  const { addCommitment } = await import("@/app/actions/plan");
  failure = wrappedError("22003");

  assert.deepEqual(await addCommitment(addCommitmentInput), {
    ok: false,
    error: "plan.errors.valueOutOfRange",
  });
});

test("addCommitment rethrows a wrapped error with another code", async () => {
  const { addCommitment } = await import("@/app/actions/plan");
  failure = wrappedError("23505");

  await assert.rejects(addCommitment(addCommitmentInput), (thrown) => thrown === failure);
});

test("declareFact maps a wrapped 22003 to quantityInvalid instead of throwing", async () => {
  const { declareFact } = await import("@/app/actions/facts");
  failure = wrappedError("22003");

  assert.deepEqual(await declareFact(declareFactInput), {
    ok: false,
    error: "day.errors.quantityInvalid",
  });
});

test("declareFact rethrows a wrapped error with another code", async () => {
  const { declareFact } = await import("@/app/actions/facts");
  failure = wrappedError("23505");

  await assert.rejects(declareFact(declareFactInput), (thrown) => thrown === failure);
});
