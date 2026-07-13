// Regenerates the .d.ts declaration tree the claude.ai/design converter reads
// for component discovery. Charm is a noEmit Tauri app with no dist/, so the
// converter's `exportedNames`/`projectFor` (which only read real .d.ts) find
// nothing without this. Emits component declarations from src, then writes the
// barrel that package.json `types` points at.
//
// Run by the design-sync driver via cfg.buildCmd before each build; also
// runnable by hand: `node .design-sync/gen-types.mjs`.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// Run tsc's JS entry via the current node binary rather than node_modules/.bin/tsc
// (that shim is a POSIX shell script; Windows would need tsc.cmd). This spelling
// is cross-platform.
const require = createRequire(import.meta.url);
const tscBin = require.resolve("typescript/bin/tsc");
execFileSync(process.execPath, [tscBin, "-p", ".design-sync/tsconfig.ds-types.json"], {
  stdio: "inherit",
});

// Keep in sync with .design-sync/ds-entry.ts (the runtime bundle entry).
const modules = [
  "avatar",
  "button",
  "dialog",
  "dropdown-menu",
  "input",
  "label",
  "popover",
  "switch",
  "tabs",
  "tooltip",
];
const barrel = modules.map((m) => `export * from "./components/ui/${m}";`).join("\n") + "\n";
writeFileSync(".design-sync/types/ds-entry.d.ts", barrel);
console.log(`gen-types: emitted declarations + barrel for ${modules.length} components`);
