---
title: Charm 2.0 Spec — Export chat history
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent.

## Problem & why now

Charm 1.0 lets a user export a room's message history (for record-keeping, legal
hold, or just personal archive) to a file. Charm 2.0 has no export path — a user
wanting a copy of a conversation currently has no in-client option beyond manual
scrolling/screenshotting.

## Non-goals

- Not a bulk "export my entire account" tool in Phase 1 — per-room export,
  matching Charm 1.0's scope; a full-account export is a plausible bigger follow-up
  (ties into data-portability/GDPR-style requests) but scope this spec to one room
  at a time first.
- Not exporting encrypted media file contents inline into the export bundle by
  default in the simplest format (plain text/HTML) — for those formats, media
  renders as a reference/link; a richer export format that bundles decrypted media
  files alongside the text (e.g. a zip with an HTML file + a media/ folder) can be
  the "full" export option, not the only one.

## High-level design

- Room settings/room-info panel gets an "Export chat" action.
- Format choice: plain text (`[timestamp] sender: body`, one line per message,
  closest to a simple log), HTML (styled, closer to how the room actually rendered,
  optionally with inline images if the "bundle media" option is chosen), and
  optionally JSON (raw structured event data, useful for programmatic use/legal
  hold requiring an unaltered record).
- Range selection: whole room history (as far back as locally available — exports
  are bounded by what's synced/available locally, not a forced full-server
  backfill, matching how Spec 28's search index similarly doesn't force backfill)
  or a date range (pairs naturally with the Jump-to-date spec if that lands first —
  reuse its date-range-picker component if so).
- Output: saved to a user-chosen location via the OS file-save dialog (Tauri's
  file-system/dialog plugin), not silently written somewhere in app data.
- Redacted messages: excluded from export by default (respecting the redaction),
  not silently included — match how the timeline itself already treats redactions.

## Data flow

Reads already-synced/locally-available timeline events (same source as normal
timeline rendering) plus, for the "bundle media" HTML option, fetches/decrypts
media the export includes (reusing Spec 02's existing media fetch/decrypt path).
Formatting/file-writing can happen either frontend-side (build the string/HTML,
hand off to a save-dialog write) or Rust-side if large exports risk frontend
memory/performance issues — start frontend-side for simplicity, move to Rust only
if profiling on a large room shows it's needed.

## API/contract changes

Possibly none if export purely reads through existing timeline-read IPC and writes
via Tauri's file-dialog plugin from the frontend. If Rust-side formatting is chosen
per the trade-off above, a new `export_room(room_id, format, range) -> file_path`
command.

## Testing strategy

- Frontend: each format's output correctness against a fixture event set (text
  layout, HTML structure, JSON shape), redacted-message exclusion, date-range
  filtering.
- Manual: export a real room with mixed content (text, media, edits, redactions,
  reactions), confirm output is legible and redactions are actually excluded, not
  just hidden.

## Trade-offs

- **Frontend-formatted vs Rust-formatted**: frontend-first chosen for simplicity
  and because it avoids adding a new Rust command for what's fundamentally a
  string-formatting task; revisit only if a very large room (tens of thousands of
  messages) proves slow/memory-heavy in the browser/webview context.

## What I'd revisit as this grows

- Full-account export (all rooms) if requested for data-portability/compliance
  reasons.
- Scheduled/automatic periodic export (e.g. for legal-hold-style continuous
  archival) — meaningfully different feature (background job, not one-shot user
  action), scope separately if it comes up.
