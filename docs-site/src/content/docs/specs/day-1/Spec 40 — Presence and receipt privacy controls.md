---
title: Charm 2.0 Spec — Presence and receipt privacy controls
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent. Extends Spec 05 (read receipts, typing,
presence), which shipped the *display* of these but none of the user controls over
them.

## Problem & why now

The parity audit (2026-07-13) found an entire privacy-settings surface from Charm
1.0's `src/app/features/settings/General.tsx` (lines ~477-517) missing in Charm
2.0 — controls over what *you* broadcast. Charm 2.0 shows receipts/typing/presence
but gives the user no way to opt out, and the `setPresence` IPC even already exists
(`matrix.ts:469`) wired to no UI. These are standard privacy expectations; their
absence means a Charm 2.0 user is always broadcasting read receipts, typing, and
presence with no opt-out.

## Non-goals

- Not per-room receipt/typing privacy — global toggles, matching Charm 1.0.
- Not a redesign of how receipts/typing/presence are *displayed* (Spec 05) — this
  spec adds the controls and two small display additions (status message,
  last-active), not a rework.

## Scope

### Privacy toggles (new settings, wire to existing/available APIs)

1. **Hide read receipts** ("send read receipts" off) — Charm 1.0 `General.tsx:485`.
   When off, don't send `m.read` receipts (use the SDK's private-read-receipt /
   suppression path). Note: this typically also means you stop *seeing* others'
   receipts, per Matrix reciprocity — surface that trade-off in the setting's
   description.
2. **Hide typing indicators** — Charm 1.0 `General.tsx:477`. When off, don't send
   typing notifications from the composer (`useChatTyping` stops emitting).
3. **Presence enable / "appear offline"** — Charm 1.0 `General.tsx:493`. Wire the
   already-existing `setPresence` IPC to a real toggle so the user can appear
   offline / stop broadcasting presence.
4. **Auto-idle / away + idle timeout** — Charm 1.0 `General.tsx:503-517`
   (`autoIdlePresence`, `presenceIdleTimeoutMins`). Automatically set presence to
   unavailable after N minutes of inactivity; needs an idle-detection loop (reuse
   Spec 10's native-shell activity signals if available, else a frontend
   idle-timer).

### Small display additions (finish what Spec 05's DTO already carries)

5. **"Seen by N" expandable list** — Charm 1.0 opens a read-receipt modal
   (`RoomViewFollowing.tsx:51`). Charm 2.0's receipt chip (`BubbleMessageRow.tsx:211`)
   is static; make it clickable to show the full ordered list of who's read to that
   point. (Overlaps Spec 37's "read-by list" — implement once, in whichever lands
   first; they're the same feature.)
6. **Render presence status message + last-active-ago** — both fields
   (`status_msg`, `last_active_ago_ms`) already exist in the `PresenceUpdate` DTO
   but are never shown. Surface them on the presence indicator / profile card
   (Spec 36 hosts the profile version).

## Data flow

Mostly settings + existing APIs: `setPresence` already exists; receipt/typing
suppression are SDK settings/flags — confirm the matrix-rust-sdk surface for
private read receipts and typing suppression. Idle detection is a frontend/native
timer feeding `setPresence`. The seen-by list needs the per-event receipt map Spec
05 already computes (`useReadReceipts`) — just expose the full list, not a count.

## API/contract changes

- Wire existing `setPresence` to UI (no new command).
- Possibly new flags/commands for receipt/typing suppression if the SDK needs them
  set Rust-side rather than being pure send-time decisions.
- No DTO changes for status-message/last-active (already present).

## Testing strategy

- Frontend: each toggle persists and, when off, suppresses the corresponding send
  (assert no `m.read`/typing/presence emitted); idle timer flips presence after the
  configured timeout; seen-by chip expands to the full list.
- Rust: presence set correctly (including appear-offline); receipt/typing
  suppression honored.
- Manual: with "hide read receipts" on, confirm a second client doesn't see your
  read marker advance; confirm appear-offline shows you offline to others.

## Trade-offs

- **Global vs per-room privacy**: global matches Charm 1.0 and the mental model
  ("I'm private" is a person-level stance, not per-room); per-room would multiply
  the surface for little real benefit.
- **Reciprocity disclosure for read receipts**: rather than silently changing
  behavior, the setting explains that hiding your receipts also hides others' —
  avoids a confusing "why did everyone's read markers disappear" support issue.

## What I'd revisit as this grows

- OS-activity-driven idle (tie auto-away to real OS idle via Spec 10) if the
  frontend timer proves inaccurate (e.g. app backgrounded).
