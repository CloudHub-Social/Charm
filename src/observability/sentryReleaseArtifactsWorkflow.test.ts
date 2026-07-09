import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Sentry release artifact workflow", () => {
  const root = process.cwd();
  const workflow = readFileSync(
    resolve(root, ".github/workflows/sentry-release-artifacts.yml"),
    "utf8",
  );
  const viteConfig = readFileSync(resolve(root, "vite.config.ts"), "utf8");
  const releaseEnvScript = readFileSync(
    resolve(root, ".github/scripts/configure-sentry-release-env.sh"),
    "utf8",
  );
  const androidAppBuild = readFileSync(
    resolve(root, "src-tauri/gen/android/app/build.gradle.kts"),
    "utf8",
  );

  it("keeps manual release and environment inputs available", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toMatch(/release:\r?\n\s+description: "Sentry release name\./);
    expect(workflow).toMatch(/environment:\r?\n\s+description: "Sentry environment tag/);
    expect(workflow).toContain("default: production");
  });

  it("requires Sentry owner secrets before upload jobs run", () => {
    for (const secret of ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT", "VITE_SENTRY_DSN"]) {
      expect(workflow).toContain(`secrets.${secret}`);
    }

    expect(releaseEnvScript).toContain("required=(SENTRY_AUTH_TOKEN SENTRY_ORG SENTRY_PROJECT)");
    expect(releaseEnvScript).toContain("required+=(VITE_SENTRY_DSN)");
    expect(releaseEnvScript).toContain("Missing required Sentry secret(s)");
  });

  it("uploads frontend sourcemaps only from explicit Sentry release builds", () => {
    expect(workflow).toContain('REQUIRE_VITE_SENTRY_DSN: "true"');
    expect(workflow).toContain('WRITE_FRONTEND_UPLOAD_ENV: "true"');
    expect(releaseEnvScript).toContain("SENTRY_UPLOAD=true");
    expect(viteConfig).toContain('procEnv.SENTRY_UPLOAD === "true"');
    expect(viteConfig).toContain(
      "SENTRY_UPLOAD=true requires SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT",
    );
    expect(viteConfig).toContain("filesToDeleteAfterUpload");
    expect(viteConfig).toContain("dist/**/*.map");
    expect(workflow).toContain("Sentry sourcemap upload left .map files in dist");
  });

  it("uploads desktop and Apple debug files with source context and release debuginfo", () => {
    expect(workflow).toContain('WRITE_RUST_DEBUG_ENV: "true"');
    expect(releaseEnvScript).toContain("CARGO_PROFILE_RELEASE_DEBUG=1");
    expect(workflow).toMatch(/pnpm dlx @sentry\/cli@3\.5\.1 debug-files upload/);
    expect(workflow).toContain("--include-sources");
    expect(workflow).toContain("--wait");
    expect(workflow).toContain("pnpm tauri build");
    expect(workflow).toContain("pnpm tauri ios build --target aarch64-sim --debug --ci");
  });

  it("keeps Android mapping, native-symbol, and size-analysis uploads wired", () => {
    expect(workflow).toContain('SENTRY_ANDROID_UPLOAD: "true"');
    expect(workflow).toContain("pnpm tauri android build --ci");
    expect(androidAppBuild).toContain('System.getenv("SENTRY_ANDROID_UPLOAD") == "true"');
    expect(androidAppBuild).toContain("autoUploadProguardMapping.set(true)");
    expect(androidAppBuild).toContain("autoUploadNativeSymbols.set(true)");
    expect(androidAppBuild).toContain("includeNativeSources.set(true)");
    expect(workflow).toContain("pnpm dlx @sentry/cli@3.5.1 build upload");
    expect(workflow).toContain("--base-sha");
  });
});
