## 0.1.4 (2026-09-08)

### Fixes

- Add the default-off Charm UX renewal across the responsive application shell, navigation rail, room list, conversations, composer, Activity, onboarding, authentication, settings, and contextual panels. The people-first rail keeps visible direct-message shortcuts out of the overflow badge, while typed navigation and device-local pane sizing preserve active conversation ownership across responsive transitions. ([#540](<https://github.com/CloudHub-Social/Charm/pull/540>) by @Just-Insane)

#### Fix iOS launch and Safari single-sign-on callbacks when building with Xcode 27, ([#537](<https://github.com/CloudHub-Social/Charm/pull/537>) by @Just-Insane)

including a post-login database failure caused by continuing to use the
temporary Matrix store after it was moved into the signed-in account, and
register Tao's scene delegate before UIKit resolves the static scene manifest.
Heap-box release-mode Tauri IPC futures so large Matrix startup commands do not
overflow the iOS main-thread stack after login. Stop the Xcode phase immediately
when Rust compilation fails instead of repairing and linking a stale archive.

#### Restore a mobile Matrix sync task promptly when Charm returns to the foreground, ([#542](<https://github.com/CloudHub-Social/Charm/pull/542>) by @Just-Insane)

without claiming background or killed-app notification delivery.

## 0.1.3 (2026-09-06)

### Features

- Add experimental clock and date display preferences behind the disabled-by-default appearance parity flag. ([#497](<https://github.com/CloudHub-Social/Charm/pull/497>) by @Just-Insane)
- Add feature-flagged group DM composite avatars and presence rings, real member-list avatars and presence, and busy presence visuals. ([#457](<https://github.com/CloudHub-Social/Charm/pull/457>) by @Just-Insane)
- Add the default-off composer-parity /join command using the existing room-ID/alias join flow. ([#495](<https://github.com/CloudHub-Social/Charm/pull/495>) by @Just-Insane)
- Add native encrypted Matrix room-key import and export behind the default-off crypto key files flag. Transfers use native file pickers, preserve existing import passphrases, and stop if the active account or device changes before file processing begins. ([#484](<https://github.com/CloudHub-Social/Charm/pull/484>) by @Just-Insane)
- Add a default-off, lazy-loaded full Unicode emoji picker shared by reactions and the composer, with chrome that follows the user's selected Charm theme and recently used emoji isolated per Matrix account. ([#454](<https://github.com/CloudHub-Social/Charm/pull/454>) by @Just-Insane)
- Add a feature-flagged room calendar that jumps to and highlights messages by date. ([#460](<https://github.com/CloudHub-Social/Charm/pull/460>) by @Just-Insane)
- Add a feature-flagged public room directory with homeserver search, pagination, room metadata, and join actions on desktop and web. ([#470](<https://github.com/CloudHub-Social/Charm/pull/470>) by @Just-Insane)
- Add default-off first-time Matrix recovery setup, with protected pending-key custody until the user confirms saving their recovery key. ([#485](<https://github.com/CloudHub-Social/Charm/pull/485>) by @Just-Insane)
- Add a feature-flagged room-upgrade flow with permission-gated confirmation, server-recommended room versions, and read-only replacement-room guidance for tombstoned rooms. ([#463](<https://github.com/CloudHub-Social/Charm/pull/463>) by @Just-Insane)
- Add feature-flagged Matrix polls with composer creation, single-select voting, disclosed or hidden results, and creator-controlled ending on desktop and web. ([#468](<https://github.com/CloudHub-Social/Charm/pull/468>) by @Just-Insane)
- Add encrypted local message search on desktop and web, including SQLCipher FTS5 indexing, edit and redaction handling, scoped queries, and result navigation. ([#421](<https://github.com/CloudHub-Social/Charm/pull/421>) by @Just-Insane)
- Add the SQLCipher-encrypted, device-scoped storage and redaction foundation for encrypted local message search. ([#414](<https://github.com/CloudHub-Social/Charm/pull/414>) by @Just-Insane)
- Complete server-owned browser provider SSO and bounded desktop password-reset resend support. ([#444](<https://github.com/CloudHub-Social/Charm/pull/444>) by @Just-Insane)
- Add a default-off fuzzy quick switcher for keyboard navigation between joined rooms, direct messages, and spaces. ([#448](<https://github.com/CloudHub-Social/Charm/pull/448>) by @Just-Insane)
- Add opt-in voice-message recording with a local preview and explicit send or discard, behind the default-off voice recording flag. ([#496](<https://github.com/CloudHub-Social/Charm/pull/496>) by @Just-Insane)

#### Complete user profile cards with member-list entry, identity copy actions, ([#442](<https://github.com/CloudHub-Social/Charm/pull/442>) by @Just-Insane)

last-active detail, direct-message/block/moderation actions, and room-scoped
profile writes across desktop and web.

### Fixes

- Stop anonymous web socket reconnect loops after an empty restore, and continue physical local-data deletion even when the preceding sign-out cleanup reports an error. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Publish Charm under Apache-2.0 and expose its license and third-party notices in the app. ([#527](<https://github.com/CloudHub-Social/Charm/pull/527>) by @Just-Insane)
- Invalidate the authenticated renderer before terminal-session disk cleanup can fail, and release login exclusion before cancelled SSO device revocation waits on the network. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Bound encrypted room-key file reads and import a private snapshot so later source-file changes cannot bypass the size limit. ([#484](<https://github.com/CloudHub-Social/Charm/pull/484>) by @Just-Insane)
- Cancel superseded web SSO callbacks during token exchange and initial sync, releasing admission capacity before bounded best-effort session revocation. ([#491](<https://github.com/CloudHub-Social/Charm/pull/491>) by @Just-Insane)
- Block session restoration while cancelled-registration cleanup remains pending. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Dispatch slash commands in reply mode, update existing links without duplicate text, and stop active staged formatting when its rollout is disabled. ([#495](<https://github.com/CloudHub-Social/Charm/pull/495>) by @Just-Insane)
- Gate native composer spellcheck behind composer parity and apply live rollout or kill-switch changes without discarding the draft. ([#495](<https://github.com/CloudHub-Social/Charm/pull/495>) by @Just-Insane)
- Filter unsupported directory entries and preserve room selection across delayed join sync; prevent pagination from racing a debounced search. ([#470](<https://github.com/CloudHub-Social/Charm/pull/470>) by @Just-Insane)
- Stage release assets on an unpublished draft, verify the complete uploaded set, and refuse to overwrite published or conflicting assets during reruns. ([#494](<https://github.com/CloudHub-Social/Charm/pull/494>) by @Just-Insane)
- Keep native Matrix sessions signed in across ordinary access-token expiry by requesting, rotating, and durably persisting refresh tokens without allowing a logged-out or superseded client to overwrite the current account session. ([#528](<https://github.com/CloudHub-Social/Charm/pull/528>) by @Just-Insane)
- Keep the full emoji picker's search accessibility reference valid when opening or clearing search. ([#495](<https://github.com/CloudHub-Social/Charm/pull/495>) by @Just-Insane)
- Fix the iOS build while preserving fail-closed message-search backup exclusion. ([#480](<https://github.com/CloudHub-Social/Charm/pull/480>) by @Just-Insane)
- Add a confirmed account-management action that signs out and forgets retained Matrix and encrypted-search data on this device. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Gate device-local account-data deletion independently from encrypted message search. Enabling search no longer enables the destructive account-management control. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Scope official notification-plugin permissions to non-iOS targets so APNs builds do not request permissions from a plugin they no longer install. ([#483](<https://github.com/CloudHub-Social/Charm/pull/483>) by @Just-Insane)
- Keep the jump-to-present pill reliable when a live message arrives immediately after the reader scrolls away from the bottom. ([#464](<https://github.com/CloudHub-Social/Charm/pull/464>) by @Just-Insane)
- Show a privacy-safe error when a Labs flag change cannot complete, including pending search cleanup, and prevent overlapping toggle/reset submissions while it runs. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Accept legacy slash-separated Cargo license expressions when generating complete third-party notices for native builds. ([#513](<https://github.com/CloudHub-Social/Charm/pull/513>) by @Just-Insane)
- Align native authentication destination filtering with the web companion outside the well-known NAT64 prefix. ([#488](<https://github.com/CloudHub-Social/Charm/pull/488>) by @Just-Insane)
- Serialize native search retry admission with live failure reporting so detached reconciliation cannot erase a newer failure and incorrectly report complete results. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Refresh Settings and room-list profile queries after a successful /nick command. ([#495](<https://github.com/CloudHub-Social/Charm/pull/495>) by @Just-Insane)
- Harden password-reset cancellation and IPv4-compatible IPv6 destination validation. ([#488](<https://github.com/CloudHub-Social/Charm/pull/488>) by @Just-Insane)
- Preserve password-reset cancellation warnings when the recovery feature is disabled during an in-flight request. ([#488](<https://github.com/CloudHub-Social/Charm/pull/488>) by @Just-Insane)
- Reject replacement login adoption while that account has unfinished local-data cleanup, preventing a later startup sweep from deleting the replacement session. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Honor the polls rollout flag for notifications and bound poll text at native and HTTP command boundaries. ([#468](<https://github.com/CloudHub-Social/Charm/pull/468>) by @Just-Insane)
- Prevent unsupported multi-select votes and notify new poll starts in unopened rooms through the existing privacy-aware notification path. ([#468](<https://github.com/CloudHub-Social/Charm/pull/468>) by @Just-Insane)
- Preserve full account-data deletion intent in a fallback marker when the primary marker cannot be written. Startup retries encrypted-store and search cleanup rather than downgrading deactivation to ordinary logout. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Keep account identifiers, local storage paths, and raw errors out of session-restore and store-relocation diagnostics. ([#481](<https://github.com/CloudHub-Social/Charm/pull/481>) by @Just-Insane)
- Keep a newer invite acceptance from being overridden by an older profile-card direct-message navigation. ([#446](<https://github.com/CloudHub-Social/Charm/pull/446>) by @Just-Insane)
- Keep a newly created direct message visible while its room-list snapshot catches up. ([#445](<https://github.com/CloudHub-Social/Charm/pull/445>) by @Just-Insane)
- Publish platform release artifacts with signed checksum manifests and SPDX SBOMs. ([#494](<https://github.com/CloudHub-Social/Charm/pull/494>) by @Just-Insane)
- Keep the push notification turn-off control available for existing registrations when new registrations are disabled. ([#483](<https://github.com/CloudHub-Social/Charm/pull/483>) by @Just-Insane)
- Keep password-reset cancellation available after disabling recovery, and avoid misleading cancellation warnings when no reset is active. ([#488](<https://github.com/CloudHub-Social/Charm/pull/488>) by @Just-Insane)
- Require durable encrypted web-session storage before recovery setup and align frontend passphrase bounds with the backend. ([#485](<https://github.com/CloudHub-Social/Charm/pull/485>) by @Just-Insane)
- Keep an in-flight recovery setup and its issued recovery key available when the setup feature flag is disabled, while preventing new setup submissions. ([#485](<https://github.com/CloudHub-Social/Charm/pull/485>) by @Just-Insane)
- Combine registration cleanup vetoes with account-wide wipe retries, preserving shutdown cancellation intent until all cleanup completes. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Reject and attempt to revoke newly committed login sessions when final persistence cleanup fails, preventing silent restoration or resumption of a superseded client and reporting incomplete cleanup explicitly. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Reset both the message-search query and results when reopening the search dialog. ([#461](<https://github.com/CloudHub-Social/Charm/pull/461>) by @Just-Insane)
- Reset expanded timeline notice groups when switching between notice-only rooms. ([#469](<https://github.com/CloudHub-Social/Charm/pull/469>) by @Just-Insane)
- Preserve web password-reset attempts for retry when safety-receipt admission is full before dispatch, without evicting live evidence or restoring cancelled attempts. ([#488](<https://github.com/CloudHub-Social/Charm/pull/488>) by @Just-Insane)
- Avoid claiming a password change may have been dispatched when cancellation fails during the initial recovery-email request before any attempt reaches the browser. Preserve late-attempt cleanup and uncertainty warnings for issued attempts. ([#488](<https://github.com/CloudHub-Social/Charm/pull/488>) by @Just-Insane)
- Serialize web payload sends with permanent session removal, and retain account-wipe retry intent when deactivation cannot delete search indexes. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Retain the encrypted Matrix device and prompt for same-device password reauthentication after a soft logout. ([#531](<https://github.com/CloudHub-Social/Charm/pull/531>) by @Just-Insane)
- Keep unrelated remote feature flags updating when message-search cleanup fails, while holding search disabled until cleanup succeeds. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Prevent delayed search backfills from recreating stale pending state after renderer reload, and protect all backfill exits from clearing a replacement scan. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Harden encrypted message-search cleanup and exclude its mobile storage from backups. ([#450](<https://github.com/CloudHub-Social/Charm/pull/450>) by @Just-Insane)
- Persist encrypted message-search kill-switch cleanup across renderer and process restarts. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Preserve the renderer-selected edit when upgrading a search index with equally ordered edits. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Defer new native search purges until the rollout cache is normalized, while recovering existing durable cleanup intent at startup. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Persist plaintext-free search reconciliation checkpoints and retry incomplete local-cache rebuilds on desktop and web. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Reset native search readiness and backfill on renderer reload until the new page normalizes its flag cache. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Preserve renderer-selected edits through metadata-only queue backpressure and replay open timeline selections before search retry completion. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Keep room-scoped message searches from widening when the active room changes. ([#451](<https://github.com/CloudHub-Social/Charm/pull/451>) by @Just-Insane)
- Keep message search open and explain when an outdated result points to a room that is no longer joined. ([#453](<https://github.com/CloudHub-Social/Charm/pull/453>) by @Just-Insane)
- Keep cached-enabled message search unavailable until native startup cleanup reconciliation succeeds. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Migrate existing version-5 search indexes to remove forged edit provenance and rebuild visible search rows before queries can run. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Keep sender avatar and name touch gestures from opening the message action menu while preserving ordinary profile taps. ([#456](<https://github.com/CloudHub-Social/Charm/pull/456>) by @Just-Insane)
- Wait for a web logout response before exposing replacement login or sending replacement authentication requests, preventing a late logout response from deleting the new session cookie. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Require fresh typed confirmation after canceling a local-data wipe, preserve replacement search scans when stale workers finish, and bound remote pusher cleanup before local session invalidation. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Prevent late logout or wipe completion callbacks from clearing a replacement login after native session invalidation. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Avoid duplicate initial scroll-to-end work when collapsed timeline notices appear on both sides of the final message. ([#467](<https://github.com/CloudHub-Social/Charm/pull/467>) by @Just-Insane)
- Clear stale reply context when dispatching message-sending slash commands, without clearing replies for settings or moderation commands. ([#495](<https://github.com/CloudHub-Social/Charm/pull/495>) by @Just-Insane)
- Normalize password-reset resend behavior and keep cancelled browser SSO polls isolated until their session cleanup finishes. ([#447](<https://github.com/CloudHub-Social/Charm/pull/447>) by @Just-Insane)
- Wait for native SSO completion and cancellation to settle before allowing restart, preserving successful sign-in when durable adoption wins the cancellation race. Ignore obsolete errors and callback updates after leaving the login screen. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Keep post-commit SSO cleanup errors visible after cancellation and verify that revoked web sessions send invalidation before closing. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Carry desktop SSO cancellation through final session adoption and close temporary clients before cleanup. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Continue independent credential and encrypted-search cleanup after startup cleanup failures, retaining retry markers until all required targets succeed. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Update web persistence's S3 storage dependency to remove vulnerable XML parsing dependencies while retaining conditional writes and rollback safeguards. ([#483](<https://github.com/CloudHub-Social/Charm/pull/483>) by @Just-Insane)
- Reject non-text message types in the text-edit backend and preserve text, emote, and notice semantics when composing replacements. ([#495](<https://github.com/CloudHub-Social/Charm/pull/495>) by @Just-Insane)
- Hide unsupported text editing actions for non-text messages in every timeline layout and guard direct edit callbacks. ([#495](<https://github.com/CloudHub-Social/Charm/pull/495>) by @Just-Insane)
- Discard backgrounded voice capture and reject recordings that exceed the duration limit despite delayed timers. ([#496](<https://github.com/CloudHub-Social/Charm/pull/496>) by @Just-Insane)
- Use bounded base64 for native voice uploads and enable mobile recording gestures independently of the chat redesign. ([#496](<https://github.com/CloudHub-Social/Charm/pull/496>) by @Just-Insane)
- Allow public well-known NAT64 homeserver destinations in the web companion while preserving private-address and local-translation restrictions. ([#491](<https://github.com/CloudHub-Social/Charm/pull/491>) by @Just-Insane)
- Run web companion unit regressions alongside native Rust unit tests in CI. ([#491](<https://github.com/CloudHub-Social/Charm/pull/491>) by @Just-Insane)
- Order web password-reset cancellation against dispatch, preserve owner-bound uncertainty after submission, and prevent automatic or restored-attempt retries of an uncertain password change. ([#491](<https://github.com/CloudHub-Social/Charm/pull/491>) by @Just-Insane)
- Resume live web events after completed UIA registration, including immediately completed registration, without adopting intermediate challenges as sessions. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Serialize web search retry admission with live failure reporting so a detached rebuild cannot erase a new dropped-mutation failure or falsely report complete results. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Stop remaining web session snapshot and event sends after session revocation. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Close a web connection revoked during its WebSocket upgrade before replaying session snapshots. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Deliver a payload-free session invalidation event before closing revoked web sockets, while continuing to suppress all retained account data. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)
- Attempt all local account wipe targets even when a credential or filesystem cleanup fails, retaining incomplete cleanup for retry. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)

#### Order native password-reset cancellation atomically against password-change dispatch, and report when cancellation can no longer prevent a password change. ([#488](<https://github.com/CloudHub-Social/Charm/pull/488>) by @Just-Insane)

Retain bounded completion status so late cancellation cannot report that it prevented an already-completed password change.

Wait for cancellation before dismissing recovery. If cancellation cannot be confirmed, clear sensitive inputs and explicitly warn that the password may still change.

#### Keep Escape inside the link dialog from cancelling an unsaved composer edit. ([#495](<https://github.com/CloudHub-Social/Charm/pull/495>) by @Just-Insane)

Wrap formatting controls within narrow mobile composers so every action stays reachable.

#### Explicitly enable native spell-check on the message composer. ([#495](<https://github.com/CloudHub-Social/Charm/pull/495>) by @Just-Insane)

Add default-off strikethrough and code-block formatting controls.

#### Show an acknowledged warning when web password-reset confirmation may have changed the password but its response was lost. Apply the public IPv4 destination policy to NAT64 email-submission addresses to prevent translated private-network access. ([#488](<https://github.com/CloudHub-Social/Charm/pull/488>) by @Just-Insane)

Native password changes also dispatch only once, disable automatic HTTP retries, and report uncertainty without restoring an already-dispatched attempt after an error.

#### Keep room-upgrade cleanup isolated across account changes, honor the persisted ([#465](<https://github.com/CloudHub-Social/Charm/pull/465>) by @Just-Insane)

kill switch immediately before upgrading, and block nested-space creation on
an unresolved or upgraded parent.

#### Serialize ignored-user changes across settings, slash commands, and web sessions in one backend process, fetching current server data so concurrent updates do not overwrite recent blocks from a stale sync cache. ([#495](<https://github.com/CloudHub-Social/Charm/pull/495>) by @Just-Insane)

Invalidate the settings ignored-user query after successful ignore/unignore slash commands.

Fetch current server data for explicit ignored-user settings reads without changing offline timeline/search filtering.

#### Bound web homeserver discovery while streaming and atomically supersede attempts associated with both browser authentication cookies. ([#491](<https://github.com/CloudHub-Social/Charm/pull/491>) by @Just-Insane)

Reject private IPv4 addresses embedded in compatible IPv6 addresses in web homeserver discovery and email submission validation.

#### Track authentication permit lifetimes separately from cancellation records so abandoned setup attempts cannot reserve bounded replacement waits at saturation. ([#491](<https://github.com/CloudHub-Social/Charm/pull/491>) by @Just-Insane)

Retain a live owner's handoff witness through permit acquisition and publication so a newer replacement cannot be rejected in the handoff gap.

Release the semaphore slot before dropping its ownership witness to preserve the same guarantee during teardown.

#### Emit the session-invalidation event to connected browser tabs when the web companion permanently removes their session, before fallible disk cleanup. ([#490](<https://github.com/CloudHub-Social/Charm/pull/490>) by @Just-Insane)

Invalidate on authenticated HTTP 401s and probe closed sockets for missed revocation, while preserving sessions on network failures and ignoring stale responses after replacement login.

## 0.1.2 (2026-08-01)

### Fixes

- Cancel every stale password-reset attempt when recovery is cancelled or restarted. ([#394](https://github.com/CloudHub-Social/Charm/pull/394) by @Just-Insane)
- Keep the space settings label stable for assistive technology while the dialog closes. ([#395](https://github.com/CloudHub-Social/Charm/pull/395) by @Just-Insane)

## 0.1.1 (2026-07-31)

### Features

- Add personal, private message bookmarks and a global "Saved Messages" settings panel (Spec 12), gated behind the default-off `bookmarks` feature flag. ([#294](https://github.com/CloudHub-Social/Charm/pull/294) by @Just-Insane)
- Discover homeserver login choices, render provider-specific SSO actions, and support advertised one-time token login behind the registration and recovery flag. ([#331](https://github.com/CloudHub-Social/Charm/pull/331) by @Just-Insane)
- Show a feature-gated room drop target while attachment files are dragged over chat. ([#279](https://github.com/CloudHub-Social/Charm/pull/279) by @Just-Insane)
- Add feature-gated media captions, upload-size preflight, upload cancellation, GIF autoplay, and default EXIF stripping on upload. ([#302](https://github.com/CloudHub-Social/Charm/pull/302) by @Just-Insane)
- Add forward-to-room, view source, report message, edit history viewing, a reaction "who reacted" tooltip/dialog, and a quick-react emoji row, completing Spec 37's message-action parity with Charm 1.0. All gated behind the existing default-off `message_action_parity` feature flag. ([#300](https://github.com/CloudHub-Social/Charm/pull/300) by @Just-Insane)
- Add a feature-gated action for copying a canonical Matrix permalink to a message. ([#275](https://github.com/CloudHub-Social/Charm/pull/275) by @Just-Insane)
- Add a desktop email password-recovery flow behind the registration and recovery flag. ([#332](https://github.com/CloudHub-Social/Charm/pull/332) by @Just-Insane)
- Add a default-off desktop registration-UIA flow that keeps pending Matrix clients and credentials behind the Tauri boundary while supporting terms, automatic dummy, homeserver fallback, cancellation, and onboarding handoff. ([#330](https://github.com/CloudHub-Social/Charm/pull/330) by @Just-Insane)
- Add feature-gated resend and discard actions for messages that failed to send, using the send-queue's own retry/abort primitives. ([#282](https://github.com/CloudHub-Social/Charm/pull/282) by @Just-Insane)
- Add a feature-gated last-message preview with sender label to room list rows. ([#283](https://github.com/CloudHub-Social/Charm/pull/283) by @Just-Insane)
- Add a persisted display preference for ambient unread message counts in room-list rows. ([#278](https://github.com/CloudHub-Social/Charm/pull/278) by @Just-Insane)
- Add feature-gated space rail management: pin/unpin, reorder, and a per-space context menu (Invite, Add Existing, Mark/Unmark Suggested, Remove, Leave), synced across devices via account data. ([#290](https://github.com/CloudHub-Social/Charm/pull/290) by @Just-Insane)
- Add drag-to-nest and un-nest interactions to the space rail, with cycle feedback and hierarchy reconciliation. ([#333](https://github.com/CloudHub-Social/Charm/pull/333) by @Just-Insane)
- Open spaces in the shared settings shell from the space rail with space-specific controls and labels. ([#334](https://github.com/CloudHub-Social/Charm/pull/334) by @Just-Insane)
- Manage published child rooms and subspaces from a permission-gated Children tab in space settings. ([#335](https://github.com/CloudHub-Social/Charm/pull/335) by @Just-Insane)
- Add feature-gated canonical space-parent APIs and a permission-gated Create subspace action for Spec 33. ([#321](https://github.com/CloudHub-Social/Charm/pull/321) by @Just-Insane)
- Start Spec 39 with a typed timeline-item union that preserves Matrix membership, profile, room state, tombstone, and hidden-state classifications for the upcoming renderer. ([#324](https://github.com/CloudHub-Social/Charm/pull/324) by @Just-Insane)
- Show collapsible membership and room-state notices in timelines behind a default-off feature flag, with matching Appearance controls. ([#336](https://github.com/CloudHub-Social/Charm/pull/336) by @Just-Insane)
- Start Spec 36 with user-profile read contracts for desktop and web plus a default-off surface flag, including room-specific identity, best-effort presence, and privacy-minimal mutual-room summaries. ([#323](https://github.com/CloudHub-Social/Charm/pull/323) by @Just-Insane)
- Add browser-bound companion routes for registration UIA, password recovery, login-flow discovery, and advertised token login. ([#339](https://github.com/CloudHub-Social/Charm/pull/339) by @Just-Insane)
- Add direct, backend-owned email verification to interactive account registration. ([#337](https://github.com/CloudHub-Social/Charm/pull/337) by @Just-Insane)

### Fixes

- Confirm message deletion and allow an optional Matrix redaction reason when message-action parity is enabled. ([#277](https://github.com/CloudHub-Social/Charm/pull/277) by @Just-Insane)
- Add an optional All or Unread filter to Home, direct-message, and space room lists. ([#276](https://github.com/CloudHub-Social/Charm/pull/276) by @Just-Insane)
- Fix an N+1 request storm on room load: redact-permission checks now fetch once per room instead of once per unique message sender. ([#287](https://github.com/CloudHub-Social/Charm/pull/287) by @Just-Insane)
- Add web (browser) support for link previews (Spec 29), proxying the homeserver's `/preview_url` endpoint through the companion server. Matches the existing desktop implementation and stays behind the default-off `link_previews` feature flag. ([#273](https://github.com/CloudHub-Social/Charm/pull/273) by @Just-Insane)
- Add message pinning (shared, room-state `m.room.pinned_events`) — pin/unpin from the message action menu, a pinned-messages panel, and a header pin-count badge — behind a default-off `message_pinning` feature flag. ([#293](https://github.com/CloudHub-Social/Charm/pull/293) by @Just-Insane)
- Parallelize the room-list snapshot loop (bounded concurrency) and cache feature-flag reads, cutting login and steady-state sync latency for accounts with many rooms. ([#286](https://github.com/CloudHub-Social/Charm/pull/286) by @Just-Insane)
- Add presence and receipt privacy controls (hide read receipts, hide typing indicators, appear offline, auto-idle) behind a default-off `presence_privacy_controls` feature flag. ([#291](https://github.com/CloudHub-Social/Charm/pull/291) by @Just-Insane)
- Add web companion server routes for room alias management (list/check/add/remove local aliases, set/clear canonical alias, remove alt alias), wiring the `charm-web-server` transport to the same `_impl` functions desktop's Spec 32 already uses behind the `room_alias_management` flag. ([#274](https://github.com/CloudHub-Social/Charm/pull/274) by @Just-Insane)
- Add a room-list sort control (default, activity, A-Z, unread-first) and a typing-in-list indicator, both behind default-off flags. ([#301](https://github.com/CloudHub-Social/Charm/pull/301) by @Just-Insane)
- Clarify that Spec 13's outstanding iOS, Android, and Linux live results are hardware-blocked and remove contradictory historical Android closure wording. ([#327](https://github.com/CloudHub-Social/Charm/pull/327) by @Just-Insane)
- Make Spec 28 decision-ready with a dedicated per-account FTS5 index, explicit plaintext-at-rest boundary, lifecycle rules, and a cursor-based desktop/web API contract. ([#325](https://github.com/CloudHub-Social/Charm/pull/325) by @Just-Insane)
- Add deterministic authenticated Synapse evidence for desktop and web link previews, plus an explicit frontend cache-reuse regression test. ([#328](https://github.com/CloudHub-Social/Charm/pull/328) by @Just-Insane)
- Make Spec 55 decision-ready with navigation-only scope, account-isolated recents, complete keyboard behavior, and a clear dependency on Spec 28 for room search. ([#326](https://github.com/CloudHub-Social/Charm/pull/326) by @Just-Insane)
- Gate SpaceRail's Invite, Add existing, Mark/Unmark suggested, and Remove from space context-menu actions behind the room's actual power level, closing Spec 63's known gap. ([#298](https://github.com/CloudHub-Social/Charm/pull/298) by @Just-Insane)
- Prevent unsafe space-removal actions with fresh parent-space permission checks. ([#320](https://github.com/CloudHub-Social/Charm/pull/320) by @Just-Insane)
- Add a default-off user profile card for message senders and mentions with presence and mutual-room navigation. ([#329](https://github.com/CloudHub-Social/Charm/pull/329) by @Just-Insane)

## 0.1.0 (2026-07-14)

Charm 2.0 is still pre-release. This entry is a placeholder for Knope's
release automation (`knope prepare-release`/`knope release`) — real,
user-facing entries will start accumulating here as changesets land and
get released.
