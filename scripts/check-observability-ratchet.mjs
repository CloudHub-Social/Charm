#!/usr/bin/env node
// Ratchet check for e2e coverage and Sentry/tracing instrumentation call
// sites, mirroring how vitest.config.ts's coverage.thresholds already ratchet
// test coverage: floors are set to today's actual counts, CI fails if a PR
// drops below them, and the floor only ever moves up (by hand, in the same
// PR that adds the coverage) — never down just to make CI pass.
//
// This exists because CLAUDE.md/AGENTS.md ask for e2e coverage and Sentry
// instrumentation on relevant changes, but that's a soft instruction with no
// mechanical backstop — see observability-ratchet.json's own comment for the
// full rationale. This check is deliberately coarse (repo-wide counts, not
// per-PR diff analysis): it can't tell whether new code specifically needed
// more coverage, only that the codebase's total didn't regress. Combined
// with the PR checklist gate (which asks per-PR "did you add coverage here")
// this catches the case where someone deletes existing coverage without
// anyone noticing.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RATCHET_PATH = path.join(ROOT, "observability-ratchet.json");

// Plain `find`/`grep -r` rather than `git ls-files`/`git grep` with a glob
// pathspec: verified empirically that git's `**` pathspec magic does not
// reliably match files directly under the base directory (e.g.
// `src-tauri/src/lib.rs`), silently undercounting. `find`/`grep -r` walk the
// real filesystem, so a stray untracked file could inflate a count, but that
// risk is acceptable here — this only needs to fail closed on removed
// coverage, not police untracked files.
function countFiles(dir, filenamePattern) {
  const out = execSync(
    `find ${dir} -type f -name '${filenamePattern}'`,
    { cwd: ROOT }
  ).toString();
  return out.split("\n").filter(Boolean).length;
}

function countMatches(pattern, dir) {
  try {
    const out = execSync(`grep -rEc '${pattern}' ${dir}`, {
      cwd: ROOT,
    }).toString();
    // `grep -c` prints one "path:count" line per matching file.
    return out
      .split("\n")
      .filter(Boolean)
      .reduce((sum, line) => sum + Number(line.split(":").pop()), 0);
  } catch (err) {
    // grep exits 1 when there are zero matches — that's a legitimate count
    // of 0, not a failure.
    if (err.status === 1) return 0;
    throw err;
  }
}

const { _comment, ...floors } = JSON.parse(readFileSync(RATCHET_PATH, "utf8"));

const actual = {
  e2eSpecFiles: countFiles("e2e", "*.spec.ts"),
  // --exclude test/spec files: without it, mock assertions like
  // `expect(Sentry.captureException).toHaveBeenCalledWith(...)` count as
  // "instrumentation call sites", inflating the floor with test scaffolding
  // that says nothing about actual production coverage (found by Sentry's
  // own PR bot review — verified empirically: 9 of the original 11 matches
  // were in src/observability/ipc.test.ts).
  frontendSentryCallSites: countMatches(
    "Sentry\\.(captureException|captureMessage)|addBreadcrumb\\(",
    "src --include='*.ts' --include='*.tsx' " +
      "--exclude='*.test.ts' --exclude='*.test.tsx' " +
      "--exclude='*.spec.ts' --exclude='*.spec.tsx'"
  ),
  rustSentryCallSites: countMatches(
    "tracing::(info|warn|error|debug)!|sentry::|capture_event|add_breadcrumb",
    "src-tauri/src --include='*.rs'"
  ),
};

const failures = [];
for (const [key, floor] of Object.entries(floors)) {
  const count = actual[key];
  if (count === undefined) {
    failures.push(`Unknown ratchet key "${key}" in observability-ratchet.json`);
    continue;
  }
  if (count < floor) {
    failures.push(
      `${key}: ${count} is below the floor of ${floor} in observability-ratchet.json`
    );
  }
}

if (failures.length > 0) {
  console.error("Observability ratchet check failed:\n");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nIf coverage genuinely dropped (e.g. an e2e spec or Sentry call site " +
    "was removed without a replacement), restore it. If this is a false " +
    "positive from the ratchet's own counting logic, fix the script — do " +
    "not lower the floor to make CI pass without raising the underlying " +
    "coverage."
  );
  process.exit(1);
}

// console.error, not console.log: oxlint's no-console rule only allows
// warn/error (see oxlint.config.ts), and this script itself is linted.
console.error("Observability ratchet OK:");
for (const [key, floor] of Object.entries(floors)) {
  console.error(`  ${key}: ${actual[key]} (floor ${floor})`);
}
