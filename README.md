# Charm

Charm 2.0 — a ground-up rewrite of the Charm Matrix client (matrix-rust-sdk over typed
Tauri IPC, new design language). This is the active `charm` project going forward.

> Charm 1.0 (the matrix-js-sdk client) now lives at `~/git/Charm-1.0`
> (GitHub: `CloudHub-Social/Charm-1.0`).

Charm 2.0 is under active pre-release development — expect breaking changes and
missing features.

## Getting started

```sh
pnpm install
pnpm tauri dev    # native desktop app
# or
pnpm dev          # frontend only, in a browser (no Tauri IPC)
```

Run `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, and `pnpm build` before
opening a PR — see [CONTRIBUTING.md](CONTRIBUTING.md) for the full quality gate
and contribution guidelines.

## Identity — keep it clean

This app publishes as plain **Charm**. Do **not** reintroduce a version suffix into any
published-facing identifier:

- `package.json` `name`: `charm`
- Tauri `productName`: `Charm`, `identifier`: `social.cloudhub.charm`
- deep-link scheme: `charm://`
- Cargo crate: `charm` / `charm_lib`

No `charm2`, `charm-2.0`, `Charm 2`, or `social.cloudhub.charm2` anywhere user- or
store-visible.

## Updater signing key

The real minisign keypair has been generated (`pnpm tauri signer generate -w
~/.tauri/charm-updater.key`) and the public half is in
`src-tauri/tauri.conf.json`'s `plugins.updater.pubkey`. The private key stays local,
password-protected, never committed. Still TODO before shipping updates for real:
add `endpoints` once a release/update server exists.

## Planning / source of truth

Scope, architecture, and design decisions live in the vault:
`Knowledge-Platform/10-19 Personal Life/15 Personal projects/15.12 Charm 2.0.md`.
