import assert from "node:assert/strict";
import { test } from "node:test";

import { requestHost, servedOrigin, servedOrigins } from "./hosts";

const SITE = "https://homefund.test";

test("the served origins are the configured one and the old production address", () => {
  assert.deepEqual(servedOrigins(SITE), [SITE, "https://our-piggy-bank.vercel.app"]);
  assert.deepEqual(servedOrigins("https://our-piggy-bank.vercel.app"), ["https://our-piggy-bank.vercel.app"]);
  assert.deepEqual(servedOrigins("http://localhost:3000"), ["http://localhost:3000", "https://our-piggy-bank.vercel.app"]);
});

test("the issuer follows the host the request came on when this app serves it", () => {
  assert.equal(servedOrigin("our-piggy-bank.vercel.app", SITE), "https://our-piggy-bank.vercel.app");
  assert.equal(servedOrigin("homefund.test", SITE), SITE);
});

test("any other host, or none, is answered with the configured origin", () => {
  assert.equal(servedOrigin("evil.example", SITE), SITE);
  assert.equal(servedOrigin("our-piggy-bank.vercel.app.evil.example", SITE), SITE);
  assert.equal(servedOrigin(null, SITE), SITE);
});

test("the host is the Host header, else the URL's", () => {
  assert.equal(requestHost({ headers: new Headers({ host: "a.test" }), url: "https://b.test/x" }), "a.test");
  assert.equal(requestHost({ headers: new Headers(), url: "https://b.test/x" }), "b.test");
});
