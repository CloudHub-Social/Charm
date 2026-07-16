---
title: Charm 2.0 Spec — Link previews
type: spec
project: Charm 2.0
created: 2026-07-13
status: in-progress
---

## Implementation status

**Desktop implementation shipped in
[PR #250](https://github.com/CloudHub-Social/Charm/pull/250), behind the
default-off `link_previews` flag.** The Tauri implementation uses the
homeserver preview endpoint with legacy fallback, caches by room and URL, and
renders the card in all three message layouts.

**Web support now shares the same path.** The companion server exposes an
authenticated JSON `POST /api/media/preview_url`, which wraps the identical
`get_url_preview_impl` desktop's Tauri command uses, so both platforms get the
same homeserver-preview-with-legacy-fallback behavior. The web transport calls
that preflighted, custom-header-guarded route and still resolves to `null` on
any failure (404, timeout, malformed response) rather than throwing — matching
the desktop contract. Both platforms remain gated behind the default-off
`link_previews` flag. Unit and mocked-homeserver tests cover the desktop
graceful-failure contract; live-homeserver manual verification was not
recorded.

:::note[Historical baseline]
The proposal below is retained as the implementation design. Its present-tense
gap statements describe the state before PR #250.
:::

**Workstream:** one PR / one agent. Small backend fetch/cache surface plus a
`MessageRow` rendering addition.

## Problem & why now

Charm 1.0 renders an unfurled preview (title, description, thumbnail image) under a
message when its body contains a URL, using the Matrix `/preview_url` homeserver
endpoint. Charm 2.0 has no equivalent — URLs render as plain clickable links only.
This is a small but very visible Day-1 gap: pasted links (news articles, GitHub PRs,
Twitter/X posts) are common in day-to-day chat and their absence makes the client
feel visually thinner than 1.0 immediately.

## Non-goals

- Not client-side scraping/unfurling — use the homeserver's existing
  `/_matrix/client/v1/media/preview_url` (or legacy `/media/r0/preview_url`)
  endpoint, same as Charm 1.0, rather than building an independent OpenGraph
  scraper. Avoids duplicating server-side privacy/rate-limit handling and SSRF
  protections the homeserver already implements.
- Not previews inside encrypted rooms' *content* sent to the server as new
  metadata — the existing Matrix behavior (server sees the URL because it must
  fetch it) is unchanged from Charm 1.0's own privacy posture; not attempting a
  more private redesign here.
- Not multi-link previews per message (Charm 1.0 shows at most one) — match that.
- Not a settings toggle to disable previews entirely in this initial phase, unless
  trivial to add alongside the render path (nice-to-have, not blocking).

## High-level design

- Detect the first HTTP(S) URL in a message's plain-text body via existing
  linkify/URL-detection already used for clickable links in `MessageRow`.
- On render, call `preview_url(url, ts?)` via IPC → Rust → homeserver
  `/preview_url`, cached client-side (URL → preview blob, TTL matching the
  `expires_ts` typically inherent to that endpoint's response, or a sane default
  e.g. 1 hour if the server doesn't specify one) to avoid re-fetching on every
  scroll/remount.
- Render a `LinkPreviewCard` below the message body: thumbnail (if
  `og:image`/`matrix:image:size` present), title, description (truncated), site
  name/domain. Clicking anywhere on the card opens the link the same way clicking
  the inline URL text does.
- Graceful failure: if the endpoint 404s, times out, or the homeserver doesn't
  support it, render nothing extra — never show a broken-image placeholder or error
  state inline in the timeline.
- Respect `m.url_previews`/`org.matrix.msc4238`-style disable hints if the room or
  message opts out (check current MSC/spec status before implementing; if no stable
  mechanism exists yet, skip this bullet and revisit later).

## Data flow

New IPC command, e.g. `get_url_preview(room_id, url) -> UrlPreview | null`, Rust
side calls the homeserver's `/preview_url` with the user's access token (server
requires auth on this endpoint) and returns a typed struct (title, description,
image URL, image dimensions if known). Frontend caches by URL in-memory (and
optionally on-disk if it should survive app restart — start in-memory only, revisit
if refetch-on-every-launch proves too chatty).

## API/contract changes

New IPC command as above with ts-rs bindings. No changes to existing message
send/render paths beyond the additive `LinkPreviewCard`.

## Testing strategy

- Rust: unit test the `/preview_url` client call against a mocked HTTP response
  (success, 404, malformed JSON, timeout) — confirm each maps to a safe frontend
  result (`Some(preview)` or `None`, never a panic/unhandled error surfaced to UI).
- Frontend: `LinkPreviewCard` component tests for each field-presence combination
  (image+title+desc, title only, no data at all → renders nothing), and a
  `MessageRow` test confirming a message with no URL never triggers a preview
  fetch.
- Manual: paste a real URL in a real room against a real homeserver, confirm the
  preview appears and that scrolling the message out of view and back doesn't
  re-fetch (cache hit).

## Trade-offs

- **Homeserver `/preview_url` vs client-side fetch**: homeserver endpoint chosen to
  match Charm 1.0's exact behavior/privacy model and avoid re-solving SSRF
  protection client-side; a client-side fetch would also leak the user's IP
  directly to arbitrary link targets, which the homeserver-proxy approach avoids.
- **In-memory-only cache for v1**: simpler, avoids a new persistent cache table;
  revisit disk persistence only if repeated preview fetches on app relaunch prove
  to be a real cost/latency problem in practice.

## What I'd revisit as this grows

- Disk-persisted preview cache if relaunch refetch cost matters.
- Per-room/per-message opt-out once a stable Matrix spec mechanism for it exists.
