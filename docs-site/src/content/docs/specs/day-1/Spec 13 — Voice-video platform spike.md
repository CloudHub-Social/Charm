---
title: "Charm 2.0 Spec — Voice-video platform spike"
type: spec
project: Charm 2.0
created: "2026-07-04"
status: spike-mostly-resolved
---

**Workstream:** one PR / one agent. **Tier:** Day-1 launch-critical.

## Problem & why now

Charm 2.0's planning doc mandates first-party WebRTC calling in Phase 4 — running
WebRTC **directly in the WRY webview**, replacing Charm 1's iframe-embedded Element
Call. That is a large, expensive build, and its feasibility rests on an assumption
that is **not yet proven on any target platform**: that the webview each Tauri target
ships (WKWebView on macOS/iOS, WebView2 on Windows, WebKitGTK on Linux, Android
System WebView) will actually grant camera/mic access, establish an
`RTCPeerConnection`, negotiate media, and ideally screen-share — from inside a Tauri
app, not a browser.

This is exactly where prior art bites: WKWebView historically did not implement
`getUserMedia` at all until relatively recently and still has entitlement/Info.plist
requirements; WebView2 gates media permissions through a native
`PermissionRequested` event the host app must handle; WebKitGTK needs the correct
build and a permission-request signal wired up; Android System WebView requires the
host `Activity` to grant runtime permissions **and** answer the `onPermissionRequest`
callback. Any one of these failing quietly turns Phase 4 into a rewrite mid-flight.

The doc therefore requires this spike **in parallel during Phase 1**, because its
findings **gate the Phase 4 calling build**. This spec is an **investigation
deliverable** — a findings matrix and a go/no-go per platform — **not shipped call
UI**. CEF is explicitly out unless WRY is shown to be a dead end on a platform.

## Current state (in repo)

- Runtime is Tauri v2 with the default **WRY** webview per platform; no CEF.
- No calling code, no WebRTC, no `getUserMedia`/`RTCPeerConnection` usage anywhere
  today. `App.tsx` → `RoomsScreen` is the whole surface; verification is the only
  crypto-adjacent feature.
- No camera/mic permission strings, entitlements, or manifest permissions are
  declared in any platform config (`Info.plist` / macOS entitlements /
  `AndroidManifest.xml` / Tauri capability files) because nothing has needed them.
- Matrix's own calling primitives (MatrixRTC / Element Call widget) are **not** in
  scope for this spike — the spike validates the *transport substrate* (webview +
  WebRTC + permissions), not the Matrix signalling layer.

## Scope (in)

Validate, on **all five targets** — macOS, Windows, Linux, iOS, Android — the three
gating capabilities:

1. **Permission prompt + real grant.** `navigator.mediaDevices.getUserMedia({ audio,
   video })` triggers the OS/webview permission prompt, and after the user accepts,
   access is **actually granted** (a live `MediaStream` with active audio/video
   tracks — not a silently-empty or immediately-ended stream).
2. **Peer connection + media negotiation.** Two `RTCPeerConnection` instances complete
   an offer/answer SDP exchange (`createOffer` → `setLocalDescription` →
   `setRemoteDescription` → `createAnswer`), gather ICE candidates, reach
   `connectionState === "connected"`, and carry live media — loopback (two PCs in one
   webview) as the baseline, and two-device where loopback is insufficient (mobile).
3. **Screen share.** `navigator.mediaDevices.getDisplayMedia()` returns a usable
   screen/window stream **or** is confirmed unsupported for that platform, with the
   reason recorded (desktop-only expectation for mobile).

For each platform, document and exercise:
- **How to test WebRTC inside WRY** and the webview's known media-capture caveats.
- **The exact Tauri v2 permission / entitlement mechanics** needed to make (1) work.
- **The go/no-go input** each result feeds into Phase 4.

A minimal throwaway harness (a Tauri command + a test page with three buttons: "get
media", "loopback PC", "screen share", plus a live status/log readout) is in scope as
*spike scaffolding*, explicitly not production code.

## Non-goals (out)

- **No call UI**, no ringing, no call state machine, no Matrix call signalling, no
  MatrixRTC / Element Call integration, no TURN/SFU selection. All Phase 4.
- No production entitlement hardening or store-review packaging — the spike declares
  the *minimum* permissions to prove capability, not the final signed config.
- No CEF evaluation unless a platform returns **no-go** on WRY and the findings doc
  recommends escalating that one platform.
- No performance/quality benchmarking (bitrate, codecs, echo cancellation tuning) —
  capability presence only.

## Design & approach

### Harness

One tiny Tauri app target (or a dev route behind a flag) loading a static test page:

- **Button A — getUserMedia:** requests `{ audio: true, video: true }`, renders the
  local stream in a `<video>`, logs track states.
- **Button B — loopback PC:** builds `pcA`/`pcB`, wires `onicecandidate` →
  `addIceCandidate`, `ontrack` → second `<video>`, runs the offer/answer dance, logs
  `connectionState`/`iceConnectionState` transitions. No signalling server needed for
  loopback; for the two-device mobile case, a trivial manual copy-paste / LAN
  signalling shim.
- **Button C — getDisplayMedia:** requests display media, renders or logs the failure
  reason (`NotAllowedError`, `NotSupportedError`, etc.).

The page logs to an on-screen console so mobile runs (no devtools) are still
capturable via screenshot.

### Per-platform permission / entitlement mechanics to wire and record

- **macOS (WKWebView):**
  - `Info.plist`: `NSCameraUsageDescription`, `NSMicrophoneUsageDescription` (missing
    keys → immediate crash on access).
  - App **entitlements**: `com.apple.security.device.camera`,
    `com.apple.security.device.audio-input` (required under the hardened runtime /
    App Sandbox that Tauri's macOS bundle uses).
  - Note WKWebView's history: `getUserMedia` support is comparatively recent; confirm
    the `getUserMedia`/`getDisplayMedia` availability on the WKWebView version WRY
    binds, and whether a `WKUIDelegate`
    `requestMediaCapturePermissionFor` decision is needed/possible from WRY.
- **iOS (WKWebView):**
  - Same `NSCameraUsageDescription` / `NSMicrophoneUsageDescription` in the iOS
    `Info.plist`.
  - Confirm `getDisplayMedia` is **expected unsupported** (iOS screen capture is
    ReplayKit-based, not exposed to the webview) — record as a known gap, not a
    failure.
  - Two-device or device+desktop test for the PC leg (no meaningful loopback camera).
- **Windows (WebView2):**
  - WebView2 raises `CoreWebView2.PermissionRequested`; the host must handle it and
    set `State = Allow` for `Camera`/`Microphone`, otherwise the JS prompt never
    resolves to a grant. Determine whether WRY surfaces/handles this or whether a
    Tauri-side hook is required, and record exactly what was needed.
  - No OS Info.plist analog; note any Windows privacy-setting (Settings → camera/mic
    access) that must be on.
- **Linux (WebKitGTK):**
  - WebKitGTK emits `WebKitWebView::permission-request`
    (`WebKitUserMediaPermissionRequest`); confirm WRY grants it or whether a signal
    handler must be added. Record the WebKitGTK version / `webkit2gtk` package the
    build links, since media support varies by build.
  - `getDisplayMedia` availability is Wayland/PipeWire-dependent — record the session
    type and result.
- **Android (Android System WebView):**
  - `AndroidManifest.xml`: `android.permission.CAMERA`,
    `android.permission.RECORD_AUDIO` (and `INTERNET`, already present for Matrix).
  - Runtime permission request (Android 6+) from the host `Activity` **and** the
    WebView's `WebChromeClient.onPermissionRequest` must call
    `PermissionRequest.grant(...)` — both are required; either missing blocks media.
    Record how this is wired through the Tauri Android shell.
  - `getDisplayMedia` on Android WebView is generally unsupported (MediaProjection is
    native) — expect a gap; record.

### Tauri v2 capability layer

Independent of OS permissions, record whether any **Tauri v2 capability** entries
(in `src-tauri/capabilities/*.json`) or plugin permissions are needed for the webview
to reach media APIs, and note the CSP: a restrictive `Content-Security-Policy` can
block WebRTC/media — confirm the spike's CSP allows `mediastream:`/`blob:` as needed.

### Go/no-go framing

Each of the 5 platforms gets a verdict fed to Phase 4:
- **GO** — all three capabilities pass (or fail only on an *expected* gap like mobile
  screen share) with the required permission wiring documented.
- **CONDITIONAL GO** — passes with a non-trivial workaround (e.g. a custom permission-
  request handler that must be built in Phase 4); the workaround is specified.
- **NO-GO** — a capability cannot be achieved in WRY on that platform; triggers an
  explicit escalation note (alternative webview build, native call surface, or — last
  resort, per the doc — CEF for that platform only).

## Deliverable (what the spike produces)

Not feature code. The spike ships:

1. **Findings doc** beside this spec in the repository, containing:
   - **Per-platform findings matrix** — rows = `{macOS, Windows, Linux, iOS, Android}`;
     columns = `{getUserMedia grant, RTCPeerConnection + media negotiated,
     getDisplayMedia}`; each cell PASS / FAIL / EXPECTED-GAP with the evidence
     (screenshot / log excerpt) and the **exact permission/entitlement/manifest/
     capability changes** that made it work.
   - **Go / No-go / Conditional-go verdict per platform**, each with the specific
     Phase 4 implication and any required workaround spelled out.
   - **Scoped gaps list** — every EXPECTED-GAP and every CONDITIONAL item written as a
     concrete Phase 4 work item (e.g. "Windows: implement WebView2 PermissionRequested
     handler", "iOS/Android: screen share needs native ReplayKit/MediaProjection
     bridge or is descoped").
   - **Webview version inventory** — the WKWebView/WebView2/WebKitGTK/Android WebView
     versions the WRY build actually bound on each test machine.
2. **Throwaway harness** kept on a spike branch (not merged to `main` as product
   code), referenced from the doc so results are reproducible.

## Spike exit-criteria checklist

The spike is **done** when, for **each** of the five platforms (macOS, Windows,
Linux, iOS, Android), all three are recorded with evidence and a verdict:

- [ ] **(1) Permission + grant:** `getUserMedia({audio,video})` prompts, and after
      accept a live `MediaStream` with active tracks is obtained — PASS/FAIL + the
      exact permission wiring (Info.plist keys / entitlements / manifest perms /
      WebView2 or WebKitGTK/Android permission-request handling / Tauri capability).
- [ ] **(2) Peer connection + media:** two `RTCPeerConnection`s complete offer/answer,
      reach `connectionState === "connected"`, and carry live media (loopback and/or
      two-device) — PASS/FAIL + evidence.
- [ ] **(3) Screen share:** `getDisplayMedia()` yields a usable stream, **or** is
      recorded as EXPECTED-GAP/unsupported with the platform reason.
- [ ] **Verdict** recorded per platform (GO / CONDITIONAL GO / NO-GO) with Phase 4
      implication.

Overall exit: 15 capability cells + 5 verdicts filled, findings doc published, gaps
enumerated as Phase 4 work items.

## Testing

This is an investigation, so "testing" is the manual, evidence-capturing runs
themselves, run on real hardware/emulators for each target (macOS + Windows + a Linux
box/VM; a physical or simulator iOS device where camera permits; an Android
device/emulator with a virtual camera). Each run captures the on-screen log +
screenshot as evidence in the matrix. No automated Vitest/Playwright suite is required
for the throwaway harness; if any harness helper is kept, a smoke test that the page
loads is sufficient. The **real** automated call tests are a Phase 4 deliverable,
scoped by this spike's findings.

## Dependencies & sequencing

- **Runs in parallel during Phase 1** (per the doc) — does not depend on onboarding,
  rooms, or verification work.
- **Gates Phase 4:** no calling UI work starts until this spike returns verdicts. A
  NO-GO changes Phase 4's architecture (or platform scope) before any build cost is
  sunk.
- **Needs:** access to all five platforms/emulators; ability to modify each platform's
  Tauri config (`Info.plist`, entitlements, `AndroidManifest.xml`,
  `capabilities/*.json`) on the spike branch.
- One PR (the harness + doc link) / one agent, though execution spans multiple
  machines.

## Risks & open questions

- **R1 — WRY abstracts away the native permission hook.** WebView2's
  `PermissionRequested`, WebKitGTK's `permission-request`, and Android's
  `onPermissionRequest` may not be surfaced by WRY, requiring a patch/fork or a Tauri
  plugin to intercept. If so, that itself is a Phase 4 line item — capture it as
  CONDITIONAL, not NO-GO, unless truly unreachable.
- **R2 — mobile loopback is meaningless.** Single-device loopback doesn't exercise a
  real camera path the same way; the two-device leg is mandatory for iOS/Android and
  needs a minimal signalling shim.
- **R3 — screen share expected-gaps on mobile** could be misread as failures — the
  matrix must distinguish EXPECTED-GAP from FAIL so a mobile screen-share "no" doesn't
  wrongly read as a platform NO-GO.
- **Q1 — webview version drift.** Results are tied to the WKWebView/WebView2/
  WebKitGTK/Android WebView versions on the test machines; a user on an older OS may
  differ. Record minimum supported versions as a Phase 4 constraint.
- **Q2 — CSP interaction.** Confirm the production CSP direction won't retroactively
  block media once real screens ship.
- **Q3 — does any platform force a CEF reconsideration?** Only escalate if a capability
  is genuinely unreachable in WRY; document the trigger explicitly.

## Effort estimate

**M.** Individually each platform run is small, but the spike's weight is breadth —
five platforms × three capabilities × real permission wiring, plus device/emulator
setup for mobile and the evidence-capture discipline needed for a decision-grade
findings matrix. Low code, high coordination.
