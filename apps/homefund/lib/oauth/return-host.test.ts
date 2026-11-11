import assert from "node:assert/strict";
import test from "node:test";

import { returnHost } from "./return-host";

// RP-60: the consent names where the person returns. The host is the one
// part of the redirect a client cannot dress up, so it is never the path.

test("claude.ai's callback reads as its host alone, with no path", () => {
  assert.equal(returnHost("https://claude.ai/api/mcp/auth_callback"), "claude.ai");
});

test("a path, query and fragment never reach the host", () => {
  assert.equal(returnHost("https://a.example/x?y#z"), "a.example");
  assert.equal(returnHost("https://a.example/x?y=https://evil.example"), "a.example");
});

test("the default port of the scheme is dropped", () => {
  assert.equal(returnHost("https://a.example:443/"), "a.example");
  assert.equal(returnHost("http://a.example:80/cb"), "a.example");
});

test("a port that is not the default stays", () => {
  assert.equal(returnHost("http://localhost:33418/callback"), "localhost:33418");
  assert.equal(returnHost("https://a.example:8443/cb"), "a.example:8443");
  assert.equal(returnHost("https://a.example:80/cb"), "a.example:80");
});

test("an IPv6 host keeps its brackets and its port", () => {
  assert.equal(returnHost("http://[::1]:8080/"), "[::1]:8080");
  assert.equal(returnHost("http://[::1]/cb"), "[::1]");
});

test("credentials in the address never show", () => {
  assert.equal(returnHost("https://user:pass@a.example/cb"), "a.example");
});

test("the host is lower-cased as a browser resolves it", () => {
  assert.equal(returnHost("https://Claude.AI/cb"), "claude.ai");
});
