---
title: Charm 2.0 Spec — Voice message recording
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent. Extends Spec 02 (media), which explicitly
scoped voice-message *recording* out ("adjacent Day-1+1; renders/plays received
`m.audio` but does not record").

## Problem & why now

Charm 2.0 can play received voice messages but cannot record and send one. Charm
1.0 has a full recorder: `src/app/features/room/AudioMessageRecorder.tsx`,
`plugins/voice-recorder-kit/useVoiceRecorder.ts`, `micHoldGesture.ts` — mic
capture, waveform, hold-to-record gesture. Voice messages are a mainstream chat
expectation (WhatsApp/Signal/Telegram/Element all have them), and Spec 02's own
non-goals flagged this as the one clear recording miss. The mic-permission
plumbing needed for this was already validated per-platform by Spec 13 (voice-video
spike), so the platform groundwork exists.

## Non-goals

- Not voice-to-text transcription.
- Not live/streaming voice (that's calling — day-2 Spec 02).
- Not editing a recording (trim) before send in v1 — record, preview, send or
  discard; trimming can follow if requested.

## High-level design

- Composer gains a **record-voice** affordance (mic button, or press-and-hold
  gesture like Charm 1.0's `micHoldGesture.ts`). Choose one primary interaction;
  press-and-hold + slide-to-cancel is the mobile-friendly default, with a
  tap-to-start/tap-to-stop fallback for desktop.
- **Capture:** use the platform mic via the Web Audio / MediaRecorder API in the
  webview (the permission path Spec 13 fixed per-platform gates this — reuse it,
  and handle permission-denied with a clear message, not a silent no-op).
- **Waveform + timer:** show a live waveform and elapsed time while recording
  (Charm 1.0 renders a waveform); on stop, show a preview with play/scrub before
  the user commits to send.
- **Encode & send:** encode to a widely-supported format (Opus in Ogg/WebM is the
  Matrix ecosystem norm for `m.audio` voice messages) and send as an `m.audio`
  event with the voice-message markers (`org.matrix.msc3245.voice` / MSC1767 audio
  + waveform `org.matrix.msc3246.audio` with the amplitude array) so other Matrix
  clients render it as a voice message, not a generic audio file. Confirm current
  stable MSC state for voice-message markers before finalizing the content shape.
- **Send path:** route through Spec 02's existing `send_attachment`/attachment
  pipeline (upload, progress, encryption in E2EE rooms) — don't build a parallel
  upload path.

## Data flow

Recording/encoding happens in the webview (frontend); the resulting blob is handed
to Spec 02's existing attachment-send command with the voice-message content
markers and waveform data attached. No new media-cache or fetch work — playback of
the sent message reuses Spec 02's existing `m.audio` rendering (`AudioPlayer.tsx`),
which may want a waveform-aware variant to match how it renders received voice
messages (small enhancement, note if the current `AudioPlayer` doesn't show a
waveform for voice messages).

## API/contract changes

### Implementation boundary

The pinned matrix-sdk 0.18.0 provides `AttachmentInfo::Voice(BaseAudioInfo)`.
Its attachment send path constructs the voice marker and audio details from that
variant; use it rather than constructing a second upload/send implementation.
`BaseAudioInfo::waveform` accepts normalized floating-point amplitudes in `[0, 1]`;
the SDK converts these into the Matrix wire representation. Duration and waveform
must both be supplied for the SDK's audio-details block.

The current native command takes a filesystem path, whereas browser recording
produces a `Blob` with no trusted path. Extend the existing attachment boundary
to accept a bounded recording payload and metadata, without granting arbitrary
filesystem write access or persisting microphone data merely to bridge the two.
The web companion should accept the same metadata alongside its existing
multipart upload. Both transports must validate audio MIME, finite normalized
waveform samples, duration, and payload size before starting the upload; reuse
the current room authorization, transaction ID, progress, cancellation, and
encrypted-room handling. Ordinary attachment behavior must remain unchanged.

Recording must stop and release microphone tracks, timers, audio nodes, and
preview object URLs on discard, room/account change, flag disable, and unmount.
A late permission response must release its stream if the recording attempt is
no longer current. Preview is local-only until explicit send. Microphone samples,
filenames, and recorded content must not enter logs or telemetry.

The implementation branch now has bounded MediaRecorder capture, local native
audio-control preview, explicit send/discard, desktop start/stop and mobile
hold/slide-to-discard controls. The composer mounts the recorder behind the
default-off `voice_recording` flag and keys it by account and room. Recording
metadata travels through the existing native and web attachment transports;
failed sends retain the local preview for retry. The current live visualization
is a microphone-level meter, not yet the required waveform history.

This is implementation progress, not acceptance: generated binding import,
microphone lifecycle and gesture tests, CI, waveform UI, platform permission
checks, and real-device/cross-client interoperability remain outstanding.

- Reuse Spec 02's `send_attachment` if it can carry the extra voice-message content
  markers + waveform; if not, a small extension or a dedicated
  `send_voice_message(room_id, file_path, waveform, duration_ms)` command.
- Tauri mic-permission capability entries per platform (mirrors Spec 13's
  per-platform permission work — reuse its findings/config).

## Testing strategy

- Frontend: record → preview → send happy path with a mocked MediaRecorder; discard
  path; permission-denied path shows a clear message.
- Rust/IPC: voice message sends with correct `m.audio` + voice-message markers +
  waveform; round-trips and renders as a voice message (not generic audio) when
  read back.
- Manual + per-platform: actually record and send on at least macOS and one mobile
  target, reusing Spec 13's per-platform permission checklist; confirm a received
  voice message from Element renders correctly and vice versa (cross-client).

## Trade-offs

- **Reuse Spec 02's attachment pipeline vs a bespoke voice path**: reuse — it
  already handles upload/progress/E2EE; voice messages are `m.audio` with extra
  markers, not a fundamentally different transport.
- **Opus/Ogg encoding target**: matches the Matrix ecosystem norm for voice
  messages so cross-client rendering works; a non-standard codec would play in
  Charm but show as a generic file elsewhere.

## What I'd revisit as this grows

- Trim-before-send if users ask for it.
- Playback-speed control on received voice messages (small `AudioPlayer`
  enhancement).
