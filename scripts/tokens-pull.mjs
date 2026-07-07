#!/usr/bin/env node
// Regenerates the GENERATED primitive + semantic regions of
// src/styles/tokens.css (Charm 2.0 Spec 09's "Claude Design sync contract").
//
// Claude Design is the intended system of record: token *values* should
// originate there and be pulled into tokens.css. As of this script, there
// is no headless MCP call that returns raw token values for a design
// project — the claude-design MCP's read_file/list_files surface component
// discovery artifacts (.d.ts prop contracts, .prompt.md composition notes,
// scraped Storybook CSS for the picker-card compare oracle), not a
// structured token export. Rather than fake a network call, this script
// pulls from a checked-in JSON file that stands in for that export:
// .design-sync/tokens/design-tokens.json. Swap `readTokens()` below for a
// real Claude Design MCP/API call once that export surface exists; every
// other part of the contract (banner markers, regeneration, drift-check)
// is already the real, permanent shape.
//
// Usage: `pnpm tokens:pull` (also run by CI's drift-check step).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOKENS_JSON_PATH = `${ROOT}.design-sync/tokens/design-tokens.json`;
const TOKENS_CSS_PATH = `${ROOT}src/styles/tokens.css`;

function readTokens() {
  return JSON.parse(readFileSync(TOKENS_JSON_PATH, "utf8"));
}

function cssVarLines(entries, indent = "  ") {
  return Object.entries(entries)
    .map(([name, value]) => `${indent}--${name}: ${value};`)
    .join("\n");
}

function renderPrimitiveBlock(primitive) {
  return [
    "/* GENERATED:PRIMITIVE:START */",
    ":root {",
    cssVarLines(primitive),
    "}",
    "/* GENERATED:PRIMITIVE:END */",
  ].join("\n");
}

function renderSemanticBlock(semantic) {
  const blocks = [
    "/* GENERATED:SEMANTIC:START */",
    ":root {",
    cssVarLines(semantic.dark),
    "}",
    "",
    '[data-theme="light"] {',
    cssVarLines(semantic.light),
    "}",
    "",
    '[data-theme="midnight"] {',
    cssVarLines(semantic.midnight),
    "}",
    "/* GENERATED:SEMANTIC:END */",
  ];
  return blocks.join("\n");
}

function replaceRegion(css, marker, replacement) {
  const startTag = `/* GENERATED:${marker}:START */`;
  const endTag = `/* GENERATED:${marker}:END */`;
  const start = css.indexOf(startTag);
  const end = css.indexOf(endTag);
  if (start === -1 || end === -1) {
    throw new Error(
      `tokens-pull: could not find GENERATED:${marker} region in ${TOKENS_CSS_PATH} — has the banner been removed?`,
    );
  }
  return css.slice(0, start) + replacement + css.slice(end + endTag.length);
}

function main() {
  const tokens = readTokens();
  let css = readFileSync(TOKENS_CSS_PATH, "utf8");
  css = replaceRegion(css, "PRIMITIVE", renderPrimitiveBlock(tokens.primitive));
  css = replaceRegion(css, "SEMANTIC", renderSemanticBlock(tokens.semantic));
  writeFileSync(TOKENS_CSS_PATH, css);
  // oxlint's no-console rule only allows warn/error — this is a one-shot CLI
  // script (run via `pnpm tokens:pull` and in CI's drift-check step), so a
  // plain status line on completion is the right signal, not a warning.
  console.error(`tokens-pull: regenerated GENERATED regions in ${TOKENS_CSS_PATH}`);
}

main();
