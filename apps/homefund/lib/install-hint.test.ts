import assert from "node:assert/strict";
import { test } from "node:test";

import { isIosSafariTab } from "./install-hint";

const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const SAFARI_IPAD =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const CHROME_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1";

test("Safari in an iPhone tab is offered the hint; the installed app is not", () => {
  assert.equal(isIosSafariTab(SAFARI_IPHONE, false, 5), true);
  assert.equal(isIosSafariTab(SAFARI_IPHONE, true, 5), false);
});

test("an iPad posing as a Mac counts, a real Mac and Chrome on iOS do not", () => {
  assert.equal(isIosSafariTab(SAFARI_IPAD, false, 5), true);
  assert.equal(isIosSafariTab(SAFARI_IPAD, undefined, 0), false);
  assert.equal(isIosSafariTab(CHROME_IPHONE, false, 5), false);
});
