import { changedInputs } from "./changed-inputs.mjs";
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

// Keep the existing native and web input surfaces; shared resolver changes
// only the comparison trees. Unknown inputs remain conservative.
const iosPattern =
  /^(\.gitignore$|src-tauri\/|crates\/|Cargo\.(toml|lock)$|package\.json$|pnpm-lock\.yaml$|scripts\/(check-ios-frontend-css\.mjs|ios-build-diagnostics\.sh|check-ios-config\.mjs|configure-personal-ios\.mjs|configure-sideload-ios(\.test)?\.mjs|update-altstore-source\.mjs|personal-ios\.sh|generate-third-party-licenses\.mjs|xcode27-swiftrs-tools\/|license-texts\/)|\.github\/(templates\/altstore-source\.json|workflows\/(ios-release-evidence|quality-checks|nightly|release-builds)\.yml)$)/;
const webPattern =
  /^(src\/|public\/|\.design-sync\/|src-tauri\/src\/bindings\/|\.env$|\.env\.web$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig.*\.json$|vite\.config\.ts$|index\.html$|LICENSE$|NOTICE$|LICENSING\.md$|THIRD_PARTY_NOTICES\.md$|scripts\/(generate-third-party-licenses\.mjs$|license-texts\/)|\.github\/actions\/build-web-worker\/|\.github\/workflows\/web-preview\.yml$)/;
const unknownInput = (path) => Object.values(selectJobs([path])).every(Boolean);
export const selectIos = (paths) =>
  paths === null || paths.some((path) => iosPattern.test(path) || unknownInput(path));
export const selectWeb = (paths) =>
  paths === null || paths.some((path) => webPattern.test(path) || unknownInput(path));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let event = {};
  try {
    const parsed = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) event = parsed;
  } catch {
    // Missing/malformed event input must select every lane.
  }
  const eventName = process.env.GITHUB_EVENT_NAME;
  const revision = process.env.GITHUB_SHA;
  const resolved = changedInputs({ eventName, event, revision });
  const lane = process.argv[2];
  const selected =
    lane === "ios"
      ? { ios: eventName !== "pull_request" || selectIos(resolved.paths) }
      : lane === "web"
        ? { web: eventName !== "pull_request" || selectWeb(resolved.paths) }
        : selectJobs(resolved.paths);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(selected)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
  const { paths, ...receipt } = resolved;
  process.stdout.write(
    `${JSON.stringify({ revision, eventBase: event.pull_request?.base?.sha, ...receipt, selected })}\n`,
  );
}
