---
title: Charm 2.0 Spec — Media send polish
type: spec
project: Charm 2.0
created: 2026-07-13
status: in-progress
---

## Implementation status

**In progress behind the default-off `media_send_polish` feature flag.** The first
independently releasable slice adds a full-chat drop-target overlay while a file is
dragged over the active room. It uses drag-depth tracking so crossing nested message
or composer elements does not flicker the target, ignores non-file drags, clears on
drop, leave, or room switch, and keeps the existing desktop/web attachment payload
handling unchanged. The public media-and-attachments gallery entry now identifies
this flag as a preview rollout while the broader attachment experience remains usable.

Captions, upload-size preflight, actual upload cancellation, GIF autoplay controls,
and default EXIF stripping remain planned. This spec is therefore not shipped or
complete.

**Workstream:** one PR / one agent. Small cluster of Spec 02 (media) sub-features
the parity audit found scoped out. Individually minor, collectively noticeable.

## Problem & why now

Charm 2.0's media send/render is broadly at parity, but the audit (2026-07-13)
found four gaps against Charm 1.0, each confirmed absent in Charm 2.0's code:

1. **Media captions** — Charm 1.0 sends and renders captions on media
   (`features/room/attachmentSendPlan.ts`, `message/MessageEditor.tsx`). Charm 2.0's
   `media/MediaMessage.tsx:14` uses `body` only as alt text, and the composer has no
   caption path. Users can't add a line of text to an image/file at send time.
2. **Upload file-size limit / warning** — Charm 1.0 checks the homeserver's
   `m.upload.size` limit (`upload-card/UploadCardRenderer.tsx:392`). Charm 2.0's
   `useAttachmentUploads.ts` has no size check, so an over-limit upload fails
   opaquely server-side instead of a friendly pre-flight warning.
3. **Upload cancel** — Charm 2.0's `useAttachmentUploads.ts:54` `dismissUpload`
   only removes the tray row; it does **not** abort the in-flight send. A large
   mis-picked upload can't actually be stopped.
4. **Inline GIF autoplay** — Charm 1.0 autoplays animated images inline (gated by
   an `autoplayGifs` setting, `message/content/ImageContent.tsx:64`). Charm 2.0
   (`MediaMessage.tsx:95`) shows a static thumbnail inline and only animates in the
   lightbox.
5. **EXIF stripping on upload** (owner-added 2026-07-13). Strip EXIF/metadata
   (GPS location, camera info, timestamps) from images before upload, with a
   **toggle to keep/strip and strip-by-default**. Absent in both clients today, but
   the owner wants it added — a real privacy leak (sharing a photo silently shares
   where it was taken). Strip Rust-side during the upload path (Spec 02's
   `send_attachment`) before the bytes go to the homeserver; the keep/strip toggle
   is an appearance/privacy setting (default = strip).

## Non-goals

- Not image editing/markup before send (day-2 Spec 08).
- Not media galleries / per-room media index.
- Not streaming range-playback of large videos (Spec 02 deferred this
  intentionally; still fine to defer).

## High-level design

- **Captions:** add an optional caption text field to the attachment preview in the
  composer (before send); send it as the caption per the Matrix convention Spec 02's
  attachment API already supports (`AttachmentConfig::caption` was referenced in
  Spec 02's own design). Render the caption under the media in `MediaMessage`
  instead of using `body` only as alt text.
- **Size limit:** fetch the homeserver's `m.upload.size` (media config endpoint)
  once and warn/block pre-flight when a picked file exceeds it, with a clear message
  ("This server's limit is X MB") — don't just let the send fail.
- **Upload cancel:** wire `dismissUpload` to actually abort the in-flight send via
  the send-queue's cancel for that transaction (same mechanism Spec 37's
  resend/discard uses), not just hide the row.
- **GIF autoplay:** render animated images inline as animated (respecting a new
  `autoplayGifs` appearance toggle — put it with Spec 47's other autoplay-media
  toggles; default matching Charm 1.0). Static-thumbnail-until-hover is an
  acceptable middle ground if always-autoplay proves too heavy on long timelines —
  match Charm 1.0's behavior/setting.

## Data flow

Captions ride Spec 02's existing attachment send. Size limit needs a read of the
server media config (`get_media_config` IPC if not already available). Cancel reuses
the send-queue transaction cancel. GIF autoplay is a frontend render decision gated
by a setting.

## API/contract changes

- Possibly `get_media_config() -> { upload_size_limit }` if not already exposed.
- Caption support in the attachment send path (Spec 02 may already carry it).
- Send-queue cancel wrapper surfaced to the frontend (shared with Spec 37).

## Testing strategy

- Frontend: caption field sends and renders; over-limit file is warned/blocked
  pre-flight; cancel aborts an in-flight upload (assert the send-queue cancel is
  called, not just a UI hide); animated image renders animated per setting.
- Rust: `get_media_config` returns the server limit; caption content is attached
  correctly.
- Manual: add a caption to an image and confirm a second client shows it; try to
  send an over-limit file and confirm the friendly warning; cancel a large upload
  mid-flight.

## Trade-offs

- **Bundle these four vs separate PRs**: bundled — each is small and they all live
  in the same media send/render surface; splitting would be more overhead than the
  work itself.

## UI-parity addition (from the 2026-07-13 UI deep-dive)

- **Drag-drop drop-zone overlay.** Charm 2.0's `ChatShell.tsx:589-613` handles
  `onDragOver`/`onDrop`/paste but only `preventDefault()`s — there's **no visible
  drop-target overlay**, so the user gets no confirmation a drop will land. Charm 1.0
  shows a full-panel overlay ("Drop files in {Room}", `RoomInput.tsx:2372-2389`).
  Add a drop-target overlay/highlight shown while a file is dragged over the message
  area.

## What I'd revisit as this grows

- Multi-file caption-per-item vs one caption for a batch, if batch upload with
  captions is requested.
