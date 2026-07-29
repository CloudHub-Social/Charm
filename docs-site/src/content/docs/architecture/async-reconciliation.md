---
title: Async reconciliation
description: Ownership, freshness, and regression-test rules for asynchronous frontend state.
---

Charm's frontend receives state from several clocks at once: Matrix sync events,
Tauri or web IPC requests, React Query caches, optimistic mutations, and local
timers. Code that combines those clocks must make ownership and freshness
explicit. A late result is not necessarily the newest result.

## Design review conclusion

The presence, privacy-settings, and pinned-message review histories originally
looked like one shared race-condition pattern. They are not one algorithm:

- privacy settings serialize authoritative, account-owned writes;
- pinned messages invalidate room-owned previews from Matrix events; and
- presence labels advance from a locally anchored elapsed-time value.

Sharing a generic "reconciliation" helper across those features would hide the
different ownership and ordering rules. Keep the implementations feature-local,
but apply the invariants and tests below consistently.

## Required invariants

### Scope every result to its owner

An async result may update state only while the account, room, event, or session
that started it is still current.

- Account-owned writes must be canceled or made inert when the active account
  changes. `usePrivacySettings.ts` uses a write generation for that boundary.
- Room event listeners must close over the active room and unsubscribe when it
  changes. `PinnedMessagesPanel.tsx` scopes its query keys and event filters to
  `roomId`.
- Local timers must be replaced when their source observation changes.
  `PresenceDot.tsx` anchors elapsed time to each received presence observation.

Do not rely on component unmounting alone. Tauri invocations and already-started
promises can still settle after React Query or React has stopped observing them.

### Make freshness monotonic

Starting later and finishing later are different facts. When results can settle
out of order, reserve a monotonically increasing sequence at start time and only
let a result replace confirmed state when it is still the newest eligible
confirmation.

For serialized writes, also distinguish:

- the latest optimistic mutation, which owns the visible cache;
- the latest successfully persisted snapshot, which owns rollback; and
- the current account generation, which owns permission to write at all.

An optimistic value is never a safe rollback target until its write has been
confirmed.

### Invalidate only on meaningful change

Matrix sync can repeat equivalent events. Refetch only when the source event,
decryption state, or room details can change the rendered result.

`PinnedMessagesPanel.tsx` fingerprints the relevant preview fields and ignores
unchanged timeline emissions. This avoids a feedback loop in which every sync
causes another fetch while still ensuring redactions, edits, decryption, and
pinned-id changes become visible.

### Fail closed across account and room switches

If ownership is uncertain, discard the late result and refetch for the current
owner. Never display an outgoing account's cached privacy values, reuse a
previous room's preview, or continue an elapsed-time anchor from another
presence observation.

## Regression-test matrix

Every reconciler must test the ordering that can break it, not only the ordinary
success path.

| Boundary | Required scenario | Current coverage |
| --- | --- | --- |
| Account write queue | A queued old-account write becomes inert after logout or account switch | `usePrivacySettings.test.tsx` |
| Optimistic cache | An older mutation settles after a newer optimistic mutation | `usePrivacySettings.test.tsx` |
| Rollback | A later failed mutation restores the last persisted snapshot, not an optimistic layer | `usePrivacySettings.test.tsx` |
| Query confirmation | A canceled or stale fetch resolves after a newer mutation confirms | `usePrivacySettings.test.tsx` |
| Room event stream | A relevant pinned event changes, redacts, decrypts, or becomes unresolved | `PinnedMessagesPanel.test.tsx` |
| Duplicate room event | An equivalent timeline update does not refetch | `PinnedMessagesPanel.test.tsx` |
| Local timer | A fresh presence observation re-anchors even when its elapsed value is numerically identical | `PresenceDot.test.tsx` |
| Feature gate | Turning privacy controls off removes private presence detail and timer work | `PresenceDot.test.tsx` |

Use deferred promises and fake timers so each test controls the exact settlement
order. A test that lets the runtime choose the order cannot prove a race is
closed.

## Review checklist

Before merging asynchronous state changes:

1. Name the authoritative owner and the cache/query key.
2. Identify every operation that can outlive that owner.
3. Define which sequence, generation, or fingerprint establishes freshness.
4. Define the rollback source separately from the optimistic value.
5. Add a test where the stale operation settles last.
6. Add an account- or room-switch test when state is user- or room-scoped.

Introduce a reusable coordinator only when two callers share the same owner,
clock, cancellation behavior, and rollback semantics. Similar-looking promises
are not enough.
