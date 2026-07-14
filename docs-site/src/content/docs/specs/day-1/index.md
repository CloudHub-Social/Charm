---
title: Charm 2.0 — Day-1 Spec Index
type: index
project: Charm 2.0
created: 2026-07-04
status: active
---

Specs for the **outstanding Day-1 launch-critical tier** of the Charm 2.0 rebuild,
grounded against the [product vision and architecture](/product/vision/) and the
current `CloudHub-Social/Charm` repository. Each spec is scoped as **one PR / one
agent**.

> **Cross-cutting principle (owner, 2026-07-13): library-first, app-wide.** Use
> established libraries as much as possible; almost never roll our own — especially
> for **rich content rendering, media, syntax highlighting, math, emoji, and GIF**
> handling (solved problems where bespoke code is an XSS/edge-case/maintenance
> trap). When a spec below describes building a custom parser/renderer/player/widget
> for something a maintained library covers, prefer the library. Hand-roll only when
> no suitable library fits (licensing / bundle size / a hard requirement) and
> justify it. Applies to every spec, not just the ones that name it explicitly
> (e.g. Spec 58 rich-content, 59 GIF, 38 emoji, 41 voice waveform, 42/02 media, 51
> i18n, 55 fuzzy-match). The composer already models this (TipTap).

**Status refreshed 2026-07-13** against actual merged GitHub PRs. This pass found:
Spec 26 Phase 2 shipped (#232) since the last refresh; Spec 27 was completely
untracked in this index despite shipping 2026-07-11 (#195); issues #144 and #133
had closed; the Dependabot open-PR list was half stale (3 of 6 closed, 2 new ones
opened); and 5 small UI bug-fix PRs (#174–178) had shipped without ever being
logged here.

**Implementation update 2026-07-14:** Spec 52 shipped in PR #242, with its
owner-reviewed mobile room UX follow-up shipping in PR #245 behind the default-off
`mobile_chat_redesign` flag. Spec 56 shipped in PR #243, and Spec 58 shipped in PR
#244. Specs 56 and 58 remain default-off behind the `room_invites` and
`rich_message_rendering` feature flags, respectively.

## The specs

| # | Spec | Status | PR | Notes |
|---|------|--------|----|----|
| 01 | [Spec 01 — Timeline identity and profiles](/specs/day-1/spec-01--timeline-identity-and-profiles/) | **Shipped** | #22 | Display names + avatars, own profile |
| 02 | [Spec 02 — Media and attachments](/specs/day-1/spec-02--media-and-attachments/) | **Shipped** | #10 | Upload/render/lightbox + media cache |
| 03 | [Spec 03 — Message actions](/specs/day-1/spec-03--message-actions-edit-redact-reply-react/) | **Shipped** | #11 | Superseded internally by Spec 14's Timeline adoption |
| 04 | [Spec 04 — Composer upgrade](/specs/day-1/spec-04--composer-upgrade-rich-text-slash-commands-autocomplete/) | **Shipped** | #15 | TipTap-based |
| 05 | [Spec 05 — Read receipts, typing, and presence](/specs/day-1/spec-05--read-receipts-typing-and-presence/) | **Shipped** | #9 | Fully-read marker feeds Spec 06 |
| 06 | [Spec 06 — Spaces and room-list organization](/specs/day-1/spec-06--spaces-and-room-list-organization/) | **Shipped** | #14 | Unread invariant; shares `RoomSummary` with 05 |
| 07 | [Spec 07 — Room management and moderation](/specs/day-1/spec-07--room-management-and-moderation/) | **Shipped** | #21 | Right panel + power levels |
| 08 | [Spec 08 — Settings and device management](/specs/day-1/spec-08--settings-and-device-management/) | **Shipped** | #18 | `logout`, devices, notif rules |
| 09 | [Spec 09 — Theming and appearance](/specs/day-1/spec-09--theming-and-appearance/) | **Shipped** | #27 | Token engine, 3 themes, Claude Design sync |
| 10 | [Spec 10 — Native platform shell](/specs/day-1/spec-10--native-platform-shell/) | **Shipped** | #28 | Tray/badges/notifications/menus/adaptive layout |
| 11 | [Spec 11 — Push notifications](/specs/day-1/spec-11--push-notifications/) | **Shipped** | #44 | UnifiedPush + APNs; push-decrypt |
| 12 | [Spec 12 — First-run onboarding](/specs/day-1/spec-12--first-run-onboarding/) | **Shipped** | #30 | Skippable, account-data-gated |
| 13 | [Spec 13 — Voice-video platform spike](/specs/day-1/spec-13--voice-video-platform-spike/) | **All 5 platforms have code-level fixes; 2/5 hardware-confirmed** | #229 (Android), #230 (iOS + Linux) | macOS + Windows: **GO**, confirmed on real hardware/CI. Android (#229, merged 2026-07-13): corrected root cause — wry's `RustWebChromeClient` already implements `onPermissionRequest`; the actual gap was missing `CAMERA`/`RECORD_AUDIO` in `AndroidManifest.xml`, now added (no Kotlin changes). iOS + Linux (#230, merged 2026-07-13): iOS was missing `Info.plist` usage-description keys (app was crashing outright, not just denying) and needed `IPHONEOS_DEPLOYMENT_TARGET` bumped 14.0→15.0 for wry's WKUIDelegate media-capture delegate to exist at all; Linux had zero permission-request handling anywhere in wry's WebKitGTK backend, fixed by wiring the signal directly in this app's own Rust setup code. **None of the three re-verified on real device/emulator/display yet** — still the concrete next step before flipping their verdicts from CONDITIONAL to GO. Findings: [Spec 13 findings — voice-video platform spike](/specs/day-1/spec-13-findings--voice-video-platform-spike/) |

## Chat presentation

| # | Spec | Status | PR | Notes |
|---|------|--------|----|----|
| 27 | [Spec 27 — Chat message layout modes](/specs/day-1/spec-27--chat-message-layout-modes-bubble-discord-irc/) | **Shipped** | #195 | Bubble, Discord, and IRC layouts shipped in PR #195 on 2026-07-11. The repository spec now records the durable scope and acceptance criteria. |

## Foundational refactors

| # | Spec | Status | PR | Notes |
|---|------|--------|----|----|
| 14 | [Spec 14 — Adopt matrix-sdk-ui Timeline](/specs/day-1/spec-14--adopt-matrix-sdk-ui-timeline/) | **Shipped** | #12 | Replaced Spec 03's hand-rolled relation-folding with the SDK's `Timeline` engine |
| 15 | [Spec 15 — Per-account store isolation](/specs/day-1/spec-15--per-account-store-isolation/) | **Shipped** | #13 | Per-account SQLCipher store + keychain entries; fixed the crypto-store collision on second-account login |

## Platform expansion — Web

| # | Spec | Status | PR | Notes |
|---|------|--------|----|----|
| 16 | [Spec 16 — Web client via companion Matrix server](/specs/day-1/spec-16--web-client-via-companion-matrix-server/) | **Shipped** | #45, #49, #55, #98 | Phase 1: `_impl` extraction. Phase 2 A/B: companion `charm-web-server` crate (HTTP router + session store, then WebSocket events + encrypted session persistence). #98 (merged 2026-07-09) added the remaining frontend/deploy leg: browser transport for Matrix calls, HTTP/WS routing instead of Tauri IPC for web builds, browser `File` upload support, `build:web` script, `/api/auth/me` device restore, Cloudflare Pages preview workflow. |

## Post-Day-1 UX rework — Charm 1.0 IA parity

| # | Spec | Status | PR | Notes |
|---|------|--------|----|----|
| 17 | [Spec 17 — Room settings IA rework](/specs/day-1/spec-17--room-settings-ia-rework-match-charm-10-structure/) | **Shipped** | #53 | Modal shell, left-nav sections incl. standalone Permissions tab |
| 18 | [Spec 18 — Global settings IA rework](/specs/day-1/spec-18--global-settings-ia-rework-match-charm-10-structure/) | **Shipped** | #57 | Real routing/deep-links, dual shell modes, missing sections added |
| 19 | [Spec 19 — Space hierarchy and room-list rebuild](/specs/day-1/spec-19--space-hierarchy-and-room-list-rebuild-match-charm-10-structure/) | **Shipped — all 4 phases** | #99, #102, #150, #153 | (1) Rust recursive hierarchy walk + badge-rollup — #99. (2) space rail + real Home/DM/space-scoped room-list navigation — #102. (3) room-list search (scoped + "Search everywhere" escape hatch) — #150. (4) real space creation/join-by-address, replacing #102's placeholder — new `create_space` Tauri/web-server command, `join_room` returning `{room_id, is_space}` — #153. |

## Structured errors

| # | Spec | Status | PR | Notes |
|---|------|--------|----|----|
| 20 | [Spec 20 — Structured UIA error type for settings commands](/specs/day-1/spec-20--structured-uia-error-type-for-settings-commands/) | **Shipped** | #60 | `UiaCommandError` distinguishes UIA-challenge vs. other errors across the IPC boundary |

## Observability

| # | Spec | Status | PR | Notes |
|---|------|--------|----|----|
| 21 | [Spec 21 — Sentry observability](/specs/day-1/spec-21--sentry-observability-error-monitoring-tracing-replay-logs/) | **Shipped** | #81, #83, #85, #87, #91, #93, #94, #95, #96, #97 | Landed as a rapid sequence of PRs across 2026-07-08 to 2026-07-09: foundation (#81), release-artifact/symbol/Android uploads (#83, #85, #87), IPC breadcrumbs (#91, #93), user feedback UI (#94), size analysis (#95), consent-gated Android runtime init (#96), Rust tracing log bridge (#97). Confirm no residual work remains on `codex/sentry-observability` before considering this fully closed. |
| 22 | [Spec 22 — User feedback categorization and GitHub label mapping](/specs/day-1/spec-22--user-feedback-categorization-and-github-label-mapping/) | **Shipped** | #165 | Bug vs. feature-request category on feedback submissions + Sentry-org GitHub label mapping, prompted by [issue #162](https://github.com/CloudHub-Social/Charm/issues/162). Merged 2026-07-11 — not yet re-diffed against the spec's acceptance criteria line by line. |
| 23 | [Spec 23 — User feedback client context capture](/specs/day-1/spec-23--user-feedback-client-context-capture/) | **Shipped** | #169 | Real per-OS `charm.platform` tag (via `@tauri-apps/plugin-os`) + `charm.build.version` tag on Sentry feedback events, plus a one-line disclosure in the feedback form. Merged 2026-07-11. Not yet re-diffed line-by-line against the spec's original acceptance criteria (e.g. whether "associated-error context" beyond platform/version was fully covered). |
| 24 | [Spec 24 — Build and release identification](/specs/day-1/spec-24--build-and-release-identification-short-sha-pr-previews/) | **Shipped** | #166 | Canonical `{version}+{short_sha}` / `+pr{n}.{sha}` / `+nightly.{sha}` build identifier, single shared CI script, surfaced in `AboutPanel` and as a Sentry tag. Merged 2026-07-11 (confirmed via `gh pr view 166`, `state: MERGED`) — the "PR open, BEHIND" status recorded earlier was stale. Follow-up fix #184 (`compute-build-id.mjs` non-Error throw handling) and #182 (doc-comment correction) also landed same day. |
| 25 | [Spec 25 — Persistent crypto state and recovery-key-sufficient verification](/specs/day-1/spec-25--persistent-crypto-state-and-recovery-key-sufficient-verification-web-client/) | **Shipped — both phases** | #172, #173, #181 | Phase 1 (#172): per-session on-disk `matrix-sdk-sqlite` crypto store, survives ordinary restarts (still lost on a DO App Platform *redeploy*, no persistent volume — logged as a tracked follow-up, not blocking). Phase 2 (#173): `recover_from_key_impl` now self-verifies the device after recovery-key restore, shared between desktop and web. #181 fixed 3 leak/data-loss bugs Codex flagged in #172's own review round (directory-cleanup race, persisted-vs-open crypto state conflation). All merged 2026-07-11. |

## Post-Day-1 web-client bug — crypto persistence

| # | Spec | Status | PR | Notes |
|---|------|--------|----|----|
| 25 | [Spec 25 — Persistent crypto state and recovery-key-sufficient verification](/specs/day-1/spec-25--persistent-crypto-state-and-recovery-key-sufficient-verification-web-client/) | **Shipped — both phases** | #172, #173, #181 | Confirmed fixed by re-reading the current repo (2026-07-13): `charm-web-server`'s crypto store now persists to on-disk `matrix-sdk-sqlite` per session (#172), and recovery-key-alone restore now calls `device.verify()` (#173). #181 closed real leak bugs found in #172's own review. Remaining known limitation: a DO App Platform *redeploy* (not a plain restart) still loses crypto state since there's no persistent volume — degrades gracefully to the pre-existing recovery-key re-prompt rather than failing; not yet re-scoped as its own follow-up item. |

## Remaining known gaps (refreshed 2026-07-13 against `gh pr list`/repo state)

- **Spec 19** (space hierarchy/room-list rebuild) — **fully shipped**, all 4 phases merged (#99, #102, #150, #153). No longer a gap.
- **Spec 13** — code-level fixes for all three remaining platforms landed 2026-07-13: Android's `getUserMedia` hang fixed by adding `CAMERA`/`RECORD_AUDIO` to `AndroidManifest.xml` (#229 — wry already had the `onPermissionRequest` callback, the manifest permissions were the actual missing piece); iOS's app-crash-on-media-request fixed by adding `Info.plist` usage-description keys + bumping `IPHONEOS_DEPLOYMENT_TARGET` 14.0→15.0 (#230); Linux's silent-deny fixed by wiring WebKitGTK's `permission-request` signal directly in `src-tauri/src/lib.rs` (#230, same PR as iOS). **None of the three has been re-verified on real device/emulator/display** — that's the concrete remaining step (re-run `public/spike-webrtc.html` on each) before the findings doc's capability matrix can move from CONDITIONAL to GO. This is still the only remaining Day-1 spec-sequence gap, but it's now "needs hardware verification of a landed fix" rather than "needs the fix written."
- **Spec 21** — resolved: `codex/sentry-observability` and `codex/sentry-release-artifacts` branches no longer exist (confirmed via `git ls-remote`), nothing residual to land.
- **Specs 22–25 — all shipped, correcting a stale "Draft"/"In progress" status previously recorded here.** #165 (22), #169 (23), #166+#184+#182 (24), #172+#173+#181 (25) all merged 2026-07-11, confirmed via `gh pr view` and (for 25) a direct read of `crates/charm-web-server/src/persistence.rs`. This index previously said 22–24 were "Draft, not yet started" and 25 had "no PR yet" — both wrong as of this refresh.
- **Spec 26** — **both phases now shipped.** Phase 1 (#194, merged 2026-07-11): sticky-bottom scroll anchoring. Phase 2 (#232, "bottom-up, virtualized timeline rendering," merged 2026-07-13) has since landed too — see [Spec 26 Phase 2 — Bottom-up timeline rendering](/specs/day-1/spec-26-phase-2--bottom-up-timeline-rendering-follow-up/) for the spec it implements. No longer a gap; the "not yet implemented" note from the last refresh is stale.
- **Spec 27** — net-new, discovered this refresh: PR #195 "Add chat message layout modes: bubble, Discord, IRC," merged 2026-07-11, was never logged in this index at all until now. No spec note exists for it yet — see the Chat presentation table above.
- QR-code login shipped separately (PR #4, 2026-07-05), outside this numbered spec sequence — see [product vision and architecture](/product/vision/)'s timeline.
- **All 27 numbered specs now have at least their first phase shipped** except Spec 13's Android/iOS/Linux voice-video gaps.
- **Dependabot PRs, re-checked 2026-07-13 via `gh pr list --state open`:** only 3 of the previously-tracked 6 remain open — **#38** (npm-major), **#52** (cargo group), **#128** (cargo-major). #129, #130, #131 are now closed unmerged (superseded, not landed). Two newer ones have since opened: **#200** (github-actions group, 13 updates) and **#234** (npm-non-major group, 19 updates).
- **PRs #174–178 (a batch of 5 small UI bug-fix PRs from a prior session — unread dot, space-rail badge clipping, undecrypted-message action gating, unread-badge tooltip, composer send-button disabled state)** — all confirmed **merged** 2026-07-11. Not tied to any numbered spec and not previously logged in this index; noting here for completeness since they're real shipped user-facing fixes.
- **PR #228** (open, unmerged as of 2026-07-13) — "Tunnel desktop Sentry envelopes through IPC; add crash-recovery prompt." In-progress observability work outside the numbered spec sequence, worth checking on next refresh.
- **Issue #144** (Linux nightly build failure) — **closed**, resolved by the flurry of nightly-build fix PRs (#203/#206/#209/#211/#212/#213). Previously logged as open/untriaged — stale.
- **Issue #133** (flaky media-cache-eviction test) — **closed**, fixed by PR #187. Previously logged as open — stale.

## Post-Day-1 activity worth tracking (outside the numbered spec sequence)

- **Spec 16 continuation**: `charm-web-server` migrated off the hand-run VPS onto DigitalOcean App Platform (#141), plus follow-up hardening (#142 wget timeout, #145 fixed a bug wiping DO secrets on every deploy, #147 downsized to the 512MB/1vCPU tier). Live and healthy as of this refresh (`/api/health` → 200).
- **Device verification / decryption bug** (issue #143, filed via in-app Sentry feedback from #141's preview, **closed 2026-07-10**): root cause was two unrelated things — the DO deploy crash-looping (now fixed) and a misunderstanding of self-verification UI (working as intended; `DeviceRow.tsx` correctly hides "Verify" for the active device). Confirmed working via a live cross-device SAS test.
- **PR #149 (merged 2026-07-10)** — "Implement recovery-key restore (Matrix key backup / 4S)": added a manual, on-demand recovery-key restore flow (`recovery_status_impl`/`recover_from_key_impl`, `GET`/`POST /api/verification/recovery`, a "Recovery" card in Settings). **Confirmed by re-reading the current repo (2026-07-10) that this did NOT close the underlying gap**: `crates/charm-web-server/src/persistence.rs`'s "Known gap: the Olm/Megolm crypto store is not persisted" doc comment is still present, byte-for-byte unchanged — every `charm-web-server` restart still wipes Olm/Megolm state, and the recovery-key flow never calls `device.verify()`, so device verification is still a separate required SAS step. #149's author deliberately chose the manual-restore-flow route over server-side persistence, citing DO App Platform's Web Service tier having no persistent volume. The real fix (crypto-store persistence + recovery-key-alone verification) is now scoped as [Spec 25 — Persistent crypto state and recovery-key-sufficient verification](/specs/day-1/spec-25--persistent-crypto-state-and-recovery-key-sufficient-verification-web-client/).
- **PR #148 (open)** — idle-session eviction for `charm-web-server`, not yet reviewed/merged.
- **CI/build infrastructure overhaul** (2026-07-09/10, ~20 PRs): merge-queue stall fixes, path-based change detection, `sccache` object-level caching backed by a dedicated DigitalOcean Spaces bucket, native platform builds moved off the PR/merge-queue path onto a new nightly schedule (Tier 3), debug-mode compile checks. Fully documented in `docs/ci-tiers.md` (repo) and [CI and release tiers](/contributing/ci-tiers/) (vault).
- **Issue #144 — closed** (see "Remaining known gaps" above for the fix PRs). Was previously "open, untriaged" here — stale.
- **Issue #133 — closed**, fixed by PR #187. Was previously "open" here — stale.
- **Issue #48 (open)** — Spec 11 Android embedded-FCM push fallback needs a VAPID gateway; infra work, not app code. Unchanged since 07-09 — still the one open item in this list.

## Cross-cutting notes surfaced by the specs (historical, still accurate)

- **ts-rs → frontend binding generation is wired.** Rust `#[ts(export)]` types generate into `src-tauri/src/bindings/` and are re-exported through `src/lib/matrix.ts` via the `@bindings/*` alias; CI fails on drift. Specs should add the Rust type + regenerate — no hand-mirror.
- **Local-echo handling was reworked twice.** Spec 03 replaced `sender + body` dedupe with id-based reconciliation; Spec 14 then removed the hand-rolled echo entirely in favor of the SDK Timeline's own `send_state`-based echoes.
- **Spec 08's `ProfileSummary` and Spec 01's `get_own_profile`** shipped independently before either merged (08 landed first) — flagged for reconciliation into one shared shape; check current repo state before assuming this is still open.

- **Spec 11** — real-device testing status against a free-tier Apple Account (Personal Team signing) researched 2026-07-09: APNs push isn't end-to-end testable on this tier regardless of app-code state (needs a paid Apple Developer Program push cert), and the iOS APNs bridge is separately still a documented stub. See [Spec 11 — Push notifications](/specs/day-1/spec-11--push-notifications/)'s "Real-device testing status update" section; build/install mechanics for this signing tier live in the repo's `CLAUDE.md`, not here.

## Day-1 parity gap specs (added 2026-07-13, unshipped)

Specs 01-27 above are all shipped; the folder was split into `day-1/` (this file's
own new location) and a sibling `day-2/` folder the same day, to keep the growing
spec count navigable. These five close the remaining **Day-1** (core daily-driver)
feature gaps found by a fresh Charm 1.0 → 2.0 parity pass — see
[product vision and architecture](/product/vision/) for the pass's summary. Charm 2.0's own IPC/web-search 2.0
gaps (threads, calling, polls, etc.) are Day-2 and live in `../day-2/`.

| # | Spec | Status | Notes |
|---|------|--------|----|
| 28 | [Spec 28 — Cross-room message search](/specs/day-1/spec-28--cross-room-message-search/) | **Draft, unbuilt** | Local FTS index (matrix-seshat equivalent) needed for encrypted-room search; Spec 19's "Search everywhere" only filters the room list, not message content. |
| 29 | [Spec 29 — Link previews](/specs/day-1/spec-29--link-previews/) | **Draft, unbuilt** | Homeserver `/preview_url` unfurl, small addition to `MessageRow`. |
| 30 | [Spec 30 — Focus mode and do-not-disturb](/specs/day-1/spec-30--focus-mode-and-do-not-disturb/) | **Draft, unbuilt** | Global notification-silencing override on top of Spec 08's per-room rules; gates Spec 11's push-dispatch decision. |
| 31 | [Spec 31 — Room upgrades](/specs/day-1/spec-31--room-upgrades/) | **Draft, unbuilt** | `m.room.tombstone` handling — admin-initiated upgrade action plus a banner/read-only state for landing in an already-tombstoned room. |
| 32 | [Spec 32 — Room alias management](/specs/day-1/spec-32--room-alias-management/) | **Draft, unbuilt** | Publish/unpublish aliases, set canonical alias — Charm 2.0 already follows permalinks but has no admin UI to manage them. |

## Day-1 sub-feature audit (added 2026-07-13) — gaps *within* already-shipped specs

A deeper pass (same day) checked whether shipped specs 01-27 quietly scoped out
real Charm 1.0 sub-features rather than being fully missing areas (the gaps 28-32
above). Explicitly checked and **confirmed NOT regressions** (worth recording so
this doesn't get re-litigated): room-list sectioning (favourites/low-priority —
2.0's `roomSections.ts` actually exceeds 1.0, which has no tag-based sections at
all), manual drag-to-reorder rooms (`DraggableRoomRow`/`computeManualOrder` in
`RoomList.tsx`, fully working), keyboard shortcuts panel, ban/policy-list UI
(absent in *both* clients, not 2.0-specific). Two real gaps confirmed:

| # | Spec | Status | Notes |
|---|------|--------|----|
| 33 | [Spec 33 — Space nesting and hierarchy reorganization](/specs/day-1/spec-33--space-nesting-and-hierarchy-reorganization/) | **Draft, unbuilt** | Addendum to Spec 19. `SpaceRail.tsx` is read-only — no drag-to-nest, no create-space-under-parent. Charm 1.0's `Lobby.tsx`/`CreateSpace.tsx` both support this. |
| 34 | [Spec 34 — Labs and experimental settings panel](/specs/day-1/spec-34--labs-and-experimental-settings-panel/) | **Draft, unbuilt** | Addendum to Spec 08/18. Charm 1.0 has a populated `Experimental.tsx` labs panel; Charm 2.0 has no labs/flag mechanism at all — infrastructure gap that'll matter for staging Day-2 features (threads, calling, etc.) too. Now depends on Spec 35 for the underlying flag mechanism. |
| 35 | [Spec 35 — Feature flags](/specs/day-1/spec-35--feature-flags-openfeature--sentry-evaluation-tracking/) | **Draft, unbuilt — next to ship** | The flag *plumbing* Spec 34's panel and every Day-2 feature need. OpenFeature (OSS/free, vendor-neutral) on both JS (`@openfeature/web-sdk`) and Rust (`open-feature` + `open-feature-ofrep`), backed by **GO Feature Flag** (MIT) — relay-proxy container on **DO App Platform** (smallest instance, next to `charm-web-server`). Config source-of-truth = PR-reviewed **`charm-flags`** Git repo → GitHub Action validates + publishes to **DO Spaces** (which GFF reads) + fires Sentry change webhook; documented **break-glass** direct-to-Spaces path for emergency kills. Per-environment configs (prod/preview). Also covers proxy CORS/API-key, first-paint no-flicker contract, and e2e flag-pinning. **Non-phased** — three-layer resolver (local override → GFF/OFREP → catalog default) so kill-switch + staged/percentage rollout work in the wild, not just dark-launch. Percentage cohorting via Spec 21's anonymized install ID as the OFREP targeting key (sent only to our own proxy, never the Matrix ID — disclosed in PRIVACY.md). Wires Sentry evaluation tracking + Generic-webhook change tracking — the Feature Flags product Spec 21 explicitly deferred. Rejected: Unleash Autonomous Feature Management (paid), Cloudflare Workers (can't host the Go proxy). Future DIY: Sentry-alert → auto-flip-off. Effort L, ~2 PRs for review size but no capability deferred. |

## Full deep-dive parity audit (added 2026-07-13) — sub-features scoped out of shipped specs 01-27

The two passes above (28-35) were spot audits. This is the **exhaustive** pass the
project owner asked for: three parallel deep-dive agents read the *actual component
code* of Charm 1.0 and Charm 2.0 across every shipped spec area, hunting for
sub-features that got parked in a spec's "Non-goals (out)" during the Day-1 shipping
push. Each gap below was confirmed by reading Charm 2.0's code (not just spec docs)
and cites the Charm 1.0 file it exists in. These 13 specs (36-48) are scoped as one
PR / one agent each and are the remaining work to reach **true** Charm 1.0 parity.

| # | Spec | Extends | Status | Gap |
|---|------|---------|--------|-----|
| 36 | [Spec 36 — User profile cards](/specs/day-1/spec-36--user-profile-cards/) | 01 | **Draft, unbuilt** | No profile card for *other* users — clicking a member opens only an admin menu. Missing: view profile, mutual rooms, copy ID/permalink, presence+status, contextual ignore, per-room nick/avatar, interactive mention pills. Biggest single messaging-core miss. |
| 37 | [Spec 37 — Message action parity](/specs/day-1/spec-37--message-action-parity/) | 03 | **Draft, unbuilt** | Menu is only Reply/Edit/Copy-text/Delete/React. Missing: **forward**, **copy-link/permalink**, view-source, report, edit-history, reaction-viewer, **resend-failed** (no retry on a failed send today), redact-with-reason+confirm. |
| 38 | [Spec 38 — Full emoji picker](/specs/day-1/spec-38--full-emoji-picker/) | 03/04 | **Draft, unbuilt** | Picker is 40 hardcoded emoji, no search, no custom. Shared searchable picker for reactions + a composer emoji-browse button; extension point for day-2 custom packs. |
| 39 | [Spec 39 — Timeline state and membership events](/specs/day-1/spec-39--timeline-state-and-membership-events/) | 14/26 | **Draft, unbuilt** | **Timeline renders zero state/membership events** — no join/leave/kick/ban, no name/topic/avatar-change notices; all filtered pre-render. Includes collapsing + hide/show toggles. Most-noticeable omission of the whole audit. |
| 40 | [Spec 40 — Presence and receipt privacy controls](/specs/day-1/spec-40--presence-and-receipt-privacy-controls/) | 05 | **Draft, unbuilt** | Entire privacy surface missing: hide read receipts, hide typing, appear-offline (`setPresence` IPC exists, no UI), auto-idle/away, "seen by N" expandable list, render presence status-msg/last-active. |
| 41 | [Spec 41 — Voice message recording](/specs/day-1/spec-41--voice-message-recording/) | 02 | **Draft, unbuilt** | Playback works; recording doesn't exist. Mic capture + waveform + hold-gesture → `m.audio` voice message. Reuses Spec 13's per-platform mic permissions. |
| 42 | [Spec 42 — Media send polish](/specs/day-1/spec-42--media-send-polish/) | 02 | **Draft, unbuilt** | Captions on media (send+render), upload size-limit warning, actual upload-cancel (today only hides the row), inline GIF autoplay. |
| 43 | [Spec 43 — Composer parity](/specs/day-1/spec-43--composer-parity/) | 04 | **Draft, unbuilt** | Slash commands 5 → ~40; add spoiler, block-code, strikethrough; **up-arrow-to-edit-last** (owner-confirmed present in 1.0, 2026-07-13). Mostly wiring composer verbs to existing IPC. |
| 44 | [Spec 44 — Crypto key backup setup and key import-export](/specs/day-1/spec-44--crypto-key-backup-setup-and-key-import-export/) | 25 | **Draft, unbuilt** | Restore works but there's **no first-time backup/4S setup** (recovery card only shows for `incomplete` state) and no megolm key file import/export. Lost device = lost history for new users today. |
| 45 | [Spec 45 — Registration and password-reset flows](/specs/day-1/spec-45--registration-and-password-reset-flows/) | 12 | **Draft, unbuilt** | **Registration submits username/password only — no UIA (reCAPTCHA/terms/email), so signup fails on matrix.org and most servers.** Also: no forgot-password reset, single generic SSO button (no per-provider), no standalone token login. Highest-impact onboarding gap. |
| 46 | [Spec 46 — Notification rule granularity and email pushers](/specs/day-1/spec-46--notification-rule-granularity-and-email-pushers/) | 08/11/18 | **Draft, unbuilt** | Coarse all/mentions/mute only — no per-category push-rule levels (DM/encrypted/rooms, displayname/username/@room, loud-vs-notify), no `m.email` pusher, and the "Sound" toggle is a stored no-op. |
| 47 | [Spec 47 — Appearance and display parity](/specs/day-1/spec-47--appearance-and-display-parity/) | 09/27 | **Draft, unbuilt** | Custom theme import, system-emoji-vs-twemoji, 12h/24h clock, date format, finer message spacing, autoplay-media toggles, minor cosmetics. |
| 48 | [Spec 48 — Desktop shell and settings controls](/specs/day-1/spec-48--desktop-shell-and-settings-controls/) | 08/10/18 | **Draft, unbuilt** | Close button hardcoded to minimize-to-tray (no quit option), no tray-icon toggle, Win/Linux menu gaps, no device rename, no clear-cache, settings export/import. |
| 49 | [Spec 49 — Widget support](/specs/day-1/spec-49--widget-support/) | new | **Draft, unbuilt** | Owner-added. Embed Matrix widgets + widget API (`matrix-widget-api`) + lightweight add/remove UI. **Sable Call is a widget**, so this is a prerequisite for calling — day-2 Spec 02 now depends on it. |
| 50 | [Spec 50 — Cross-device settings sync](/specs/day-1/spec-50--cross-device-settings-sync/) | new (was 48-optional) | **Draft, unbuilt** | Owner-confirmed needed. Sync portable prefs across devices via Matrix account data; classify synced-vs-device-local; export/import. |
| 51 | [Spec 51 — App localization](/specs/day-1/spec-51--app-localization-i18n/) | new | **Draft, unbuilt — stretch/low-priority** | Owner: full app language is a stretch goal (pronoun pills, the firm part, are in Spec 47). i18n framework + string extraction + locale select + RTL. Behind core parity. |

**Confirmed NOT regressions (checked and at parity or ahead — don't re-litigate):**
change-password-in-settings, deactivate account, QR login, cross-signing bootstrap
+ SAS verification + recovery restore + reset, ignored-users list, badge/tray/
window-state/deep-link/autostart shell wiring, Sentry opt-out, date dividers +
unread marker + jump-to-present, redaction/edit indicators, all four composer
autocomplete providers, drag-drop/paste upload, video controls, file download,
media lightbox. **Absent in both clients AND settled-excluded / read-only by owner
(2026-07-13):** per-room draft *persistence* across restart (owner: no chat app does
this), 3PID add/verify (owner: read-only display is fine). NB several other
"absent in both" items were **added anyway on owner request** — EXIF stripping,
guest access, notification content-preview, integrations/widgets, font picker — see
the adjudication table below for where each landed.

### Owner adjudication — resolved 2026-07-13

The audit had excluded/deprioritized these on an "absent in / not confirmed for
Charm 1.0" premise. Owner ruled on every one (2026-07-13). Verdicts applied to the
specs; three items became **new specs 49-51**.

| Candidate | Owner verdict | Where it landed |
|---|---|---|
| Up-arrow to edit last message | ✅ Include | Spec 43 (empty-composer ArrowUp loads last editable msg) |
| Guest access / peek login | ✅ Include — **UI-only, very low priority**, disable anything needing a real account | Spec 45 (item 5, read-only preview) |
| 3PID add + verify | ⏸️ **Read-only display is fine** — no add/verify | Settled; current read-only `ContactInformationCard` kept, no work |
| App language/locale | ➗ Split: **pronoun pills = firm**, full app language = **stretch** | Pronoun pills → Spec 47 (#8); full i18n → **new Spec 51** (stretch) |
| Integrations manager / **widgets** | ✅ Include — **needed; Sable Call is a widget** | **New Spec 49 (Widget support)**; day-2 Spec 02 (calling) now depends on it |
| Spell-check | ✅ Include — minimal (OS-provided) | Spec 43 (ensure native `spellcheck` on, no custom engine) |
| EXIF stripping | ✅ Include — **toggle, strip by default** | Spec 42 (item 5, Rust-side strip on upload) |
| Notification content preview | ✅ Include — **default hidden** like 1.0; content opt-in (encrypted opt-in on top) | Spec 46 (item 5) |
| Notification inline actions (reply/mark-read from OS notification) | ✅ Include | Spec 46 (item 6) |
| QR-code *device self-verification* | ✅ **Resolved 2026-07-14: include** (Element-style, alongside SAS) | Spec 44 (promoted to firm scope) |
| Global font-family picker | ✅ Include — "Sable has this" | Spec 47 (#7, synced setting) |
| Per-room draft persistence across restart | ❌ Exclude — "no chat app does this" | Settled-excluded |
| Notif "active-client vs all-clients" scope | ✅ Promote to firm | Spec 46 (item 4, now firm) |
| Cross-device settings sync | ✅ Include — needed | **New Spec 50 (Cross-device settings sync)** |
| Code-block theme picker | ✅ Include | Spec 47 (#9, firm) |
| Page zoom | ✅ Include | Spec 47 (#10, firm) |
| Saturation / accent adjustment | ✅ Include | Spec 47 (#11, firm) |
| Privacy blur (media/emoji/gifs/avatars) | ✅ Include | Spec 47 (#12, firm) |
| Pronoun pills | ✅ Include — **must** | Spec 47 (#8, firm) |
| Legacy username color | ✅ **Resolved 2026-07-14: include** | Spec 47 (#13, promoted to firm scope) |
| Per-message/user trust shields + blacklist-unverified | ✅ Include — **follow Element** (security) | Spec 44 (promoted to firm scope) |

Three new specs came out of this: **49 Widget support** (enables Sable Call —
day-1), **50 Cross-device settings sync** (day-1), **51 App localization / i18n**
(day-1, explicit stretch/low-priority). Added to the deep-dive table above.

## UI deep-dive audit (added 2026-07-13) — visual/affordance parity + a real responsive bug

The audits above were about *features*. The owner then asked for a **UI deep-dive**.
Five parallel agents read the actual component code of both clients: (A) avatars/
presence, (B) room-list/sidebar + filtering, (C) timeline/content rendering + the GIF
picker, (D) a wide-net full-surface inventory + cross-cutting UI, and (E) a
**responsive/mobile-layout bug hunt of Charm 2.0 itself** (prompted by the owner
seeing elements leave the screen on phones). Framing rule: Charm 2.0 has an
*intentional* new design language, so only capability/affordance/information gaps
were reported, never styling taste. Deduped against all specs above (the wide-net
agent re-flagged many already-spec'd features — threads/polls/pins/etc. — which are
**not** re-filed here). Nine new specs (day-1 52-59, day-2 13):

| # | Spec | Kind | Gap |
|---|------|------|-----|
| 52 | [Spec 52 — Responsive and mobile-web layout hardening](/specs/day-1/spec-52--responsive-and-mobile-web-layout-hardening/) | 2.0 bug fix — **Shipped 2026-07-14 (#242, #245)** | #242 fixed the reported phone bug with dynamic viewport sizing, safe-area handling, and viewport-bounded UI. #245 added the owner-reviewed, chat-app-style mobile room view behind the default-off `mobile_chat_redesign` flag. Unused `App.css` cleanup and real-device browser checks remain non-blocking follow-ups. |
| 53 | [Spec 53 — Avatars and presence visuals](/specs/day-1/spec-53--avatars-and-presence-visuals/) | UI gap | Group-DM composite ("triangle") avatar; presence **rings** + dot/ring toggle + always-rings-for-group-DM + group presence aggregation; member-list rows show initials-only (never the avatar image, though `avatar_url` is in the DTO) + no presence dots; DND/busy presence state missing from the enum. |
| 54 | [Spec 54 — Room-list row enrichment, filtering and sorting](/specs/day-1/spec-54--room-list-row-enrichment-filtering-and-sorting/) | UI gap | **Owner's unread/activity filter for Home/DMs/Spaces**; last-message preview + sender label in rows; typing-in-list; ambient unread-message count (in DTO, unrendered); sort toggle (activity/A-Z/unread-first). |
| 55 | [Spec 55 — Command palette and quick switcher](/specs/day-1/spec-55--command-palette-and-quick-switcher/) | UI gap | No ⌘K room/DM/space jump (1.0 has it); wires ⌘F to Spec 28 in-room search. |
| 56 | [Spec 56 — Room invites surface](/specs/day-1/spec-56--room-invites-surface/) | functional gap — **Shipped 2026-07-14 (#243)** | Pending-invite surface, count badge, inviter metadata, accept/decline, deep-link handling, and mute-aware new-invite notifications shipped behind the default-off `room_invites` flag. |
| 57 | [Spec 57 — In-app activity and notifications inbox](/specs/day-1/spec-57--in-app-activity-and-notifications-inbox/) | UI gap | No in-app mentions/activity inbox (distinct from OS push); 1.0 has an inbox tab. May unify with Spec 56. |
| 58 | [Spec 58 — Rich message content rendering](/specs/day-1/spec-58--rich-message-content-rendering/) | UI gap + **bug** — **Shipped 2026-07-14 (#244)** | Sanitized shared HTML-to-React rendering, concealed spoilers, code/tables, Matrix pills, room mentions, KaTeX, linkification, jumbo emoji, loading skeletons/shimmer, and caught-up marker shipped behind the default-off `rich_message_rendering` flag. Sanitization and spoiler concealment remain always-on safety behavior. |
| 59 | [Spec 59 — GIF picker](/specs/day-1/spec-59--gif-picker-klipy/) | new feature | Owner-requested standalone. "Klippy" = **Klipy** (klipy.com GIF API). Full 1.0 impl reverse-engineered: search/trending/favorites-via-account-data + a proxy that rewrites CDN URLs to `mxc://` + bridge-compat send. |
| d2-13 | [Spec 13 — Scheduled and delayed send](/specs/day-2/spec-13--scheduled-and-delayed-send/) (day-2) | new feature | 1.0 has scheduled send (`SchedulePickerDialog`); prefer MSC4140 server-side delayed events over client-only timers. |

**Folded into existing specs (not new):** who-reacted tooltip + quick-react hover row
+ shared confirm-with-reason dialog → Spec 37; drag-drop drop-zone overlay → Spec 42;
link-insert toolbar button → Spec 43; **space settings surface** (only room settings
exists today) → Spec 33; ⌘F in-room search entry → Spec 28.

**UI confirmed at parity or ahead (don't re-litigate):** user/room/space avatars +
initial fallbacks, timeline sender avatars, 1:1 DM presence dot, Radix dialog system,
tooltips (wide use), context-menu mechanism, theming (light+dark), **accessibility
(2.0 ahead of 1.0** via the Storybook axe gate), empty-states, date dividers + unread
marker + jump-to-present, link safety, knock/"Request to join". **Absent in both (not
gaps):** transient toasts/snackbars, multi-image gallery grid, offline/connection
banner.

## Round 2 owner adjudication + native-platform integration specs (2026-07-14)

Owner reviewed the two items left open from the first adjudication round and ruled
both **in**:

- **QR-code device self-verification** — include, Element-style alongside SAS.
  Promoted into [Spec 44 — Crypto key backup setup and key import-export](/specs/day-1/spec-44--crypto-key-backup-setup-and-key-import-export/)'s firm
  scope (see the table above).
- **Legacy username color** — include, exact recreation of 1.0's color-hash
  function behind a toggle. Promoted into [Spec 47 — Appearance and display parity](/specs/day-1/spec-47--appearance-and-display-parity/)'s firm scope (see the table above).

Plus three infra/architecture confirmations that resolved open questions in
existing specs:

- **Sable Call is confirmed a Matrix widget** (same model as Element Call) — no
  longer "likely," the architecture decision in [Spec 02 — Native voice and video calling](/specs/day-2/spec-02--native-voice-and-video-calling/) is closed. That spec was rewritten around embedding the Sable
  Call widget on top of [Spec 49 — Widget support](/specs/day-1/spec-49--widget-support/); the native-WebRTC option is
  dropped, not deferred.
- **Spec 59 (GIF picker)'s proxy is settled**: reuse Charm 1.0's existing GIF proxy
  as-is — it's a Cloudflare Worker, already deployed. No new `charm-web-server`
  extension needed; this removed what was the spec's main infra risk.
- **Spec 35 (feature flags, owned by a concurrent session) has a PR coming
  shortly** — noted for awareness, no action needed here.

**New: native-platform integration specs.** The owner flagged that OS-level
platform integration (distinct from in-app UI, which the deep-dive above already
covered) is real, needed work — and asked for it spec'd **per platform**, not as
one generic "mobile" item, naming iOS Contacts/Focus Modes/Share Sheet as concrete
examples.

| # | Spec | Platform | Scope |
|---|------|----------|-------|
| 60 | [Spec 60 — iOS platform integrations](/specs/day-1/spec-60--ios-platform-integrations/) | iOS | Share Extension, Contacts integration (Messages-app style), Focus Modes, plus Siri/Shortcuts, Handoff, Live Activities, widgets as fast-follows. |
| 61 | [Spec 61 — Android platform integrations](/specs/day-1/spec-61--android-platform-integrations/) | Android | Share intent + Direct Share, notification channels + inline reply actions, Conversation shortcuts (People/priority-DND), plus Bubbles/App Shortcuts/Assistant as fast-follows. |
| 62 | [Spec 62 — Desktop platform integrations](/specs/day-1/spec-62--desktop-platform-integrations-macos-and-windows/) | macOS + Windows | macOS: Share Extension, Focus Status, Contacts, Spotlight. Windows: Share contract (flags an MSIX-packaging risk to resolve first), Jump Lists, toast notification actions. Linux noted but not deep-scoped (fragmented DE landscape, Spec 13 foundational gaps first). |

Each coordinates with an existing spec for the OS-agnostic half of the same
feature: Spec 30 (in-app DND) ↔ Focus/Focus-Assist; Spec 36 (profile cards) ↔
Contacts resolution; Spec 46 (notification granularity) ↔ inline notification
actions; Spec 02 attachment send ↔ Share Sheet/intent/contract. None of these three
existed before this round — they're genuinely new scope, not folds.

## Follow-on specs (post-Day-1, not launch-critical)

| # | Spec | Status | PR | Notes |
|---|------|--------|----|----|
| 25 | [Spec 25 — Persistent crypto state and recovery-key-sufficient verification](/specs/day-1/spec-25--persistent-crypto-state-and-recovery-key-sufficient-verification-web-client/) | **Shipped — both phases** | #172, #173, #181 | Superseded by the entry above — see Observability/crypto-persistence tables. Kept here only because the spec was originally logged as a follow-on item before either phase shipped. |
| 26 | [Spec 26 — Timeline scroll anchoring and bottom-up rendering](/specs/day-1/spec-26--timeline-scroll-anchoring-and-bottom-up-rendering/) | **Shipped — both phases** | #194, #232 | Phase 1 (#194, merged 2026-07-11): sticky-bottom scroll anchoring, media-aspect-ratio reservation, pagination-scroll-anchor fix. Phase 2 (#232, "bottom-up, virtualized timeline rendering," merged 2026-07-13) — the bottom-anchored render + virtualization migration described in [Spec 26 Phase 2 — Bottom-up timeline rendering](/specs/day-1/spec-26-phase-2--bottom-up-timeline-rendering-follow-up/) has now actually landed, not just been spec'd. This entry previously said Phase 2 was "spec drafted, not implemented" — that's now stale; verify the shipped implementation matches the Phase 2 spec's acceptance criteria (spike-validated library choice, jump-to-present indicator, replacement of Phase 1's hand-rolled mechanisms) next time this area is touched. |
