import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import { widgetScript } from "./script";

type Summary = {
  currency: string;
  disponible: { cents: number };
  mes: { spentCents: number; budgetedCents: number };
  bandeja: { pendingCount: number };
  creditos: { person: string; currency: string; paidThisMonth: string; installmentCents: number | null; daysUntilDue: number | null }[];
};

const SUMMARY: Summary = {
  currency: "COP",
  disponible: { cents: 123_456_789 },
  mes: { spentCents: 30_000, budgetedCents: 500_000 },
  bandeja: { pendingCount: 3 },
  creditos: [],
};

type Scenario = {
  family?: string | null;
  inApp?: boolean;
  keychain?: Record<string, string>;
  status?: number;
  body?: unknown;
  offline?: boolean;
  typedKey?: string;
};

// Runs the script against a stand-in for Scriptable's API and reports what the widget would have drawn.
async function run(scenario: Scenario) {
  const store = new Map(Object.entries(scenario.keychain ?? {}));
  const texts: string[] = [];
  const requests: { url: string; headers: Record<string, string> }[] = [];
  let widgetUrl: string | undefined;
  let alerts = 0;

  class Stack {
    layoutVertically() {}
    addSpacer() {}
    setPadding() {}
    addStack() {
      return new Stack();
    }
    addText(value: string) {
      texts.push(value);
      return {};
    }
  }
  class ListWidget extends Stack {
    url?: string;
    presentSmall() {
      widgetUrl = this.url;
    }
    presentMedium() {
      widgetUrl = this.url;
    }
  }
  class Color {
    static dynamic(light: unknown) {
      return light;
    }
  }
  class Alert {
    addTextField() {}
    addAction() {}
    addCancelAction() {}
    async presentAlert() {
      alerts += 1;
      return scenario.typedKey === undefined ? -1 : 0;
    }
    textFieldValue() {
      return ` ${scenario.typedKey} `;
    }
  }
  class Request {
    url: string;
    headers: Record<string, string> = {};
    response = { statusCode: scenario.status ?? 200 };
    constructor(url: string) {
      this.url = url;
    }
    async load() {
      requests.push({ url: this.url, headers: this.headers });
      if (scenario.offline) throw new Error("The Internet connection appears to be offline.");
      return { toRawString: () => JSON.stringify(scenario.body ?? SUMMARY) };
    }
  }

  const context = vm.createContext({
    Color,
    Alert,
    Request,
    ListWidget,
    Font: { systemFont: () => ({}), boldSystemFont: () => ({}) },
    Keychain: {
      contains: (key: string) => store.has(key),
      get: (key: string) => store.get(key),
      set: (key: string, value: string) => void store.set(key, value),
      remove: (key: string) => void store.delete(key),
    },
    config: {
      runsInApp: scenario.inApp ?? false,
      runsInWidget: !(scenario.inApp ?? false),
      widgetFamily: scenario.family === undefined ? "small" : scenario.family,
    },
    Script: {
      setWidget(widget: { url?: string }) {
        widgetUrl = widget.url;
      },
      complete() {},
    },
  });
  const source = widgetScript("https://homefund.test/ignored/path");
  await new vm.Script(`(async () => {${source}\n})()`).runInContext(context);

  return { texts, requests, store, alerts, widgetUrl };
}

const KEYED = { "homefund-widget-key": "whk_abc" };

test("the script carries the app's origin and opens the Bandeja on a tap", async () => {
  assert.match(widgetScript("https://homefund.test/ignored/path"), /var BASE = "https:\/\/homefund\.test";/);
  const { widgetUrl } = await run({ keychain: KEYED });
  assert.equal(widgetUrl, "https://homefund.test/es/inbox");
});

test("pesos read with dots and no cents, and the request carries the key from the Keychain", async () => {
  const { texts, requests } = await run({ keychain: KEYED, family: "small" });
  assert.ok(texts.includes("$1.234.568"), texts.join(" | "));
  assert.ok(texts.includes("Mes $300 de $5.000"), texts.join(" | "));
  assert.ok(texts.includes("3 por revisar"));
  assert.equal(requests[0].url, "https://homefund.test/api/widget");
  assert.equal(requests[0].headers.Authorization, "Bearer whk_abc");
});

test("a negative balance keeps its sign, and a quiet Bandeja says so", async () => {
  const body = { ...SUMMARY, disponible: { cents: -50_000 }, bandeja: { pendingCount: 0 }, mes: { spentCents: 0, budgetedCents: 0 } };
  const { texts } = await run({ keychain: KEYED, family: "medium", body });
  assert.ok(texts.includes("-$500"), texts.join(" | "));
  assert.ok(texts.includes("$0"), "no budget reads the spend alone");
  assert.ok(texts.includes("Bandeja al día"));
});

test("the lock screen families draw the same figures in their own shape", async () => {
  const inline = await run({ keychain: KEYED, family: "accessoryInline" });
  assert.deepEqual(inline.texts, ["Disponible $1.234.568 · 3"]);
  const rectangular = await run({ keychain: KEYED, family: "accessoryRectangular" });
  assert.deepEqual(rectangular.texts, ["Disponible $1.234.568", "Mes $300 de $5.000", "3 por revisar"]);
});

test("the first run in the app asks for the key and keeps it in the Keychain", async () => {
  const { alerts, store, requests } = await run({ inApp: true, family: null, typedKey: "whk_typed" });
  assert.equal(alerts, 1);
  assert.equal(store.get("homefund-widget-key"), "whk_typed");
  assert.equal(requests[0].headers.Authorization, "Bearer whk_typed");
});

test("without a key the widget asks nothing and says where to put it", async () => {
  const { alerts, texts, requests } = await run({});
  assert.equal(alerts, 0);
  assert.equal(requests.length, 0);
  assert.ok(texts.some((line) => line.startsWith("Abre este script en Scriptable")));
});

test("offline it draws the last figures marked «Sin conexión», or says so when it has none", async () => {
  const cached = await run({ keychain: { ...KEYED, "homefund-widget-cache": JSON.stringify(SUMMARY) }, offline: true });
  assert.ok(cached.texts.includes("Sin conexión") && cached.texts.includes("$1.234.568"));
  const bare = await run({ keychain: KEYED, offline: true });
  assert.ok(bare.texts.some((line) => line.startsWith("Sin conexión.")));
});

test("a refused key is dropped and the message says to paste another", async () => {
  const { store, texts } = await run({ keychain: KEYED, status: 401, body: { error: "unauthorized" } });
  assert.equal(store.has("homefund-widget-key"), false);
  assert.ok(texts.some((line) => line.startsWith("La clave ya no sirve")));
});

test("a server failure says it will try again", async () => {
  const { texts } = await run({ keychain: KEYED, status: 500, body: { error: "unexpected" } });
  assert.ok(texts.some((line) => line.startsWith("HomeFund no respondió")));
});

test("the medium widget draws one line per credit somebody else pays, three at most", async () => {
  const credit = (person: string, paidThisMonth: string, daysUntilDue: number | null) => ({
    person, currency: "COP", paidThisMonth, installmentCents: 20_000_000, daysUntilDue,
  });
  const body = {
    ...SUMMARY,
    creditos: [credit("John", "done", 6), credit("Ana", "none", 0), credit("Luis", "partial", 1), credit("Eva", "done", null)],
  };
  const { texts } = await run({ keychain: KEYED, family: "medium", body });
  assert.ok(texts.includes("John: pagó ✓ · cuota en 6 días"), texts.join(" | "));
  assert.ok(texts.includes("Ana: sin pago · cuota hoy"));
  assert.ok(texts.includes("Luis: pagó una parte · cuota en 1 día"));
  assert.ok(!texts.some((line) => line.startsWith("Eva")) && texts.includes("y 1 más"));
  const small = await run({ keychain: KEYED, family: "small", body });
  assert.ok(!small.texts.some((line) => line.startsWith("John")), "the small widget has no room for them");
});

test("a summary with no credits, or cached before they existed, draws none", async () => {
  const { creditos, ...old } = SUMMARY;
  assert.deepEqual(creditos, []);
  const { texts } = await run({ keychain: KEYED, family: "medium", body: old });
  assert.ok(texts.includes("3 por revisar") && !texts.some((line) => line.includes("cuota")));
});
