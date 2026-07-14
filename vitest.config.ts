import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@bindings": path.resolve(__dirname, "./src-tauri/src/bindings"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.d.ts",
        "src/main.tsx",
        "src/providers.tsx", // composition root (provider wiring) — like main.tsx
        "src/test/**",
        "src/**/*.test.{ts,tsx}",
        "src/**/*.spec.{ts,tsx}",
        "src/**/*.stories.tsx",
        "src/components/ui/**",
        "src/bindings/**",
      ],
      thresholds: {
        // Deliberately enforced, unlike Charm 1.0's unenforced coverage collection.
        // These are a RATCHET: set to just under current actual coverage (as of
        // 2026-07-14, after merging Spec 30's focus-mode coverage with Spec 32's
        // room-alias-management and Spec 29's link-preview coverage. When tests
        // raise coverage, raise these floors in the same PR.
        lines: 85.4,
        statements: 83.5,
        functions: 76,
        branches: 83.1,
      },
    },
  },
});
