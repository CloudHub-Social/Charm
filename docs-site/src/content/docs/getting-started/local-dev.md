---
title: Local development
description: Get Charm running locally.
---

Charm 2.0 is a Tauri app: a Rust core (`src-tauri/`, using `matrix-rust-sdk`)
talking to a React/TypeScript frontend (`src/`) over typed IPC.

## Prerequisites

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

## Quality gate

Before committing, run the same checks CI enforces:

```sh
pnpm lint
pnpm fmt:check
pnpm typecheck
pnpm test:coverage
pnpm knip
pnpm build
```

See [CI / release tiers](/contributing/ci-tiers/) for how these fit into the
overall pipeline, and the repository's `CLAUDE.md` for the full contributor
guide (branching, worktrees, code-signing, etc.).
