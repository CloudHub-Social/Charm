import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";

// @ts-expect-error process is a nodejs global
const procEnv = process.env as Record<string, string | undefined>;

const host = procEnv.TAURI_DEV_HOST;

// Source-map upload + Sentry release only run when an explicit release build
// requests upload and provides all three credentials. Every dev run and normal
// PR CI build leaves this unset, so the plugin is not added and the build does
// not create Sentry releases or emit source maps.
const sentryUploadRequested = procEnv.SENTRY_UPLOAD === "true";
const sentryUploadConfigured = Boolean(
  procEnv.SENTRY_AUTH_TOKEN && procEnv.SENTRY_ORG && procEnv.SENTRY_PROJECT,
);
const sentryEnabled = sentryUploadRequested && sentryUploadConfigured;
if (sentryUploadRequested && !sentryUploadConfigured) {
  throw new Error("SENTRY_UPLOAD=true requires SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT");
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  // Emit source maps only when Sentry will upload them; the plugin deletes the emitted
  // `.map` files after upload so they're never shipped to users.
  build: { sourcemap: sentryEnabled },
  plugins: [
    react(),
    tailwindcss(),
    ...(sentryEnabled
      ? [
          sentryVitePlugin({
            org: procEnv.SENTRY_ORG,
            project: procEnv.SENTRY_PROJECT,
            authToken: procEnv.SENTRY_AUTH_TOKEN,
            // Auto-detected from git if SENTRY_RELEASE isn't set; falls back to the
            // package version when a script sets `npm_package_version`.
            release: { name: procEnv.SENTRY_RELEASE || procEnv.npm_package_version },
            sourcemaps: { filesToDeleteAfterUpload: ["dist/**/*.map"] },
            // Annotate React components with data-sentry-* attributes so Sentry shows
            // component names in breadcrumbs/replay instead of raw CSS selectors.
            reactComponentAnnotation: { enabled: true },
          }),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@bindings": path.resolve(__dirname, "./src-tauri/src/bindings"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
