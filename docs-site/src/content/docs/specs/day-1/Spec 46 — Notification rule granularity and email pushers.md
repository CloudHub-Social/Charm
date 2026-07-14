---
title: Charm 2.0 Spec — Notification rule granularity and email pushers
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
sidebar:
  label: "Notification rule granularity"
---

**Workstream:** one PR / one agent. Extends Spec 08/11/18 (notifications), which
shipped a coarse notification model.

## Problem & why now

Charm 2.0 collapses notifications to one `RoomNotificationModeKind`
(all_messages / mentions_and_keywords_only / mute) as a default + per-room override
(`NotificationsPanel.tsx:325-360`), plus keyword push. Charm 1.0 exposes the full
Matrix push-rule matrix. The parity audit (2026-07-13) found these specific gaps:

1. **Per-category rule levels.** Charm 1.0 `notifications/AllMessages.tsx` gives
   independent loud/notify/off for **DM, Encrypted DM, Rooms, Encrypted Rooms**, and
   `SpecialMessages.tsx` gives independent levels for **Mention (user ID), Contains
   Display Name, Contains Username, and @room mention** (a separate toggle). Charm
   2.0 has none of this granularity — no encrypted-vs-unencrypted split, no separate
   displayname/username/@room rule levels, no loud-vs-notify distinction.
2. **Email notifications (`m.email` pusher).** Charm 1.0
   `SystemNotification.tsx:326-397` sets an `m.email` pusher (`setPusher`). Charm 2.0
   has no email-pusher path at all (confirmed absent).
3. **The "Sound" toggle is a no-op.** Charm 2.0's `NotificationsPanel.tsx:491`
   "Sound" checkbox stores a preference but "isn't wired up yet" — it doesn't
   actually control notification sound. Charm 1.0 has distinct in-app / system /
   in-app-sound / background-sound controls (`SystemNotification.tsx:1109-1188`).
4. **Notification device scope** (owner-promoted to firm 2026-07-13). Target the
   active client only vs all clients (Charm 1.0 `SystemNotification.tsx:1146`). No
   longer "include if trivial" — the owner wants it in.
5. **Notification content preview — default hidden** (owner-added 2026-07-13). Charm
   1.0 by default does **not** put message content in notifications; showing content
   is opt-in. Charm 2.0 should match: a "show message content in notifications"
   setting that defaults **off** (notifications say e.g. "New message in {room}"),
   with showing actual content opt-in — and for **encrypted rooms specifically**,
   content display is opt-in on top of that (privacy-preserving by default). The
   audit had wrongly called this "absent in both"; 1.0 has the hidden-by-default
   behavior.
6. **Notification inline actions** (owner-added 2026-07-13). Quick actions on the OS
   notification itself — reply and mark-as-read — without opening the app. Uses
   native notification action buttons on desktop (Spec 10's notification path) and
   push-notification actions on mobile (Spec 11). Absent in both today; owner wants
   it.

## Non-goals

- Not DND/focus mode (day-1 Spec 30, already spec'd).
- Not keyword push (already present in Charm 2.0).
- Not re-architecting the per-room override (that works) — this adds the *default*
  rule granularity beneath/beside it, and the pushers/sound.

## High-level design

- **Push-rule matrix UI:** expose the underlying Matrix push rules as Charm 1.0
  does — a settings section with per-category selectors:
  - Content/room categories: DM, Encrypted DM, Room, Encrypted Room — each
    loud / notify / off (mapping to the `m.push_rules` underride/room rules and
    their `notify` + `sound`/`highlight` actions).
  - Mention/keyword rules: mention (user ID), contains display name, contains
    username, @room — each with its own level.
  matrix-rust-sdk exposes push-rule read/set — confirm its API surface and prefer
  driving the actual server push rules over a Charm-local abstraction, so rules set
  here are honored by push (Spec 11) and by other Matrix clients.
- **Email pusher:** add/remove an `m.email` pusher for a verified email 3PID
  (`set_pusher`), with a settings toggle. Requires a verified email on the account
  (note the dependency; 3PID add/verify is absent in both clients per the audit, so
  this works for accounts that already have a verified email).
- **Wire the sound toggle:** connect the existing no-op "Sound" preference to actual
  notification sound behavior (Spec 10's native notification path / Spec 11's push
  path), and add the in-app-vs-system distinction if low-effort.

## Data flow

Push-rule read/set and pusher set/remove go through matrix-rust-sdk to the
homeserver (these are account-level, synced). New IPC: `get_push_rules() ->
PushRuleSet`, `set_push_rule(kind, level)`, `set_email_pusher(email, enabled)`.
Sound wiring connects the existing setting to the notification dispatch decision
(Spec 10/11).

## API/contract changes

New IPC for push-rule get/set and email pusher (ts-rs bindings). Sound wiring may
need no new command (just honoring the existing stored preference at dispatch time)
— confirm where the dispatch decision lives (frontend vs Rust, per Spec 11).

## Testing strategy

- Rust: push-rule get/set round-trips against the homeserver; email pusher
  add/remove; assert the rule shapes match Matrix `m.push_rules` semantics.
- Frontend: the per-category matrix renders current rule levels and updates them;
  email toggle reflects pusher state; sound toggle now actually gates sound (assert
  the dispatch respects it).
- Manual: set "Encrypted Rooms → off" and confirm an encrypted-room message no
  longer notifies while a DM still does; confirm the sound toggle audibly works.

## Trade-offs

- **Drive real push rules vs a Charm-local notification abstraction**: real push
  rules are honored server-side and by push (so notifications match on mobile too)
  and interoperate with other clients — a local abstraction would desync from
  what the server actually pushes.
- **Email pusher depends on a verified email**: acceptable given accounts commonly
  have one; full 3PID add/verify is a separate gap (absent in both clients) not
  scoped here.

## What I'd revisit as this grows

- 3PID add/verify flow (absent in both clients) if email pushers prove commonly
  blocked by users lacking a verified email.
- Notification-content-preview hide toggle (absent in both — not a current gap) if
  requested.
