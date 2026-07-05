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
        // 2026-07-05, after the PR #11 review-fix pass: lines 47.64 / statements
        // 45.75 / functions 39.07 / branches 50.72), so any regression fails CI.
        // When you add tests and coverage rises, raise these to the new floor in
        // the same PR — never lower them to make CI pass.
        lines: 47,
        statements: 45,
        functions: 39,
        branches: 50,
      },
    },
  },
});
