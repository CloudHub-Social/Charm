---
title: Spec 26 Phase 2 — Bottom-up timeline rendering (follow-up)
type: spec
project: Charm 2.0
created: 2026-07-13
status: shipped
sidebar:
  label: "Phase 2: Bottom-up rendering"
---

**Parent spec:** [Spec 26 — Timeline scroll anchoring and bottom-up rendering](/specs/day-1/spec-26--timeline-scroll-anchoring-and-bottom-up-rendering/)
(Phase 1 shipped in **PR #194**, merged 2026-07-11). Phase 1's own text deferred
this work to "its own follow-up spec, informed by how Phase 1 holds up in
practice" — this is that spec.

## Status

**Shipped in [PR #232](https://github.com/CloudHub-Social/Charm/pull/232).** The
merged implementation uses the bottom-anchored, virtualized timeline model scoped
here, including pagination and jump-to-present behavior.

:::note[Historical baseline]
The remainder of this section records how the proposal was revised before
implementation. It is retained as design history.
:::

Written 2026-07-13, two days after Phase 1 merged. **Revised same day**
after review: the first draft of this spec deferred virtualization pending
telemetry that doesn't exist and isn't coming soon (Charm 2.0 has no
production users yet). On reflection that was the wrong bar — Charm 1.0's own
issue history (#445, #444, #527, #328, #224, cited in the parent spec) is
already sufficient evidence that scroll/jump bugs are a real, recurring
*class* of problem in a top-down, non-virtualized timeline, not a
hypothetical one. Waiting for Charm 2.0 to independently reproduce that
history before fixing it architecturally is the "whack-a-mole" pattern the
parent spec exists to avoid, not a prudent delay. **This spec now commits to
both** the bottom-up rendering model and virtualization, per the parent
spec's original Phase 2 sketch.

## Problem & why now

Phase 1 shipped a working fix for the reported bug (timeline not opening at
bottom) and its two related jump classes (media reflow, backward-pagination
jump), but by its own design it's **three separate hand-rolled mechanisms**
bolted onto a flat, top-down `.map()` over `messages`
(`src/features/rooms/useChatTimeline.ts`, confirmed current at 276 lines):

1. `isAtBottomRef` + a `useLayoutEffect` keyed on `messages`, gated by a
   bottom-sentinel `IntersectionObserver` — sticky-bottom-on-arrival.
2. CSS `aspect-ratio` layout reservation in `MediaMessage.tsx` — media reflow
   guard.
3. `pendingAnchorRef` + a second `useLayoutEffect` doing manual
   `scrollHeight`/`scrollTop` delta math — backward-pagination anchor.

This is exactly the pattern the parent spec named as Charm 1.0's failure mode:
imperative scroll-restoration patches accumulating on top of a fundamentally
top-down list, rather than a single coherent bottom-anchored model. Charm
1.0's issue history shows this pattern doesn't stay stable — #328 is the
*opposite* regression of #527's fix, #224 patches both, #444 regresses #419's
own fix. Three hand-rolled mechanisms today is the same shape as the code that
produced that history, just younger. Phase 2 replaces the shape, not just the
current bugs: a bottom-anchored, virtualized render model that makes "the view
is anchored to the newest message and grows upward" a property of the
architecture, not an effect someone has to remember to re-derive correctly
every time a new interaction (thread jump, search-result jump, keyboard
open/close) touches the scroll container.

## Research: resolving the parent spec's blocking open questions

### Question 1 — does `RoomMessageSummary.media` carry width/height?

**Resolved: yes, already present, no backend change was or is needed.**
`src-tauri/src/matrix/timeline.rs`'s `MediaContent` enum (`Image`/`Video`
variants) has carried `width: Option<u32>` / `height: Option<u32>` since before
Phase 1 — confirmed by reading the current struct definition
(`timeline.rs:34-71`) and by Phase 1's own PR #194 description, which states
the field was "already present server-side, no backend change needed" and
implemented `MediaMessage.tsx`'s `aspect-ratio` purely as a frontend read of
existing data. This question is fully closed; nothing further to do here —
virtualized rows can size themselves the same way Phase 1's does.

### Question 2 — is virtualization actually justified?

**Resolved: yes — proceed, on the strength of Charm 1.0's precedent rather
than fresh telemetry, which doesn't exist and won't for a while.** What was
checked against the actual code:

- `get_timeline_page`'s default page size is 30 messages, capped at
  `MAX_PAGE_LIMIT = 200` per call (`timeline.rs:854-888`). A room opens with
  one page (30 messages) in memory, not its full history.
- The `messages` array grows via live arrival (`timeline:update`) and via
  explicit backward pagination (`loadMoreHistory`, +30 per top-sentinel
  intersection) — and **nothing currently caps how many pages accumulate** as
  a user keeps scrolling up. A long session in an active, long-lived room can
  genuinely reach thousands of loaded messages, each currently a permanently-
  mounted DOM subtree (message body, avatar, reactions, possibly a media
  element) that never unmounts even once scrolled far out of view.
- There is no Charm-2.0-specific telemetry on typical loaded-message-count or
  render cost, and there won't be meaningful telemetry until there's a
  meaningful number of active users with deep room history — which is
  circular as a precondition for fixing an architectural problem the *design*
  already predicts. Charm 1.0's own history is the closest available signal,
  and it's not ambiguous: a non-virtualized, imperatively-patched timeline
  produced a chain of interacting scroll bugs over multiple issues and
  multiple attempted fixes. That's the outcome this spec is trying to
  pre-empt in Charm 2.0, not react to after the fact.

**Conclusion:** proceed with virtualization now, alongside the bottom-up
rendering model, rather than waiting for Charm 2.0 to accumulate its own
version of Charm 1.0's issue history first.

## Scope (in)

### 1. Bottom-up, anchored rendering model
Replace the flat oldest-first `.map()` in `ChatShell.tsx` with a render model
anchored at the newest message, growing upward as older history loads —
matching how the underlying conversation actually behaves (new content
arrives at the bottom; history is requested, not pushed).

### 2. Virtualization
Adopt a windowed-rendering library so only the messages within (or just
outside) the visible viewport are mounted at any time, regardless of how many
pages have accumulated via live arrival or backward pagination.

- **Primary candidate: `@tanstack/react-virtual`**, evaluated specifically for
  its reverse/bottom-anchored mode, since that's the native fit for "anchor at
  newest, grow upward" rather than requiring extra glue on top of a
  forward-only virtualizer. Confirm during implementation that its
  bottom-anchor mode composes cleanly with:
  - variable-height rows (messages vary a lot in height: single-line text vs.
    multi-line vs. media vs. reactions/threads-preview) — `react-virtual`
    supports dynamic measurement via `measureElement`, needs verifying against
    Charm's actual row shapes;
  - the existing media aspect-ratio reservation (Question 1) — a virtualized
    row's estimated height should use the known aspect ratio when available,
    the same fallback-box logic Phase 1 already established, so switching to
    virtualization doesn't reintroduce the #445-class reflow jump via bad
    height estimates.
- If `react-virtual`'s bottom-anchor mode doesn't compose cleanly with
  Charm's variable-height rows during a implementation spike, document why and
  fall back to the next candidate (e.g. `react-virtuoso`, which has a
  purpose-built `Virtuoso`/`followOutput` chat-style mode) rather than forcing
  a bad fit — see Open Questions.

### 3. Replace Phase 1's three mechanisms with the new model's own primitives
The virtualizer's own bottom-anchor/`followOutput`-equivalent mode replaces
`isAtBottomRef`'s sticky-bottom effect; its own prepend/scroll-preservation
behavior (most virtualizers designed for infinite lists handle this natively)
replaces `pendingAnchorRef`'s manual delta math. Media aspect-ratio reservation
(Phase 1 item 3) carries forward unchanged into row-height estimation (see
above) rather than being replaced.

### 4. "Jump to present" indicator
Include as part of Phase 2, scoped small (see Design & approach). Charm 1.0's
#444/#328 history shows this is a real, recurring UX need once bottom-anchoring
exists — a user scrolled up reading history has no way to know new messages
arrived, or to get back to them, without it.

## Non-goals (out)

- **Changing the pagination page size or `MAX_PAGE_LIMIT`.** Unrelated to the
  rendering-model question; no evidence current values are wrong.
- **Any backend/Rust change.** Confirmed by Question 1's research — `media`
  already carries what the frontend needs. This is a frontend-only migration,
  same as Phase 1's own scoping.
- **New scroll-related features** (jump-to-message, jump-to-date, thread-aware
  scroll anchoring) — future specs, same as the parent spec's non-goals. The
  chosen virtualization library should not preclude these, but building them
  is out of scope here.
- **Building a custom virtualizer from scratch.** Adopt an established library
  rather than hand-rolling windowed rendering — the entire point of this
  migration is trading three hand-rolled mechanisms for one well-tested one,
  not trading them for a fourth hand-rolled mechanism with a bigger surface
  area.

## Design & approach

- **Library spike first.** Before committing to `@tanstack/react-virtual`
  specifically, spend a short, time-boxed spike (see Effort estimate)
  confirming its bottom-anchor mode handles: variable/dynamic row heights,
  smooth backward-pagination prepend (loading older history above the
  current viewport without a visible jump), and sticky-bottom-during-live-
  arrival — the three behaviors Phase 1 hand-rolled. If it doesn't compose
  cleanly, fall back to `react-virtuoso`'s chat-oriented mode (see Open
  Questions) before writing off virtualization entirely.
- **Row height / media integration**: virtualized rows use
  `RoomMessageSummary.media`'s known `width`/`height` (Question 1) to estimate
  height before measurement settles, and the virtualizer's dynamic
  `measureElement`-equivalent to correct the estimate once the row actually
  renders — carrying Phase 1's aspect-ratio reservation logic forward instead
  of discarding it.
- **`ChatShell.tsx` render itself changes**: unlike a narrower consolidation
  refactor, this migration does touch the list render, not just the
  `useChatTimeline.ts` hook — the flat `.map()` is replaced by the
  virtualizer's windowed render output.
- **`useChatTimeline.ts`** keeps owning data fetching (`getTimelinePage`,
  `onTimelineUpdate`, `loadMoreHistory`) — the virtualizer consumes `messages`
  the same way the old `.map()` did; only the render/scroll-anchoring
  responsibility moves out of the hand-rolled refs/effects and into the
  library.

### "Jump to present" indicator

Surface a visible "N new messages ↓" pill in `ChatShell.tsx` when the user is
scrolled away from the bottom-anchor and a new message arrives; clicking it
scrolls to bottom (via the virtualizer's own scroll-to-bottom/scroll-to-index
API) and dismisses itself. Explicitly scoped **without** Charm 1.0's
#328/#419 "timer lock" complexity — appear/disappear/click-to-scroll only, not
a replica of 1.0's more elaborate history.

## Acceptance criteria

- The message list in `ChatShell.tsx` renders through a windowed/virtualized
  component; only messages near the viewport are mounted in the DOM at a
  given time — verifiable by checking mounted row count doesn't scale
  linearly with a large accumulated `messages` array in a test with many
  loaded pages.
- Bottom-anchored, grows-upward rendering replaces the flat oldest-first
  `.map()` — new messages arrive anchored at the bottom; loading older history
  prepends above the current view without a visible jump.
- Media aspect-ratio reservation (Phase 1, Question 1) continues to prevent
  reflow jump, now expressed as virtualized-row height estimation rather than
  plain CSS `aspect-ratio` on an always-mounted element.
- A visible "jump to present" indicator appears when the user is scrolled up
  and a new message arrives, and clicking it scrolls to bottom and dismisses
  itself; it does not appear while already at bottom (no #328-style
  regression).
- Phase 1's existing test coverage (`ChatShell.test.tsx`,
  `MediaMessage.test.tsx`) is ported to assert equivalent behavior against the
  new render model — exact assertions will change (they currently assert on
  `scrollIntoView`/`scrollTop` calls specific to the hand-rolled
  implementation), but the *behaviors* they verify (sticky bottom, no-yank-
  while-scrolled-up, pagination doesn't jump) must all still be covered.
- The coverage ratchet in `vitest.config.ts` does not regress.
- No `src-tauri` changes.
- Full quality gate passes (`pnpm lint`, `pnpm fmt:check`, `pnpm typecheck`,
  `pnpm test:coverage`, `pnpm knip`, `pnpm build`), matching the parent spec's
  and every other Charm 2.0 spec's bar. Additionally: `pnpm test:e2e` (the
  Playwright suite runs against a real browser layout, unlike jsdom-based
  unit tests, and is the better signal for virtualized-scroll behavior — Phase
  1's PR explicitly skipped e2e coverage for scroll behavior citing jsdom
  limitations; a real virtualizer's scroll math is worth checking against real
  layout here).

## Effort estimate

Medium, likely two stages within one PR-sequence rather than strictly "one PR
/ one agent" like most Day-1 specs:

1. **Spike** (short, time-boxed): validate `@tanstack/react-virtual`'s
   bottom-anchor mode against Charm's actual row shapes (variable height,
   media, reactions) in isolation before touching `ChatShell.tsx` for real.
   Go/no-go on the library choice comes out of this stage.
2. **Migration**: replace the flat `.map()` and Phase 1's three mechanisms
   with the validated library, port test coverage, add the "jump to present"
   indicator.

This is larger than Phase 1 (#194, ~250 lines) — expect a genuine new
dependency, a render-architecture change in `ChatShell.tsx`, and a full port
of existing scroll-behavior tests to the new model, plus new e2e coverage.
Comparable in size to a mid-sized foundational spec (e.g. Spec 14's Timeline
adoption).

## Open questions

- **[Engineering, blocking implementation start]** Confirm `@tanstack/react-
  virtual`'s bottom-anchor/reverse mode actually composes with Charm's
  variable-height, media-bearing rows during the spike stage above. If it
  doesn't, the fallback candidate is `react-virtuoso`'s `followOutput`
  chat-mode, which is more purpose-built for this exact "chat timeline"
  pattern at the cost of a less commonly-used-elsewhere-in-the-ecosystem
  dependency — decide during the spike, not before.
- **[Product, non-blocking]** Exact visual treatment/copy for the "jump to
  present" pill (e.g. "N new messages" vs. a plain down-arrow FAB) — leave to
  implementation/design-system conventions rather than blocking spec
  approval on it.
- **[Engineering, non-blocking]** Should "new messages since scrolled up"
  count distinguish the user's own sent messages (which trigger their own
  scroll regardless) from others' — worth checking during implementation, not
  expected to change scope.
- **[Engineering, non-blocking]** Whether virtualization changes how
  `IntersectionObserver`-driven mark-as-read (Spec 05) needs to work, since
  the bottom sentinel's mount lifecycle changes under a virtualizer (it's no
  longer a permanently-mounted DOM node like Phase 1's) — confirm the chosen
  library exposes an equivalent "is the true bottom visible" signal.

## Timeline considerations

- No hard dependency beyond Phase 1 (shipped, PR #194). Safe to start anytime.
- Structured as spike-then-migrate specifically so the go/no-go on the library
  choice happens cheaply, before the larger `ChatShell.tsx` migration is
  underway — avoids sinking the full migration's cost into a library that
  turns out not to fit Charm's row shapes.
