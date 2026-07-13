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
 * If a dialog (Radix `role="dialog"`) is open, resets scroll to top on
 * everything *outside* it — background bleed-through behind an otherwise-static
 * modal, never the state under test. Playwright's auto-scroll-into-view (e.g.
 * bringing a below-the-fold "Log out" button into view before clicking it)
 * leaves that background at a non-deterministic offset, which showed up as a
 * flaky diff on `settings-logout-confirm`. When no dialog is open, scroll is
 * left untouched: a scrolled-down settings panel can itself be the subject of
 * the snapshot (e.g. `settings-observability-opted-in` scrolls down to reach
 * "Send feedback" and captures that state), so resetting it there would hide
 * the very thing the test drove into view.
 */
export async function captureSnapshot(page: Page, name: string): Promise<void> {
  if (!captureDir) return;
  await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    if (dialogs.length === 0) return;
    const isBackground = (el: Element) => !dialogs.some((dialog) => dialog.contains(el));

    window.scrollTo(0, 0);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode as Element | null;
    while (node) {
      if ((node.scrollTop !== 0 || node.scrollLeft !== 0) && isBackground(node)) {
        node.scrollTo(0, 0);
      }
      node = walker.nextNode() as Element | null;
    }
  });
  await page.screenshot({
    path: `${captureDir}/${name}.png`,
    animations: "disabled",
  });
}
