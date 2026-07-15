---
title: Charm 2.0 Spec — Focus mode and do-not-disturb
type: spec
project: Charm 2.0
created: 2026-07-13
status: shipped
---

## Implementation status

**Shipped in [PR #249](https://github.com/CloudHub-Social/Charm/pull/249), behind
the default-off `focus_mode` flag.** Settings and the desktop tray can set timed
or indefinite DND; native and push-decrypt notification paths suppress OS
notifications while unread and badge state continue to update. Native tray
behavior still lacks a recorded manual verification run.

:::note[Historical baseline]
The proposal below predates PR #249 and is retained as design history.
:::

**Workstream:** one PR / one agent. Client-local state plus a filter over Spec 11's
existing push/notification pipeline.

## Problem & why now

Charm 1.0 lets a user mute all notifications globally for a period ("Do not
disturb") independent of per-room notification settings (Spec 08 covers per-room
rules; this is the global override on top). Charm 2.0 has no equivalent — the only
way to quiet the app today is muting rooms individually, which doesn't scale past a
handful of rooms and doesn't help for "I'm in a meeting for the next hour." This is
a small, high-value Day-1 gap flagged as "planned but unbuilt" in the parity
analysis.

## Non-goals

- Not OS-level Focus/DND integration (e.g. syncing with macOS Focus modes) — pure
  in-app toggle for this phase; OS integration is a plausible future enhancement,
  not built now.
- Not a scheduling system (e.g. "DND every weekday 9-5") — manual toggle with an
  optional timed auto-expire (e.g. "for 1 hour"), not a recurring schedule.
- Not per-room DND — that's what mute already does (Spec 08); this is a single
  global override.

## High-level design

- New global setting, `doNotDisturb: { enabled: boolean, until: timestamp | null }`,
  in the same local settings store as other client-local preferences (Spec 09's
  theme, Spec 27's layout mode).
- Toggle surface: quick-access control (e.g. in the app's tray/menu-bar icon menu
  from Spec 10, plus a settings panel entry) with preset durations (30m, 1h, 8h,
  "until I turn it off").
- Enforcement point: wherever Spec 11's push-decrypt/notification-dispatch pipeline
  decides whether to actually surface an OS notification — gate on `!doNotDisturb ||
  now > doNotDisturb.until`, auto-clearing the flag once `until` passes rather than
  requiring the user to remember to turn it back off.
- In-app badge counts / unread state are **not** suppressed by DND — DND only
  silences OS-level notification pop-ups/sounds, matching Charm 1.0's behavior
  where the app still tracks unreads, it just doesn't interrupt you about them.
- Visual indicator: a small icon/badge in the app chrome while DND is active, so the
  state is never invisible (a common complaint pattern with silent DND modes is
  forgetting it's on).

## Data flow

Purely local — no Matrix account-data sync in this phase (DND is a "this device,
right now" concept in Charm 1.0 too, not a cross-device synced preference). State
lives in the same local settings persistence Spec 09 already uses.

## API/contract changes

No IPC/Rust changes if notification dispatch already happens frontend-side; if
Spec 11's push-decrypt path is Rust-side and makes the "should I notify" decision
there, add a Rust-visible flag it can read (small addition to whatever config
Spec 11 already threads through). Confirm which side owns the decision before
implementing — do not duplicate the check on both sides.

## Testing strategy

- Settings/store test: toggling on, off, timed-expire auto-clear.
- Notification-dispatch test: with DND active, a would-be-notified event does not
  produce an OS notification call; with DND expired (`until` in the past), it does.
- Manual: verify tray icon reflects DND state, and unread badge counts still
  increment while DND is on (confirms non-goal boundary is respected).

## Trade-offs

- **No OS Focus integration in v1**: OS-level Focus API integration varies
  significantly per platform (macOS Focus filters, Windows Focus Assist, no
  equivalent on Linux) and would multiply this into a per-platform spec; ship the
  simple in-app toggle first, revisit OS sync only if requested.

## What I'd revisit as this grows

- OS Focus-mode sync (auto-enable Charm DND when the OS enters a Focus mode) if
  users ask for it — platform-specific follow-up work, not blocking this spec.
- Scheduled/recurring DND windows if manual toggling proves to be genuinely
  annoying in practice rather than just theoretically nice-to-have.
