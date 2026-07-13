#!/usr/bin/env node
// Computes the canonical Charm build identifier described in Spec 24
// ("Build and release identification"). This is the single source of truth
// for the format — every CI workflow that needs a build id (
// release-builds.yml, web-deploy-dev.yml, web-preview.yml,
// nightly.yml) calls this script instead of recomputing its
// own variant, which is how today's inconsistency (full vs. short SHA, tag
// vs. SHA, plain version) crept in.
//
// Canonical formats:
//   ordinary commit : {version}+{short_sha}            e.g. 0.4.2+a1b2c3d
//   PR preview       : {version}+pr{number}.{short_sha} e.g. 0.4.2+pr187.a1b2c3d
//   nightly build    : {version}+nightly.{short_sha}    e.g. 0.4.2+nightly.a1b2c3d
//
// `+` is Cargo/semver build-metadata syntax (ignored in version comparisons),
// so this doesn't fight either ecosystem's version parsing.
//
// IMPORTANT for PR builds: `sha` must be the PR's actual head SHA
// (`github.event.pull_request.head.sha`), not `GITHUB_SHA` — on
// `pull_request` events `GITHUB_SHA` resolves to a synthetic merge-ref
// commit, not the commit the PR actually contains.

import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SHORT_SHA_LENGTH = 7;

/**
 * @param {object} opts
 * @param {string} opts.version - e.g. "0.4.2" (package.json's `version`).
 * @param {string} opts.sha - full commit SHA to derive the short SHA from.
 * @param {"" | "pr" | "nightly"} [opts.kind] - build kind. Defaults to "".
 * @param {string | number} [opts.prNumber] - required when kind is "pr".
 * @returns {string} the canonical build id.
 */
export function computeBuildId({ version, sha, kind = "", prNumber } = {}) {
  if (!version) {
    throw new Error("computeBuildId: version is required");
  }
  if (!sha) {
    throw new Error("computeBuildId: sha is required");
  }
  const shortSha = sha.slice(0, SHORT_SHA_LENGTH);
  if (shortSha.length < SHORT_SHA_LENGTH) {
    throw new Error(`computeBuildId: sha "${sha}" is shorter than ${SHORT_SHA_LENGTH} characters`);
  }

  switch (kind) {
    case "pr": {
      if (!prNumber) {
        throw new Error('computeBuildId: prNumber is required when kind is "pr"');
      }
      return `${version}+pr${prNumber}.${shortSha}`;
    }
    case "nightly":
      return `${version}+nightly.${shortSha}`;
    case "":
      return `${version}+${shortSha}`;
    default:
      throw new Error(
        `computeBuildId: unknown kind "${String(kind)}" (expected "pr", "nightly", or "")`,
      );
  }
}

/**
 * Coerces a caught value (which may not be an Error instance, since any
 * value can be thrown in JS) into a safe, human-readable string for logging.
 * @param {unknown} error
 * @returns {string}
 */
export function describeCaughtError(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    const json = JSON.stringify(error);
    if (json !== undefined) return json;
  } catch {
    // fall through to String() below
  }
  return String(error);
}

function readPackageVersion() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  return pkg.version;
}

function isMainModule() {
  // path.resolve() is a no-op on the already-absolute path Node puts in
  // process.argv[1] (verified across relative, ./-prefixed, subdirectory,
  // and shebang-direct invocation) — kept as cheap defense against any
  // invocation style that isn't already normalized.
  return (
    process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  );
}

// CLI entry point — reads inputs from the environment so every workflow can
// call this identically:
//   VERSION    - defaults to package.json's version.
//   SHA        - defaults to $GITHUB_SHA. For PR builds, callers MUST pass
//                the PR head SHA explicitly (see module comment above).
//   BUILD_KIND - "" (default) | "pr" | "nightly"
//   PR_NUMBER  - required when BUILD_KIND=pr
//
// Prints the build id to stdout. If $GITHUB_OUTPUT is set, also appends
// `build-id=<value>`. If $GITHUB_ENV is set, also appends `BUILD_ID=<value>`
// and `VITE_BUILD_ID=<value>` so later steps in the same job see it as a
// plain env var (and Vite picks up the VITE_-prefixed one automatically).
function main() {
  const version = process.env.VERSION || readPackageVersion();
  const sha = process.env.SHA || process.env.GITHUB_SHA;
  const kind = process.env.BUILD_KIND || "";
  const prNumber = process.env.PR_NUMBER;

  let buildId;
  try {
    buildId = computeBuildId({ version, sha, kind, prNumber });
  } catch (error) {
    console.error(`::error::${describeCaughtError(error)}`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${buildId}\n`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `build-id=${buildId}\n`);
  }
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `BUILD_ID=${buildId}\nVITE_BUILD_ID=${buildId}\n`);
  }
}

if (isMainModule()) {
  main();
}
