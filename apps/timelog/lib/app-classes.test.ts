import assert from "node:assert/strict";
import { test } from "node:test";

import { appClass, appTone, mainSiteClass, pageClass, siteClass, timeByClass } from "./app-classes";

test("an app takes its class by its readable name; Sistema is its own and an unknown app is «other»", () => {
  assert.equal(appClass("VS Code", "Sistema"), "code");
  assert.equal(appClass("GitHub Desktop", "Sistema"), "code");
  assert.equal(appClass("Chrome", "Sistema"), "other");
  assert.equal(appClass("Discord", "Sistema"), "messages");
  assert.equal(appClass("Teams", "Sistema"), "work");
  assert.equal(appClass("Steam", "Sistema"), "games");
  assert.equal(appClass("Minecraft", "Sistema"), "games");
  assert.equal(appClass("Spotify", "Sistema"), "social");
  assert.equal(appClass("Explorer", "Sistema"), "system");
  assert.equal(appClass("Sistema", "Sistema"), "system");
  assert.equal(appClass("GhostOfTsushima", "Sistema"), "other");
});

test("a game is any Unreal shipping build, Apex or Fortnite", () => {
  assert.equal(appClass("Hogwarts-Win64-Shipping", "Sistema"), "games");
  assert.equal(appClass("FortniteClient-Win64-Shipping", "Sistema"), "games");
  assert.equal(appClass("r5apex_dx12", "Sistema"), "games");
});

test("a site takes its class by host, a subdomain its parent's rule and the longest rule winning", () => {
  assert.equal(siteClass("localhost"), "code");
  assert.equal(siteClass("127.0.0.1"), "code");
  assert.equal(siteClass("my-app.vercel.app"), "code");
  assert.equal(siteClass("gist.github.com"), "code");
  assert.equal(siteClass("claude.ai"), "ai");
  assert.equal(siteClass("gemini.google.com"), "ai");
  assert.equal(siteClass("docs.google.com"), "work");
  assert.equal(siteClass("google.com"), "other");
  assert.equal(siteClass("acme.atlassian.net"), "work");
  assert.equal(siteClass("acme.my.salesforce.com"), "work");
  assert.equal(siteClass("web.whatsapp.com"), "messages");
  assert.equal(siteClass("whatsapp.com"), "other");
  assert.equal(siteClass("www.youtube.com"), "social");
  assert.equal(siteClass("music.youtube.com"), "social");
  assert.equal(siteClass("www.amazon.com.co"), "shopping");
  assert.equal(siteClass("detail.1688.com"), "shopping");
  assert.equal(siteClass("checkout.stripe.com"), "shopping");
  assert.equal(siteClass("stripe.com"), "other");
  assert.equal(siteClass("checkout.wompi.co"), "shopping");
  assert.equal(siteClass("www.bancolombia.com"), "shopping");
  assert.equal(siteClass("example.org"), "other");
});

test("time adds up by class, longest first, and a class with nothing is left out", () => {
  const rows = timeByClass(
    [
      { app: "VS Code", seconds: 600 },
      { app: "Terminal", seconds: 300 },
      { app: "Figma", seconds: 100 },
      { app: "Sistema", seconds: 0 },
    ],
    [],
    "Sistema",
  );
  assert.deepEqual(rows, [
    { kind: "code", seconds: 900 },
    { kind: "other", seconds: 100 },
  ]);
});

test("a browser's seconds are split across its sites' classes; what no site accounts for is «other»", () => {
  const rows = timeByClass(
    [
      { app: "Chrome", seconds: 1000 },
      { app: "Edge", seconds: 200 },
    ],
    [
      { host: "youtube.com", seconds: 500 },
      { host: "github.com", seconds: 300 },
      { host: "claude.ai", seconds: 100 },
    ],
    "Sistema",
  );
  assert.deepEqual(rows, [
    { kind: "social", seconds: 500 },
    { kind: "code", seconds: 300 },
    { kind: "other", seconds: 300 },
    { kind: "ai", seconds: 100 },
  ]);
});

test("sites that outrun the browser are scaled down to it, losing no second", () => {
  const rows = timeByClass([{ app: "Chrome", seconds: 100 }], [{ host: "youtube.com", seconds: 150 }, { host: "github.com", seconds: 50 }], "Sistema");
  assert.equal(rows.reduce((sum, one) => sum + one.seconds, 0), 100);
  assert.deepEqual(rows, [
    { kind: "social", seconds: 75 },
    { kind: "code", seconds: 25 },
  ]);
});

test("a browser with no sites is all «other»", () => {
  assert.deepEqual(timeByClass([{ app: "Chrome", seconds: 90 }], [], "Sistema"), [{ kind: "other", seconds: 90 }]);
});

test("the main class of sites ignores «other»; the browser draws in it, Claude's app in its orange", () => {
  const sites = [{ host: "example.org", seconds: 900 }, { host: "github.com", seconds: 10 }];
  assert.equal(mainSiteClass(sites), "code");
  assert.equal(mainSiteClass([]), "other");
  assert.equal(appTone("Chrome", "Sistema", "code"), "code");
  assert.equal(appTone("Claude", "Sistema"), "claudeApp");
  assert.equal(appTone("VS Code", "Sistema"), "code");
  assert.equal(appTone("Sistema", "Sistema"), "system");
});

test("the study sites and Anki are «study»; the specific rule beats `*.vercel.app` (RT-31)", () => {
  assert.equal(siteClass("wordbookapp.vercel.app"), "study");
  assert.equal(siteClass("other.vercel.app"), "code");
  assert.equal(siteClass("www.duolingo.com"), "study");
  assert.equal(siteClass("ankiweb.net"), "study");
  assert.equal(siteClass("es.khanacademy.org"), "study");
  assert.equal(appClass("Anki", "Sistema"), "study");
});

test("a page titled studyAid is study whatever its host", () => {
  assert.equal(pageClass("localhost:5173", "Ejercicios · studyAid"), "study");
  assert.equal(pageClass("localhost:5173", "Diagnóstico: Inglés · studyAid"), "study");
  assert.equal(pageClass("localhost:5173", "STUDYAID"), "study");
  assert.equal(pageClass("localhost:5173", "Vite App"), "code");
  assert.equal(pageClass("localhost:5173", "studyAid notes in code"), "code");
});

test("a host's seconds split by its pages: study pages to «study», the rest keep the host's class", () => {
  const sites = [{ host: "localhost:5173", seconds: 1000 }];
  const pages = [
    { host: "localhost:5173", title: "Ejercicios · studyAid", seconds: 600 },
    { host: "localhost:5173", title: "Vite App", seconds: 100 },
  ];
  assert.deepEqual(timeByClass([{ app: "Chrome", seconds: 1000 }], sites, "Sistema", pages), [
    { kind: "study", seconds: 600 },
    { kind: "code", seconds: 400 },
  ]);
  assert.equal(mainSiteClass(sites, pages), "study");
});

test("without pages a host keeps its class; study pages beyond the host's seconds are capped", () => {
  const sites = [{ host: "localhost:5173", seconds: 500 }];
  assert.deepEqual(timeByClass([{ app: "Chrome", seconds: 500 }], sites, "Sistema"), [{ kind: "code", seconds: 500 }]);
  const pages = [{ host: "localhost:5173", title: "studyAid", seconds: 900 }];
  assert.deepEqual(timeByClass([{ app: "Chrome", seconds: 500 }], sites, "Sistema", pages), [{ kind: "study", seconds: 500 }]);
});
