import path from "node:path";
import type { TestRunnerConfig } from "@storybook/test-runner";

// When SENTRY_SNAPSHOT_CAPTURE is set (only the `sentry-snapshots` CI job sets it), take a
// screenshot of every visited story into `.artifacts/sentry-snapshots/<id>.png` for upload
// to Sentry's visual-snapshot system. A no-op otherwise, so the `storybook-a11y` job —
// which runs the same test-runner without this env — is completely unaffected.
// @ts-expect-error process is a nodejs global
const env = process.env as Record<string, string | undefined>;
const captureDir = env.SENTRY_SNAPSHOT_CAPTURE
  ? (env.SNAPSHOT_OUT ?? ".artifacts/sentry-snapshots")
  : null;

const config: TestRunnerConfig = {
  async postVisit(page, context) {
    if (!captureDir) return;
    // Playwright creates parent dirs for the screenshot path; `animations: "disabled"`
    // keeps captures deterministic across runs.
    await page.screenshot({
      path: path.join(captureDir, `${context.id}.png`),
      animations: "disabled",
    });
  },
};

export default config;
