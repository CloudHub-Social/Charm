---
title: Charm 2.0 Spec — Rich message content rendering
type: spec
project: Charm 2.0
created: 2026-07-13
status: shipped
---

## Implementation status

**Shipped 2026-07-14 in [PR #244](https://github.com/CloudHub-Social/Charm/pull/244)**
(`98ff2613fccda0c1f6a0466cf19d9c5d9fdff781`).

The merged implementation replaces injected formatted HTML with a shared,
DOMPurify-sanitized HTML-to-React pipeline across Bubble, Discord, and IRC layouts.
It adds concealed click-to-reveal spoilers, lazy syntax highlighting and code copy,
scrollable tables, interactive Matrix user/room pills, `@room`/`@here` highlighting,
lazy KaTeX rendering, plain-text linkification, jumbo emoji, IRC block styling, an
appearance preference, undecrypted-message shimmer, room-list skeletons, and the
caught-up timeline marker.

Enhanced rendering ships behind the default-off `rich_message_rendering` feature
flag. Sanitization and spoiler concealment remain always on as the safety baseline,
so disabling the feature cannot expose hidden spoiler content. The implementation
uses maintained libraries (`html-react-parser`, `highlight.js`, `katex`,
`emoji-regex`, and Linkify) rather than bespoke parsers, with the heavy syntax and
math paths lazy-loaded.

Validation passed with 970 frontend unit tests, 130 Storybook tests, the focused and
full E2E suites, accessibility checks, Rust checks, CodeQL, and approved visual
snapshots. All review threads were resolved before the PR merged through the queue.

**Workstream:** one PR / one agent. New spec from the UI-parity deep-dive
(2026-07-13). Fixes the **render** side of formatted messages — including one active
privacy bug.

## Problem & why now

Charm 2.0 renders `formatted_body` by sanitizing (DOMPurify) and injecting via
`dangerouslySetInnerHTML`, then styling with a handful of Tailwind child selectors
(`DiscordMessageRow.tsx:112-124`, `BubbleMessageRow.tsx:104-121`,
`IrcMessageRow.tsx:86-103`). Charm 1.0 uses a full HTML→React parser
(`plugins/react-custom-html-parser.tsx`) that actually *handles* rich content. Result:
several formatting features render wrong or not at all in 2.0, and one is a real
defect:

1. **Spoilers render in plain view (BUG).** `data-mx-spoiler` passes the sanitizer
   allowlist (`composerSanitize.ts:63`) but there's **no CSS to hide it and no
   click-to-reveal handler** — so spoiler content is just visible. This is a
   correctness/privacy bug, not only a polish gap. (Charm 1.0:
   `react-custom-html-parser.tsx:979-990` + `useSpoilerClickHandler.ts`.)
2. **Code blocks are unstyled** — `<pre>` is allowed but rendered with no monospace
   block, no syntax highlighting, no copy button; the IRC layout even forces
   `[&_*]:inline`, collapsing block structure. (1.0: `CodeHighlightRenderer`, lang
   detection + copy.)
3. **Tables are unstyled** — `th/td/tr` allowlisted but zero border/cell styling, so
   tables render as run-together text.
4. **Mention/room pills render as plain underlined links** — `data-mx-pill` allowed
   but no pill styling, no click handling, no self-mention highlight. (1.0 renders
   interactive styled pills; click opens the user — coordinate with Spec 36 profile
   cards so a user-pill click opens the profile.)
5. **No `@room`/`@here` highlight** — 1.0 highlights these (`makeHighlightRegex`).
6. **No math/LaTeX** — 1.0 renders KaTeX (`react-custom-html-parser.tsx:137-170`).
7. **No jumbo emoji** — 1.0 scales up emoji-only messages (`isJumboEmojiText`,
   `jumboEmojiSize`); 2.0 renders them at normal size.
8. **Blockquote/list styling missing in the IRC layout specifically** (present in
   Discord/Bubble) — PARTIAL.

Plus timeline loading-state polish the audit flagged: **decryption-pending shimmer**,
**room-list loading skeletons**, and a **"you're all caught up" marker** — all absent
in 2.0 (blank vs loading is ambiguous during history fetch).

## Non-goals

- Not the composer *send* side of spoiler/code/strike — that's Spec 43 (this is the
  render side; the two must agree on the format).
- Not link previews (Spec 29) or custom emoji (day-2 Spec 05).
- Not keeping the current CSS-over-`dangerouslySetInnerHTML` approach — per the
  library-first default this spec moves to a maintained HTML→React renderer (see
  design/trade-offs). Sanitization stays (vetted sanitizer in front), it's the
  ad-hoc styling/DOM-patching that's replaced.

## High-level design

> **Library-first (project-wide default).** Prefer established libraries over
> hand-rolled rendering here — this is a solved problem and bespoke HTML handling is
> a classic XSS/edge-case/maintenance trap. The strongest option is to **adopt a
> proper Matrix-aware HTML→React rendering pipeline** (as Charm 1.0 does with its
> `react-custom-html-parser`) — a maintained HTML parser/renderer that turns the
> sanitized `formatted_body` into real React nodes, into which the library-backed
> pieces below plug — rather than continuing to CSS-patch `dangerouslySetInnerHTML`.
> Use a real **syntax highlighter** (e.g. Shiki / highlight.js / Prism), **KaTeX**
> for math, a maintained **emoji** library for detection/rendering, and a
> **linkify** library — do not write these from scratch. Only hand-roll a piece
> where no suitable library fits (and justify it). Whichever renderer is chosen must
> keep a vetted sanitizer (DOMPurify or the renderer's own allowlist) in front — the
> library choice must not weaken sanitization.

- **Rendering pipeline**: replace the CSS-over-injected-HTML approach with a
  library-backed HTML→React render of the sanitized `formatted_body`, shared by all
  three layout modes. Everything below becomes a node type / plugin in that pipeline
  rather than a post-mount DOM hack.
- **Spoilers**: render `[data-mx-spoiler]` as a component that hides content
  (blur/blackout) with click-to-reveal — a real node in the renderer, not a CSS +
  delegated-listener workaround. All three layouts.
- **Code blocks**: a code-block component using a maintained **syntax highlighter**
  (lazy-load languages for bundle size; language from `class="language-…"`), rendered
  as a real monospace block with horizontal scroll (`overflow-x-auto`) and a copy
  button. Do **not** let IRC mode collapse them to inline.
- **Tables**: border/cell/padding styling with `overflow-x-auto` so wide tables
  scroll inside their container (not widen the row — ties to Spec 52 responsive).
- **Pills**: style user/room pills (chip background, avatar/name) and make user-pill
  clicks open the profile card (Spec 36); room-pill clicks navigate. Highlight
  self-mentions.
- **@room/@here highlight**: detect and highlight.
- **Math/LaTeX**: dynamic-import a KaTeX-equivalent and render math nodes (match
  1.0's dynamic import so it's not in the base bundle).
- **Jumbo emoji**: detect emoji-only messages and scale up (per a setting, matching
  1.0's `jumboEmojiSize`).
- **IRC blockquote/list**: add the missing styling for the IRC layout.
- **Loading states**: decryption-pending shimmer for undecrypted items, room-list
  skeletons, and a "you're all caught up" end-of-timeline marker.

## Data flow

Frontend-only rendering over the existing `formatted_body`, through the
library-backed HTML→React pipeline described above (each feature is a node
type/plugin in that renderer — spoiler component, code-block+highlighter, math via
KaTeX, emoji lib, pills). No IPC/Rust changes. Pill-click-opens-profile coordinates
with Spec 36's card.

## API/contract changes

None (Rust/IPC). Pure rendering. Coordinates with Spec 43 (send format) and Spec 36
(pill → profile).

## Testing strategy

- Frontend unit/RTL per feature: spoiler is hidden until clicked (assert not visible
  initially — guards the bug); code block renders monospace + copy; table has
  borders + scrolls; user pill is styled and click opens the profile; `@room`
  highlighted; math renders; emoji-only message is scaled; IRC blockquote styled.
- Storybook + axe: rich-content stories (spoiler, code, table, pills, math, jumbo)
  across all three layout modes.
- Manual + cross-client: receive a spoiler / code block / table / math from
  Element, confirm each renders correctly (and spoiler stays hidden until clicked).

## Trade-offs

- **Library-backed renderer vs CSS-patching injected HTML**: adopt a maintained
  HTML→React rendering pipeline (per the library-first default) rather than layering
  CSS + post-mount DOM hacks on `dangerouslySetInnerHTML`. The renderer makes
  spoiler-reveal, pills, KaTeX, and jumbo emoji real components/plugins instead of
  fragile after-the-fact DOM patching, and is the more correct/secure/maintainable
  path — matching how Charm 1.0 already does it. Keep a vetted sanitizer in front
  regardless of the renderer chosen.
- **Spoiler is a bug, prioritize it**: even if the rest is deferred, the spoiler
  render fix should not wait — content meant to be hidden is currently shown.
- **Syntax-highlighter bundle size**: use a maintained highlighter and lazy-load
  languages (don't hand-roll highlighting).
- **Spoiler is a bug, prioritize it**: even if the rest is deferred, the spoiler
  render fix should not wait — content meant to be hidden is currently shown.
- **Syntax-highlighter bundle size**: pick a small one / lazy-load languages.

## What I'd revisit as this grows

- Per-language code themes (ties to Spec 47's code-block theme picker).
- Collapsible long code blocks / long quotes if they dominate the timeline.
