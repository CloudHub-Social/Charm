---
title: Charm 2.0 Spec — Responsive and mobile-web layout hardening
type: spec
project: Charm 2.0
created: 2026-07-13
status: shipped
sidebar:
  label: "Responsive & mobile-web hardening"
---

## Implementation status

**Shipped 2026-07-14 in [PR #242](https://github.com/CloudHub-Social/Charm/pull/242)**
(`39f58f8d1f549e46a98a627178338da4272efc4c`).

The merged implementation moves the web shell onto the visible dynamic viewport,
adds safe-area handling, and keeps mobile headers, navigation, dialogs, the
composer, login, lightbox, members drawer, and autocomplete UI inside phone-sized
viewports. Focused unit coverage and a 375×812 Playwright suite were added. The
full frontend quality gate and merge-queue checks passed before merge.

The launch-blocking responsive scope is closed. Two audit follow-ups remain
explicitly non-blocking: the unused `src/App.css` boilerplate file was not removed,
and real-device iOS Safari / Android browser checks are still recommended.

### Mobile room UX follow-up

**Shipped 2026-07-14 in [PR #245](https://github.com/CloudHub-Social/Charm/pull/245)**
(`767b4c05571b12476cdb2a1907cecc966cf96c78`), built on PR #242.

After reviewing the hardened layout on a phone, the owner asked for the room view
to feel like a chat app rather than a desktop surface squeezed into a narrow
viewport. The follow-up makes the mobile chat fill the viewport, moves Back into a
compact header with a room-actions menu, hides bottom navigation while viewing a
room, uses touch-sized controls, collapses rich-text formatting by default, adds a
useful empty-room state, and places a participants strip above the composer. It
also returns to the room list if the active room disappears and updates the
responsive placeholder without emitting false typing activity.

The redesign is behind the default-off `mobile_chat_redesign` feature flag, so the
legacy mobile room experience remains available while rollout is controlled. Unit
coverage and the 375×812 Playwright regression were expanded, and the full frontend
quality gate passed before merge.

This is an owner-approved, separately gated extension beyond the original "not a
layout rewrite" boundary; PR #242 remains the baseline Spec 52 hardening.

**Workstream:** one PR / one agent (mostly CSS/layout). New spec from a
responsive-layout bug audit (2026-07-13) prompted by owner reports: in the **web
build on a phone**, UI elements "leave the screen," the composer/nav render off the
bottom, and the layout doesn't fit. This is a **2.0 quality/bug pass**, not a
1.0-parity item.

## Problem & why now

At authoring time, the audit found the *architecture was sound* — there was a real adaptive system
(`useAdaptiveLayout.ts` with a `max-width:767px` breakpoint; `AppShell` swaps a
four-pane desktop layout for a mobile bottom-nav + list/detail; message rows/room
list use `min-w-0`/`truncate` correctly). The missing layer was what makes a web
build survive a **mobile browser**: viewport-unit sizing, safe-area insets,
on-screen-keyboard handling, and a few fixed-width/overflow escapes. These directly
produced the reported "things leave the screen" behavior addressed by PR #242.
Every item below records the original audit finding and proposed fix.

## Non-goals

- Not a layout rewrite — the adaptive strategy stays; this hardens it.
- Not native-mobile-specific (Tauri iOS/Android) chrome beyond what these CSS fixes
  also improve — the reproduction surface is the web build in a mobile browser.

## Scope — ranked by severity

### Critical (breaks the page on a phone browser)

1. **`100vh` → `100dvh` sweep.** The app shell is sized with `h-screen`/
   `min-h-screen` (= `100vh`), which on mobile browsers is the viewport *with the URL
   bar hidden* — so while the URL bar shows, the app is taller than the visible area
   and the bottom nav (`AppShell.tsx:86`) and composer (`ChatShell.tsx:862`) render
   **below the fold**. Files: `AppShell.tsx:65,75`, `App.tsx:50,62`,
   `LoginScreen.tsx:158`, `ErrorFallback.tsx:40`. Fix: `h-[100dvh]` /
   `min-h-[100dvh]` (keep a `100vh` fallback via `@supports` if desired). **This is
   the headline fix for the reported bug.**
2. **Safe-area insets + `viewport-fit=cover`.** `index.html:6` viewport meta lacks
   `viewport-fit=cover`; there are **zero** `env(safe-area-inset-*)` in `src`. On
   notched/home-indicator phones the bottom nav + composer sit under the home
   indicator and headers under the notch. Fix: add `viewport-fit=cover`;
   `pb-[env(safe-area-inset-bottom)]` on the bottom `<nav>` and composer wrapper,
   `pt-[env(safe-area-inset-top)]` on mobile headers (a small Tailwind utility).
3. **Login card fixed `w-90` (360px) overflows narrow phones.**
   `LoginScreen.tsx:159` — `w-90` inside `p-8` needs ~424px; clips/scrolls
   horizontally on 360–375px devices (the *first screen a user sees*). Fix:
   `w-full max-w-90`, and `p-4` on small screens.

### High (content leaves the screen in normal use)

4. **Chat header room name doesn't truncate.** `ChatShell.tsx:616` (left group, no
   `min-w-0`) + `:627` (name span, no `truncate`). A long name pushes the
   Info/Settings buttons off the right edge. Fix: `min-w-0` on the group, `truncate`
   on the span (mirror `RoomList.tsx:353,393`).
5. **Autocomplete popover isn't clamped to the viewport.** `Composer.tsx:62`
   (`rectToPosition` → `{top: rect.bottom+4, left: rect.left}`) rendered by
   `AutocompletePopover.tsx:37-38` as `fixed w-64` with raw `top/left`. Typing a
   mention with the caret in the right half of a phone runs the 256px list off the
   right edge (and off the bottom near the bottom — it never flips up). Fix: clamp
   `left` to `innerWidth - width - margin`; flip above the caret when it would
   overflow the bottom.

### Medium (fragile / overflows in specific states)

6. **`MembersDrawer` fixed `w-80 shrink-0`** made full-width on mobile only via a
   fragile ancestor `[&>div]:w-full` override (`MembersDrawer.tsx:22`,
   `AppShell.tsx:76`). Fix: make the drawer own its responsiveness —
   `w-full md:w-80`.
7. **Dialogs constrain width but not height / internal scroll.** `dialog.tsx:54`
   has `max-w-[calc(100%-2rem)]` but no `max-h` / `overflow-y-auto`; a tall dialog
   (RoomSettingsForm, CreateJoinSpaceDialog) on a short/landscape phone extends past
   the screen with its buttons unreachable. Fix: `max-h-[calc(100dvh-2rem)]
   overflow-y-auto` on `DialogContent`; switch `SettingsScreen.tsx:197`'s `85vh` →
   `85dvh`.
8. **Composer / on-screen keyboard.** Because the shell is `100vh`, the mobile
   keyboard overlays the composer instead of resizing the layout. Largely fixed by
   #1 (`100dvh`); optionally add `interactive-widget=resizes-content` to the viewport
   meta or use the `visualViewport` API for precise behavior.

### Minor / cleanup

9. Delete the unused Vite-boilerplate `src/App.css` (hardcoded light colors,
   `padding-top:10vh`) — confirm it's not imported, then remove so it can't be
   reintroduced.
10. `Lightbox.tsx:48` `95vw`/`90vh` → `dvh` for consistency (works today, just
    align with the mobile-browser fix).

## Data flow

None — pure frontend layout/CSS. No IPC, no Rust.

## Testing strategy

- **Playwright (existing e2e)** at a **375×812 mobile viewport**: assert the
  composer and bottom nav are within the visual viewport (not off-bottom), the login
  card doesn't cause horizontal page scroll, a long room name truncates instead of
  pushing header buttons off-screen, and an autocomplete popover near the right edge
  stays within the viewport.
- **Storybook**: the a11y gate already runs; add mobile-viewport parameters to the
  shell/composer/dialog stories.
- **Manual**: real phone browser (iOS Safari with the URL bar showing, an Android
  notch device) — confirm composer visible, nothing under the notch/home indicator,
  keyboard doesn't cover the input.
- Regression: verify desktop layout is unchanged (the fixes are additive/`dvh` swaps
  + clamps, not desktop-affecting).

## Trade-offs

- **`dvh` vs `vh`+JS**: `dvh` is the correct, dependency-free default for the mobile
  URL-bar problem; a JS `visualViewport` listener is only needed for precise
  keyboard-resize behavior (optional item #8), not the core fix.
- **One coordinated PR**: items 1/2/8 are the same root concern (viewport sizing)
  and should land together; the rest are small independent clamps/truncates that fit
  the same PR.

## What I'd revisit as this grows

- A dedicated mobile QA pass on the native Tauri iOS/Android builds (this spec's
  reproduction surface is the web build; the `dvh`/safe-area fixes help native too,
  but native has its own status-bar/gesture nuances worth a separate check).
