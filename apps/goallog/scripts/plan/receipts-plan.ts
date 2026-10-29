// `createGoal`, `addPhase` and `addCommitment` with a `requestId` (RP-56, RP-119):
// a create the network lost and the client resent leaves one row and answers
// what the first answered; without an id each call writes, as before. The
// concurrent replays are driven by `interleave`: the first create is held
// uncommitted while the second, with the same id, runs.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { actor, admin, close, interleave, open, type Acts, type Person } from "./lib/race";

let acts: Acts;
let owner: Person;
let other: Person;
let as: ReturnType<typeof actor>;
let asOther: ReturnType<typeof actor>;
let year: number;

before(async () => {
  delete process.env.PULSAR_CLOCK;
  const opened = await open(2);
  acts = opened.acts;
  [owner, other] = opened.people;
  as = actor(acts, owner);
  asOther = actor(acts, other);
  year = Number((await import("@/lib/zone")).todayInZone().slice(0, 4)) + 1;
});

after(async () => {
  await close([owner, other]);
});

const show = (value: unknown) => JSON.stringify(value);

async function goalsNamed(personId: string, name: string): Promise<string[]> {
  const rows = await admin<{ id: string }[]>`
    select id from goals.goals where user_id = ${personId} and name = ${name}`;
  return rows.map((row) => row.id);
}

async function freshGoal(name: string): Promise<string> {
  const made = await as(() => acts.plan.createGoal({ name, horizon: `${year}-12-31` }));
  if (!made.ok) throw new Error(`createGoal ${name}: ${made.error}`);
  return made.goalId;
}

const create = (name: string, requestId?: string) => () =>
  as(() => acts.plan.createGoal({ name, horizon: `${year}-12-31`, ...(requestId ? { requestId } : {}) } as never));

const phase = (goalId: string, requestId: string) => () =>
  as(() =>
    acts.plan.addPhase({ goalId, aim: "una fase", startsOn: `${year}-02-01`, endsOn: `${year}-02-28`, requestId } as never),
  );

const habit = (goalId: string, requestId: string) => () =>
  as(() =>
    acts.plan.addCommitment({ goalId, name: "un hábito", cadenceKind: "daily", satisfaction: "tap", requestId } as never),
  );

async function phasesOf(goalId: string): Promise<number> {
  const [{ n }] = await admin<{ n: number }[]>`select count(*)::int as n from goals.phases where goal_id = ${goalId}`;
  return n;
}

async function habitsOf(goalId: string): Promise<number> {
  const [{ n }] = await admin<{ n: number }[]>`select count(*)::int as n from goals.commitments where goal_id = ${goalId}`;
  return n;
}

// ------------------------------------------------------------ Replay, goal

test("replay, goal: createGoal with one requestId twice in a row answers the same goalId and leaves one row", async () => {
  const requestId = randomUUID();
  const first = await create("recibo meta", requestId)();
  const second = await create("recibo meta", requestId)();
  assert.equal(first.ok, true, show(first));
  assert.deepEqual(second, first);
  assert.equal((await goalsNamed(owner.id, "recibo meta")).length, 1);
});

// ------------------------------------------------------------ Replay, concurrent

test("replay, concurrent: the same requestId from two connections at once leaves one row and both answers equal", async () => {
  const requestId = randomUUID();
  const run = await interleave(create("recibo a la vez", requestId), create("recibo a la vez", requestId));
  assert.equal(run.first.ok, true, show(run));
  assert.deepEqual(run.second, run.first, show(run));
  assert.equal((await goalsNamed(owner.id, "recibo a la vez")).length, 1, show(run));
});

// ------------------------------------------------------------ Replay, goal inside a goal

const createUnder = (parentId: string, name: string, requestId: string) => () =>
  as(() => acts.plan.createGoal({ name, horizon: `${year}-06-30`, parentId, requestId } as never));

async function childrenOf(parentId: string): Promise<number> {
  const [{ n }] = await admin<{ n: number }[]>`select count(*)::int as n from goals.goals where parent_id = ${parentId}`;
  return n;
}

test("replay, child goal: createGoal under a goal with one requestId twice answers the same goalId and leaves one child", async () => {
  const parent = await freshGoal("recibo madre");
  const requestId = randomUUID();
  const first = await createUnder(parent, "recibo hija", requestId)();
  const second = await createUnder(parent, "recibo hija", requestId)();
  assert.equal(first.ok, true, show(first));
  assert.deepEqual(second, first);
  assert.equal(await childrenOf(parent), 1);
});

test("replay, child goal, concurrent: the same requestId at once under a goal leaves one child and both answers equal", async () => {
  const parent = await freshGoal("recibo madre a la vez");
  const requestId = randomUUID();
  const run = await interleave(createUnder(parent, "recibo hija a la vez", requestId), createUnder(parent, "recibo hija a la vez", requestId));
  assert.equal(run.first.ok, true, show(run));
  assert.deepEqual(run.second, run.first, show(run));
  assert.equal(await childrenOf(parent), 1, show(run));
});

// ------------------------------------------------------------ Replay, phase and habit

test("replay, phase: addPhase with one requestId twice answers the same phaseId and leaves one phase", async () => {
  const g = await freshGoal("recibo fase");
  const requestId = randomUUID();
  const first = await phase(g, requestId)();
  const second = await phase(g, requestId)();
  assert.equal(first.ok, true, show(first));
  assert.deepEqual(second, first);
  assert.equal(await phasesOf(g), 1);
});

test("replay, phase: the same requestId twice at once leaves one phase and both answers equal", async () => {
  const g = await freshGoal("recibo fase a la vez");
  const requestId = randomUUID();
  const run = await interleave(phase(g, requestId), phase(g, requestId));
  assert.equal(run.first.ok, true, show(run));
  assert.deepEqual(run.second, run.first, show(run));
  assert.equal(await phasesOf(g), 1);
});

test("replay, habit: addCommitment with one requestId twice answers the same commitmentId and leaves one habit", async () => {
  const g = await freshGoal("recibo hábito");
  const requestId = randomUUID();
  const first = await habit(g, requestId)();
  const second = await habit(g, requestId)();
  assert.equal(first.ok, true, show(first));
  assert.deepEqual(second, first);
  assert.equal(await habitsOf(g), 1);
});

test("replay, habit: the same requestId twice at once leaves one habit and both answers equal", async () => {
  const g = await freshGoal("recibo hábito a la vez");
  const requestId = randomUUID();
  const run = await interleave(habit(g, requestId), habit(g, requestId));
  assert.equal(run.first.ok, true, show(run));
  assert.deepEqual(run.second, run.first, show(run));
  assert.equal(await habitsOf(g), 1);
});

// ------------------------------------------------------------ No id, as today

test("no id, as today: two createGoal without a requestId write two goals", async () => {
  const first = await create("sin recibo")();
  const second = await create("sin recibo")();
  assert.equal(first.ok, true, show(first));
  assert.equal(second.ok, true, show(second));
  assert.notDeepEqual(second, first);
  assert.equal((await goalsNamed(owner.id, "sin recibo")).length, 2);
});

test("no id, as today: two addPhase and two addCommitment without a requestId each write", async () => {
  const g = await freshGoal("sin recibo hijos");
  const a = await as(() => acts.plan.addPhase({ goalId: g, aim: "a", startsOn: `${year}-02-01`, endsOn: `${year}-02-28` }));
  const b = await as(() => acts.plan.addPhase({ goalId: g, aim: "b", startsOn: `${year}-04-01`, endsOn: `${year}-04-30` }));
  assert.equal(a.ok && b.ok, true, show([a, b]));
  const tap = { goalId: g, name: "toque", cadenceKind: "daily", satisfaction: "tap" } as never;
  const h1 = await as(() => acts.plan.addCommitment(tap));
  const h2 = await as(() => acts.plan.addCommitment(tap));
  assert.equal(h1.ok && h2.ok, true, show([h1, h2]));
  assert.equal(await phasesOf(g), 2);
  assert.equal(await habitsOf(g), 2);
});

// ------------------------------------------------------------ A refusal is not stored

test("a refusal is not stored: a refused create with an id, then a valid one with the same id writes, and replays", async () => {
  const requestId = randomUUID();
  const refused = await as(() =>
    acts.plan.createGoal({ name: "recibo negado", horizon: `${year}-12-31`, parentId: randomUUID(), requestId } as never),
  );
  assert.equal(refused.ok, false, show(refused));
  assert.deepEqual(await goalsNamed(owner.id, "recibo negado"), []);

  const valid = await create("recibo tras negativa", requestId)();
  assert.equal(valid.ok, true, `the valid create wrote: ${show(valid)}`);
  assert.equal((await goalsNamed(owner.id, "recibo tras negativa")).length, 1);

  const replay = await create("recibo tras negativa", requestId)();
  assert.deepEqual(replay, valid);
  assert.equal((await goalsNamed(owner.id, "recibo tras negativa")).length, 1);
});

test("a refused phase with an id, then a valid one with the same id, writes the phase", async () => {
  const g = await freshGoal("fase tras negativa");
  const requestId = randomUUID();
  const refused = await as(() =>
    acts.plan.addPhase({ goalId: g, aim: "pasada", startsOn: `${year + 1}-02-01`, endsOn: `${year + 1}-02-28`, requestId } as never),
  );
  assert.deepEqual(refused, { ok: false, error: "plan.errors.phasePastHorizon" });
  const valid = await phase(g, requestId)();
  assert.equal(valid.ok, true, show(valid));
  assert.equal(await phasesOf(g), 1);
  assert.deepEqual(await phase(g, requestId)(), valid);
  assert.equal(await phasesOf(g), 1);
});

// ------------------------------------------------------------ Receipts are the person's own

test("two people sending the same requestId each get their own goal", async () => {
  const requestId = randomUUID();
  const mine = await create("recibo compartido", requestId)();
  const theirs = await asOther(() =>
    acts.plan.createGoal({ name: "recibo compartido", horizon: `${year}-12-31`, requestId } as never),
  );
  assert.equal(mine.ok && theirs.ok, true, show([mine, theirs]));
  assert.notDeepEqual(theirs, mine);
  assert.equal((await goalsNamed(owner.id, "recibo compartido")).length, 1);
  assert.equal((await goalsNamed(other.id, "recibo compartido")).length, 1);
});
