---
title: "Spec 13 findings — voice-video platform spike"
type: spec-findings
project: Charm 2.0
created: "2026-07-06"
status: in-progress
sidebar:
  label: "Spike findings"
---

Companion findings doc to [Spec 13 — Voice-video platform spike](/specs/day-1/spec-13--voice-video-platform-spike/). This is a
progress snapshot, not a final GO/NO-GO — see "What's left" at the bottom.

**Spike branch:** `spike/voice-video-platform` on `CloudHub-Social/Charm`
(latest commit `ac69689`, pushed, not merged to `main`).
https://github.com/CloudHub-Social/Charm/tree/spike/voice-video-platform

## Environment available this session

This run was executed from a non-interactive coding-agent session with:
- **macOS** (this Mac, Apple Silicon, Xcode installed) — full access.
- **iOS Simulator** available via Xcode, but simulators have **no camera hardware**,
  so capability (1) can never PASS there regardless of wiring — noted per platform.
- **No Windows machine**, **no Android SDK/emulator/device**, **no Linux GUI**
  (Docker is present but headless — WebKitGTK's permission-request signal needs a
  real display to exercise).
- User has a personal Windows machine available for a manual follow-up run.

Given this, the exit-criteria checklist (15 cells + 5 verdicts) is **not fully
closed by this session** — see per-platform status below.

## Harness

`public/spike-webrtc.html` — static page, three buttons (A: getUserMedia, B:
loopback RTCPeerConnection, C: getDisplayMedia), on-screen log console. Opened as a
second Tauri window (label `spike-webrtc`) via `tauri.conf.json`, so `pnpm tauri dev`
on the spike branch launches both the normal app window and the harness window.
A `?manual=1` query param enables a copy/paste manual SDP exchange box for the
two-device mobile leg (R2 in the spec).

## Per-platform capability matrix

| Platform | (1) getUserMedia grant | (2) RTCPeerConnection + media | (3) getDisplayMedia | Verdict |
|---|---|---|---|---|
| macOS | **PASS** | **PASS** | **PASS** | **GO** |
| iOS | **BLOCKED** (Simulator has no camera; no physical device this session) - config gaps fixed 2026-07-13, still unverified on hardware | UNVERIFIED-LIVE | EXPECTED-GAP (ReplayKit-only, not exposed to WKWebView) | **CONDITIONAL** (fix landed, needs physical device) |
| Windows | **PASS** | **PASS** | **PASS** | **GO** |
| Linux | NOT RUN - no GUI display this session; fix landed 2026-07-13, still unverified | NOT RUN | NOT RUN | **CONDITIONAL** (fix landed, needs display environment) |
| Android | **FAIL as tested** (fix landed 2026-07-13, not yet re-verified) | UNTESTED (never reached — depends on (1)) | **EXPECTED-GAP, confirmed** — `getDisplayMedia` not present on WebView at all | **CONDITIONAL** — fix merged, needs device re-run |

### macOS — detail

Wiring landed on the spike branch:
- `src-tauri/Info.plist` (new) — `NSCameraUsageDescription` /
  `NSMicrophoneUsageDescription`, merged into the bundled Info.plist by
  Tauri's macOS bundler at build time.
- `src-tauri/Entitlements.plist` (new) — `com.apple.security.device.camera` and
  `com.apple.security.device.audio-input`, wired via
  `bundle.macOS.entitlements` in `tauri.conf.json` (required because Tauri's
  macOS bundle runs under the hardened runtime).
- CSP `media-src` extended with `blob:` and `mediastream:` (Q2 in the spec) —
  needed since WebRTC/media element sources use these schemes.

**Confirmed by manual click-through (2026-07-06, user's machine, real hardware,
`pnpm tauri dev` on commit `2b7bb63`).** Full on-screen log, verbatim:

```
[00:40:36.552] UA: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)
[00:40:36.574] getUserMedia available: true
[00:40:36.574] getDisplayMedia available: true
[00:40:36.575] RTCPeerConnection available: true
[00:40:47.337] A: requesting getUserMedia({audio:true,video:true})...
[00:40:51.416] A: PASS — granted, tracks = [audio:live:enabled=true, video:live:enabled=true]
[00:40:53.313] B: building pcA/pcB loopback...
[00:40:53.367] B: pcB received track kind=audio
[00:40:53.367] B: pcB received track kind=video
[00:40:53.373] B: pcB.connectionState = connecting
[00:40:53.374] B: pcA.connectionState = connecting
[00:40:53.374] B: offer/answer exchanged, waiting for ICE + connectionState=connected...
[00:40:53.376] B: pcA.connectionState = connected
[00:40:53.377] B: pcB.connectionState = connected
[00:40:55.149] C: requesting getDisplayMedia()...
[00:40:57.831] C: PASS — got display stream, tracks=1
```

- **(1) getUserMedia grant:** PASS — system prompt appeared (implied by the ~11s
  gap between click and grant, consistent with a user accept dialog, vs. the ~2s
  and ~3s gaps on B/C where no new permission class was being requested), live
  audio+video tracks, both `readyState: live`, both `enabled: true`.
- **(2) RTCPeerConnection + media:** PASS — offer/answer completed, both peers
  reached `connectionState: connected` in ~3ms of each other, `ontrack` fired for
  both audio and video on the receiving side.
- **(3) getDisplayMedia:** PASS — screen-recording prompt accepted, stream
  returned with 1 track.
- **Permission wiring that made it work:** exactly the config committed —
  `src-tauri/Info.plist` usage-description keys +
  `src-tauri/Entitlements.plist` (camera/audio-input device entitlements) wired
  via `bundle.macOS.entitlements`, plus the CSP `media-src` addition. No further
  changes were needed; nothing had to be patched after this run.
- **Webview version note:** the UA string reports `Intel Mac OS X 10_15_7` —
  this is WKWebView's known-generic compatibility UA and does **not** reflect the
  real CPU architecture or an exact WebKit build number. To get the actual bound
  WKWebView/Safari version for the inventory, run `defaults read
  /Applications/Safari.app/Contents/Info.plist CFBundleShortVersionString` (or
  check `sw_vers`) on the same machine — not yet done, listed under "what's left."

**macOS verdict: GO.** All three gating capabilities pass with only the minimum
entitlement/Info.plist/CSP wiring already documented above — no workaround, no
custom permission-request handler needed. Phase 4 can build native macOS calling
directly on WRY/WKWebView with this config as the baseline.

### iOS - detail

Updated 2026-07-13, PR #230 on GitHub. The "wiring landed" note below described
the spike's own branch, not main - confirmed absent on main before this PR.
Two real gaps fixed, neither of which needed a physical device to find:

1. NSCameraUsageDescription / NSMicrophoneUsageDescription were never actually
   added to src-tauri/gen/apple/charm_iOS/Info.plist on main. Without these,
   iOS kills the app outright (not just denies) the instant WKWebView asks
   AVFoundation for camera/mic access.
2. IPHONEOS_DEPLOYMENT_TARGET was 14.0. Reading wry 0.55.1's vendored source
   (wkwebview/class/wry_web_view_ui_delegate.rs) confirms its WKUIDelegate
   already implements
   webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:
   and auto-grants - same corrected-finding pattern as Android in PR #229 -
   but that delegate method is iOS 15+ API. Below that OS version nothing in
   WKWebView can grant the permission at all. Bumped to 15.0.

No entitlements needed on iOS (that's a macOS hardened-runtime/App Sandbox
concept, not applicable the same way to iOS apps).

The iOS Simulator has no real camera, so even a full build+run there can only prove
(2) API-level negotiation and code-path plumbing - not (1). A physical iOS device
(or the two-device leg envisioned in the spec, R2) is still required for a real
(1) verdict - not done in this PR, flagged as the next concrete step.

### Windows — detail (confirmed via headless CI, 2026-07-07)

Per Tauri v2 / WebView2 docs: WebView2 raises `CoreWebView2.PermissionRequested`
for camera/mic; if the host app (or WRY) doesn't handle it and set
`args.State = CoreWebView2PermissionState.Allow`, the JS-side `getUserMedia`
promise never resolves to a grant — it hangs or rejects. Whether WRY/Tauri v2
surfaces this event by default, or requires a Tauri plugin/custom WebView2
controller hook, was the R1 risk called out in the spec.

**Answered by CI, not manually.** The `windows` job in
`.github/workflows/spec-13-webrtc-spike.yml` ran `pnpm tauri dev` on a GitHub
Actions `windows-latest` runner with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
set to Chromium's `--use-fake-device-for-media-stream
--use-fake-ui-for-media-stream` (synthesizes a virtual camera/mic and
auto-accepts the permission prompt — since WebView2 is Chromium-based, these
flags apply to it directly). This ran unattended via the harness's `?auto=1`
mode, which reports results back to Rust over IPC. Took 4 CI iterations to get
a clean run — the first 3 failures were **not** the R1 risk showing up; they
were real, unrelated build/link bugs surfaced by this being (as far as this
session found) the first-ever Windows build of this app at all:

1. Job 1 timed out — not a platform finding, just an undersized CI timeout for
   a cold, uncached matrix-sdk + Tauri build (fixed: 15-min window + rust-cache).
2. Job 2 failed to link: `LNK1181: cannot open input file 'sqlite3.lib'` —
   `libsqlite3-sys` looks for a system SQLite via pkg-config/vcpkg; macOS/Linux
   CI runners have one, this Windows runner didn't. Fixed with a
   `cfg(target_os = "windows")`-scoped `libsqlite3-sys = { features =
   ["bundled"] }` in `src-tauri/Cargo.toml` (compiles SQLite from source,
   macOS/Linux linking untouched).
3. **Job 3 (commit `c3fab4c`) passed clean.** Full report artifact
   (`spike-13-windows-report`), `spike-ci-report.json`, verbatim:

   ```json
   {
     "a_getUserMedia": {
       "detail": "audio:live:enabled=true, video:live:enabled=true",
       "status": "PASS"
     },
     "b_loopbackPeerConnection": {
       "detail": "connectionState=connected on both peers",
       "status": "PASS"
     },
     "c_getDisplayMedia": {
       "detail": "tracks=1",
       "status": "PASS"
     },
     "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0"
   }
   ```

- **(1) getUserMedia grant — PASS.** The fake-device/fake-UI flags resolved
  cleanly with live audio+video tracks. This directly answers R1: **WRY/Tauri
  does let WebView2's permission flow resolve without a custom
  `PermissionRequested` handler** — at minimum, nothing blocks it from
  resolving when the Chromium-level permission surface is satisfied. (Caveat:
  this doesn't 100% prove a *real* user-facing prompt renders identically to a
  real user clicking Allow on unpatched WRY — the fake-UI flag auto-satisfies
  whatever permission surface Chromium presents, whether that's WebView2's
  native `PermissionRequested`-driven UI or its own fallback. A real
  human-click confirmation, like the macOS one, would remove that caveat —
  listed under "what's left.")
- **(2) RTCPeerConnection + media — PASS.** Both peers reached
  `connectionState: connected`.
- **(3) getDisplayMedia — PASS.** 1-track stream returned.
- **Webview version:** UA reports `Edg/149.0.0.0` — an actual, specific
  Chromium/Edge WebView2 build number (unlike macOS's generic WKWebView UA),
  giving a real version anchor for the inventory.

**Windows verdict: GO**, with the fake-UI caveat above noted rather than
suppressed. No custom WebView2 permission handler was required to get this
result.

### Linux - detail (research only, not run; fix landed 2026-07-13)

Per WebKitGTK docs: the `WebKitWebView::permission-request` signal
(`WebKitUserMediaPermissionRequest`) must be handled by the host app or the
prompt/grant never happens. `getDisplayMedia` on Linux is additionally gated by
Wayland/PipeWire vs. X11 session type. No GUI display was available in this
session's environment (Docker without a compositor) to exercise this - needs a
real Linux desktop or VM with a display.

Updated 2026-07-13, PR #230 on GitHub. Confirmed (not just suspected) by reading
wry 0.55.1's vendored source directly: wry has zero permission-request handling
anywhere in its webkitgtk backend - unlike Android/macOS/iOS, which do each
implement their platform's equivalent. Unlike Windows/macOS, Linux also has no
OS-level consent gate behind this signal (no TCC-style prompt), so left
unhandled it silently denies rather than ever showing anything to the user.

Fix: rather than wait on/patch wry upstream, connected the
WebKitWebView::permission-request signal directly in this app's own Rust setup
code, via Tauri's PlatformWebview::inner() escape hatch (which already exposes
the underlying webkit2gtk::WebView) - see src-tauri/src/lib.rs's
linux_wire_user_media_permission. Grants UserMediaPermissionRequests
unconditionally, matching wry's own macOS/iOS behavior of granting at the
webview layer (no other gate to defer to here, since the webview only ever
loads this app's first-party frontend). webkit2gtk 2.0.2 added as a direct
Linux-only Cargo dependency, version-matched to what tauri/wry already
transitively pin (confirmed via `cargo metadata --filter-platform
x86_64-unknown-linux-gnu`, no conflict).

Not verified in this session - no Linux GUI/display environment available.
CI's own `rust` job (quality-checks.yml) installs libwebkit2gtk-4.1-dev on
ubuntu-latest and runs cargo test, which is the first real compile of this
code path; still needs an actual display-environment re-run of
public/spike-webrtc.html Buttons A/B to confirm the fix works end-to-end.

### Android — detail (real capability result via headless CI, 2026-07-07)

Wiring landed: `android.permission.CAMERA` / `android.permission.RECORD_AUDIO` in
`AndroidManifest.xml`, plus non-required camera `<uses-feature>` entries. Per
Android docs this OS-level permission is necessary but **not sufficient** — the
`WebView`'s `WebChromeClient` must separately override `onPermissionRequest` and
call `PermissionRequest.grant(...)` for in-page media access; whether Tauri's
default Android shell does this was the open question (R1).

**Getting a real answer took nine CI iterations** — genuinely worth naming since
it's most of why Android took so long: five distinct build bugs (openssl-sys
had no Android pkg-config sysroot → vendored feature; the vendored build then
needed NDK's `llvm-ranlib`/`llvm-ar` instead of the removed `<triple>-ranlib`
names; `keyring` has no Android backend at all, fixed by PR #31's Keystore-backed
`secret_store` abstraction; Spec 10's autostart plugin isn't implemented for
mobile, needed `cfg(desktop)` gating; `libsqlite3-sys` needed the same
`bundled`-feature fix as Windows, just for the NDK sysroot) plus two CI-script
bugs of my own (a wrong APK filename glob, and — the big one —
`reactivecircus/android-emulator-runner`'s `script:` field silently running each
line as its own separate process, so shell variables never survived between
lines; rewritten to write the script to a real file and run that as one
process). None of those nine were the actual finding — they just had to clear
before the real test could even run once.

**The tenth run produced real data.** Full relevant console trace
(`adb logcat`, cleared right before launch so it's not diluted by 5 minutes of
emulator system noise):

```
getUserMedia available: true
getDisplayMedia available: false
RTCPeerConnection available: true
auto: CI mode — running A, B, C unattended...
A: requesting getUserMedia({audio:true,video:true})...
[nothing further — ever; 5-minute CI timeout, no report file, no PASS/FAIL from
 the harness's own JS]
```

- **(1) getUserMedia grant — FAIL (hangs, not rejects).** The call fires and
  then never resolves or rejects — no error surfaces even in our own harness's
  `try/catch`. Unlike Windows, there's no `--use-fake-ui-for-media-stream`
  equivalent for the Android emulator's camera permission — and since nothing in
  Tauri's default Android shell implements `WebChromeClient.onPermissionRequest`
  to call `grant()`, the in-webview media-permission negotiation never resolves
  at all. The `adb shell pm grant ... android.permission.CAMERA` step only
  satisfies the OS-level runtime permission Android itself requires — it does
  nothing for the separate WebView-level permission callback. **This is exactly
  the R1 risk the spec named up front, now confirmed with real evidence instead
  of a guess.**
- **(2) RTCPeerConnection + media — untested.** Never reached; the harness's `B`
  button requires a local stream from `A`, which never completed.
- **(3) getDisplayMedia — EXPECTED-GAP, confirmed.** `getDisplayMedia available:
  false` in the UA/capability probe at page load — the API isn't present on
  Android WebView at all, exactly as the spec predicted (MediaProjection is
  native-only, never exposed to the webview).
- **Also observed, unrelated noise:** a separate `Uncaught (in promise)
  notification.is_permission_granted not allowed on window "spike-webrtc"`
  error from the app's own startup code hitting the default Tauri capability
  profile (which only allows that command on window `"main"`). Harmless to this
  test — it's a different async call, not connected to the `getUserMedia` hang —
  but worth knowing about if the spike harness's second window is reused later.
- **Webview version:** confirmed via UA — `Chrome/101.0.4951.61` (Android
  System WebView, Android 13 emulator image).

**Android verdict: NO-GO as tested, CONDITIONAL for Phase 4 — fix landed
2026-07-13, not yet re-verified on device.**
[PR #229](https://github.com/CloudHub-Social/Charm/pull/229) implements the fix, but
with a **corrected root cause** from what this section originally assumed. Reading
the actually-pinned `wry` version (`0.55.1`, pinned since 2026-07-04 — i.e. before
this spike even ran) shows Tauri's Android WebView already ships a
`RustWebChromeClient` that overrides `onPermissionRequest` and requests the matching
Android runtime permissions via `ActivityResultLauncher`, and `setWebChromeClient`
is wired unconditionally for every WebView Tauri creates. So the callback this
section says was "not implemented" was already there the whole time. The real gap
was narrower: `AndroidManifest.xml` never declared `CAMERA`/`RECORD_AUDIO` at all,
so that existing runtime-permission flow had nothing to request against — plausibly
why the observed failure mode was an indefinite hang rather than a clean deny. The
fix adds those two permissions (plus `MODIFY_AUDIO_SETTINGS` and not-required
camera/microphone `uses-feature` entries so AndroidTV/camera-less devices stay
installable) to the manifest, with **no Kotlin changes** — writing a custom
`WebChromeClient` would have duplicated or regressed wry's existing grant/deny,
file-chooser, and console-logging behavior. This is still a real, bounded
engineering task, just a one-file manifest fix instead of new Kotlin plumbing.
**Not yet confirmed on a device/emulator** — see updated checklist below.

## Tauri v2 capability layer

No `capabilities/*.json` entry was needed to reach `navigator.mediaDevices` from
the webview on macOS (dev build ran fine with only the default capability file
unchanged) — media APIs are exposed directly by the webview, not gated by Tauri's
IPC capability system. This should be re-checked on the other platforms in case
Android/Windows differ, but nothing in Tauri v2's docs suggests a capability entry
is needed for browser-native `getUserMedia`/`RTCPeerConnection` (those aren't Tauri
IPC commands).

## Scoped gaps list (Phase 4 work items)

1. ~~**Windows:** determine whether WRY/Tauri v2 surfaces WebView2's
   `PermissionRequested` automatically~~ — **Resolved 2026-07-07: yes**, all
   three capabilities passed via CI with no custom handler. Remaining item is
   just a real human click-through to remove the fake-UI caveat noted above.
2. **Linux:** same shape of item for WebKitGTK's `permission-request` signal —
   still fully open, no fake-device/fake-UI equivalent exists for WebKitGTK the
   way it does for Chromium/WebView2.
3. ~~**Android:** implement/confirm `WebChromeClient.onPermissionRequest` →
   `PermissionRequest.grant(...)`~~ — **Confirmed 2026-07-07: it's not
   implemented today**, and getUserMedia hangs indefinitely without it. This is
   now a confirmed, required Phase 4 work item (not a hypothetical) — implement
   the grant callback in the generated Android shell, plus the `Activity`-level
   runtime permission flow.
4. **iOS/Android screen share:** both are native-API-only (ReplayKit /
   MediaProjection) and not reachable from the webview — Phase 4 either bridges
   these natively or descopes screen share on mobile. This is an EXPECTED-GAP by
   design, not a defect.
5. **iOS:** capture the real click-through evidence via a physical-device run
   (macOS is now done — see below).
6. **Webview version inventory:** captured for none of the platforms in exact
   form yet. macOS's `navigator.userAgent` came back as the generic
   `Intel Mac OS X 10_15_7` WKWebView compatibility string, not a real version —
   need `sw_vers`/Safari version cross-ref on the same machine instead.

## What's left to close this spike

- [x] macOS: manual click-through run, on-screen log evidence for A/B/C — **GO**,
      2026-07-06.
- [x] Windows: headless CI run (fake-device/fake-UI), all 3 capabilities PASS —
      **GO**, 2026-07-07. Real webview version captured (`Edg/149.0.0.0`).
- [x] iOS: config gaps fixed - [PR #230](https://github.com/CloudHub-Social/Charm/pull/230),
      2026-07-13 (missing Info.plist usage-description keys; deployment target
      bumped 14.0 -> 15.0 for wry's WKUIDelegate media-capture delegate to be
      reachable at all).
- [ ] iOS: **physical-device run still needed** (Simulator can't test camera
      grant) to confirm the fix actually resolves getUserMedia end-to-end.
- [x] Linux: fix implemented - [PR #230](https://github.com/CloudHub-Social/Charm/pull/230),
      2026-07-13. Wired WebKitGTK's `permission-request` signal directly in
      app code (wry itself has no handler for it at all, confirmed via
      source read) via Tauri's `PlatformWebview::inner()` escape hatch.
- [ ] Linux: **real-display re-run still needed** (VM or physical box) - not
      verified in this session; no fake-device shortcut exists for WebKitGTK
      like Chromium/WebView2 has, so this can't be done headlessly the way
      Windows/Android's CI runs were.
- [x] Android: headless CI run, real result — **NO-GO as tested** — 2026-07-07.
      getUserMedia hangs indefinitely; `getDisplayMedia` confirmed absent
      (expected).
- [x] Android: fix implemented and merged — [PR #229](https://github.com/CloudHub-Social/Charm/pull/229),
      2026-07-13. Corrected root cause: wry's `RustWebChromeClient` already
      implements `onPermissionRequest`; the gap was missing
      `CAMERA`/`RECORD_AUDIO` manifest declarations, now added. No Kotlin
      changes.
- [ ] Android: **device/emulator re-run still needed** — re-run
      `public/spike-webrtc.html` Buttons A/B against a real device or emulator
      to confirm getUserMedia now resolves PASS instead of hanging, and update
      the capability matrix above from CONDITIONAL to GO (or note any
      remaining gap) accordingly. This session had no Android SDK/emulator
      access, same constraint as the original spike.
- [ ] Webview version inventory: macOS still needs a real version (UA was
      generic); Windows done (`Edg/149.0.0.0`); Android done
      (`Chrome/101.0.4951.61`, Android 13 emulator image).
- [ ] Optional: a real human click-through on Windows to remove the fake-UI
      caveat noted in the Windows section (low priority — CI result is already
      strong signal).
- [ ] Final GO/CONDITIONAL/NO-GO verdicts once iOS/Linux/Android land.

**Updated bottom line (2026-07-07):** 3 of 5 platforms now have real,
CI/hardware-confirmed verdicts:
- **macOS — GO.** No workaround needed.
- **Windows — GO.** No workaround needed (R1 resolved: WRY surfaces WebView2's
  permission flow without custom code).
- **Android — NO-GO as shipped, CONDITIONAL for Phase 4.** R1 resolved the other
  way: a `WebChromeClient.onPermissionRequest` handler is required and doesn't
  exist yet. This is a scoped, known engineering task, not an architectural
  dead end.
- **iOS — pending** a physical device (Simulator can't test camera grant).
- **Linux — not attempted** (no display environment available this session; no
  fake-device shortcut exists for WebKitGTK the way Chromium/WebView2 has one).

The spike has done its job for the three platforms it could reach: it turned
"we don't know if this works" into either a clean GO or a specific, bounded
Phase 4 work item — which is exactly what a gating investigation is supposed to
produce.

## Phase 4 handoff spec: Android `onPermissionRequest` fix

**Status: implemented, PR merged-pending review — [PR #229](https://github.com/CloudHub-Social/Charm/pull/229) (2026-07-13).**
See the corrected-root-cause note in the Android detail section above: the fix
that landed is a manifest-only change (`CAMERA`/`RECORD_AUDIO`/
`MODIFY_AUDIO_SETTINGS` permissions), not new Kotlin `WebChromeClient` code,
because wry already implements the grant/deny callback. Device/emulator
verification is still outstanding. The rest of this section is kept as
originally written for context on what was investigated before implementing.

This is no longer investigation work — the
finding above is confirmed (getUserMedia hangs indefinitely on Android because
no `WebChromeClient.onPermissionRequest` handler exists). This section is a
self-contained implementation spec a new agent/session can pick up directly,
without re-reading the rest of this findings doc.

**Environment constraint driving this handoff:** the session doing this
implementation work may not have an Android SDK/emulator or device available
(confirmed: this was true of the current session, 2026-07-13 — no
`android_sdk_root`/emulator tooling present). **Do not block on that.** Land the
code change and the manifest/permission wiring regardless; end-to-end
verification (the actual `getUserMedia` grant + `RTCPeerConnection` +
`getDisplayMedia` re-run against the harness) happens in a *separate* session
that has emulator/device access — same shape as how Windows's CI-based run and
Android's own 10-iteration CI run were done in this spike. Flag in the PR
description that manual/CI verification is a follow-up, not a blocker for
merging the code.

### Problem (recap, confirmed via CI 2026-07-07)

`android.permission.CAMERA` / `android.permission.RECORD_AUDIO` are already
declared in `AndroidManifest.xml` (OS-level runtime permission), but that's
necessary and not sufficient for in-webview media access. The generated Android
shell's `WebView` never overrides `WebChromeClient.onPermissionRequest`, so
when a page calls `getUserMedia`, the in-page permission negotiation has no
handler to resolve it — the call hangs forever (not reject, not error).
Confirmed today: `src-tauri/gen/android/app/src/main/java/social/cloudhub/charm/MainActivity.kt`
on `main` is a bare `TauriActivity` subclass with no `WebChromeClient`
override — the gap is still present outside the spike branch.

### Scope (in)

1. **Runtime permission request at the `Activity` level.** Before/on first use
   of a calling surface, request `android.permission.CAMERA` and
   `android.permission.RECORD_AUDIO` via the standard Android 6+
   runtime-permission flow (`ActivityCompat.requestPermissions` /
   `registerForActivityResult(RequestMultiplePermissions())`) if not already
   granted. Manifest declaration alone (already present) does not grant these
   at runtime on API 23+.
2. **`WebChromeClient.onPermissionRequest` override.** Get (or set, if none
   exists yet) a custom `WebChromeClient` on the Tauri-managed `WebView`
   instance and override `onPermissionRequest(request: PermissionRequest)` to:
   - Check the requested resources (`PermissionRequest.RESOURCE_VIDEO_CAPTURE`,
     `RESOURCE_AUDIO_CAPTURE`).
   - If the corresponding Android runtime permission is already granted, call
     `request.grant(request.resources)` on the main thread.
   - If not granted, deny (`request.deny()`) rather than hang — a real user
     denial should surface as a JS-side rejection, not an indefinite hang. (The
     hang itself, independent of grant/deny, is the bug this item fixes — a
     resolved `deny()` is a correct terminal state; an unresolved promise is
     not.)
3. **Wire it into Tauri's Android shell correctly.** Tauri v2's generated
   Android project builds the `WebView` through its own Kotlin/Rust bridge
   (not a hand-rolled `WebView` in `MainActivity.kt`), so confirm the actual
   integration point — likely overriding/extending the `WebViewClient`/
   `WebChromeClient` Tauri already installs (check `RustWebViewClient` /
   equivalent in the `gen/android` output, or whether a Tauri plugin hook
   exists for this) rather than replacing Tauri's own `WebChromeClient`
   wholesale and losing whatever it already does (e.g. `onShowFileChooser`,
   console logging).
4. **Don't reintroduce this on every `tauri android init` regen.** `gen/android`
   is normally regenerable output. If the fix must live in a file under
   `gen/android`, confirm whether that directory is checked in (it is, per
   `MainActivity.kt` existing on `main` today — same "hand-edit checked-in
   generated file" situation Spec 15 hit with Android's keyring backend) or
   whether Tauri supports injecting this via a plugin/hook that survives
   regeneration. Prefer the plugin/hook path if one exists; document the
   choice either way so it isn't silently lost on the next `tauri android init`.

### Non-goals (out)

- No call UI, no MatrixRTC/Element Call wiring — same non-goals as the parent
  spec. This item is purely the permission-callback plumbing.
- No fix for Android `getDisplayMedia` — confirmed absent from Android WebView
  entirely (MediaProjection is native-only); this is the pre-existing
  EXPECTED-GAP from the spike, unchanged, and out of scope here.
- No iOS or Linux work — tracked separately below, not part of this item.

### Acceptance criteria

- [ ] `AndroidManifest.xml` permission declarations unchanged/confirmed present
      (already there).
- [ ] Runtime permission request implemented and triggers on first
      camera/mic-requiring action.
- [ ] `WebChromeClient.onPermissionRequest` override implemented, granting only
      resources whose corresponding Android runtime permission is already
      held, denying (not hanging) otherwise.
- [ ] Change integrates with Tauri's existing Android `WebView`
      construction rather than replacing it outright (verify no regression to
      existing `WebChromeClient` behavior, e.g. file chooser, if Tauri already
      installs one).
- [ ] PR description explicitly notes end-to-end verification (re-running the
      spike harness's Button A/B on a real device or emulator) is a follow-up
      once Android SDK/emulator access is available, not a merge blocker.
- [ ] Follow-up verification (separate session, when emulator/device access
      exists): re-run `public/spike-webrtc.html` Buttons A and B on Android and
      confirm (1) resolves PASS instead of hanging, updating the matrix in this
      findings doc from NO-GO to GO/CONDITIONAL as appropriate.

### Other remaining gaps from this spike (unchanged, tracked here for completeness)

Not part of the Android item above — separate follow-ups, each blocked on
environment access this session doesn't have either:

- **iOS:** needs a physical-device run (Simulator has no camera) to confirm
  capability (1); config (`Info.plist` keys) is already believed sufficient
  from the spike, just unverified on real hardware.
- **Linux:** fully unattempted — needs a real display (VM or physical box); no
  fake-device/fake-UI shortcut exists for WebKitGTK the way Chromium/WebView2
  has one, so this can't be done headlessly like the Windows/Android CI runs
  were.
- **Webview version inventory:** macOS's real WKWebView/Safari version still
  not captured (UA string is generic); Windows and Android are already
  captured.
- **Windows:** optional real human click-through to remove the fake-UI CI
  caveat — low priority, CI result already treated as strong signal.

None of these four require re-running the Android fix above — they're
independent per-platform gaps a future session with the right hardware access
can pick up individually.
