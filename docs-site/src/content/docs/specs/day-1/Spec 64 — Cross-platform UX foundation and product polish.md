---
title: "Charm 2.0 Spec — Cross-platform UX foundation and product polish"
type: spec
project: Charm 2.0
created: "2026-09-06"
status: in-progress
sidebar:
  label: "Cross-platform UX renewal"
---

## Implementation status

**In progress.** [Issue #539](https://github.com/CloudHub-Social/Charm/issues/539)
is the program ledger. The first slice establishes the default-off
`ux_refresh_v1` rollout gate, the account-scoped unread-DM rail model, the
gated application-rail treatment, and deterministic Storybook fixtures. The
legacy shell and preference schema remain the rollback path.

Spec 47's unfinished appearance work is preserved as a separate branch. Any
portable theme, font, density, spacing, or message-layout persistence introduced
here must be reconciled with that work before the two branches overlap. Pane
dimensions are device-local and must not enter cross-device appearance sync.

## Approved direction

![Sable-forward desktop direction: warm aubergine rail, charcoal room list, ink conversation canvas, and people-first unread-DM shortcuts](/design/spec-64/sable-forward-desktop.png)

This concept is directional rather than pixel evidence. Approved Storybook
fixtures provide the measured component contract. Deterministic CI screenshots
and native artifacts replace the concept as each implementation slice ships.

Charm combines:

- Discord-like conversational clarity and restrained message chrome;
- Sable-like personalization and people-first navigation; and
- Charm's own purple, mint, yellow, and speech-bubble identity.

Sable and Discord are references only. Do not copy their code, assets, branding,
or proprietary iconography.

The unread-DM behavior follows the public
[Sable notification design](https://docs.sable.moe/features/notifications/):
visible contacts carry their own attention state and the Direct Messages control
represents only the overflow.

## Measured visual contract

The spacing grid is 4px. Interactive targets are at least 44×44px.

| Region | Default | Allowed range | Behavior |
|---|---:|---:|---|
| Application rail | 80px | fixed | Always visible above compact layout; safe-area aware |
| Room sidebar | 280px | 240–360px | User-resizable on pointer-capable desktop; width is device-local |
| Conversation | flexible | minimum 360px | Prose measure is about 72 characters; media may be wider |
| Context panel | 320px | 280–420px | Optional on wide screens, overlay on medium screens |

The rail uses a warm aubergine surface, the room sidebar uses charcoal, and the
conversation uses a slightly lighter ink canvas. Purple is primary, mint means
presence/success, and yellow is reserved for small Charm/favourite/focus details.
Each dark, light, and midnight theme must preserve the same hierarchy rather than
reusing literal dark-theme values.

Typography uses the existing Manrope/JETBrains Mono families. Default conversation
copy is 15px with approximately 1.45 line height; room titles and sender names use
600 weight; timestamps and supporting metadata use 12px. Do not use weight alone
to communicate unread, selected, error, or presence state.

Motion uses existing duration tokens and honors reduced motion. Selection may
cross-fade or move over 120–200ms; no navigation state depends on animation.

## Application rail contract

The rail is ordered as follows:

1. Charm mark/Home.
2. Up to three recently active unread-DM avatars, each with its own unread,
   highlight, presence, tooltip, accessible label, and direct room action.
3. Direct Messages overflow. Its badge counts only additional unread DM
   conversations and highlights not represented by the visible avatars.
4. Activity for mentions, replies, invites, calls, and actionable failures.
5. Divider, then spaces and compact nested-space folder capsules.
6. Add Space and account switching at the bottom.

Unread DM shortcuts are derived from one account's joined-room snapshot. Sort by
descending `last_activity_ts`; ties and missing timestamps preserve the
authoritative room-list order. Never aggregate one unread conversation into both a
visible contact shortcut and the Direct Messages overflow badge.

Selected spaces use an organic plum backing and a short mint edge marker. Space
avatars are 44px. Avoid rectangular icon outlines and generic app-launcher imagery.
Ambient unread may use a subdued dot; use numerical badges where the exact number
helps the user act, including highlights and overflow.

The Activity and account-switcher positions are reserved by this information
architecture, but they must not be rendered as inert controls before their routes
exist.

## Room list, conversation, and composer

- Select rooms with a soft plum wash and a 3px lavender marker rather than a
  heavy gray slab or boxed border.
- Keep room rows full-width, with clear muted/offline/unread states, resilient
  truncation, and no layout shift when badges appear.
- Use flat grouped messages. Align avatar, sender, timestamp, reactions, receipts,
  pending/error state, hover/focus actions, date dividers, and unread dividers
  across layout modes without making the prose column excessively wide.
- Keep rich media wider than prose when space permits.
- Consolidate room identity, bridge/security status, search, calls, pins, members,
  and overflow actions in the header.
- Use one stable composer shell for text, formatting, reply/edit, uploads, voice,
  polls, GIFs, stickers, custom emoji, and image editing. Formatting controls are
  contextual, not permanently exposed.
- Preserve virtualization, scroll anchoring, local echoes, encryption state,
  drafts, media playback ownership, and offline recovery across layout changes.

## Responsive navigation model

The production shell will replace scattered visibility booleans with typed state
equivalent to:

- `PrimaryDestination` — Home, Direct Messages, Activity, or Space;
- `AppNavigationState` — active account, destination, space, room, contextual
  panel, and mobile route;
- `ContextPanelKind` — Threads, members, pins, room details, search, or none;
- `MobileRoute` — top-level destination, list, conversation, or contextual detail;
- `RailAttentionItem` — one account-scoped actionable rail shortcut; and
- `PanePreferences` — versioned device-local pane sizes and open state.

Responsive behavior:

- **Wide (≥1200px):** rail, room sidebar, conversation, and optional context panel.
- **Medium (768–1199px):** rail, sidebar, and conversation; context content overlays.
- **Compact (<768px):** one pushed pane at a time, native back behavior, safe-area
  and software-keyboard handling, and bottom navigation for top-level destinations.

Breakpoint transitions preserve deep links, active room, draft, scroll anchor,
call shelf, media playback ownership, and account isolation. Opening or closing a
pane must not remount the owner of a draft, upload, call, or playing media item.

## Essential destinations and remaining surfaces

- Activity composes Spec 57's events and actionable failures.
- Threads use the context panel on desktop and a pushed route on compact screens.
- Calls enter from the room header and persist in a call shelf across room changes.
- Emoji, GIF, sticker, and custom-emoji discovery share one responsive expression
  tray while their protocol behavior remains in their feature specs.
- Images receive a reversible preview/edit step before upload.
- Fresh installations choose Modern, Bubbles, or IRC from live previews; Modern is
  preselected. Existing installations keep their saved/current layout without a
  new prompt.
- Settings is a desktop modal/window and a compact routed surface with immediate
  appearance previews.
- Authentication, recovery, verification, profiles, search, directories, and room
  administration reuse the same hierarchy, microcopy, focus, loading, empty, and
  error patterns.

## Migration and rollout

`ux_refresh_v1` defaults off in both flag catalogs. Feature-specific flags remain
independent: the shell must compose an unavailable destination gracefully rather
than silently enabling its underlying feature.

Version appearance persistence when chat-style onboarding lands. Portable theme,
font, density, spacing, and message-layout values remain compatible with future
cross-device settings sync; pane widths remain device-local. Keep the legacy shell
and existing preference schema until rollback has survived one stable release.

Rollout sequence:

1. Opt-in nightly for seven days.
2. Default-on nightly for seven clean days.
3. Stable release, retaining the legacy rollback path.
4. Delete the legacy shell only after the following stable release is verified.

Cross-platform nightly failures are repaired in separate PRs and cannot count as
positive rollout evidence merely because a UI change is unrelated to the failure.

## Delivery slices

1. Rail model, tokens, gated presentation, Storybook states, and specification.
2. Typed shell state and device-local pane preferences.
3. Room-list selection and conversation/header/composer treatment.
4. Activity, account switching, Threads, and persistent call shelf composition.
5. Expression tray and image preview/edit composition.
6. Onboarding, settings, authentication, verification, search, directory, and
   administration polish.
7. Opt-in/default-on rollout evidence and legacy-shell retirement.

Only one major redesign seam is active at a time. Each slice is independently
reviewable, feature-flagged, and reversible.

## Acceptance criteria

1. CI captures deterministic Linux screenshots at 1440×900, 1024×768, 768×1024,
   and 390×844 using real Charm fixtures.
2. Rail fixtures cover zero, one, three, and more than three unread DMs; folders;
   selected spaces; muted rooms; large counts; multiple/offline accounts; and long
   names.
3. Unit and journey tests prove visible DM avatars and overflow badges never
   double-count the same conversation.
4. Axe and manual review cover contrast, keyboard navigation, visible focus,
   logical reading order, screen-reader labels, 44px touch targets, 200% zoom,
   reduced motion, bidirectional text, and long strings.
5. Journeys cover account/space/room switching, Activity triage, Threads, calls,
   expression/media sending, image editing, and first-run appearance choice.
6. Reviewers inspect CI screenshots and native artifacts for macOS, Windows/Linux,
   web, iOS, and Android before closing each applicable slice.
7. Deep links, drafts, scroll anchoring, uploads, local echoes, encryption states,
   media playback, calls, and account isolation survive pane and breakpoint changes.
8. The legacy shell remains functional with `ux_refresh_v1` disabled throughout
   the rollback window.
