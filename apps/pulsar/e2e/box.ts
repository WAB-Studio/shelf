import { expect, type Locator } from "@playwright/test";

// `boundingBox()` answers null while the element is not drawn yet; wait for it first.
export const boxOf = async (loc: Locator) => {
  await expect(loc).toBeVisible();
  return (await loc.boundingBox())!;
};
