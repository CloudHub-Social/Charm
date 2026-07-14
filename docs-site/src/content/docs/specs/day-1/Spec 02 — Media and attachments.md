---
title: "Charm 2.0 Spec — Media and attachments"
type: spec
project: Charm 2.0
created: "2026-07-04"
status: shipped
---
**Workstream:** one PR / one agent. **Tier:** Day-1 launch-critical.

## Problem & why now
Charm today is text-only in both directions. `src-tauri/src/matrix/send.rs`
sends `RoomMessageEventContent::text_plain` only, and
`timeline.rs#events_to_summaries` explicitly filters to text `m.room.message`
events — its own doc comment calls out that "images/other msgtypes are a later
timeline-rendering pass." The attach button in `ChatShell.tsx` is hard-`disabled`
with a `cursor-not-allowed`. A Matrix client that can't send or display an image,
file, or voice clip isn't shippable. This spec also owns the **filesystem media
cache**, which Spec 01 (profiles) depends on for avatar thumbnails — so it's on
the Day-1 critical path for two features.

## Current state (in repo)
- `src-tauri/src/matrix/send.rs` — single `send_message(room_id, body)` command;
  `room.send_queue().send(AnyMessageLikeEventContent::RoomMessage(text_plain))`.
- `src-tauri/src/matrix/timeline.rs` — `events_to_summaries()` matches only
  `AnySyncMessageLikeEvent::RoomMessage` and takes `content.body()`; all
  non-`m.room.message` and all non-text msgtypes are dropped. `RoomMessageSummary`
  has no msgtype / media fields.
- `src/features/rooms/ChatShell.tsx` — renders `message.body` as a plain text
  bubble; attach `<button disabled>`; optimistic local echo on send.
- No media cache, no `client.media()` usage anywhere; no filesystem cache dir.
- `persistence.rs` already establishes an app data dir (`store_path(app)`) + OS
  keychain patterns to reuse for the cache root and any encryption concerns.

## Scope (in)
1. **Upload flow:** enable the attach button; support attach-picker (Tauri
   dialog), **drag-and-drop**, and **paste-image** into `ChatShell`.
2. **Send** `m.image` / `m.video` / `m.audio` / `m.file` via matrix-rust-sdk
   attachment APIs, with generated thumbnails/`AttachmentInfo`, through the send
   queue, with **upload progress** surfaced to the UI.
3. **Render** non-text msgtypes in the timeline: generalize `events_to_summaries`
   to carry msgtype + media metadata (not just `body`).
4. **Viewers:** image/video **lightbox**; inline **audio/video player**; file
   attachments as a download chip.
5. **Filesystem media cache**: real directory with **LRU (7-day / 500 MB /
   evict-oldest-10%)**, mxc→local-path resolution, and thumbnail fetching.
6. **Encrypted media**: decrypt in Rust only; the frontend only ever gets local
   file paths, never keys or ciphertext.
7. Expose **`media::resolve_avatar_thumbnail(mxc, size)`** for Spec 01.

## Non-goals (out)
- **Voice-message *recording*** (mic capture + waveform UI) — adjacent Day-1+1;
  this spec renders/plays received `m.audio` but does not record.
- Media galleries / per-room media index UI.
- Image editing/markup, GIF picker, stickers.
- Streaming/range playback of very large videos (fetch-whole-file for Day-1).
- Server-side media retention / redaction handling beyond honoring a redacted
  event.

## Design & approach

### Rust: new/changed modules, matrix-rust-sdk APIs, commands, events
- **New module `src-tauri/src/matrix/media.rs`** owning the cache + fetch/decrypt.
  - **Fetch/decrypt:** `client.media().get_media_content(&MediaRequestParameters
    { source, format }, use_cache=true)` where `source` is
    `MediaSource::Plain(mxc)` or `MediaSource::Encrypted(Box<EncryptedFile>)` —
    the SDK transparently decrypts encrypted sources, so crypto never leaves
    Rust. `format` is `MediaFormat::File` (full) or
    `MediaFormat::Thumbnail(MediaThumbnailSettings { method: Method::Scale,
    width, height, animated })`.
  - **Cache:** custom LRU over a real dir (e.g. `<app_data>/media/`), filename =
    hash of `(mxc, format, size)`. On write, enforce the policy: evict on
    >500 MB total or files older than 7 days (mtime/atime), removing the
    oldest ~10% when over budget. Index kept in a small sqlite table or an
    in-memory `BTreeMap` rebuilt from a dir scan at startup. Cache read returns a
    `PathBuf`; the frontend loads it via Tauri's asset protocol
    (`convertFileSrc`).
  - **Public API:** `resolve_media(mxc_or_source, kind) -> PathBuf`,
    `resolve_thumbnail(source, w, h) -> PathBuf`, and the Spec-01-facing
    `resolve_avatar_thumbnail(mxc, size) -> Option<PathBuf>`.
- **Changed `send.rs`:** new command **`send_attachment(room_id, file_path,
  caption: Option<String>)`**. Read bytes + infer `mime` (via the `mime_guess`
  crate), then
  `room.send_attachment(&filename, &content_type, data, AttachmentConfig::new()
  .caption(...).info(AttachmentInfo::…))` — this routes through the send queue,
  auto-encrypts in E2EE rooms, and generates the right msgtype from the mime.
  Generate a thumbnail for images/videos and pass it in the `AttachmentConfig`.
  Surface progress via the send queue's upload progress observable
  (`RoomSendQueueUpdate` / `MediaUploadProgress`) → emit a new
  **`upload:progress`** event `{ txn_id, room_id, sent, total }`.
- **Extend `timeline.rs#events_to_summaries` (OWNED BY SPEC 03) additively:** Spec 03
  owns `RoomMessageSummary`, `events_to_summaries`, and the relation-folding, and has
  already shipped the struct **flat** (top-level `body` + `formatted_body`, no content
  enum). Do **not** redefine the struct or replace its fields. Instead add one field
  `media: Option<MediaContent>` (see below) and, in the `RoomMessage` arm, inspect
  `original.content.msgtype` (`MessageType::{Image, Video, Audio, File}`) and set
  `media = Some(...)` with **metadata only** (mime, size, dimensions/duration,
  `has_thumbnail`, blurhash). Text/notice/emote leave `media = None` and keep Spec 03's
  top-level `body`. Do **not** eagerly fetch bytes.
- **New command `resolve_media(room_id, event_id, thumbnail: bool) -> String`**
  returning the local cache path. Re-derives the `MediaSource` from the event
  server-side (fetch/decrypt/cache on miss), so **no opaque media handle crosses IPC**
  and Spec 03's struct stays decoupled from this pipeline. Keeps the timeline page
  cheap; the UI fetches on demand (thumbnail first, full on lightbox open).

### IPC types (ts-rs bindings — `src-tauri/src/bindings/`)
- **Do not redefine `RoomMessageSummary` — Spec 03 owns it and ships it flat**
  (`event_id, sender, body, formatted_body, timestamp_ms, edited, redacted,
  reactions, in_reply_to, transaction_id, send_state`). **Add exactly one field,
  additively:** `pub media: Option<MediaContent>` (`None` for text). Define a new
  `MediaContent` tagged enum carrying **display metadata only** — no bytes, no source
  handle:
  - `Image { mime, size, width, height, has_thumbnail: bool, blurhash: Option<String> }`
  - `Video { mime, size, width, height, duration_ms, has_thumbnail: bool }`
  - `Audio { mime, size, duration_ms }`
  - `File { filename, mime, size }`
  All `u64`/`u32` fields get `#[ts(type = "number")]` (repo convention). The raw
  mxc/`EncryptedFile` never crosses IPC — the frontend resolves bytes by
  `(room_id, event_id)` via `resolve_media`.
- `UploadProgress { txn_id, room_id, sent, total }` (`#[ts(type = "number")]` on the
  byte counts) for `upload:progress`.
- IPC types are ts-rs-generated and re-exported through `src/lib/matrix.ts` via the
  `@bindings/*` alias (no hand-mirror — that landed in the ts-rs groundwork PR). Add
  `sendAttachment`, `resolveMedia`, `onUploadProgress` wrappers.
- Register `send_attachment` + `resolve_media` in `lib.rs#invoke_handler`.

### Frontend: components/hooks/atoms, surfaces changed
- **`ChatShell.tsx`:**
  - Un-`disable` the attach button → opens Tauri file dialog
    (`@tauri-apps/plugin-dialog`).
  - Add a drop zone (dragover/drop) over the message list and a `paste` handler
    on the textarea reading `clipboardData.files` for images.
  - Render by `message.media`: `null` → text bubble (Spec 03's `body`/
    `formatted_body`); `Image`/`Video` → thumbnail (calls `resolveMedia(roomId,
    eventId, thumbnail=true)` → `convertFileSrc`); `Audio` → inline `<audio>`;
    `File` → file chip with size + download.
  - Optimistic echo: extend the existing local-echo (`local-${Date.now()}`)
    scheme to attachments, showing an upload-progress bar driven by
    `onUploadProgress` keyed on txn id.
- **New components:** `MediaMessage`, `Lightbox` (Radix `Dialog` from
  `components/ui/dialog.tsx`; image/video, keyboard esc/arrows, 44px controls),
  `AudioPlayer`, `FileChip`.
- **New hook `useMediaSource(roomId, eventId, {thumbnail})`** — TanStack Query
  wrapping `resolveMedia`, cache-keyed on `(roomId, eventId, thumbnail)`.

### Media flow
Timeline page → summaries carry media **metadata only** (`media: Some(...)`, no bytes).
Frontend renders thumbnails via `resolveMedia(roomId, eventId, thumbnail=true)`;
opening the lightbox calls `resolveMedia(roomId, eventId, thumbnail=false)`. Rust
fetches+decrypts+caches, returns a path; frontend loads it with `convertFileSrc`.
Uploads go the reverse way with
progress events.

## Acceptance criteria
1. The attach button is enabled and opens a native file picker; a chosen file is
   sent and appears in the timeline as the correct msgtype.
2. Dropping a file onto the message area, and pasting an image into the composer,
   each trigger the same upload path.
3. Sending a large file shows a progress indicator that advances and clears on
   completion; a failed upload removes the optimistic echo and surfaces an error.
4. Images and videos render as inline thumbnails in the timeline; clicking opens
   a lightbox with the full-resolution media; audio renders an inline player;
   generic files render a download chip with filename + human-readable size.
5. In an **E2EE room**, sent media is encrypted and received encrypted media is
   decrypted and displayed; no key material or ciphertext crosses the IPC
   boundary (frontend only ever receives local file paths).
6. The media cache stores fetched files on the real filesystem and enforces the
   LRU policy: total stays ≤ 500 MB, entries older than 7 days are evicted, and
   over-budget eviction removes the oldest ~10%.
7. `resolve_media` returns a valid local path on cache hit without a network
   round-trip, and fetches+caches on miss.
8. `resolve_avatar_thumbnail(mxc, size)` returns a cached thumbnail path
   consumable by Spec 01.
9. `events_to_summaries` no longer drops non-text `m.room.message` events; text
   messages still render unchanged (no regression to Spec 01 / existing tests).

## Testing
- **cargo test** (`src-tauri/tests/` against dev Synapse): upload each of
  image/video/audio/file to a room and assert the echoed event's msgtype +
  `AttachmentInfo`; fetch it back via `resolve_media` and assert bytes round-trip.
  Repeat in an encrypted room and assert decrypt succeeds. Unit-test the LRU
  policy (pure, synthetic dir/index): budget eviction, 7-day expiry, oldest-10%
  selection — inline `#[cfg(test)]` like `sso_state_tests`.
- **cargo test** — `events_to_summaries` now emits `Image`/`File`/etc. variants
  for representative raw events, and still emits `Text` for text (guard against
  Spec 01 regression).
- **vitest + RTL** — `MediaMessage` renders correct variant per `content`;
  `Lightbox` opens/closes and traps focus; `useMediaSource` calls `resolveMedia`
  once per handle (dedup); upload-progress bar reacts to mocked
  `upload:progress`; paste/drop handlers dispatch send.
- **Playwright** (web build, mocked IPC + fixture files) — drag-drop an image,
  see thumbnail, open lightbox; send a file, see the chip.
- **Storybook + axe** — media message variants, lightbox, audio player;
  a11y check on lightbox controls (44px targets, keyboard, contrast).

## Dependencies & sequencing
- **No hard upstream Day-1 dependency** — builds directly on the shipped
  send/timeline/sync wiring in `send.rs` / `timeline.rs` / `mod.rs`.
- **Spec 01 (Timeline identity & profiles) soft-depends on this** for real avatar
  images via `resolve_avatar_thumbnail`. Recommended order: land the media cache
  + resolver early so Spec 01 can wire `avatar_path` in the same milestone.
- Reuses `persistence.rs` app-dir + keychain conventions for the cache root.

## Risks & open questions
- **Upload progress API surface:** confirm the exact matrix-rust-sdk send-queue
  progress hook (`RoomSendQueue` update stream vs. an `AbstractProgress`
  observable on `send_attachment`) — the event contract (`upload:progress`) is
  stable regardless, but the Rust wiring may differ from the sketch above.
- **Thumbnail generation:** decide Rust-side (e.g. `image` crate for stills;
  video first-frame is harder — may ship without server-generated video
  thumbnails Day-1 and rely on the homeserver's thumbnail endpoint via
  `MediaFormat::Thumbnail`).
- **`MediaSource` serialization:** encrypted sources carry an `EncryptedFile`
  (keys!). The `MediaHandle` must be an opaque server-side reference (e.g.
  event_id + a media index), never the serialized `EncryptedFile`, to keep keys
  in Rust — nail this down before implementing `resolve_media`.
- **Cache index durability:** in-memory index rebuilt by dir scan is simplest but
  loses atime precision; a tiny sqlite table is more robust — pick one.
- **`convertFileSrc` + CSP:** Tauri asset protocol must be allowlisted for the
  cache dir in `tauri.conf.json`; confirm CSP doesn't block local media.
- **Large files / memory:** `get_media_content` returns a `Vec<u8>`; very large
  videos could spike memory. Cap Day-1 upload size and flag streaming as future.

## Effort estimate
**L.** Two-directional media (upload + render + cache + decrypt) with several new
UI viewers, a new cache subsystem with an eviction policy, and a generalized
timeline content model that ripples into the Spec 01 bindings. The single largest
Day-1 workstream.
