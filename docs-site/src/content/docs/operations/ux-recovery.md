---
title: "Conversation UX recovery — implementation evidence"
---

# Conversation UX recovery

This ledger continues Specs 52 and 64 and issues #539/#526. It is not a replacement roadmap.

## Baseline

Research baseline: `e08884843c387c34559c0a1f6a1d30d6cadd3bd1`.
Initial regression commit: `627d53331af3dfe559218acfc13910dd08456e1b`.
[PR #601](https://github.com/CloudHub-Social/Charm/pull/601) owns this bounded repair.

The initial [Quality run](https://github.com/CloudHub-Social/Charm/actions/runs/40586378988)
reproduced geometry assertion failures in Bubble, Modern, and IRC at 320, 375,
390, and 430 CSS pixels. For example, the 320px Bubble case had 72px of row
overflow and its right edge exceeded the viewport by 12px. Document overflow
alone was zero, demonstrating why a page-only assertion would miss the failure.
The initial test also needed formatting and the existing snapshot capture hook;
those test-integration failures are distinct from the reproduced geometry defect.

## Current scope

- Move timeline gutters into measured item content instead of the virtualizer viewport.
- Constrain message rows and Bubble sender/content widths without clipping prose.
- Keep IRC reactions below the text rather than competing for horizontal space.
- Use one bounded, out-of-flow action surface for the three message layouts.
- Reveal actions through pointer hover, native-button keyboard focus, or a normal text tap.
  Preserve long-press and pointer context-menu entry to the existing menu.
- Preserve existing Matrix action permissions, local-echo rules, and menu dismissal.

## Interaction correction and verification

The first action implementation used focusable message containers. Accessibility
lint rejected that markup. The correction keeps messages non-interactive and
focuses the native menu button after a short text tap. Keyboard users reach the
existing action buttons with Tab and activate their native menu behavior.
Cancelled, scrolling, multi-touch, embedded-control, and selection gestures must
not reveal actions or steal focus. A long press that already opened a menu must
not move focus back to its trigger on release.

At `4aa37da6a587d53f40a7920bf0db81251a5411c2`, the
[Quality run](https://github.com/CloudHub-Social/Charm/actions/runs/40593093063)
passed accessibility lint and the browser job, including the geometry matrix,
existing reaction journeys, and new keyboard-entry/focus-return journey.
Storybook build/accessibility also passed. The frontend job stopped at an IRC
formatting difference; typecheck, unit coverage, dead-code checking, and build
were not verified by that run. The
[documentation run](https://github.com/CloudHub-Social/Charm/actions/runs/40593093595)
passed content, build, and site-graph checks after the ledger links were corrected.
These are revision-specific results, not a claim that a later head is qualified.

## Picker and gesture regression follow-up

Exact logs from the 51cc4673 merge run identify two unit failures in
ChatShell.test.tsx and messageActionSurface.test.tsx, not the previously
suspected MessageRow.test.tsx. The integration fixture now supplies a real
one-touch start; the selection fixture clears an existing range and verifies
selected text before asserting that touch release preserves focus.

Test-first commit 3b6c17910f4ae82b6d81f2ba787174aeb1eb5c74, in
[Quality run 40599079756](https://github.com/CloudHub-Social/Charm/actions/runs/40599079756),
passes those two tests and 2,233 unit cases overall; its only unit failure is
the new compact-picker dismissal assertion. Browser regressions separately
show the picker remaining mounted after selection and the action surface
having pointer-events disabled while the portalled picker owns focus.

The repair makes selection dismiss either picker variant and retains action
surface visibility and pointer access for an open Radix trigger. The
cross-popover journey still requires a normal More-actions click to open its
menu and dismiss the picker. No forced clicks, removed journey assertions,
relaxed timeouts, disabled rules, or lowered coverage gates are used.
Record qualification against the subsequent implementation head in PR #601;
the test-first run above is intentionally failing, not release evidence.

## Scroll-boundary review follow-up

Review comment 4395287876 identified that the above-row toolbar can be
clipped at the timeline top or when the start of a tall message has scrolled
out of view. Test-only head c7c6ed6cdf5f74a6582593f52c57e414bfe1d7af,
in [Quality run 40603216306](https://github.com/CloudHub-Social/Charm/actions/runs/40603216306),
reproduced boundary failures while the 126 existing browser cases passed.
Ten cases demonstrated actual clipping; two IRC tall-message fixtures were
subsequently enlarged because IRC collapses newlines and the original body
was not consistently taller than the viewport. The initial fixture iteration was corrected for signed-zero
scroll coordinates and input capability before relying on that evidence.

A shared positioning hook now owns timeline/visual-viewport containment for
the existing action surface. Unit cases cover placement, active scrolling,
resize, portal focus, cleanup, and CSS fallback. The 12 browser cases retain
actual hit testing and ordinary menu clicks. Exact-head CI must qualify the
implementation before the finding is closed.

Eight gallery images changed by the earlier geometry repair were visually
reviewed and copied from the CI-produced feature-docs candidate for 5c2db696.
The feature-docs comparison thresholds are unchanged, and no gallery build
or browser checks were run locally on the owner's Mac.

## Native-content and header review follow-up

Test-only head 5d25a1c4bd952a44cf8b7fca35efb005163a38e6, in
[Quality run 40605792376](https://github.com/CloudHub-Social/Charm/actions/runs/40605792376),
had 2,243 passing unit tests and four expected failures: native summary and
React-portal touches were consumed, and both header states lacked gutters.
The repair excludes native disclosure controls and out-of-row portal targets
from message gestures, and restores header-owned padding without doubling
first-item spacing. Browser cases also exercise real disclosure taps in all
three layouts, in addition to pointer/touch scroll-boundary placement.

The formatter available in the shared checkout was 0.61.0, while this branch
pins 0.71.0. Explicit file edits now use the pinned formatter in write mode;
project manifests and lockfiles are unchanged and checks still run in CI.

## Owner handoff continuation (2026-10-28)

Owner handoff `handoff_4a9cdc50fd81029efedfb8e2aaa52821af8d84195458c009cd025ab5882bbc00`
was manually claimed before edits. The existing branch and implementation were
preserved. At pickup head `9b386d5db08c5eafe79c2c159ded60f46a40be5c`,
[Quality run 40607622509](https://github.com/CloudHub-Social/Charm/actions/runs/40607622509)
recorded 2,251 passing unit tests and one failing IRC empty-reaction-wrapper
assertion. This was a unit failure, not a coverage-threshold failure. The repair
now omits that wrapper when reactions are absent, retaining the regression test.

The compact browser matrix extends Bubble/Modern/IRC at 320/375/390/430px to
rich URLs/code/tables/math, long replies, failed local echoes and file labels.
It checks row and ancestor bounds through the virtualized item, timeline, pane
and shell, and tests that explicit code/table/math scroll owners retain access
to wide content. Existing pointer/touch/keyboard and complete message journeys
remain in place. These additions require fresh CI; source assertions alone do
not establish that the expanded matrix passes.

Six gallery candidates from that run were visually inspected before copying:
rich-message-rendering, link-previews, message-actions, media-attachments,
timeline-state-events and ux-refresh-navigation-rail. The restored caught-up
header spacing is intentional; the toolbar is outside prose and the reviewed
candidates show no clipped content. Source artifact `12781717289` is
`feature-docs-candidate-601-attempt-1`; browser artifact `12782031822` includes
its capture receipt for CI merge revision `ce31305f9118496712cc429825cf44d7ef1266f9`.
These images qualify only that captured revision. Screenshot thresholds remain
unchanged. New-head comparison and visual review remain required.

The pickup revision's browser, Storybook/axe, Rust and iOS build/simulator jobs
passed, while feature-doc comparisons and four unresolved review threads blocked
qualification. The web preview returned HTTP 503 from its API proxy in
[run 40607622189](https://github.com/CloudHub-Social/Charm/actions/runs/40607622189).
That service dependency is outside this geometry repair; no deployment or API
configuration change is authorized here. Current-head outcomes are recorded in
PR #601 and the same handoff, separately from historical evidence.

The original research PDF was not delivered to this executor. This continuation
uses the handoff's preserved requirements and repository Specs 27/37/38/41/52/64;
it does not claim to have read the attachment. Physical iPhone/iPad keyboard,
long-press, screen-reader, rotation and multitasking acceptance remains blocked
pending a genuine current-build device record from the owner/tester. No merge,
release or flag promotion is implied.

The expanded matrix at `361c58f4` produced **177 passes, 12 failures and 34 skips**
in [browser job 122582627136](https://github.com/CloudHub-Social/Charm/actions/runs/40617260811/job/122582627136).
All four widths reproduced overflowing long reply quotes in Bubble and Modern,
and long file chips in Bubble. For example, Modern at 390px had 3,476px of
row overflow while document overflow remained zero. The quote now constrains
its author and preview to the available width; the file-media flex item may
shrink within the row. The tests retain zero row/ancestor-overflow assertions
and local wide-content-scroll checks. These are container repairs, not global
clipping or relaxed tolerances.

## Context-menu release review

Seer finding [4396133951](https://github.com/CloudHub-Social/Charm/pull/601#discussion_r4396133951)
reviewed head `361c58f442d067403ad4d3ad6cb38327f3037ef2`. Radix MenuItem
synthesizes a click on pointer release when the press began outside that item.
The message menu now prevents non-primary releases in capture before that
handler runs, preserving normal left-click and keyboard selection. A browser
regression holds the opening right-click, moves onto Reply, releases it and
requires the menu to remain open until a separate primary click.

The same head's frontend and iOS jobs stopped at TS2322 in the expanded test's
ancestor walk: Playwright exposes HTMLElement or SVGElement. That walk now uses
Element, and original plain-content snapshot names are retained. These source
corrections await subsequent CI; the stopped jobs did not verify unit coverage
or application/native builds.

Hosted Codex review explicitly reported exhausted payer quota on the new head
in [comment 6458483095](https://github.com/CloudHub-Social/Charm/pull/601#issuecomment-6458483095).
A gate runner completing is not a clean code-review result. The payer/repository
administrator must restore the existing review capability, then obtain a fresh
exact-head review; settings and review gates are not changed by this task.

## Qualified source revision and remaining gates (2026-10-28)

The repaired **source revision** is
`bdcb60d96241b9ece6ac15825705c3828763257e`. The following are provider reads,
not extrapolations from the earlier green revision. A subsequent evidence-only
ledger commit must receive its own applicable CI; the PR body records that head
and distinguishes its checks from the source results below.

| Evidence at source revision | Observed result |
| --- | --- |
| [Quality 40618269615](https://github.com/CloudHub-Social/Charm/actions/runs/40618269615) | Success; all applicable jobs passed; nightly-failure tracking skipped |
| Frontend job 122586397284 | Lint, format, typecheck, coverage, knip and build passed; 2,252 tests in 179 files |
| Coverage | Statements 86.50%, branches 84.59%, functions 80.24%, lines 88.72%; floors preserved |
| Browser job 122586397358 | 189 passed, 34 existing skips, one flaky timeline-scroll case passed on retry; zero terminal failures |
| No-capture scroll witness | One passed; separate from the retry above |
| Compact matrix and actions | All 60 content/layout/width cases passed, plus viewport hit testing, native disclosure, portal, keyboard and context-release journeys |
| Storybook/axe job 122586397353 | Passed; accessibility rules preserved |
| Rust, auth/recovery integrations and companion container | Passed, including required Rust aggregate 122593294697 |
| [iOS 40618269549](https://github.com/CloudHub-Social/Charm/actions/runs/40618269549) | Success; build/simulator evidence, not physical-device acceptance |
| [CodeQL 40618269582](https://github.com/CloudHub-Social/Charm/actions/runs/40618269582) | Success |
| [Docs 40618269431](https://github.com/CloudHub-Social/Charm/actions/runs/40618269431) | Build/content/site graph passed; deployment skipped on PR |
| Feature-doc and visual consumers | All passed; external Snapshot Testing still requests review |

Browser artifact `12786068297` binds these screenshots to CI merge revision
`dd4474a725f01c0f70ce599ab73c78b677e8b3c4`, run 40618269615, attempt 1.
Gallery candidate `12786755708` and the current 320px reply/file/rich-content
captures were inspected. Disposition: intended header spacing and bounded
out-of-flow actions retained; long reply author wraps, reply preview/file label
truncate within their own controls, and code/table/math retain their own
horizontal scrolling. The right-click capture shows Reply only after a separate
primary click. No unintended row clipping was observed in the inspected states.
This visual disposition is not an external Sentry snapshot approval, which
remains explicitly outstanding at snapshot set 120458.

The one flaky browser case is `timeline-scroll.spec.ts:83`: the initial attempt
did not find the new-message pill, then passed on retry. It is retained and
reported rather than hidden by a timeout/assertion change. The separate
no-capture witness also passed. This is a remaining stability observation,
not an all-first-attempt success claim.

### Finding dispositions and gate reconciliation

All ten GitHub review threads are resolved. Viewport containment, native
summary and portal findings are fixed in the preserved implementation; duplicate
Seer/Codex reports share those root causes. Empty IRC spacing is fixed and its
unit assertion passes. Seer's context-release finding 4396133951 is fixed and
the real pointer regression passes. Seer's exact-source-head check reports
**No issues found**, reference 2507870.

Review gate [40618269419](https://github.com/CloudHub-Social/Charm/actions/runs/40618269419)
failed at 02:20:42Z after observing one unresolved thread. The final IRC thread
was resolved after that observation; a fresh read showed all ten resolved.
Only this failed Seer/thread gate was rerun once to reconcile the changed state.
Attempt 2 completed **successfully** with all threads resolved. The separate
Codex status below remains independent.

The separate required `codex/review-gate` status at the source head remains
failure with description **Codex posted 1 finding(s) on current head**, updated
02:05:52Z, pointing to runner 40618897241. The runner's success is not a clean
review receipt. The current-head marker 6458617870 was followed by explicit
code/security payer-quota failures 6458617941 and 6458619961; no clean completion
has been observed. Thread resolution alone does not establish an independent
Codex review. At that checkpoint, quota restoration and a fresh receipt were outstanding.
The direct owner decision below supersedes that requirement: record Codex review
as owner-waived, not passed. No purchase or review-settings change is needed.

The current [preview run 40618269454](https://github.com/CloudHub-Social/Charm/actions/runs/40618269454),
job 122585838343, failed **Verify deployed API proxy** with HTTP 503 at
02:00:37Z for build `pr601.bdcb60d`. This is freshly read failure evidence,
not reuse of the historical 503. The companion/R2 stream owns remediation;
this task does not change its deployment or configuration.

Physical phone/iPad keyboard, long-press, screen-reader, rotation and
multitasking checks remain **unverified and blocking acceptance**. The owner or
device tester must supply a genuine current-build record. No merge, deployment,
release, default-on promotion or physical-device acceptance has occurred here.

### Programme reconciliation — 2026-10-28, 08:18 Toronto

This provider-read checkpoint supersedes the earlier **task-started/awaiting
approval** package rows. It does not supersede the underlying P0–P12 plan,
owner holds or acceptance requirements. No duplicate workers were dispatched.
Current continuation is owned coordination and this ledger only; shared-file
transfers remain a prerequisite to implementation.

| Package / record | Current source and observed stage | Remaining owner and acceptance condition |
| --- | --- | --- |
| P1/P2, [#601](https://github.com/CloudHub-Social/Charm/pull/601) | `dfd9e8ad4557e07d769375c4aec5d289d2d24c1b`; [Quality 40624505133](https://github.com/CloudHub-Social/Charm/actions/runs/40624505133), [iOS 40624504948](https://github.com/CloudHub-Social/Charm/actions/runs/40624504948), [CodeQL 40624504883](https://github.com/CloudHub-Social/Charm/actions/runs/40624504883) and docs passed at this head | PR601 retains message rows/actions/ChatShell, gallery and ledger. Independent review, preview and physical acceptance remain separate; this is not a qualified programme or merge decision |
| P3 reactions, [#609](https://github.com/CloudHub-Social/Charm/pull/609) | Current `6a32b75a8d5ecf3e3fe711ba3ec0777f782c3625`, not the earlier queued `8ce7a12d`; [Quality 40669232904](https://github.com/CloudHub-Social/Charm/actions/runs/40669232904) failed frontend and browser; Storybook/axe passed | P3 keeps reaction components/tests. Current failures and three unresolved threads require disposition before an integration candidate is frozen |
| P4 voice, draft [#608](https://github.com/CloudHub-Social/Charm/pull/608) | `e82a72eaa99bb8f5f91f4595a8f97d9b418f8b61`; [Quality 40636392895](https://github.com/CloudHub-Social/Charm/actions/runs/40636392895) passed for the standalone component package; eight inspected screenshots were coordinator-reported | P4 keeps voice components/tests. Composer/ChatShell are not wired; component CI and screenshot inspection do not prove integrated recording/send/retry behavior |
| P5 adaptive, [#607](https://github.com/CloudHub-Social/Charm/pull/607) | Current `a10c15ee3c45610f364542cba959effd596f7d26`, not `72275623`; [Quality 40660773360](https://github.com/CloudHub-Social/Charm/actions/runs/40660773360) failed frontend; browser and Storybook/axe passed | P5 retains adaptive hook/AppShell. RoomsScreen/Spec52 integration remains explicitly untransferred; six threads remain unresolved, including duplicate root causes |
| Navigation [#591](https://github.com/CloudHub-Social/Charm/pull/591) | Draft `173448659c1b67a10d21b8efc8c08c3e525cc1fe`; owns RoomsScreen tests and navigation/accessibility changes, plus Spec64 changes | No file release has been established. Preserve accessibility naming and existing uncommitted work; draft status is not permission to take ownership |
| Composer commands [#566](https://github.com/CloudHub-Social/Charm/pull/566) | Open `79b8ecfcc653419ab058b5213c0044e8f59bb42f`; owns ChatShell/props, send/command paths and Composer tests | Resolve exact shared-file custody before P4 wiring. Preserve nickname/DM commands and existing permission/account/room behavior |
| Backend [#606](https://github.com/CloudHub-Social/Charm/pull/606) | Open `55a43a91e13e7d923d04eb866769fc1f2c8dfc02`; independent companion/R2 owner | No backend/storage/deployment work transfers to this integrator; preview availability remains that stream's dependency |
| P0, P6–P11 and P12 | Retained, **unqualified/unassigned in the available numbered registry**. No executor, implementation, CI, rollout or acceptance receipt is established here for these packages | Coordinator must restore the original exact numbered outcome/acceptance mapping and assign an owner before execution. Do not silently drop, renumber, infer completion or launch duplicates |

The original research attachment is still unavailable to this executor. The
remaining named outcomes retained by the handoff are shared primitives,
supported flag profiles/rollback, durable drafts/restart continuity,
notification/Activity parity, verification/recovery, threads, calls and
expression/platform polish. Their exact mapping to the unresolved numbered
packages is not established by this repository ledger; it must be reconciled
with the original plan rather than invented. Issues #539/#526 remain open.

#### Current failure and review dispositions

P5 frontend job
[122723265031](https://github.com/CloudHub-Social/Charm/actions/runs/40660773360/job/122723265031)
reported **2,237 passed / one failed**, not a coverage-floor failure. The compact
Spaces-root test still requests a root tab while conversation detail intentionally
hides it; the accessible Back control is present in the failure output. Proposed
repair remains a real **detail → Back → root → Spaces** journey, retaining
assertions for the destination and absence of a desktop rail. No assertion was
removed or timeout increased here. This fresh failure supersedes older counts
and heads; it has not been fixed in this coordination-only change.

P5 unresolved threads group into four root causes: native room-focus/notification
suppression (`4396823548`, duplicate `4398661643`), hidden pinned-jump destination
(`4396823551`, duplicate `4396826426`), same-PR Spec52 documentation
(`4396823555`), and panel focus across the medium/wide breakpoint
(`4398663196`). The Spaces-root visibility defect was fixed at `72275623`;
the stale return-focus defect was fixed at `a10c15ee`. Those two resolved findings
do not resolve the new breakpoint-focus finding or shared integration defects.

P3 frontend job
[122751594740](https://github.com/CloudHub-Social/Charm/actions/runs/40669232904/job/122751594740)
reported **2,242 passed / one failed**: the tombstoned-room ChatShell test expects
the reactor-details control to be native-disabled. Preserve the distinction
between read-only **view details** and forbidden **toggle mutation**; after
ownership release, the integration assertion must prove no send/mutation is
possible while detail viewing remains accessible. Do not simply delete the
read-only test or change its expectation without behavioral proof.

P3 browser job
[122751594620](https://github.com/CloudHub-Social/Charm/actions/runs/40669232904/job/122751594620)
has **37 terminal failures**, including the hover-tooltip journey and the
reaction-content matrix. One directly observed compact failure places a target's
right edge at 348px in a 320px viewport. Retain containment, 44px/nonoverlapping
hit-target and gesture assertions. Failures must be split into shared-row/picker
integration versus P3-owned interaction defects using exact logs; they are not
all declared fixed by PR601 or all attributed to the shared shell.

P3's three unresolved threads are read-only detail gestures (`4397814512`),
enabled fallback focus (`4397814522`) and the newer stale return-focus fieldset
(`4398672531`). Earlier Seer duplicates marked fixed are evidence to reconcile,
not grounds for this integrator to resolve current live threads on another
owner's behalf.

#### Proposed serial integration tasks — none started

| Sequence | Files / proposed effect | Explicit release needed | Required evidence before the next effect |
| --- | --- | --- | --- |
| 1. Freeze custody | Record source SHA, target branch, exact file list, uncommitted-work disposition and sole writer for each seam in this handoff | PR591 navigation owner; PR601 shared owner; PR566 command owner; P3/P4/P5 component owners | An actual owner release/acknowledgement and designated integration scope, not this proposal or a worker dispatch |
| 2. Navigation test seam | RoomsScreen.test.tsx: use Back before Spaces; retain root/detail, destination and no-desktop-rail assertions | PR591 releases this exact test seam; choose one receiving branch/PR with P5 owner | Current-head frontend unit/coverage result; then full applicable CI. No copy into several branches |
| 3. Medium semantic integration | RoomsScreen.tsx/tests: move existing drawer declarations before the focus effect without duplicating state; derive adaptive width; clear native room focus while replacement context hides chat; close pinned context on jump | PR591 + P5 release the precise navigation seam | Open/close and wide→medium-with-panel-open tests; notification focus and visible pinned destination; preserve #591 accessibility changes |
| 4. Adaptive documentation/focus | Spec52/64: publish staged flag/width/input behavior in the **same PR** as the behavior; P5 fixes panel-focus preservation in its own AppShell seam | Explicit shared-spec reconciliation with #591 and PR601; AppShell remains with P5 until released | Panel-open resize retains active panel control, close restores a valid control, root/detail and rollback tests, exact-head review and current screenshots |
| 5. Reaction integration | Combine a frozen P3 candidate with preserved PR601 rows/actions/picker behavior; adapt ChatShell read-only tests to prove mutation exclusion and accessible details | P3 release of candidate; PR601 release for exact row/ChatShell seam | 1/5/20 reactions across three modes/compact widths, actual hit tests, pointer/touch/keyboard details without toggling, focus when a reaction disappears, current review dispositions |
| 6. Voice integration | One composer shell with `VoiceRecorder presentation="composer"`; remove only the redundant idle panel; preserve busy/send/attachment contracts and add the integrated changeset | PR566 + PR601 explicitly release Composer/ChatShell/send boundaries; P4 releases frozen component contract | Permission cancel/unmount/room switch, draft/reply/upload/encryption/local echo continuity, recording/preview/send/failure/retry/discard, hosted journeys and screenshots |
| 7. Acceptance and remaining packages | Requalify the exact assembled revision; reconcile remaining P0–P12 assignments and device matrix | Coordinator supplies original numbered acceptance mapping; owner/device tester supplies physical evidence | Separate source/CI/review/snapshot, preview/live, phone/iPad and release decisions; no implied merge/deploy/flag promotion |

The integrator accepts these later bounded serial tasks, subject to the releases
above. Shared RoomsScreen and Spec52 writes have **not** started; no task was
redispatched and no P5 targeted queue was repeated. Child components, PR591,
PR566 and backend code remain with their owners. That coordination checkpoint preserved its then-current review boundary. The
new direct owner decision below now waives Codex approval/receipt/quota; tests,
security, accessibility, screenshot and device requirements stay in force.

## Owner decision — Codex review waiver, 2026-10-28 08:24 Toronto

Dispatch `charm-codex-review-admin-waiver-20261028-v1` is a new direct owner
instruction, not a repeated task. The owner states: **All codex reviews can be
bypassed by admin merge.** Record Codex approval, clean receipt and payer quota
as **owner-waived**, never as a successful review. Earlier quota-restoration
next actions in this ledger and handoff are superseded. Do not request credits,
wait for quota restoration or impose another mandatory reviewer gate.

Admin merge is authorized only for an otherwise-ready exact head coordinated by
the designated integration owner. Preserve a head-SHA guard and merge readback
when supported. This does not authorize merging over failed tests, security,
accessibility, preview or required snapshot approval, ignoring substantive
findings, changing branch protection/settings/signing/access/spending, or
changing SableClient. No merge is performed by this ledger update.

PR #601 was freshly read at `5f41925e50aa7c848745c055091dccfb89903632`, open and
not draft. Its mergeability flag is not readiness evidence. Non-Codex gates are
routed as follows:

| Requirement | Fresh provider evidence | Responsible next actor and action |
| --- | --- | --- |
| Preview API | [Run 40687041345](https://github.com/CloudHub-Social/Charm/actions/runs/40687041345), job 122812045667, API-proxy verification returned HTTP 503 at 12:22:05Z for the current ledger head | Existing companion/R2 owner under #606 reconciles the service in that stream; integrator then requires passing current-head preview/API verification. No backend edits, deployment or blind rerun here |
| Required snapshot approval | Last published set for prior head `dfd9e8ad` is [120469](https://cloudhubsocial.sentry.io/preprod/snapshots/120469?selectedTypes=added,changed), **ACTION_REQUIRED**. No external Snapshot Testing result for `5f41925e` was published at this read; absence is not approval | Authorized snapshot reviewer reviews the exact candidate set through the existing process; require the set for the eventual current head. Read/Actions portal discovery exposes no Sentry capability in this session, so no platform approval is claimed |
| Refreshed exact-head CI | At this read, [Quality 40687041427](https://github.com/CloudHub-Social/Charm/actions/runs/40687041427), [iOS 40687041791](https://github.com/CloudHub-Social/Charm/actions/runs/40687041791) and [CodeQL 40687041202](https://github.com/CloudHub-Social/Charm/actions/runs/40687041202) were running; docs 40687041547 passed | Integrator reads actual terminal results for the exact eventual head; prior green heads are not substituted |
| Integration custody | [Dependency note 6466141626](https://github.com/CloudHub-Social/Charm/pull/601#issuecomment-6466141626) still explicitly says no ownership transfer | Its quota clause is superseded; its serial file-release/dependency plan remains in force. Preserve #591 navigation, #566 composer commands and #606 backend owners; no cross-branch wiring before release |
| Physical acceptance | Phone/iPad keyboard, long-press, screen-reader, rotation and multitasking evidence remains unavailable | Owner/device tester records genuine current-build outcomes; hosted build/simulator and source merge readiness remain separate from useful live/device acceptance |

Routing is recorded in this existing ledger and the same EA handoff for the
coordinator. No message redispatch or new worker was created. The seven serial
integration tasks above remain proposals gated by exact file release; the waiver
changes review policy only and does not transfer implementation ownership.

## Acceptance and remaining work

Implementation is not release or physical-device acceptance. Record current-head
CI results in PR #601. Its tests cover compact geometry, visible action entry,
and the existing reply/edit/reaction/delete journeys. Native phone/iPad keyboard,
long-press, screen-reader, and multitasking acceptance remain required under #526.

The full reaction-detail redesign, unified composer/voice states, medium layout,
profile rollout, durable drafts, notifications/recovery, threads, and calls remain
separate packages from the approved implementation plan. None is marked complete
by this PR. Do not close #539 or #526 when this bounded repair merges.

All automated verification is performed in GitHub Actions; no local verification
commands are run on the owner's Mac. No dependencies, credentials, production
settings, real-message test data, or Sable resources are changed.
