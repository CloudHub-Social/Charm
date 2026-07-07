import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Guards against a future e2e spec silently shipping with zero visual coverage:
 * fails if any spec file has neither a `captureSnapshot(` call nor an explicit
 * `snapshot-exempt:` opt-out comment explaining why it has nothing meaningful to
 * capture (e.g. appearance.spec.ts, which only asserts a `data-*` attribute before
 * paint — mirrors Charm 1.0's test:e2e:snapshot-coverage concept).
 */

const SELF = fileURLToPath(import.meta.url);
const E2E_DIR = path.dirname(SELF);
const EXEMPT_MARKER = "snapshot-exempt:";

test("every e2e spec captures a Sentry snapshot or explicitly opts out", () => {
  const specFiles = fs
    .readdirSync(E2E_DIR)
    .filter((file) => file.endsWith(".spec.ts") && file !== path.basename(SELF));

  const missing = specFiles.filter((file) => {
    const content = fs.readFileSync(path.join(E2E_DIR, file), "utf8");
    return !content.includes("captureSnapshot(") && !content.includes(EXEMPT_MARKER);
  });

  expect(
    missing,
    `spec(s) with no snapshot coverage and no opt-out: ${missing.join(", ")}`,
  ).toEqual([]);
});
