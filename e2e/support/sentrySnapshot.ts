import type { Page } from "@playwright/test";

// Mirrors .storybook/test-runner.ts's capture pattern: when
// SENTRY_SNAPSHOT_CAPTURE is set (only the sentry-snapshots CI job's e2e step sets
// it), write a deterministic screenshot for upload to Sentry's visual-snapshot
// system. A no-op otherwise, so every other e2e run (local dev, the plain `e2e` CI
// job) is unaffected by calling this.
//
// This is additive to the Storybook snapshots, not redundant with them: Storybook
// captures components in isolation, while these capture full compositions after a
// real interaction sequence against the mocked Tauri IPC backend — regressions in
// how components combine (e.g. a reaction pill's spacing once real message state
// surrounds it) can pass every Storybook snapshot and still show up here.
const captureDir = process.env.SENTRY_SNAPSHOT_CAPTURE
  ? (process.env.SNAPSHOT_OUT ?? ".artifacts/sentry-e2e-snapshots")
  : null;

/**
 * Captures a viewport screenshot named `name` for Sentry visual-regression
 * baselines. Call this after the assertions that establish the state you want to
 * capture are already settled — this does not itself wait for anything.
 *
 * Resets every scrollable element (and the page itself) to its scroll-top
 * position first. No test asserts on a scrolled-down state before capturing,
 * so any non-zero scrollTop at capture time is incidental — usually
 * Playwright's own auto-scroll-into-view bringing a below-the-fold element
 * (e.g. a button in a long settings panel) into view before clicking it. That
 * auto-scroll's exact resting offset isn't guaranteed stable run-to-run, which
 * showed up as a flaky diff behind an otherwise-static dialog
 * (`settings-logout-confirm`, where the "Log out" button lives near the
 * bottom of the Account panel's scrollable content).
 */
export async function captureSnapshot(page: Page, name: string): Promise<void> {
  if (!captureDir) return;
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode as Element | null;
    while (node) {
      if (node.scrollTop !== 0 || node.scrollLeft !== 0) node.scrollTo(0, 0);
      node = walker.nextNode() as Element | null;
    }
  });
  await page.screenshot({
    path: `${captureDir}/${name}.png`,
    animations: "disabled",
  });
}
