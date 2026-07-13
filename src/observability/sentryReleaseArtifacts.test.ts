import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const describeWithBash = process.platform === "win32" ? describe.skip : describe;

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function configureSentryReleaseEnv(env: Record<string, string | undefined> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "charm-sentry-release-env-"));
  const githubEnv = join(dir, "github-env");
  try {
    const result = spawnSync(
      "bash",
      [join(root, ".github/scripts/configure-sentry-release-env.sh")],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_ENV: githubEnv,
          SENTRY_AUTH_TOKEN: "token",
          SENTRY_ORG: "cloudhubsocial",
          SENTRY_PROJECT: "charm",
          GITHUB_SHA: "local-test-sha",
          ...env,
        },
      },
    );
    const githubEnvContents = result.status === 0 ? readFileSync(githubEnv, "utf8") : "";

    return { ...result, githubEnvContents };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Sentry release artifact workflow", () => {
  it("keeps the frontend release build guarded and uploadable to Sentry", () => {
    const workflow = readRepoFile(".github/workflows/release-builds.yml");
    const viteConfig = readRepoFile("vite.config.ts");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain('REQUIRE_VITE_SENTRY_DSN: "true"');
    expect(workflow).toContain('WRITE_FRONTEND_UPLOAD_ENV: "true"');
    expect(workflow).toContain("SENTRY_UPLOAD=true");
    expect(workflow).toContain("pnpm build");
    expect(workflow).toContain("find dist -name '*.map' -print -quit");
    expect(workflow).toContain("Sentry sourcemap upload left .map files in dist");
    expect(viteConfig).toContain("build: { sourcemap: sentryEnabled }");
    expect(viteConfig).toContain("sentryVitePlugin");
    expect(viteConfig).toContain(
      "release: { name: procEnv.SENTRY_RELEASE || procEnv.npm_package_version }",
    );
    expect(viteConfig).toContain('sourcemaps: { filesToDeleteAfterUpload: ["dist/**/*.map"] }');
    expect(viteConfig).toContain("reactComponentAnnotation: { enabled: true }");
  });

  it("keeps native debug files and Android build analysis wired to blocking uploads", () => {
    const workflow = readRepoFile(".github/workflows/release-builds.yml");
    const configureEnv = readRepoFile(".github/scripts/configure-sentry-release-env.sh");
    const androidGradle = readRepoFile("src-tauri/gen/android/app/build.gradle.kts");

    expect(workflow.match(/WRITE_RUST_DEBUG_ENV: "true"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(configureEnv).toContain("CARGO_PROFILE_RELEASE_DEBUG=1");
    expect(workflow.match(/@sentry\/cli@3\.5\.1 debug-files upload/g)).toHaveLength(3);
    expect(workflow.match(/--include-sources/g)?.length).toBeGreaterThanOrEqual(3);
    expect(workflow.match(/--wait/g)?.length).toBeGreaterThanOrEqual(3);
    expect(workflow).toContain('SENTRY_ANDROID_UPLOAD: "true"');
    expect(workflow).toContain("pnpm tauri android build --ci");
    expect(workflow).toContain("@sentry/cli@3.5.1 build upload");
    expect(workflow).toContain("--base-sha");
    expect(androidGradle).toContain("includeProguardMapping.set(true)");
    expect(androidGradle).toContain("autoUploadProguardMapping.set(true)");
    expect(androidGradle).toContain("uploadNativeSymbols.set(true)");
    expect(androidGradle).toContain("autoUploadNativeSymbols.set(true)");
    expect(androidGradle).toContain("includeNativeSources.set(true)");
  });

  it("documents manual dispatch requirements and Sentry-side verification", () => {
    const sentryDoc = readRepoFile("SENTRY.md");

    expect(sentryDoc).toContain("gh workflow run release-builds.yml");
    expect(sentryDoc).toContain("SENTRY_AUTH_TOKEN");
    expect(sentryDoc).toContain("VITE_SENTRY_DSN");
    expect(sentryDoc).toContain("Sentry-side verification");
    expect(sentryDoc).toContain("debug files");
    expect(sentryDoc).toContain("Size Analysis");
  });
});

describeWithBash("configure-sentry-release-env.sh", () => {
  it("writes frontend upload environment from manual dispatch inputs", () => {
    const result = configureSentryReleaseEnv({
      RELEASE_INPUT: "charm@2.0.0-test",
      ENVIRONMENT_INPUT: "staging",
      VITE_SENTRY_DSN: "https://public@example.invalid/1",
      REQUIRE_VITE_SENTRY_DSN: "true",
      WRITE_FRONTEND_UPLOAD_ENV: "true",
    });

    expect(result.status).toBe(0);
    expect(result.githubEnvContents).toContain("SENTRY_RELEASE=charm@2.0.0-test");
    expect(result.githubEnvContents).toContain("SENTRY_UPLOAD=true");
    expect(result.githubEnvContents).toContain("VITE_SENTRY_RELEASE=charm@2.0.0-test");
    expect(result.githubEnvContents).toContain("SENTRY_ENVIRONMENT=staging");
    expect(result.githubEnvContents).toContain("VITE_SENTRY_ENVIRONMENT=staging");
  });

  it("defaults to the Spec 24 canonical build id ({version}+{short_sha}) for both tag and branch builds", () => {
    // Spec 24 unifies release naming across tag pushes and ordinary commits
    // — both now use the same {version}+{short_sha} format computed by
    // scripts/compute-build-id.mjs, rather than the tag name (this
    // previously special-cased GITHUB_REF_TYPE=tag to use GITHUB_REF_NAME).
    const tagResult = configureSentryReleaseEnv({
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: "v0.1.0",
      GITHUB_SHA: "abc1234567",
    });
    const shaResult = configureSentryReleaseEnv({
      GITHUB_REF_TYPE: "branch",
      GITHUB_SHA: "def4567890",
    });

    expect(tagResult.status).toBe(0);
    expect(tagResult.githubEnvContents).toContain("SENTRY_RELEASE=0.1.0+abc1234");
    expect(shaResult.status).toBe(0);
    expect(shaResult.githubEnvContents).toContain("SENTRY_RELEASE=0.1.0+def4567");
  });

  it("computes a PR-preview build id via BUILD_ID_KIND/BUILD_ID_SHA/BUILD_ID_PR_NUMBER", () => {
    const result = configureSentryReleaseEnv({
      GITHUB_SHA: "merge-ref-sha-not-used",
      BUILD_ID_KIND: "pr",
      BUILD_ID_SHA: "a1b2c3d4e5",
      BUILD_ID_PR_NUMBER: "187",
    });

    expect(result.status).toBe(0);
    expect(result.githubEnvContents).toContain("SENTRY_RELEASE=0.1.0+pr187.a1b2c3d");
  });

  it("writes both BUILD_ID and VITE_BUILD_ID when WRITE_RUST_DEBUG_ENV is set", () => {
    // Native release/debug-file jobs (e.g. apple-debug-files) don't set
    // WRITE_FRONTEND_UPLOAD_ENV — that's the separate web/desktop sourcemap-
    // upload job's flag — but they still run Tauri's own frontend build via
    // beforeBuildCommand, bundling the JS AboutPanel straight into the
    // native app. That build needs VITE_BUILD_ID too, or it silently falls
    // back to the bare package version even with BUILD_ID correctly baked
    // into the Rust binary.
    const result = configureSentryReleaseEnv({
      GITHUB_SHA: "abc1234567",
      WRITE_RUST_DEBUG_ENV: "true",
    });

    expect(result.status).toBe(0);
    expect(result.githubEnvContents).toContain("BUILD_ID=0.1.0+abc1234");
    expect(result.githubEnvContents).toContain("VITE_BUILD_ID=0.1.0+abc1234");
  });

  it("fails before upload when required Sentry secrets are missing", () => {
    const result = configureSentryReleaseEnv({
      SENTRY_AUTH_TOKEN: "",
      SENTRY_ORG: "",
      SENTRY_PROJECT: "",
      VITE_SENTRY_DSN: "",
      REQUIRE_VITE_SENTRY_DSN: "true",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "::error::Missing required Sentry secret(s): SENTRY_AUTH_TOKEN SENTRY_ORG SENTRY_PROJECT VITE_SENTRY_DSN",
    );
  });

  it("rejects multiline release and environment values before writing GitHub env", () => {
    const releaseResult = configureSentryReleaseEnv({
      RELEASE_INPUT: "release\ninjection",
    });
    const environmentResult = configureSentryReleaseEnv({
      ENVIRONMENT_INPUT: "prod\ninjection",
      WRITE_FRONTEND_UPLOAD_ENV: "true",
      VITE_SENTRY_DSN: "https://public@example.invalid/1",
      REQUIRE_VITE_SENTRY_DSN: "true",
    });

    expect(releaseResult.status).toBe(1);
    expect(releaseResult.stdout).toContain(
      "::error::Sentry release names must be single-line values",
    );
    expect(environmentResult.status).toBe(1);
    expect(environmentResult.stdout).toContain(
      "::error::Sentry environment names must be single-line values",
    );
  });
});
