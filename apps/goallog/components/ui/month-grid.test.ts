import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// The month grid's day numbers are 14px text, so each tile's number needs 4.5:1 on its own fill, on the
// navy of both faces. The fills mix the sky into the hero's line colour, as `month-grid.module.css` says.
const root = join(import.meta.dirname, "..", "..");
const css = readFileSync(join(import.meta.dirname, "month-grid.module.css"), "utf8");
const theme = readFileSync(join(root, "app", "theme.css"), "utf8");

const token = (block: string, name: string) => {
  const found = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(block);
  assert.ok(found, `${name} in theme.css`);
  return found[1];
};
const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
const luminance = (hex: string) => {
  const [r, g, b] = channels(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const mix = (a: string, b: string, share: number) =>
  `#${channels(a).map((c, i) => Math.round(c * share + channels(b)[i] * (1 - share)).toString(16).padStart(2, "0")).join("")}`;

// What a level paints: its share of sky and the colour of its number (`ink` is the hero's own).
const rule = (level: number) => new RegExp(`\\.level${level}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

for (const [face, brand] of [["light", "light"], ["dark", "dark"]] as const) {
  const block = theme.slice(theme.indexOf(`.${brand} {`), theme.indexOf("}", theme.indexOf(`.${brand} {`)));
  const navy = token(block, "--pulsar-brand");
  const line = token(block, "--pulsar-brand-line");
  const sky = token(theme, "--pulsar-highlight");
  const ink = token(theme, "--pulsar-brand-ink");
  for (const level of [1, 2, 3, 4]) {
    test(`${face}: the number on level ${level} holds 4.5:1`, () => {
      const body = rule(level);
      const share = Number(/(\d+)%/.exec(body)?.[1] ?? 100) / 100;
      const fill = mix(sky, line, share);
      const text = /color:\s*var\(--pulsar-brand/.test(body) ? navy : ink;
      assert.ok(ratio(text, fill) >= 4.5, `level ${level} ${fill}: ${ratio(text, fill).toFixed(2)}`);
    });
  }
}
