---
title: Charm 2.0 Spec — Image editing before send
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent.

## Problem & why now

Charm 1.0 has an `image-editor/` for annotating/cropping/marking-up an image before
sending it (arrows, text, blur/redact regions, crop) — common for screenshots and
quick visual explanations in chat. Charm 2.0's Spec 02 (media/attachments) covers
upload/render/lightbox but no pre-send editing; an attached image goes straight
from file picker/clipboard to send.

## Non-goals

- Not a general-purpose image editor with layers/filters — scope matches Charm
  1.0's actual toolset: crop, basic annotation (arrow, rectangle, freehand pen,
  text label), and a blur/redact tool for hiding sensitive regions before sharing a
  screenshot. Not building beyond that toolset without a specific request.
- Not video editing/trimming — images only, matching 1.0's scope.

## High-level design

- Composer's existing attach-image flow (Spec 02) gains an intermediate "Edit"
  step: after picking/pasting an image and before it enters the send queue, an
  editor overlay opens with the toolset above.
- Editing happens client-side on the in-memory image before upload — no partial
  upload/re-upload cycle; the edited raster result is what gets uploaded, matching
  how 1.0's editor works (edit-then-upload, not upload-then-annotate-in-place).
- Tools: crop (drag handles), arrow/rectangle/freehand pen (basic vector overlay
  tools, simple color picker), text label, blur/pixelate region (draggable
  rectangle that applies a blur filter to that pixel region on flatten).
- "Done" flattens all annotations into the raster image; "Cancel" discards edits
  and returns to the original picked image (or removes the attachment entirely if
  the user backs out of the whole attach action).
- Skippable: editing is opt-in per attachment (an "Edit" button next to the
  attachment preview in the composer, not a forced step) — most sends are probably
  unedited, don't add friction to the common case.

## Data flow

Purely client-side/frontend — canvas-based editing (e.g. via an existing
lightweight canvas library, or hand-rolled `<canvas>` manipulation; avoid a heavy
new dependency for what's fundamentally crop+draw+blur) operating on the in-memory
image blob before it's handed to Spec 02's existing upload path. No new IPC/Rust
surface — this is entirely a frontend addition sitting in front of an already-
existing upload command.

## API/contract changes

None — reuses Spec 02's existing media-upload IPC path unchanged; this spec only
transforms the blob before that call.

## Testing strategy

- Frontend: each tool (crop, arrow, rectangle, pen, text, blur) applies correctly
  to a fixture canvas and flattens to the expected output; cancel restores original
  image; done hands the flattened blob to the existing upload path with correct
  MIME type/dimensions.
- Storybook: editor states for each tool, feeding the `storybook-a11y` gate (verify
  toolbar controls are keyboard-accessible, an easy thing to miss in canvas-heavy
  UI).
- Manual: full picker → edit → send → render-in-timeline round trip, confirm
  edited image (not original) is what recipients see.

## Trade-offs

- **Client-side canvas editing vs a native image-processing library via Rust**:
  canvas/frontend approach avoids adding Rust-side image manipulation dependencies
  and keeps the whole feature within Spec 02's existing upload boundary; a native
  approach would only be worth it if canvas performance on large images proves
  inadequate, which should be checked early rather than assumed.

## What I'd revisit as this grows

- Additional tools (shapes beyond rectangle, sticker/emoji overlay) if requested —
  additive to the same flattening pipeline, not a rearchitecture.
