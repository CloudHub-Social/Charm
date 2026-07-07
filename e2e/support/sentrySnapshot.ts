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
 */
export async function captureSnapshot(page: Page, name: string): Promise<void> {
  if (!captureDir) return;
  await page.screenshot({
    path: `${captureDir}/${name}.png`,
    animations: "disabled",
  });
}
