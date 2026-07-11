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
