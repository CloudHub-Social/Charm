import { expect, test } from "@playwright/test";
import { captureSnapshot } from "./support/sentrySnapshot";

// Run both with capture enabled and disabled in CI. This preserves a bounded
// no-capture witness for the scroll-sensitive behavior affected by consolidation.
test("snapshot preserves background and foreground scroll state", async ({ page }) => {
  await page.setContent(`
    <div id="background" style="height:80px;overflow:auto"><div style="height:800px">background</div></div>
    <div role="dialog" data-state="open" id="foreground" style="height:80px;overflow:auto"><div style="height:800px">dialog</div></div>
  `);
  await page.locator("#background").evaluate((element) => element.scrollTo(0, 100));
  await page.locator("#foreground").evaluate((element) => element.scrollTo(0, 150));
  await captureSnapshot(page, "ci-scroll-state-witness");
  await expect
    .poll(() => page.locator("#background").evaluate((element) => element.scrollTop))
    .toBe(100);
  await expect
    .poll(() => page.locator("#foreground").evaluate((element) => element.scrollTop))
    .toBe(150);
});
