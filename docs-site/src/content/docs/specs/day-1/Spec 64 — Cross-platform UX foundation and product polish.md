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
is the program ledger and [PR #540](https://github.com/CloudHub-Social/Charm/pull/540)
contains the complete, default-off visual renewal for Charm's currently shipped
surfaces. It covers the responsive shell, people-first rail, room list,
conversation, composer, Activity inbox, contextual panels, onboarding,
authentication, and settings as one reversible review unit.

Spec 47's appearance persistence is already present on `main` and is reused here.
Portable theme, font, density, spacing, and message-layout values remain in that
versioned appearance envelope. The new room-sidebar width uses a separate
device-local versioned preference and never enters cross-device appearance sync.
The legacy shell remains the rollback path while `ux_refresh_v1` is disabled.

## Approved direction

<img
  src="/design/spec-64/sable-forward-desktop.png"
  alt="Charm desktop direction with a warm aubergine rail, charcoal room list, ink conversation canvas, and people-first unread-DM shortcuts"
/>

This concept is directional rather than pixel evidence. Approved Storybook
fixtures provide the measured component contract. Deterministic CI screenshots
and native artifacts replace the concept as implementation evidence lands.

Charm's visual goal is a polished, calm, native-feeling chat product. Discord,
Sable, and well-designed native clients are useful starting references, not a
template Charm should follow. The product combines:

- Discord-like conversational clarity and restrained message chrome;
- Sable-like personalization and people-first navigation; and
- Charm's existing visual identity, refined through its own purple, mint, yellow,
  and speech-bubble details rather than replaced by a borrowed theme.

Reference products are references only. Do not copy their code, assets, branding,
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
6. Add Space and the active-account/settings entry at the bottom. It becomes the
   account switcher when Day-2 Spec 09 supplies the account-list and switch APIs.

Unread DM shortcuts are derived from one account's joined-room snapshot. Sort by
descending `last_activity_ts`; ties and missing timestamps preserve the
authoritative room-list order. Never aggregate one unread conversation into both a
visible contact shortcut and the Direct Messages overflow badge.

Selected spaces use an organic plum backing and a short mint edge marker. Space
avatars are 44px. Avoid rectangular icon outlines and generic app-launcher imagery.
Ambient unread may use a subdued dot; use numerical badges where the exact number
helps the user act, including highlights and overflow.

Activity is a real destination backed by the current account's invites, unread
rooms, marked-unread rooms, and message previews. The active-account entry opens
account settings today; it must not imply multi-account switching before Day-2
Spec 09 supplies that route.

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

- `PrimaryDestination` — Home, Direct Messages, Activity, the compact Spaces
  root, or an individual Space;
- `AppNavigationState` — active account, destination, space, room, contextual
  panel, and mobile route;
- `ContextPanelKind` — the currently implemented members or pinned-messages
  panel, or none; future routes extend the union when their owning specs ship;
- `MobileRoute` — Activity, Spaces, room list, conversation, or contextual detail;
- `RailAttentionItem` — one account-scoped actionable rail shortcut; and
- `PanePreferences` — versioned device-local pane sizes and open state.

Responsive behavior:

- **Wide (≥1200px):** rail, room sidebar, conversation, and optional context panel.
- **Medium (768–1199px):** rail, sidebar, and conversation; context content overlays.
- **Compact (&lt;768px):** one pushed pane at a time, safe-area and
  software-keyboard handling, a full-width Chats root, a separate Spaces root,
  bottom navigation for top-level destinations, explicit back controls, and a
  leading-edge swipe back from conversation detail.

### Platform-adaptive, product-cohesive

Charm does not make every platform pixel-identical. It keeps identity and behavior
cohesive while using the navigation container people expect on each device:

- every platform shares the same information architecture, room state, wording,
  typography, color roles, selection hierarchy, icon family, and motion character;
- desktop and tablet use the space rail, resizable room sidebar, toolbars, pointer
  hover, keyboard shortcuts, and optional contextual panel;
- phones use full-width root lists, a restrained bottom tab bar, pushed detail,
  edge-back gestures, larger touch targets, safe areas, and no permanently visible
  desktop rail;
- platform integrations may add native menus, haptics, share sheets, notification
  actions, or window chrome through Specs 60 and 61, but those enhancements must
  preserve the same destinations and state model rather than create a parallel UI.

This is progressive adaptation, not platform theming: a conversation, unread
state, draft, upload, or selected space must remain recognizable and intact as the
same user moves between web, desktop, tablet, iOS, and Android.

Breakpoint transitions preserve deep links, active room, draft, scroll anchor,
call shelf, media playback ownership, and account isolation. Opening or closing a
pane must not remount the owner of a draft, upload, call, or playing media item.

## Essential destinations and remaining surfaces

- Activity currently composes actionable state already exposed by the room
  snapshot: invites, unread rooms, marked-unread rooms, and message previews.
  Mentions, replies, calls, and delivery failures join the same destination when
  their owning APIs expose a normalized event feed.
- Members and pinned messages use the context panel on desktop and a pushed route
  on compact screens. Threads adopt the same composition when the thread feature
  ships.
- Calls enter from the room header and persist in a call shelf across room changes
  after Day-2 Spec 02 provides native calling; this PR does not add a dead call
  control.
- Existing emoji and media actions live in the stable composer shell. GIF,
  sticker, custom-emoji discovery, and reversible image editing remain owned by
  their feature specs and must join the same responsive tray without changing the
  shell.
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

## One-PR implementation boundary

PR #540 intentionally keeps the complete visual renewal in one feature-flagged
change so reviewers can judge the product as a coherent whole. It includes:

1. Rail attention model, tokens, measured Storybook states, and specification.
2. Typed navigation state, responsive shell, overlay/pushed contextual panels,
   and device-local resizable pane preferences.
3. Room-list hierarchy, message grouping, header actions, contextual formatting,
   composer treatment, empty states, and conversation-width constraints.
4. The real Activity destination and active-account/settings entry.
5. Fresh-install Modern/Bubbles/IRC selection, settings, authentication,
   reauthentication, onboarding, and shared portalled-surface treatment.
6. Deterministic dark and light desktop, medium, tablet, and compact Chats,
   Spaces, conversation, and Activity CI screenshot journeys.

This boundary does not silently pull Day-2 product work into a visual PR. Native
calling and multi-account switching remain owned by Specs 02 and 09 respectively;
Threads, the combined expression tray, and image editing remain functional
dependencies. When those features land, they must use the shell contracts in this
spec rather than introduce another parallel navigation or composer.

## Acceptance criteria

1. CI captures deterministic Linux screenshots at 1440×900 in both dark and light
   themes, plus 1024×768, 768×1024, and 390×844 using real Charm fixtures.
2. Rail fixtures cover zero, one, three, and more than three unread DMs; Activity;
   folders; selected spaces; muted rooms; large counts; and long names.
   Multiple/offline-account states join this matrix with Day-2 Spec 09.
3. Unit and journey tests prove visible DM avatars and overflow badges never
   double-count the same conversation.
4. Axe and manual review cover contrast, keyboard navigation, visible focus,
   logical reading order, screen-reader labels, 44px touch targets, 200% zoom,
   reduced motion, bidirectional text, and long strings.
5. Current-feature journeys cover space/room switching, Activity triage, media
   composition, and first-run appearance choice. Threads, calls, multi-account
   switching, the combined expression tray, and image editing add their journey
   cases in their owning feature PRs.
6. Reviewers inspect CI screenshots and native artifacts for macOS, Windows/Linux,
   web, iOS, and Android before closing each applicable slice.
7. Deep links, drafts, scroll anchoring, uploads, local echoes, encryption states,
   media playback, calls, and account isolation survive pane and breakpoint changes.
8. The legacy shell remains functional with `ux_refresh_v1` disabled throughout
   the rollback window.
