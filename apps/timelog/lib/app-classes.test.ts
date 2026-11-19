import assert from "node:assert/strict";
import { test } from "node:test";

import { appClass, appTone, mainSiteClass, siteClass, timeByClass } from "./app-classes";

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
