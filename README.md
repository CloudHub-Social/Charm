# Charm

Charm 2.0 — a ground-up rewrite of the Charm Matrix client (matrix-rust-sdk over typed
Tauri IPC, new design language). This is the active `charm` project going forward.

> Charm 1.0 (the matrix-js-sdk client) now lives at `~/git/Charm-1.0`
> (GitHub: `CloudHub-Social/Charm`).

## Identity — keep it clean

This app publishes as plain **Charm**. Do **not** reintroduce a version suffix into any
published-facing identifier:

- `package.json` `name`: `charm`
- Tauri `productName`: `Charm`, `identifier`: `social.cloudhub.charm`
- deep-link scheme: `charm://`
- Cargo crate: `charm` / `app_lib`

No `charm2`, `charm-2.0`, `Charm 2`, or `social.cloudhub.charm2` anywhere user- or
store-visible.

## Planning / source of truth

Scope, architecture, and design decisions live in the vault:
`Knowledge-Platform/10-19 Personal Life/15 Personal projects/15.12 Charm 2.0.md`.
