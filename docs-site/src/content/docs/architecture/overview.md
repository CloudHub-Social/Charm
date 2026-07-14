---
title: Architecture overview
description: How Charm's Rust core, IPC layer, and frontend fit together.
---

Charm 2.0 is a ground-up rewrite of the Charm Matrix client, built on
[`matrix-rust-sdk`](https://github.com/matrix-org/matrix-rust-sdk) over typed
[Tauri](https://tauri.app) IPC, with a new design language.

```d2
direction: right
Rust core -> IPC bindings: ts-rs
IPC bindings -> React frontend: "@bindings/*"
Rust core: {
  shape: rectangle
}
React frontend: {
  shape: rectangle
}
```

## Layers

- **Rust core** (`src-tauri/src/`) — owns the Matrix session, sync loop, local
  storage, feature-flag catalog, and crypto state. This is the source of
  truth for anything that must be authoritative (flag defaults, IPC command
  contracts).
- **IPC bindings** — request/response and event types are defined once in
  Rust and exported to TypeScript via [`ts-rs`](https://github.com/Aleph-Alpha/ts-rs)
  into `src-tauri/src/bindings/`, regenerated as a side effect of
  `cargo test --lib`. The frontend imports these through the `@bindings/*`
  alias — never hand-edited.
- **React frontend** (`src/`) — the UI, in TypeScript, using TipTap for the
  composer, Tailwind for styling, and Vite for bundling. The same frontend
  build also targets a web-only preview mode alongside the native Tauri
  shell.

## Design principles

- **Prefer established libraries over bespoke implementations**, especially
  for solved problems that are also XSS/edge-case traps: rich text and HTML
  rendering, markdown, sanitization, syntax highlighting, math, emoji,
  GIFs, media playback, waveforms, fuzzy-matching, i18n, and date/time
  formatting.
- **New user-facing features ship behind a feature flag**, defaulting off,
  so they can be dark-launched and staged. See
  [Feature flags](../../contributing/feature-flags/).
- **IPC types are generated, not hand-written.** A Rust struct change is the
  only way to change a binding; CI fails if committed bindings drift from
  the Rust source.

For deeper architecture and design-decision history, see the project's
planning documents (not yet published here).
