import type { Locator } from "@playwright/test";

/**
 * How a name sits in the browser: each word's characters on one line or not, the
 * lines it takes, its wrapping properties and where it ends. A name cut inside a
 * word has a word whose characters sit on two lines.
 */
export async function nameLayout(name: Locator) {
  return name.evaluate((el) => {
    const tops: number[] = [];
    const split: string[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      for (const match of text.matchAll(/\S+/g)) {
        const own: number[] = [];
        for (let i = 0; i < match[0].length; i++) {
          const range = document.createRange();
          range.setStart(node, match.index + i);
          range.setEnd(node, match.index + i + 1);
          const rect = range.getClientRects()[0];
          if (rect) own.push(Math.round(rect.top));
        }
        if (own.some((top) => Math.abs(top - own[0]) > 2)) split.push(match[0]);
        tops.push(...own);
      }
    }
    const lines = tops.filter((top, i) => tops.findIndex((t) => Math.abs(t - top) <= 2) === i);
    const style = getComputedStyle(el);
    return {
      split,
      lines: lines.length,
      overflowWrap: style.overflowWrap,
      wordBreak: style.wordBreak,
      ellipsis: style.textOverflow,
      bottom: el.getBoundingClientRect().bottom,
    };
  });
}
