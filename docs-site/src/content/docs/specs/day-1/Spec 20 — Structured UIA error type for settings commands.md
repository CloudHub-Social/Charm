---
title: "Charm 2.0 Spec — Structured UIA error type for settings commands"
type: spec
project: "Charm 2.0"
created: "2026-07-07"
status: shipped
sidebar:
  label: "Structured UIA error type"
---

**Workstream:** one PR / one agent. **Tier:** post-Day-1 correctness fix.

## Problem & why now

Flagged by Sentry Seer's automated review on [PR #57](https://github.com/CloudHub-Social/Charm/pull/57)
(comment 3539352737) as a pre-existing pattern across the whole app, not
introduced by that PR — hence its own spec rather than a fix bundled into
#57.

Four UIA-gated Tauri commands — `change_password`, `deactivate_account`
(`src-tauri/src/matrix/account.rs`), `delete_device`, `bootstrap_cross_signing`
(`src-tauri/src/matrix/devices.rs`) — all funnel through
`retry_uia_with_session` (`account.rs:60-93`). That helper already
distinguishes a UIA challenge from a real error server-side, via
`e.as_uiaa_response()`: `Some(info)` means "the homeserver wants
re-authentication, prompt for a password"; `None` means "this is an
unrelated failure (network error, 500, etc.)". But both branches collapse to
`.to_string()` before returning, so the distinction never crosses the IPC
boundary — every command returns a plain `Result<T, String>`.

On the frontend, four call sites reimplement the same broken heuristic
because they have nothing better to go on: catch the first error and assume
it means "needs password" —
`AccountPanel.tsx`'s `ChangePasswordDialog` (~223) and
`DeactivateAccountDialog` (~349), `DeviceRow.tsx`'s revoke flow (~69), and
`DevicesPanel.tsx`'s bootstrap flow (~48) all contain the identical
`if (!needsPassword) setNeedsPassword(true)` shape. A genuine network/server
error on the first attempt is confusingly shown as a password prompt, and
after the user enters a password the retry just fails again with the
original, unrelated problem — surfaced as a generic "incorrect password" or
similar, masking what actually went wrong.

No structured Tauri command error exists anywhere else in this codebase
today — every `#[tauri::command]` in `account.rs`/`devices.rs` currently
returns `Result<T, String>` — so this introduces a new (small, scoped)
pattern rather than extending one.

## Current state (in repo, verified 2026-07-07)

- `retry_uia_with_session` (`account.rs:60-93`): on `call(None).await` failure,
  matches `e.as_uiaa_response()`; `Some(info)` clones the UIA session id and
  retries with `AuthData::Password`; `None` returns `Err(e.to_string())`
  directly with a comment explaining exactly why ("retrying with a password
  would just produce a second, unrelated failure... masking what actually
  went wrong"). The final retry's own error is also `.map_err(|e|
  e.to_string())` (line 92) — so a UIA-flagged retry that itself fails (e.g.
  wrong password) is indistinguishable from anything else too.
- `change_password` (~340) and `deactivate_account` (~371) both call
  `retry_uia_with_session` and return its `Result<T, String>` unchanged.
- `delete_device` (`devices.rs:84`) and `bootstrap_cross_signing` similarly
  delegate to it.
- Frontend call sites (verified via grep): `AccountPanel.tsx:223`,
  `AccountPanel.tsx:349`, `DeviceRow.tsx:69`, `DevicesPanel.tsx:48` — each
  has its own local `needsPassword`/`setNeedsPassword` `useState` pair and an
  identical catch-block heuristic. No shared hook exists today.
- `ts-rs` (`ts-rs = "12.0.1"` in `src-tauri/Cargo.toml`) is already used for
  every other IPC struct (e.g. `ProfileSummary` in `account.rs`), exporting to
  `src/bindings/` and re-exported through `src/lib/matrix.ts` via the
  `@bindings/*` alias (per this repo's `CLAUDE.md`) — the same mechanism can
  export a new error enum.

## Scope (in)

1. **Rust**: introduce a small serializable error type, e.g.
   ```rust
   #[derive(Debug, Serialize, TS)]
   #[serde(tag = "kind")]
   #[ts(export, export_to = "../src/bindings/")]
   pub enum UiaCommandError {
       UiaChallenge,
       Other { message: String },
   }
   ```
   Change `retry_uia_with_session`'s return type from `Result<T, String>` to
   `Result<T, UiaCommandError>`. Return `UiaChallenge` on the `Some(info)`
   branch instead of discarding it; return `Other { message: e.to_string() }`
   everywhere else the helper currently stringifies (including the final
   retry's own failure at line 92 — a failed retry is a real error, not
   another challenge).
2. **Rust**: update `change_password`, `deactivate_account`, `delete_device`,
   `bootstrap_cross_signing` signatures to return
   `Result<T, UiaCommandError>`, and regenerate bindings
   (`cargo test --lib`) per this repo's IPC-types convention.
3. **Frontend**: add one shared hook, e.g. `useUiaRetry`, under
   `src/features/settings/` (or wherever the existing panels' shared
   utilities live), that wraps a UIA-gated action, owns the
   `needsPassword`/submitting state, and branches on
   `err.kind === "UiaChallenge"` — not "did it fail at all" — to decide
   whether to prompt for a password versus surface the error as-is.
4. **Frontend**: migrate all four call sites
   (`AccountPanel.tsx` ×2, `DeviceRow.tsx`, `DevicesPanel.tsx`) onto the new
   hook, removing the duplicated local state/heuristic.
5. **Tests**: extend the existing Rust unit tests in `account.rs`/`devices.rs`
   (they already cover the "needs a password on first attempt then succeeds"
   case — see `change_password_needs_a_password_on_first_attempt_then_succeeds`
   etc.) to assert on `UiaCommandError::UiaChallenge` specifically, and add a
   case where the first call fails with a non-UIA error (network/500) and
   assert it's `Other`, not silently treated as a challenge. Add
   Vitest/RTL coverage for `useUiaRetry` covering both branches.

## Non-goals (out)

- Any change to UIA retry *logic* (session threading, one-extra-round-trip
  probe) — that behavior in `retry_uia_with_session` is correct today; only
  its error *type* changes.
- A general-purpose structured-error convention for all Tauri commands
  across the app — scoped to the four UIA-gated commands only. If other
  commands later want structured errors, that's a separate spec informed by
  what this one learns.
- Any UI/visual change to the password-prompt dialogs themselves — only the
  branching condition that decides whether to show one changes.
- OAuth-account handling (`ProfileSummary.uses_oauth`) — unaffected; those
  flows already hide password-based actions before they'd ever hit this
  error path.

## Design & approach

- Keep `UiaCommandError` minimal (two variants) rather than a general error
  taxonomy — resist the urge to add more variants (e.g. splitting `Other`
  into network vs. server-error) unless a concrete need shows up; the
  frontend only needs the binary "challenge vs. not" distinction today.
- `#[serde(tag = "kind")]` gives the frontend a discriminated union
  (`{ kind: "UiaChallenge" } | { kind: "Other", message: string }`) that
  TypeScript can narrow on directly — no manual parsing needed.
- Follow this repo's git-worktree-isolation convention (`CLAUDE.md`).

## Acceptance criteria

1. `retry_uia_with_session` and all four commands that use it return
   `Result<T, UiaCommandError>` instead of `Result<T, String>`; the
   UIA-vs-other distinction survives the IPC boundary.
2. `useUiaRetry` (or equivalent) exists and is the single place that decides
   "show password prompt" vs. "surface error" for these four flows; the four
   call sites no longer contain their own copy of that heuristic.
3. A simulated non-UIA error (network failure, 500) on the first attempt
   surfaces as a real error message in all four flows, not a password
   prompt.
4. A genuine UIA challenge still round-trips exactly as before from the
   user's perspective (prompt → password → success).
5. `pnpm typecheck`, `pnpm test:coverage`, `cargo test`, `cargo clippy -D
   warnings` all pass; committed `src/bindings/` reflects the new enum with
   no drift from the Rust source.

## Testing

- Rust: extend existing `retry_uia_with_session`/`change_password`/
  `deactivate_account`/`delete_device` unit tests to assert on
  `UiaCommandError` variants; add a non-UIA-error case per command.
- Vitest/RTL: new tests for `useUiaRetry` (challenge branch, non-challenge
  branch) and updated tests for the four migrated components.
- No e2e changes expected — `mockTauri.ts`'s fake backend would need a way
  to simulate a non-UIA first-attempt failure if not already possible;
  check before assuming this is free.

## Dependencies & sequencing

- Independent of Spec 17 (room settings) and Spec 18 (global settings IA) —
  touches the same panel files but only their error-handling internals, not
  layout/structure. Fine to run concurrently or sequence either way; if
  Spec 18's shared card/row primitive migration lands first, migrate onto it
  in whichever PR touches these panels last to avoid conflicting diffs on
  the same files.
- No dependency on PR #57 itself landing first — this is a follow-up
  regardless of #57's fate.

## Effort estimate

**S** — one new small Rust enum, four signature changes, one new frontend
hook, four call-site migrations. Mechanical once the enum shape is settled;
main risk is bindings drift if `cargo test --lib` isn't re-run before commit.
