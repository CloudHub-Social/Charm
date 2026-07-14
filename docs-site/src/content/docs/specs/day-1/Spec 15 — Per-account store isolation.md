---
title: "Charm 2.0 Spec — Per-account store isolation"
type: spec
project: Charm 2.0
created: "2026-07-05"
status: shipped
---

**Workstream:** one PR / one agent. **Tier:** foundational fix — can run concurrently
with Spec 14; land before Spec 08 (logout).

## Problem & why now

The SQLCipher store and its keychain entries are **single, fixed, per-app** — not
per-account (`persistence.rs`: `store_path()` = `app_data_dir()/matrix_store`; a single
`sqlite-store-passphrase` / `session` / `oauth-session` entry each; the code even notes
"per-app not per-account, matching the current single-account scope"). matrix-rust-sdk
binds the crypto store to the **first account that opens it**, so any second account
collides:

```
failed to read or write to the crypto store: the account in the store doesn't match the
account in the constructor: expected `@alice:localhost:…`, got
`@alice:example.org:…`
```

This reproduces in normal dev use (log into local Synapse, then into a remote homeserver) and
breaks logout-then-log-in-as-a-different-account. The planning doc §2.2 already specifies
the fix — **"Per-account = one SQLite DB per account"** — it's just unimplemented
(`MatrixState` defers per-account multiplexing). It's foundational and should land before
Spec 08's logout so the account lifecycle is coherent.

## Current state (in repo)

- `src-tauri/src/matrix/persistence.rs` — `store_path()` fixed at
  `app_data_dir()/matrix_store`; `KEYCHAIN_SERVICE = social.cloudhub.charm` with single
  per-app accounts `sqlite-store-passphrase`, `session`, `oauth-session`;
  `get_or_create_passphrase`, `save/load/clear_session`, `save/load/clear_oauth_session`.
- `src-tauri/src/matrix/mod.rs` — `build_client` opens the store at `store_path`; `login`
  / `try_restore_session` save/restore against the single entries; `MatrixState` holds one
  active `Client`.

## Scope (in)

1. **Isolate storage per account**: store dir and keychain entries keyed by a
   filesystem-safe derivation of the account MXID (`@user:server`) — e.g.
   `matrix_store/<hash(mxid)>`, `passphrase-<hash>`, `session-<hash>`,
   `oauth-session-<hash>`. Each account gets its own SQLCipher DB + crypto store +
   passphrase, so accounts never collide.
2. **Route each login to the right store:**
   - **Password:** the MXID is known before `build_client` (`@<username>:<resolved
     server_name>`) → open the per-account store directly.
   - **SSO / QR (account unknown until after auth):** build the client against a fresh
     per-login *temp* store dir; on successful auth, learn the MXID and **atomically
     relocate** the temp store to the per-account path (and its passphrase entry). If a
     store for that account already exists (re-login), reuse it and discard the temp.
3. **`try_restore_session`** restores against the correct per-account store (iterate saved
   per-account session entries; a single active client for now).
4. **Migration** of the existing single `matrix_store`: relocate it to its bound account's
   path on first launch, or — given Charm 2.0 is pre-release with no real users — a
   documented one-time dev wipe. Pick one and document it.

## Non-goals (out)

- **Multi-account UI / account switcher / multiple concurrent active clients** — that's
  the Day-2 multi-account feature. This spec does **storage isolation only** (the doc's
  "architect Day-1"), with a single active `Client` at a time.
- Any IPC-contract change (no new user-facing commands beyond what login already exposes).
- Key backup/recovery, cross-account key sharing.

## Design & approach

- **Account key:** a stable, filesystem-safe token derived from the full MXID (e.g.
  hex-encoded SHA-256 of `@user:server`, truncated). Used as the store subdir name and the
  keychain-account suffix. Keep the MXID→key mapping pure/deterministic so restore can
  recompute it.
- **`persistence.rs`:** parameterize `store_path`, `get_or_create_passphrase`, and the
  session save/load/clear helpers by account key (or MXID). Keep the `KEYCHAIN_SERVICE`
  constant; only the *account* portion of each entry gains the per-account suffix.
- **`mod.rs` / `build_client`:** take the store path as a parameter (or an account key).
  Password login computes it up front; SSO/QR use a temp path then relocate. Add a
  `relocate_store(temp_key, account_key)` helper (rename the dir + move/rewrite the
  passphrase entry) invoked once the flow yields a `user_id`.
- **Temp-store cleanup:** a login attempt that never completes (user cancels SSO/QR)
  should leave no orphan temp store — clean up on cancel and on a best-effort startup sweep.
- **`MatrixState`:** unchanged in shape for now (one active client); this spec only changes
  *where* that client's store lives. (Coordinates with Spec 14, which also touches
  `MatrixState`/`build_client` — see Sequencing.)

## Acceptance criteria

1. Logging in as account A, then (after clearing the session, not the store) as account B,
   succeeds — each uses its own store; no crypto-mismatch error.
2. The reported error (local-Synapse account followed by a remote account) no longer reproduces.
3. Each account's store dir, passphrase, and session/oauth-session entries are isolated
   and deterministically keyed by MXID.
4. Password, SSO, and QR logins all land in the correct per-account store (SSO/QR via the
   post-auth relocation), and cross-signing/crypto persists correctly for each.
5. `try_restore_session` restores against the correct per-account store.
6. A pre-existing single `matrix_store` is handled per the chosen migration (relocated, or
   a documented dev wipe) with no data-loss surprise for a logged-in user.
7. Cancelled SSO/QR logins leave no orphan temp store.
8. Full gate green (cargo fmt/clippy/test incl. the keychain-backed persistence tests,
   pnpm gate, bindings drift).

## Testing

- **cargo integration (local Synapse):** log in as two distinct accounts sequentially →
  no collision; each restores against its own store; cross-signing state is independent.
- **cargo unit:** MXID → account-key derivation is stable and filesystem-safe; per-account
  keychain round-trips (extend the existing real-keychain `persistence` tests); the
  relocate helper renames dir + passphrase correctly and is idempotent.
- SSO/QR relocation path exercised where the harness allows; cancelled-flow cleanup.

## Dependencies & sequencing

- **Independent of Spec 14** — different subsystem (persistence vs. timeline engine).
  **Can run concurrently.** Both touch `mod.rs` (`build_client` / `MatrixState`) but in
  different regions (14: sync-loop + per-room `Timeline` map; 15: store-path derivation +
  login/restore), so whichever merges first, the other rebases — no semantic collision, no
  shared IPC type.
- **Pairs with Spec 08 (logout):** 08 should clear the *per-account* session on logout but
  **keep** that account's store for fast re-login; a separate "forget this device" action
  wipes the store. Land 15 before or with 08 so those semantics are defined together.

## Risks & open questions

- **SSO/QR "account known only after auth"** is the fiddly part — the temp-store +
  post-auth relocation must be atomic and crash-safe (a crash mid-relocation shouldn't
  strand crypto state). Prefer a filesystem rename (atomic on same volume) over copy.
- **Passphrase relocation:** moving/rewriting the keychain passphrase entry alongside the
  dir rename must stay in sync, or the relocated store becomes undecryptable — sequence
  carefully (write new passphrase entry → rename dir → delete temp entry).
- **Migration of the existing store:** for a real logged-in user, relocation must preserve
  the bound account's crypto; if in doubt for pre-release, a documented wipe + re-onboard
  is acceptable given no production users yet.

## Effort estimate

**M** — the persistence parameterization + login/restore routing is moderate; the
genuinely tricky bit is the SSO/QR temp-store-then-relocate flow and keeping the passphrase
entry in lockstep with the dir rename.
