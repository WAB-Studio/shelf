import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const appRoot = join(import.meta.dirname, "..", "..", "app", "[locale]");

const pages = [
  { path: "(app)/settings/members", loader: "getMembersScreenData", extra: [] },
  { path: "(app)/settings/categories", loader: "getCategoriesScreenData", extra: [] },
  { path: "(app)/settings/labels", loader: "getLabelsScreenData", extra: [] },
  {
    path: "onboarding/invite",
    loader: "getMembersScreenData",
    extra: ["getTranslations"],
  },
];

// The page component's body: the metadata function above it awaits on its own.
function pageBody(source: string): string {
  const start = source.indexOf("export default async function");
  assert.notEqual(start, -1, "no default async page");
  return source.slice(start);
}

for (const page of pages) {
  test(`${page.path} fans requireUser out with its loader`, () => {
    const body = pageBody(readFileSync(join(appRoot, page.path, "page.tsx"), "utf8"));

    // Awaiting the route's params and searchParams is free; every other await is a round trip.
    const awaits = [...body.matchAll(/await\s+([^;]*?)(?=[;\n])/g)]
      .map((m) => ({ index: m.index, text: m[0] }))
      .filter((a) => !/^await\s+props\.(params|searchParams)\b/.test(a.text));

    assert.ok(awaits.length > 0, "the page awaits nothing");
    assert.match(awaits[0].text, /^await\s+Promise\.all\(\[/, "first round trip is not Promise.all");

    const start = awaits[0].index;
    const end = body.indexOf("]);", start);
    assert.notEqual(end, -1, "Promise.all array is not closed");
    const array = body.slice(start, end);

    for (const name of ["requireUser()", `${page.loader}(`, ...page.extra]) {
      assert.ok(array.includes(name), `Promise.all lacks ${name}`);
    }
    assert.doesNotMatch(body, /await\s+requireUser\(\)/, "requireUser is awaited alone");
  });
}
