---
title: Charm 2.0 Spec — Timeline scroll anchoring and bottom-up rendering
type: spec
project: Charm 2.0
created: 2026-07-11
status: draft
---

**Workstream:** one PR / one agent for Phase 1; Phase 2 is a larger architectural bet,
likely its own follow-up spec once Phase 1 ships and is lived with for a bit.

## Problem & why now

User-reported: opening a room does **not** scroll to the bottom (the newest message) —
the user has to manually scroll down every time. Confirmed in code, not just report:
`src/features/rooms/ChatShell.tsx` renders the message list as a plain
`<div className="overflow-y-auto p-4">` over a flat `.map()` of `messages` (oldest→newest
in array order), with **zero** scroll-management code anywhere in the component or in
`useChatTimeline.ts` — no `scrollTop`/`scrollIntoView`/`useLayoutEffect` scroll call. The
only scroll-adjacent code is an invisible bottom sentinel (`bottomSentinelRef`) used
solely for `IntersectionObserver`-driven mark-as-read (Spec 05). So "opens at top" isn't
a bug in some separate positioning logic — it's simply what happens when nothing sets
scroll position at all, and the browser's default is top-of-content.

The user's working hypothesis is that the timeline is built **top-down** (append-only,
oldest-first array driving a plain DOM list) rather than **bottom-up** (anchored at the
newest message, growing upward as older history loads), and that a bottom-up rebuild
would pre-emptively fix a *class* of scroll/jump/media-sizing issues Charm 1.0 hit
repeatedly, not just this one bug.

That hypothesis is **partially confirmed, not fully** by the legacy Charm 1.0
codebase's own issue history:

- **#445** "Timeline jumps when content loads" — Sentry-sourced report explicitly
  attributing the jump to **embeds/media loading without reserved size** on first page
  load; the issue itself notes later opens are *better* because embed sizes get cached.
  This directly corroborates the "media-sizing causes reflow-driven jump" theory.
- **#444** "Jump buttons not staying centered after content loads" — a regression from
  removing "timer locks" in #419; same underlying cause (async content resizing shifts
  scroll position after the fact) hitting a different feature (jump-to-message).
- **#527** "Timeline does not stay at bottom" — keyboard open/close, pickers,
  autocomplete, image viewer, or room navigation while at live bottom unreliably keeps
  the view anchored. Broader anchoring fragility, not purely media-driven.
- **#328** "Jump to Present/Follow Bottom is overly sticky" — the **opposite** failure:
  bottom-anchoring logic repeatedly yanks the user back to bottom while they're
  deliberately scrolling up, especially around keyboard close / room entry.
- **#224** "Fix keyboard close gap and bottom-anchoring regressions" — keyboard dismissal
  leaves reserved blank space or moves the view off live bottom.
- **#100** "Images not loading properly" — separate; broken image rendering, not
  sizing/reflow.

Charm 1.0's actual fix machinery (`useTimelineSync.ts`'s `scrollToBottom(behavior)`
callback wired to live-event-arrival/thread-mount, `dom.ts`'s `scrollToBottom` helper,
plus explicit `aspectRatio` CSS reservations in `MsgTypeRenderers.tsx`, `ImageContent.tsx`,
`UrlPreviewCard.tsx`) is **imperative scroll-restoration bolted onto a fundamentally
top-down list** — not a bottom-anchored architecture. That approach produced a
whack-a-mole pattern: #328 is the *opposite* regression of #527's fix, #224 is a further
patch on top of both, and #444 is a regression from #419's own fix. No 1.0 issue or
postmortem explicitly concludes "we should have built this bottom-up instead" — that
conclusion is this spec's inference from the pattern, not a documented 1.0 decision.

**Why now:** Charm 2.0 has no scroll-management code at all yet (confirmed: no
`scrollToBottom`, no anchor-preservation, no virtualization library —
`react-virtuoso`/`react-window`/`react-virtualized`/`@tanstack/react-virtual` are all
absent from `package.json`). This is the cheapest point to decide the architecture:
before any imperative scroll patches accumulate, and before Spec 19's search/space work
and any future thread UI (Phase 4 territory) add more surfaces that assume "the timeline
is a flat top-down array."

## Current state (in repo)

- `src/features/rooms/ChatShell.tsx` (~lines 254–295): message list is a bare
  `<div className="overflow-y-auto p-4">`, `.map()` over `messages` in DOM order, plus an
  invisible `bottomSentinelRef` div at the end for `IntersectionObserver`-driven
  mark-as-read (`useChatTimeline.ts` lines 96–118). No scroll-position code.
- `src/features/rooms/useChatTimeline.ts`: fetches the initial page via
  `getTimelinePage(room_id)` (lines 37–44); `onTimelineUpdate` replaces state **wholesale**
  with a full re-snapshot per Spec 14 (not a delta) (lines 53–65). Messages arrive
  oldest→newest in a flat array.
- No virtualization library anywhere in the frontend — the render is a bare `.map()` over
  the **full in-memory** `messages` array. No windowing, no anchor infrastructure.
- Backend (`src-tauri/src/matrix/timeline.rs`, Spec 14): per-room `matrix-sdk-ui`
  `Timeline`, diff-stream re-snapshotted into `RoomMessageSummary[]`, `get_timeline_page`
  backed by `Timeline::paginate_backwards`. This is a solid foundation for either a
  scroll-anchoring patch or a bottom-up rebuild — the backend doesn't need to change for
  Phase 1, and Phase 2's virtualization/anchor work is purely a frontend concern.

## Scope (in)

### Phase 1 — P0, narrow, ship first
1. **Scroll to bottom on room open.** The moment the initial page of messages renders,
   position scroll at the newest message. No animation needed for the initial mount.
2. **Stay pinned to bottom while at bottom during live message arrival.** Classic "sticky
   bottom" pattern: if the user's scroll position is at (or very near) the bottom when a
   new `timeline:update` arrives, scroll to the new bottom after render. If they've
   scrolled up to read history, do **not** yank them down (this is what 1.0's #328
   regressed on — call it out explicitly as the failure mode to avoid).
3. **Reserve layout space for media before it loads**, to prevent the #445-class
   reflow-jump: images/videos/embeds should occupy their final aspect-ratio'd box
   immediately (CSS `aspect-ratio` from known dimensions in `RoomMessageSummary.media`,
   or a sensible fallback box when dimensions aren't known yet), so their arrival doesn't
   shift scroll position for anyone reading nearby content.
4. **Preserve scroll position across backward pagination** (loading older history):
   record an anchor element's offset before prepending older messages, restore the
   equivalent offset after — the load-more-history version of the same reflow problem
   #445 describes for media.

### Phase 2 — P1/P2, larger architectural bet, own follow-up spec
5. **Bottom-up rendering**: anchor the render/scroll model at the newest message and grow
   upward, rather than a flat oldest-first array with an appended sticky-bottom patch.
   This is the structural fix the user is proposing — Phase 1's sticky-bottom pattern is
   a reasonable stopgap, but true bottom-up anchoring is what eliminates the *class* of
   jump bugs at the architecture level rather than patching each symptom.
6. **Adopt a virtualization library** (evaluate `@tanstack/react-virtual` or similar) —
   there is currently none, and the message list is an unbounded in-memory array with no
   windowing. This is a **separate discovered concern** (performance/memory at scale in
   long-lived or high-traffic rooms), surfaced here because bottom-up anchoring and
   virtualization are naturally solved together (most virtualization libraries have
   built-in bottom-anchored/reverse-infinite-scroll modes), not because it's required to
   fix the reported bug.

## Non-goals (out)

- **Rewriting `matrix-sdk-ui` Timeline integration** (Spec 14) — this spec is purely
  about the frontend's render/scroll model consuming that data, not the backend diff
  pipeline.
- **Thread UI / jump-to-message / jump-to-date** — those are their own future specs;
  Phase 2's bottom-up rendering should not preclude them, but building them is out of
  scope here.
- **Fixing #100-class broken image rendering** — that's a decode/format bug, unrelated to
  scroll/layout.
- **A full virtualization migration in Phase 1.** Phase 1 ships without touching
  rendering architecture at all — it's scroll-position management and CSS layout
  reservation only, deliberately kept cheap and low-risk.

## Design & approach

### Phase 1 sticky-bottom pattern
- Track "is user at bottom" via a threshold check on scroll (or reuse the existing
  `IntersectionObserver` on `bottomSentinelRef`, which already tells you exactly this —
  extend its existing mark-as-read purpose rather than adding a second observer).
- On mount and on every `timeline:update` where "at bottom" was true *before* the update,
  scroll to bottom after the DOM updates (`useLayoutEffect`, not `useEffect`, to avoid a
  visible flash of the pre-scroll position).
- Never force-scroll when the user is not at bottom — this is the #328 lesson.

### Media layout reservation
- `RoomMessageSummary.media` (Spec 02) should carry (or be extended to carry, if it
  doesn't already) known width/height so the frontend can set `aspect-ratio` before the
  image/video element finishes loading. Where dimensions are genuinely unknown ahead of
  load, reserve a sensible default box (e.g. a typical thumbnail aspect ratio) rather than
  zero-height.

### Backward-pagination scroll anchor
- Standard technique: before prepending older messages, record `scrollHeight` (or a
  specific anchor element's `offsetTop`) of the scroll container; after the prepend
  renders, adjust `scrollTop` by the delta so the previously-visible content stays
  visually still.

### Phase 2 (sketch only — detail in the follow-up spec)
- Evaluate whether `@tanstack/react-virtual`'s reverse/bottom-anchored mode (or
  equivalent) can replace both the Phase 1 sticky-bottom logic and the backward-pagination
  anchor math with one coherent model, rather than three separate hand-rolled mechanisms.
- If adopted, this is a genuine rendering-architecture migration (windowed rendering
  instead of full in-memory `.map()`) and should get its own spec with its own
  scope/non-goals/rollout plan, informed by how well Phase 1's patches hold up in
  practice first.

## Open questions

- **[Engineering, blocking Phase 2 scoping — RESOLVED 2026-07-13]** Does
  `RoomMessageSummary.media` already carry width/height? **Yes** — confirmed present on
  `MediaContent`'s `Image`/`Video` variants before Phase 1 even started; Phase 1 (#194)
  read it as-is, no backend change was needed. See
  [Spec 26 Phase 2 — Bottom-up timeline rendering](/specs/day-1/spec-26-phase-2--bottom-up-timeline-rendering-follow-up/)'s Question 1 research.
- **[Engineering, non-blocking]** Is a fallback aspect ratio for unknown-dimension media
  visually acceptable, or does it need per-msgtype tuning (image vs. video vs. generic
  file/embed)? Still open — not revisited by the Phase 2 spec.
- **[Engineering, blocking Phase 2 decision — RESOLVED 2026-07-13]** Does the message
  list's current size in practice justify virtualization? **Proceeding without waiting
  for Charm-2.0-specific telemetry** — there is none yet and won't be for a while, and
  requiring it before fixing an architectural problem the design already predicts is
  circular. Charm 1.0's own issue history (#445, #444, #527, #328, #224) is treated as
  sufficient precedent. Phase 2 commits to both bottom-up rendering and
  `@tanstack/react-virtual` (spike-validated first). See the Phase 2 spec's Question 2
  research.
- **[Product, non-blocking — RESOLVED 2026-07-13]** Should there be a "jump to present"
  affordance? **Yes** — included in Phase 2's scope as a small addition on top of the
  bottom-anchor state that spec's consolidation refactor already produces.

## Timeline considerations

- Phase 1 is small, well-scoped, and directly fixes the reported bug plus the most common
  jump-cause class (media reflow) — no hard dependency ordering beyond landing after
  Spec 14 (already shipped).
- Phase 2 should not start until Phase 1 has shipped and been lived with for a bit — its
  own spec should incorporate whatever Phase 1 teaches about how often backward-pagination
  and media-reservation edge cases actually surface in practice, rather than
  over-designing the virtualization migration up front.
