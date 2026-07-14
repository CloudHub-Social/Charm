---
title: Charm 2.0 Spec — Multi-account switcher UI
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent. Builds directly on Spec 15's existing
per-account storage groundwork.

## Problem & why now

Spec 15 (per-account store isolation) already solved the hard storage problem —
per-account SQLCipher stores and keychain entries, fixing the crypto-store
collision bug on second-account login. But per the parity gap analysis, there's
still **no UI** for a user to actually add a second account and switch between
them day-to-day — Spec 15 built the plumbing, not the switcher. Charm 1.0 has a
visible account switcher; Charm 2.0 users with multiple Matrix accounts (personal +
work, or multiple communities) currently have no in-client way to use more than
one.

## Non-goals

- Not simultaneous multi-account notification/badge aggregation across accounts in
  a single unified inbox view — this is a *switcher* (one active account at a time,
  matching Spec 15's architecture and most chat clients' actual UX), not a unified
  multi-account timeline merge.
- Not account-linking/SSO-federation between accounts — accounts remain fully
  independent logins, switcher just changes which one's data is currently active in
  the UI.

## High-level design

- Account switcher entry point: avatar/profile area in the room-list header (or
  wherever Spec 19's space-rail navigation currently shows the current user) gains
  a dropdown/menu listing all logged-in accounts (avatar, display name, homeserver)
  plus "Add account" and "Log out of this account."
- Switching: selecting a different account swaps the active
  session/store/crypto-context to that account's already-isolated Spec 15 store
  (no re-login needed if the account is already authenticated locally — this is
  "switch," not "log in again") and re-renders the whole app shell against that
  account's room list/timeline state.
- Badge aggregation (light version, not full unified inbox): the account switcher
  entry shows a small unread-count badge per account in the dropdown, so a user can
  see "account B has 3 unread" without switching to it — reuses each account's
  already-computed unread state from Spec 05/06, just surfaced in one more place.
- Adding an account: reuses the existing onboarding/login flow (Spec 12) but
  entered from "Add account" rather than first-run, landing back in the switcher
  afterward rather than replacing the whole app state.
- Notifications while a second account is inactive: push notifications (Spec 11)
  should still arrive for the inactive account if it's registered for push —
  confirm Spec 11's push-decrypt path already handles multi-account correctly
  (Spec 15 fixed storage collision, but verify push routing also disambiguates by
  account) since a notification for the wrong/inactive account silently not
  appearing would be a real regression here.

## Data flow

No new sync/store architecture — this consumes Spec 15's existing per-account
isolation. Primarily frontend state: "which account is currently active" becomes
top-level app state that gates which account's store/timeline/room-list data flows
into the rest of the UI tree.

## API/contract changes

Likely a small IPC addition to list all locally-known accounts (`list_accounts()
-> AccountSummary[]`) and to set the active one (`set_active_account(account_id)`)
if account selection needs to be Rust-aware (e.g. because the active account
determines which SQLCipher store/keychain entry subsequent commands operate
against). Confirm against Spec 15's actual implementation whether "active account"
is already a concept the Rust side tracks, or purely a frontend-side routing
decision today.

## Testing strategy

- Frontend: switcher lists all accounts from fixture data, switching re-renders
  app shell against the target account's state, badge counts per account are
  correct.
- Cross-account isolation regression test: confirm switching accounts never leaks
  timeline/room data from the previously active account into the newly active
  one's view, even momentarily during the transition (this was the class of bug
  Spec 15 fixed at the storage layer — this spec's job is to not reintroduce it at
  the UI layer).
- Manual: add a second real account, switch back and forth, confirm push
  notifications for the inactive account still arrive and correctly attribute to
  the right account when clicked (should switch to that account, not open the
  active one's view).

## Trade-offs

- **Switcher, not unified inbox**: matches Spec 15's storage architecture (one
  active store at a time) and avoids the significantly harder problem of merging
  encrypted timelines from multiple independent accounts into one view — revisit
  only if strong user demand for a true unified inbox emerges.

## What I'd revisit as this grows

- Unified cross-account notification badge in the OS tray/dock (sum across all
  accounts, not just the active one) if per-account switcher badges prove
  insufficient for users who genuinely monitor multiple accounts simultaneously.

## Related documentation

- [Spec 15: per-account store isolation](/specs/day-1/spec-15--per-account-store-isolation/)
  is the storage and security foundation for switching.
- [Spec 50: cross-device settings sync](/specs/day-1/spec-50--cross-device-settings-sync/)
  defines which preferences may follow an account.
- [Spec 48: desktop shell controls](/specs/day-1/spec-48--desktop-shell-and-settings-controls/)
  owns tray, dock, and window-level account affordances.
