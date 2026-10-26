import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const patterns = {
  platform:
    "^(\\.gitignore$|src-tauri/|crates/|Cargo\\.(toml|lock)$|package\\.json$|pnpm-lock\\.yaml$|scripts/(check-ios-config\\.mjs|configure-personal-ios\\.mjs|configure-sideload-ios(\\.test)?\\.mjs|recover-altstore-source\\.mjs|update-altstore-source\\.mjs|personal-ios\\.sh|generate-third-party-licenses\\.mjs|sync-android-version-code\\.mjs|validate-changeset-packages\\.mjs|xcode27-swiftrs-tools/|license-texts/)|\\.github/(templates/altstore-source\\.json|workflows/(pr-checklist-gate|quality-checks|nightly)\\.yml)$|knope\\.toml$)",
  integration: "^dev/synapse/",
  companion:
    "^(crates/|src-tauri/|Cargo\\.(toml|lock)$|LICENSE$|NOTICE$|LICENSING\\.md$|THIRD_PARTY_NOTICES\\.md$|scripts/(generate-third-party-licenses\\.mjs|license-texts/)|\\.dockerignore$|\\.github/workflows/quality-checks\\.yml$)",
  frontend:
    "^(\\.gitignore$|src/|e2e/|\\.storybook/|public/|\\.design-sync/|scripts/((tokens-pull|review-envelope-contract\\.test|generate-third-party-licenses|sync-android-version-code|validate-changeset-packages|check-ios-config|check-ios-frontend-css|configure-sideload-ios|recover-altstore-source|update-altstore-source)\\.(mjs|test\\.mjs)|license-texts/)|\\.github/(templates/altstore-source\\.json|workflows/(pr-checklist-gate|quality-checks|release-builds|nightly)\\.yml|scripts/configure-sentry-release-env\\.sh)$|package\\.json$|pnpm-lock\\.yaml$|pnpm-workspace\\.yaml$|tsconfig.*\\.json$|vite\\.config\\.ts$|vitest\\.config\\.ts$|playwright\\.config\\.ts$|oxlint\\.config\\.ts$|oxfmt\\.config\\.ts$|knip\\.json$|components\\.json$|index\\.html$|knope\\.toml$)",
};
const full = () => ({
  platform: true,
  integration: true,
  frontend: true,
  browser: true,
  companion_container: true,
});
const matches = (kind, path) => new RegExp(patterns[kind]).test(path);
const browserWitness =
  /^(src-tauri\/src\/(bindings\/|feature_flags\.rs$)|docs-site\/(src\/data\/feature-gallery\.json$|public\/features\/)|scripts\/sync-feature-docs\.mjs$)/;
const toolingOnly = /^(oxlint\.config\.ts|oxfmt\.config\.ts|knip\.json)$/;
// Only known non-runtime surfaces may omit qualification. Unrecognized files
// deliberately widen, including new root configuration or build scripts.
const documentation =
  /^(docs\/|docs-site\/|\.changeset\/|\.agents\/|\.claude\/|AGENTS\.md$|CLAUDE\.md$|CONTRIBUTING\.md$|README\.md$)/;
export function selectJobs(paths) {
  if (!Array.isArray(paths)) return full();
  const result = Object.fromEntries(Object.keys(full()).map((key) => [key, false]));
  for (const path of paths) {
    if (
      typeof path !== "string" ||
      /[\r\n\0]/.test(path) ||
      !path ||
      path.startsWith("/") ||
      path.split("/").includes("..")
    )
      return full();
    if (
      /^(Cargo\.(toml|lock)$|package\.json$|pnpm-(lock\.yaml|workspace\.yaml)$|scripts\/ci\/|\.github\/(workflows|actions)\/)/.test(
        path,
      )
    )
      return full();
    const platform = matches("platform", path);
    const integration = platform || matches("integration", path);
    const frontend = matches("frontend", path) || browserWitness.test(path);
    const container = matches("companion", path);
    if (!platform && !integration && !frontend && !container && !documentation.test(path))
      return full();
    result.platform ||= platform;
    result.integration ||= integration;
    result.frontend ||= frontend;
    result.browser ||= frontend && !toolingOnly.test(path);
    result.companion_container ||= container;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let paths = null;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const kind = process.env.GITHUB_EVENT_NAME;
  const base =
    kind === "pull_request"
      ? event.pull_request?.base?.sha
      : kind === "merge_group"
        ? event.merge_group?.base_sha
        : kind === "push"
          ? event.before
          : null;
  const head = process.env.GITHUB_SHA;
  if (
    base &&
    /^[a-f0-9]{40}$/.test(base) &&
    !/^0+$/.test(base) &&
    /^[a-f0-9]{40}$/.test(head ?? "")
  ) {
    try {
      execFileSync("git", ["fetch", "--no-tags", "--depth=1", "--quiet", "origin", base], {
        stdio: "pipe",
      });
      const diff = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", base, head], {
        encoding: "utf8",
      });
      paths = diff.split("\0").filter(Boolean);
    } catch {
      console.log("::notice::Unable to resolve changed inputs; selecting all qualification lanes");
    }
  }
  const selected = selectJobs(paths);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(selected)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
  console.log(JSON.stringify({ revision: head, base, selected, fallback: paths === null }));
}
