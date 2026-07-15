---
title: Local development
description: Get Charm running locally.
---

Charm 2.0 is a Tauri app: a Rust core (`src-tauri/`, using `matrix-rust-sdk`)
talking to a React/TypeScript frontend (`src/`) over typed IPC.

## Prerequisites

- Node.js 22 or newer (Node.js 24 is required for the Storybook test runner)
- [pnpm](https://pnpm.io)
- Rust (stable toolchain)
- Platform build tools for [Tauri](https://tauri.app/start/prerequisites/)

## Run the app

```sh
pnpm install
pnpm tauri dev
```

## Web-only preview

The frontend also builds standalone for web preview/deploy targets:

```sh
pnpm dev          # Vite dev server
pnpm build:web    # web build
```

## Frontend quality gate

Before committing, run the frontend checks CI enforces:

```sh
pnpm lint
pnpm fmt:check
pnpm typecheck
pnpm test:coverage
pnpm knip
pnpm build
```

Rust changes also run formatting, clippy, and nextest in CI. Use the targeted
commands documented in `CONTRIBUTING.md` for the crate or platform you changed;
generated ts-rs bindings are refreshed by `cargo test --lib`.

See [CI / release tiers](../../contributing/ci-tiers/) for how these fit into the
overall pipeline, and the repository's `CLAUDE.md` for the full contributor
guide (branching, worktrees, code-signing, etc.).
