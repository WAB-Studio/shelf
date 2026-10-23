import assert from "node:assert/strict";
import test, { beforeEach, mock } from "node:test";

// The route's collaborators are stood in for so that the test counts what the route really calls:
// the claim on the model_calls ledger and the model itself.
const seen = { person: 0, claim: 0, settle: 0, model: 0 };

mock.module("@/lib/session", {
  namedExports: {
    getPerson: async () => {
      seen.person += 1;
      return { id: "p1", email: "a@b.test" };
    },
  },
});
mock.module("@/lib/chat/model", {
  namedExports: {
    chatAvailable: () => true,
    chatModel: () => "test-model",
    answerChat: async () => {
      seen.model += 1;
      return { status: "ok", reply: "hola", changes: [], usage: { input: 1, output: 1 } };
    },
  },
});
mock.module("@/lib/import/spend", {
  namedExports: {
    appCapReached: async () => false,
    claimModelCall: async () => {
      seen.claim += 1;
      return { id: "claim-1" };
    },
    settleModelCall: async () => {
      seen.settle += 1;
    },
  },
});
mock.module("@/lib/queries/chat", { namedExports: { loadChangeNames: async () => ({}) } });

const route = () => import("./route");

const post = (headers: Record<string, string>) =>
  new Request("https://goallog.test/chat/enviar", {
    method: "POST",
    headers: { "content-type": "application/json", host: "goallog.test", ...headers },
    body: JSON.stringify({ turns: [{ role: "person", text: "hola" }] }),
  });

beforeEach(() => {
  seen.person = seen.claim = seen.settle = seen.model = 0;
});

test("a POST from a foreign origin is refused 403 and claims nothing, asks no model", async () => {
  const { POST } = await route();
  const response = await POST(post({ origin: "https://evil.example" }) as never);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "forbidden" });
  assert.deepEqual(seen, { person: 0, claim: 0, settle: 0, model: 0 });
});

test("a POST of the own origin claims once, asks the model once and settles the claim", async () => {
  const { POST } = await route();
  const response = await POST(post({ origin: "https://goallog.test" }) as never);
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { reply: string }).reply, "hola");
  assert.deepEqual(seen, { person: 1, claim: 1, settle: 1, model: 1 });
});
