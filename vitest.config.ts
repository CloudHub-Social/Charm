import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
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
        "src/test/**",
        "src/**/*.test.{ts,tsx}",
        "src/**/*.spec.{ts,tsx}",
        "src/components/ui/**",
        "src/bindings/**",
      ],
      thresholds: {
        // Deliberately enforced, unlike Charm 1.0's unenforced coverage collection.
        // Set to roughly current actual coverage (pure logic + one presentational
        // component are tested; screens wired to Tauri IPC aren't yet) — ratchet
        // up as more of the app gets covered, don't lower to make CI pass.
        lines: 16,
        statements: 14,
        functions: 12,
        branches: 11,
      },
    },
  },
});
