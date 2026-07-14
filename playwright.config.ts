import { defineConfig, devices } from "@playwright/test";

/**
 * Runs against the plain Vite dev server (`pnpm dev`), not the native Tauri
 * webview — there's no `tauri-driver`/WebDriver harness here. The app's
 * Tauri IPC layer (`@tauri-apps/api`) is faked per-test via
 * `e2e/support/mockTauri.ts`, injected with `page.addInitScript` before the
 * app's own script runs, so `ChatShell`/`RoomsScreen` exercise their real
 * code paths against an in-memory fake backend instead of a real Tauri host
 * or homeserver. See that file for exactly what's faked and why.
 */
export default defineConfig({
  testDir: "./e2e",
  snapshotPathTemplate: process.env.FEATURE_DOCS_COMPARE
    ? "{testDir}/../docs-site/public/features/{arg}{ext}"
    : undefined,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "html",
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.FEATURE_DOCS_COMPARE
    ? undefined
    : {
        command: "pnpm dev",
        url: "http://localhost:1420",
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
