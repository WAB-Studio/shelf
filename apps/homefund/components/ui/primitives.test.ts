import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AmountField } from "./amount-field";
import { Disc } from "./disc";
import { Eyebrow } from "./eyebrow";
import { Figure } from "./figure";
import { RawText } from "./raw-text";
import { ToneSurface } from "./tone-surface";
import { Stepper } from "./stepper";

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(node);

test("Figure sets tabular numerals on text and on a heading", () => {
  assert.match(html(createElement(Figure, null, "1")), /font-variant-numeric:tabular-nums/);
  assert.match(
    html(createElement(Figure, { as: "h2", size: "8" }, "1")),
    /<h2[^>]*font-variant-numeric:tabular-nums/,
  );
});

test("Figure holds one line only when asked", () => {
  assert.doesNotMatch(html(createElement(Figure, null, "1")), /nowrap/);
  assert.match(html(createElement(Figure, { nowrap: true }, "1")), /white-space:nowrap/);
});

test("Disc is a fixed square with a radius token", () => {
  const out = html(createElement(Disc, { size: 44, radius: 5, surface: "var(--accent-a3)" }, "x"));
  assert.match(out, /width:44px/);
  assert.match(out, /height:44px/);
  assert.match(out, /border-radius:var\(--radius-5\)/);
  assert.match(out, /background:var\(--accent-a3\)/);
  assert.match(out, /flex-shrink:0/);
});

test("Disc takes full, px and ink", () => {
  const full = html(createElement(Disc, { size: 40, radius: "full", ink: "var(--accent-11)" }));
  assert.match(full, /border-radius:9999px/);
  assert.match(full, /color:var\(--accent-11\)/);
  assert.match(html(createElement(Disc, { size: 40, radius: 14 })), /border-radius:14px/);
});

test("RawText keeps line breaks and breaks a long token", () => {
  const out = html(createElement(RawText, null, "x"));
  assert.match(out, /white-space:pre-wrap/);
  assert.match(out, /overflow-wrap:anywhere/);
});

test("ToneSurface paints the tokens of its tone", () => {
  assert.match(html(createElement(ToneSurface, { tone: "danger" }, "x")), /background:var\(--red-a2\)/);
  assert.match(
    html(createElement(ToneSurface, { tone: "danger", strong: true, radius: 3 }, "x")),
    /background:var\(--red-a3\)[^"]*border-radius:var\(--radius-3\)/,
  );
  assert.match(html(createElement(ToneSurface, { tone: "success" }, "x")), /background:var\(--grass-a3\)/);
});

test("Eyebrow is uppercase with 0.06em tracking", () => {
  const out = html(createElement(Eyebrow, null, "x"));
  assert.match(out, /text-transform:uppercase/);
  assert.match(out, /letter-spacing:0\.06em/);
});

test("summary-band.module.css carries the ratios and the phone rule", () => {
  const css = readFileSync(new URL("./summary-band.module.css", import.meta.url), "utf8");
  assert.match(css, /\.cards,\s*\.card\s*\{\s*display: contents;/);
  for (const ratio of ["1.35 1 0", "1 1 0", "0.9 1 0"]) assert.ok(css.includes(`flex: ${ratio}`), ratio);
  assert.match(css, /@media \(min-width: 1024px\)/);
});

test("Stepper fills done and active steps and greys the rest", () => {
  const out = html(
    createElement(Stepper, {
      steps: [
        { key: 1, label: "a", number: 1, state: "done" },
        { key: 2, label: "b", number: 2, state: "active" },
        { key: 3, label: "c", number: 3, state: "todo" },
      ],
    }),
  );
  assert.equal(out.match(/background:var\(--accent-9\)/g)?.length, 2);
  assert.equal(out.match(/background:var\(--gray-4\)/g)?.length, 1);
  assert.equal(out.match(/height:2px/g)?.length, 2);
});

test("Figure sets a line height of one only when tight", () => {
  assert.match(html(createElement(Figure, { tight: true }, "5")), /line-height:1/);
  assert.doesNotMatch(html(createElement(Figure, null, "5")), /line-height/);
});

test("ToneSurface fades without a tone and keeps its own background", () => {
  const out = html(createElement(ToneSurface, { faded: true }, "x"));
  assert.match(out, /opacity:0\.55/);
  assert.doesNotMatch(out, /background/);
});

test("AmountField is tabular and takes a fixed width", () => {
  const out = html(createElement(AmountField, { width: 110 }));
  assert.match(out, /width:110px/);
  assert.match(out, /font-variant-numeric:tabular-nums/);
});

test("panel.module.css draws the notice card at 560px with a 16px corner", () => {
  const css = readFileSync(new URL("./panel.module.css", import.meta.url), "utf8");
  assert.match(css, /\[data-variant="notice"\]\s*\{[^}]*width: 560px;[^}]*padding: 34px 32px;/);
  assert.match(css, /\.panel\s*\{[^}]*border-radius: 16px;/);
});
