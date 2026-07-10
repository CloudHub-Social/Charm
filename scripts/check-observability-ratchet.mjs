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
  const out = execSync(`find ${dir} -type f -name '${filenamePattern}'`, { cwd: ROOT }).toString();
  return out.split("\n").filter(Boolean).length;
}

// Uses `grep -n` (line contents), not `grep -c` (a bare count), so a
// commented-out call — `// Sentry.captureException(...)` or `//
// tracing::warn!(...)` — can be filtered out below. A raw `-c` count treats
// commenting out an instrumentation call the same as leaving it live, so a
// PR could silently disable Sentry coverage while the ratchet stays green
// (found by Codex's PR bot review). Only strips `//` line comments (both
// TS and Rust use them); a `/* */` block comment or a Rust `///` doc comment
// wrapping a call would still be miscounted as live — an accepted gap given
// how rare that shape is here, not worth the complexity of a real
// comment-aware parser for a repo-wide count.
function countMatches(pattern, dir) {
  try {
    const out = execSync(`grep -rnE '${pattern}' ${dir}`, {
      cwd: ROOT,
    }).toString();
    return out
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        const content = line.slice(line.indexOf(":", line.indexOf(":") + 1) + 1);
        return !/^\s*\/\//.test(content);
      }).length;
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
      "--exclude='*.spec.ts' --exclude='*.spec.tsx'",
  ),
  // Narrowed to actual event-emitting calls/macros, not every `sentry::`
  // reference — the original broad pattern also matched setup/config code
  // (sentry::init, sentry::ClientOptions, scrub_log's type signatures in
  // lib.rs), so a PR could delete real tracing::warn!/add_breadcrumb
  // instrumentation while those unrelated references kept the count above
  // the floor (found by Codex's PR bot review). Rust tests are inline `mod
  // tests` in the same file rather than separate *.test.rs files (unlike the
  // frontend convention above), so this can't file-level exclude them the
  // same way; a test asserting on a real emitting call still counts.
  rustSentryCallSites: countMatches(
    "tracing::(info|warn|error|debug)!|capture_event|add_breadcrumb|capture_message",
    "src-tauri/src --include='*.rs'",
  ),
};

// Reject a PR that lowers a floor in observability-ratchet.json itself while
// also shrinking the underlying coverage — without this, the two checks
// above only ever compare against whatever floor the current diff ships, so
// lowering the floor and deleting the coverage in the same commit sails
// through green (found by Codex's PR bot review). Compare against
// origin/main's committed floors; if that's unavailable (no origin remote,
// first commit introducing this file, offline dev run), skip the
// decrease check rather than fail closed on an infra hiccup — the
// below-floor check above still catches a same-PR regression either way.
function baseFloors() {
  try {
    execSync("git fetch --depth=1 origin main", { cwd: ROOT, stdio: "ignore" });
    const raw = execSync("git show origin/main:observability-ratchet.json", {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    const { _comment: _baseComment, ...parsed } = JSON.parse(raw);
    return parsed;
  } catch {
    return null;
  }
}

const failures = [];
for (const [key, floor] of Object.entries(floors)) {
  const count = actual[key];
  if (count === undefined) {
    failures.push(`Unknown ratchet key "${key}" in observability-ratchet.json`);
    continue;
  }
  if (count < floor) {
    failures.push(`${key}: ${count} is below the floor of ${floor} in observability-ratchet.json`);
  }
  // A PR that adds coverage without raising the matching floor leaves the
  // floor stale, so a *later* PR can delete that same coverage and only
  // fall back to the old (still-passing) floor — the regression happens two
  // PRs removed from the floor edit that should have caught it (found by
  // Codex's PR bot review). Forcing floor === count keeps the ratchet
  // exact, not just a one-directional backstop.
  if (count > floor) {
    failures.push(
      `${key}: actual count ${count} is above the floor of ${floor} — raise the floor to ` +
        `${count} in observability-ratchet.json in this PR so the new coverage is locked in`,
    );
  }
}

// Deleting a ratchet key entirely (e.g. dropping "rustSentryCallSites" from
// observability-ratchet.json) would otherwise let a PR remove that metric's
// entire floor along with the coverage it was tracking — the loops above
// only walk the PR's own `floors`, so a removed key is invisible to them
// (found by Codex's PR bot review). Compare against origin/main's key set
// too: any key present on main must still be present here.
const base = baseFloors();
if (base) {
  for (const [key, baseFloor] of Object.entries(base)) {
    if (!(key in floors)) {
      failures.push(
        `${key}: present in origin/main's observability-ratchet.json (floor ${baseFloor}) but ` +
          "missing here — a ratchet key can't be silently dropped; restore it or raise this in " +
          "review if the metric is genuinely being retired",
      );
    }
  }
  for (const [key, floor] of Object.entries(floors)) {
    const baseFloor = base[key];
    if (baseFloor !== undefined && floor < baseFloor) {
      failures.push(
        `${key}: floor was lowered from ${baseFloor} to ${floor} in observability-ratchet.json — ` +
          "floors only ever move up; if coverage genuinely needs to shrink, that's a separate " +
          "conversation, not a silent edit to this file",
      );
    }
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
      "coverage.",
  );
  process.exit(1);
}

// console.error, not console.log: oxlint's no-console rule only allows
// warn/error (see oxlint.config.ts), and this script itself is linted.
console.error("Observability ratchet OK:");
for (const [key, floor] of Object.entries(floors)) {
  console.error(`  ${key}: ${actual[key]} (floor ${floor})`);
}
