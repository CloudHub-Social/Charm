import type { OxfmtConfig } from "oxfmt";

export default {
  printWidth: 100,
  tabWidth: 2,
  singleQuote: false,
  trailingComma: "all",
  ignorePatterns: [
    // Preserve attributed upstream bytes; cargo fmt checks the Rust crate separately.
    "vendor/tauri-plugin-updater",
    "dist",
    "coverage",
    "node_modules",
    "src-tauri",
    "package.json",
    "pnpm-lock.yaml",
    "LICENSE",
    "README.md",
  ],
} satisfies OxfmtConfig;
