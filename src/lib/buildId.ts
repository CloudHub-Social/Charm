import packageJson from "../../package.json";

/**
 * Spec 24's canonical build identifier
 * (`{version}+{short_sha}` / `{version}+pr{number}.{short_sha}` /
 * `{version}+nightly.{short_sha}`), computed once in CI by
 * `scripts/compute-build-id.mjs` and exposed to the JS build as
 * `VITE_BUILD_ID` (Vite exposes any `VITE_`-prefixed env var present at
 * build time via `import.meta.env` automatically — no `vite.config.ts`
 * wiring needed).
 *
 * Falls back to the bare package version for local/dev builds where CI
 * hasn't set `VITE_BUILD_ID` — same "no CI env, show what we can" fallback
 * `instrument.ts`'s `release()` already used before this spec.
 */
export function getBuildId(): string {
  return import.meta.env.VITE_BUILD_ID || packageJson.version;
}

const BUILD_ID_PATTERN =
  /^(?<version>.+)\+(?:pr(?<pr>\d+)\.|(?<nightly>nightly)\.)?(?<sha>[0-9a-f]{7})$/;

/**
 * Human-friendly rendering of {@link getBuildId}'s canonical id, e.g.
 * `0.4.2 (sha-a1b2c3d)` for an ordinary build, `0.4.2-pr187 (sha-a1b2c3d)`
 * for a PR preview, `0.4.2-nightly (sha-a1b2c3d)` for a nightly build. Local/
 * dev builds with no CI-supplied build id (bare package version, no `+sha`
 * suffix) render as `{version}-dev` since there's no commit to show.
 *
 * The raw {@link getBuildId} value (not this formatted string) is what
 * should still be copied to the clipboard — it's the exact string a
 * reporter needs to paste into an issue/feedback form.
 */
export function formatBuildIdForDisplay(buildId: string): string {
  const match = buildId.match(BUILD_ID_PATTERN);
  if (!match?.groups) {
    return `${buildId}-dev`;
  }
  const { version, pr, nightly, sha } = match.groups;
  if (pr) return `${version}-pr${pr} (sha-${sha})`;
  if (nightly) return `${version}-nightly (sha-${sha})`;
  return `${version} (sha-${sha})`;
}
