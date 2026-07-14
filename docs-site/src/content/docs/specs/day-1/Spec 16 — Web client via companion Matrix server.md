---
title: "Charm 2.0 Spec — Web client via companion Matrix server"
type: spec
project: Charm 2.0
created: "2026-07-06"
status: shipped
sidebar:
  label: "Web client (companion server)"
---

**Workstream:** multi-PR architecture project — plan to phase into sub-PRs (see Effort
estimate). **Tier:** first-class platform target, confirmed by the 2026-07-06 scope
revision to [product vision and architecture](/product/vision/) (web is now the 6th target platform, not a testing-only
artifact). Not part of the *original* 13-spec Day-1 tier — this is a new initiative to
give Charm a real browser-hosted client, motivated by wanting easier PR review/testing without a local
Tauri build.

> **Scope decision (2026-07-06):** the web client is being built for **personal/
> small-scale use for now**, not as a public product for strangers, even though the
> native apps may eventually distribute widely via app stores. That's a deliberate,
> explicit distinction — app-store distribution of the *native* apps doesn't touch this
> spec at all (each native install runs `matrix-rust-sdk` locally, never through the
> companion server), and the planning doc's own dogfood-first gate already defers any
> "wider rollout" decision until after Day-1 is feature-complete and dogfooded. This
> scope decision **simplifies the whole spec**: the companion server can run on the
> `matrix-vps` the project already owns and operates (see Deployment topology), with no
> Cloudflare-Containers spike, no load-testing, and no separate security review gating
> the first working version — those all become relevant only if/when a real "open this
> to other people" decision gets made later, at which point revisit with real
> information about actual demand.

## Problem & why now

Charm 2.0's React app has **no way to reach a Matrix homeserver on its own**. Every
Matrix operation — login, sync, timeline, sending, crypto, room admin, everything — is a
`#[tauri::command]` invoked over Tauri's IPC bridge from Rust running **in the same
process** as the desktop/mobile shell. Confirmed by inspection: `src/lib/matrix.ts` is
100% `invoke()` calls (57 of them) and **zero** `fetch()` calls; there is no
`matrix-js-sdk`, no WASM crypto, no direct homeserver networking anywhere in `src/`.

This is a deliberate, correct architecture for the desktop/mobile targets (native Tauri
plugin, Rust in-process — see [product vision and architecture](/product/vision/) §2.2), but it means **deploying the
Vite build to a static host (e.g. Cloudflare Workers/Pages) produces a blank/broken app**
past the loading spinner: `try_restore_session()` and everything downstream has nothing
to call. Charm 1.0's Cloudflare Worker preview (`cloudflare-web-preview.yml`) worked
because 1.0 ran `matrix-js-sdk` **in the browser** — 1.0's Worker only serves the SPA +
injects client config, it was never itself a Matrix backend. There is no equivalent
pattern in 2.0's history to reuse.

The motivating want — a live, shareable URL per PR for reviewing UI/UX changes without
building Tauri locally — is legitimate and valuable. This spec proposes the real fix: a
**companion server that hosts `matrix-rust-sdk` itself**, exposing the same operations
over HTTP + WebSocket that Tauri exposes over IPC, so the *existing* React app can run
unmodified above the boundary in a browser, talking to a real homeserver.

## Explicitly rejected alternative (record so it isn't re-proposed)

**Do not** add `matrix-js-sdk` + a WASM crypto build (`matrix-sdk-crypto-wasm`) as a
second, browser-native data layer. This was seriously considered and rejected:
- It re-implements the business logic of **every shipped spec** (01–15: timeline
  rendering, message actions, receipts/presence, media, room-list org, room admin,
  per-account store) in a second SDK/language, with no mechanical port path (the two
  SDKs' APIs and data models differ enough that it's a from-scratch reimplementation).
- It directly **reverses the reason Charm 2.0 exists**: the planning doc's core decision
  was moving *off* `matrix-js-sdk` onto `matrix-rust-sdk` (native crypto store,
  push-triggered background decrypt, single source of truth for sync/storage/crypto).
  Standing up a parallel `matrix-js-sdk` client for web permanently reintroduces the
  stack 2.0 was built to leave behind, and creates a two-SDK maintenance burden across
  every future spec, forever.

The companion-server approach below keeps **one** Matrix implementation
(`matrix-rust-sdk`) as the single source of truth; only the transport underneath it gains
a second implementation (HTTP/WS alongside Tauri IPC), which is a far smaller and more
contained surface.

**Research addendum (2026-07-06):** before settling on the companion-server approach,
we specifically checked whether `matrix-rust-sdk`'s full high-level client (not just its
crypto core) could instead run natively in a browser/edge sandbox via WASM, since that
would be an even cleaner outcome. Findings:
- **`matrix-sdk-crypto-wasm`** (used in production by Element/`matrix-js-sdk`) only
  WASM-ports the crypto **state machine** (`OlmMachine` — "a no-network-IO
  implementation," per its own docs) — never the sync/HTTP/room/timeline layer. Every
  production browser Matrix client pairs it with a full JS/TS implementation of
  everything else (i.e. `matrix-js-sdk`) — there is no production precedent for the
  full high-level client running as WASM anywhere in the ecosystem.
- **Element's own `element-hq/aurora`** is the closest attempt — plugging
  `matrix-rust-sdk` into the browser via WASM — and its own README describes it as
  "**highly experimental**... to investigate what Element X Web/Desktop **could look
  like**," not a production template. If Element's own team, with the deepest possible
  `matrix-rust-sdk` expertise, still frames their own attempt this way, that's a strong
  signal this is genuine unproven R&D, not an oversight anyone can quickly fix.
- Independent of the native-dependency questions (SQLite via `libsqlite3`, tokio's
  native reactor), plain Cloudflare Workers (the WASM-in-isolate model, as opposed to
  Cloudflare *Containers* — see Deployment topology) impose a **1 MB gzipped code-size
  ceiling** and a 30-second max CPU duration per request — `matrix-rust-sdk` plus its
  dependency tree (`ruma`'s event-type surface, crypto, HTTP stack) would plausibly
  exceed the code-size limit on its own, before any native-dependency porting question
  even comes up.

Conclusion: reusing `matrix-rust-sdk` via a companion server (this spec) is not just the
lower-effort path, it's the only one with any real prior art at all. `aurora`-style
WASM-native and the `matrix-js-sdk` dual-client remain documented, shelved alternatives —
revisit only if a genuine, well-resourced reason to attempt either emerges later.

## Current state (in repo)

- `src-tauri/src/matrix/*.rs` — all business logic (`mod.rs`, `timeline.rs`,
  `actions.rs`, `rooms.rs`, `spaces.rs`, `members.rs`, `room_admin.rs`, `media.rs`,
  `ephemeral.rs`, `presence.rs`, `verification.rs`, `qr_login.rs`, `persistence.rs`)
  is written directly against `matrix-rust-sdk`'s `Client`/`Room`/`Timeline` types, with
  a thin `#[tauri::command]` / `app.emit(...)` skin on top. **The business logic itself
  has no Tauri dependency** — only the entry/exit points do.
- `MatrixState` (`mod.rs`) holds exactly **one** `Client` (`Mutex<Option<Client>>`) —
  single-session-per-process, matching one desktop app instance.
- `src-tauri/src/matrix/persistence.rs` (Spec 15) — per-account SQLCipher store +
  keychain entries, **on the local device's filesystem/OS keychain**. There is no
  server-side storage concept anywhere in the codebase.
- `src/lib/matrix.ts` — all IPC types generated by ts-rs into
  `src-tauri/src/bindings/` and re-exported through the `@bindings/*` alias (see the
  ts-rs groundwork PR #7); the wrapper functions (`login`, `listRooms`,
  `getTimelinePage`, `sendMessage`, …) are the **only** thing that would need a second
  transport implementation — every caller above `matrix.ts` is transport-agnostic
  already.
- No wrangler/Cloudflare config exists in this repo (`find . -iname "wrangler*"` is
  empty). Charm 1.0's `worker/index.ts` served the SPA + config injection only.
- `src-tauri/Cargo.toml` already depends on `tokio` with `rt-multi-thread` — the
  runtime a server needs is already present (add `net`/HTTP-stack deps, not swap
  runtimes).
- Existing infrastructure: the Matrix origin already hosts
  Synapse/Dex/MAS for this project's dev/CI use — a natural deploy target for a
  persistent-process Rust service (see Design).

## Scope (in)

1. **A companion Rust server** (new crate, e.g. `charm-web-server`, sharing the
   existing `matrix/*.rs` modules — see Design) exposing HTTP endpoints mirroring the
   Tauri commands and a WebSocket channel mirroring the Tauri events
   (`sync:state`, `room_list:update`, `timeline:update`, `send_queue:update`,
   `room_details:update`, `verification:*`, `profile:update`, receipts/typing/presence,
   etc.).
2. **Multi-tenant session model**: the server holds many concurrent logged-in sessions
   (unlike desktop's single `Client`) — a `SessionId → Client` (+ per-room `Timeline`,
   mirroring Spec 14) map, with a server-issued session token/cookie identifying each
   browser tab's session.
3. **A frontend transport adapter**: `src/lib/matrix.ts`'s `invoke`/`listen` calls get a
   second implementation (`fetch` + `WebSocket`) selected at build time (web build vs.
   Tauri build), so `App.tsx`/`ChatShell.tsx`/every feature above `matrix.ts` needs
   **zero changes** — same pattern already proven by the ts-rs bindings swap and the
   Spec 14 Timeline adoption (swap what's under a stable contract, not the contract).
4. **A storage/security-model decision for server-held sessions** (see Design) —
   this is the one place where the desktop model's on-device guarantee ("React never
   sees raw keys", SQLCipher + OS keychain on the user's own machine) cannot carry over
   unchanged, and it needs an explicit, documented answer.
5. **Deployment**: the frontend static bundle goes on Cloudflare Workers/Pages. The
   companion server runs on the existing `matrix-vps` (see Design's "Deployment
   topology") — no spike needed, no porting, a normal always-on process. Cloudflare
   Containers (GA since 2026-04-13, runs the unmodified Rust binary as a real Docker
   image, no wasm32) is documented as a shelved future option if this ever needs to
   scale beyond personal use, not part of the current plan.
6. **A per-PR preview CI pipeline** once the above exists: build the frontend against
   the companion server (a shared preview instance, or one spun up per PR), point it at
   **test/dummy accounts on a non-production homeserver** (reuse the existing ephemeral
   CI Synapse pattern, or a stable "preview" Synapse — never real user data), deploy the
   frontend build to a per-PR Cloudflare URL, and comment the PR with the link.

## Non-goals (out)

- `matrix-js-sdk` / WASM-crypto browser-native client — explicitly rejected above.
- Full feature parity with the desktop app in the first version of the web client.
  Tauri-only surfaces (native tray/dock badge, OS notifications, autostart, the
  Updater) simply don't apply to a browser tab; browser `Notification` API parity, if
  wanted, is its own follow-up spec.
- Multi-region / horizontally-scaled companion server, load balancing, or high
  availability — a single instance is enough to unblock PR previews; scale it if it
  becomes a real production web offering later.
- Changing anything about the desktop/mobile Tauri architecture, persistence model
  (Spec 15), or IPC contract — this spec adds a second transport, it does not touch the
  first.
- Real end-user web login with real accounts/real E2EE keys in the PR-preview
  environment specifically — previews should use disposable test accounts (see Scope
  item 6); a production-grade "real users log into the real web client" offering is a
  separate, later decision with its own security review.

## Design & approach

### Server shape: reuse the business logic, replace the transport

The `matrix/*.rs` modules already separate cleanly into "logic against `Client`/`Room`"
(reusable) and "`#[tauri::command]`/`State<'_, MatrixState>`/`app.emit`" (Tauri-specific,
replaceable). Concretely:

- Each existing `pub async fn foo_impl(client: &Client, ...) -> Result<T, String>`
  (several modules already factor commands this way for testability — e.g. Spec 03's
  `edit_message_impl`, `redact_event_impl`) is exactly the reusable core. Where a module
  doesn't yet have that `_impl` split, add it as part of this work — it's a mechanical
  refactor (extract the `#[tauri::command]` body into a plain-`Client` function), not a
  logic change, and it benefits the desktop code too (more of it becomes unit-testable
  without a `State`).
- A new crate (`charm-web-server` or similar, depending on `charm_lib` as a path
  dependency so both binaries share `matrix/*.rs`) provides:
  - An HTTP router (axum, given `tokio` is already the runtime) with one route per
    Tauri command, deserializing the same request shape ts-rs already generates
    bindings for.
  - A WebSocket endpoint per session that the server pushes the same event payloads
    (`RoomTimelineUpdate`, `SendQueueUpdateEvent`, etc.) into, replacing
    `app.emit(...)`.
  - A `SessionStore` (`SessionId → Client`, keyed by an opaque server-issued token) —
    the multi-tenant analog of `MatrixState`'s single `Mutex<Option<Client>>`.

### Frontend transport adapter

`src/lib/matrix.ts`'s `invoke`/`listen` wrappers are the only integration point.
Introduce a small transport interface (`invokeCommand(name, args)`,
`listenEvent(name, cb)`) with two implementations — `tauriTransport` (today's
`@tauri-apps/api` calls) and `webTransport` (`fetch` + `WebSocket` against the
companion server) — selected once at module load based on a build-time flag (e.g.
`import.meta.env.VITE_BUILD_TARGET`). Every function in `matrix.ts` calls through the
selected transport; nothing above `matrix.ts` changes. `convertFileSrc` (media) needs a
web equivalent — serve resolved media over an authenticated HTTP endpoint on the
companion server rather than a local file path.

### The storage/security-model question (must be answered explicitly, not left implicit)

Desktop's guarantee is per-account SQLCipher + OS keychain **on the user's own device**
(Spec 15) — the operator of Charm never holds a user's session tokens or E2EE keys.
A server-hosted session breaks that guarantee by construction: something has to hold the
session/crypto state server-side for the duration of the session. Options, roughly
increasing in complexity/trust required:

1. **Ephemeral, no persistence** — each browser session is a brand-new, unverified
   "device" with in-memory-only state; closing the tab discards everything, next login
   re-verifies from scratch. Simplest, least trust-sensitive, worst UX (no session
   persistence, re-verify every time). **Recommended starting point**, especially for
   PR previews where sessions are inherently throwaway.
2. **Server-side encrypted-at-rest session storage**, keyed per logged-in web user, so a
   session survives a server restart / reconnect. This means the server operator has
   custody of ciphertext (encrypted crypto store) for as long as sessions persist — a
   real trust/privacy shift that needs its own explicit sign-off and probably a
   dedicated security review before any production (non-preview) use.
3. Do not persist real user E2EE material server-side at all for the PR-preview
   environment specifically — use disposable test accounts with no real conversation
   history to review, so option 1 is sufficient there regardless of what's eventually
   chosen for a hypothetical production web client.

Given the 2026-07-06 scope decision (personal/small-scale use, not a public product),
**option 2 (server-side encrypted-at-rest, persisted per logged-in user) is reasonable
to build directly** — the "server operator has custody of ciphertext" concern is much
lower-stakes when the operator and the primary user are the same person, on
infrastructure they already own (the same VPS as their own homeserver). Revisit with a
real security review only if/when a genuine "open this to other people" decision gets
made later — that decision, not this spec, is the trigger for treating this as
sensitive.

### Deployment topology

- **Frontend**: Cloudflare Workers or Pages, static asset hosting — this part of the
  original ask is straightforwardly achievable, same role Cloudflare already plays for
  Charm 1.0's static bundle.
- **Companion server — build on the existing VPS now; Cloudflare Containers is a
  documented, shelved future option, not part of the current plan:**

  **Primary plan: a persistent process on the existing `matrix-vps`.** Deploy as
  another service in the same `docker-compose` stack that already runs Synapse/Dex/MAS,
  or a systemd service. `matrix-rust-sdk` runs exactly as it does on desktop today —
  same tokio runtime, same `SqliteStore`, no porting, no spike needed: a normal
  always-on process has no idle-sleep model to fight at all. Given the 2026-07-06 scope
  decision (personal/small-scale use), this is the whole deployment story — build it,
  ship it, move on.

  **Shelved for later (revisit only if this needs to scale beyond personal use, or the
  VPS's operational overhead becomes worth avoiding): Cloudflare Containers.**
  Cloudflare Containers reached **General Availability on 2026-04-13** and run
  **standard Docker images on real Linux VMs** — the same unmodified compiled Rust
  binary as the VPS option, no wasm32 involved (a hand-port to `wasm32` via `workers-rs`
  was considered and rejected — see the research addendum above; Containers make that
  route moot anyway since they need no porting either). If revisited later:
  - A container instance is addressed by session ID (`getContainer(env.MY_CONTAINER,
    sessionId)`), routed to and managed by a Durable Object — a natural fit for "one
    Matrix `Client` per web session."
  - Cloudflare made active outbound connections keep a container alive (changelog,
    2026-06-19): an outbound `connect()` (TCP) or outbound WebSocket specifically
    exempts a container from its idle-sleep timer until the connection closes — close
    to what a Matrix `/sync` long-poll needs, but **unverified** whether a long-poll
    HTTP keep-alive (what `matrix-rust-sdk`'s sync loop actually does) qualifies the
    same way; would need a scoped spike before relying on it.
  - **Known gotcha**: inbound WebSockets (the browser ↔ companion-server event channel)
    do **not** reset the container's idle timer on their own (open upstream issue) —
    would need a keepalive-ping workaround.
  - **Unresolved**: whether local container disk persists across a sleep/wake cycle, or
    only Durable Object storage (`ctx.storage`) does — would need a custom
    `StateStore`/`CryptoStore` bridge if not.
  - None of this blocks anything today — the HTTP/WS transport and session-store design
    below are identical regardless of where the server process lives, so switching from
    VPS to Containers later (if ever) is a deployment change, not a redesign.
- **Per-PR preview**: all PR frontends point at one shared, always-on preview instance
  of the companion server on the VPS (simplest — the frontend build is the only per-PR
  artifact). An ephemeral-per-PR companion-server + Synapse pair (mirroring the
  `rust-integration` CI job's pattern) is a possible later refinement, not needed to
  start.

## Acceptance criteria

1. A browser (no Tauri, no `window.__TAURI_INTERNALS__`) can complete a real login
   against a real test homeserver, see a real room list, open a room, see its timeline,
   and send a message — round-tripping entirely through the companion server, with
   `src/lib/matrix.ts`'s public API unchanged.
2. A message sent from a second, independent client (e.g. a desktop Charm instance or
   another web session) arrives in the browser session via the WebSocket channel
   (`timeline:update`) without a page reload.
3. E2EE session/crypto material never reaches the browser in raw form — the browser
   only ever receives already-decrypted rendered content and IPC-shaped DTOs, mirroring
   the desktop principle ("React never sees raw keys"); crypto operations happen
   server-side in the companion server's `matrix-rust-sdk` instance.
4. The companion server supports multiple concurrent independent sessions without
   cross-session data leakage (session A never sees session B's rooms/messages/tokens).
5. `src/lib/matrix.ts`'s exported function signatures are unchanged; the transport
   selection is invisible to every caller (`App.tsx`, `ChatShell.tsx`, etc. require zero
   edits).
6. A PR opened against the repo produces a live Cloudflare-hosted preview URL (posted as
   a PR comment) that a reviewer can open and interact with the actual PR's frontend
   changes against a real (test-account) homeserver session.
7. The chosen storage model for preview sessions (recommended: ephemeral/no-persistence,
   see Design) is implemented and documented; no real user data or real homeserver
   credentials are used in the preview environment.
8. Existing desktop `cargo test` / Tauri command behavior is unaffected — the `_impl`
   extraction refactor is behavior-preserving (verified by the existing test suite still
   passing unchanged).

## Testing

- **Rust integration tests against the companion server** (new, analogous to the
  existing `src-tauri/tests/*.rs` suite but hitting HTTP/WS instead of calling `Client`
  methods directly): login, list rooms, timeline, send, edit/react/reply/redact, room
  admin, receipts — against local Synapse, through the new transport.
- **Multi-session isolation test**: two concurrent sessions on the same server instance,
  assert no cross-session leakage.
- **Frontend**: extend the existing e2e suite (`e2e/support/mockTauri.ts` pattern) with
  a **new** transport-level test double for `webTransport` (or, better, run a subset of
  the existing e2e specs against a real companion-server + Synapse instance in CI to get
  genuine end-to-end coverage instead of only mock-backed coverage).
- **Manual/CI smoke**: deploy the preview pipeline against a real PR and confirm the
  posted link works end-to-end.

## Dependencies & sequencing

- **Independent of the Day-1 desktop/mobile specs** (01–13) — this doesn't block or get
  blocked by them, since it's a second transport, not a change to the first. It can run
  concurrently with any of them.
- **Builds on Spec 14** (Timeline adoption) — the server-side per-session `Timeline` map
  is the same pattern Spec 14 introduced per-room on desktop, just keyed by session
  additionally.
- **Diverges from Spec 15** (per-account on-device store) for the reasons in the
  Storage/security-model section — this is a deliberate, documented divergence for the
  server-hosted case, not an oversight.
- Recommend phasing into sub-PRs given the size (see Effort): (1) `_impl` extraction
  refactor across `matrix/*.rs` [small, low-risk, desktop-behavior-preserving]; (2) the
  companion server + HTTP/WS transport + session store [the core new service, deployed
  to the existing `matrix-vps` — no spike required]; (3) the frontend `webTransport`
  adapter; (4) the per-PR preview pipeline. Each phase is independently mergeable and
  testable. No Cloudflare-Containers spike phase — that's a shelved future option (see
  Deployment topology), not on the critical path for the current personal/small-scale
  scope.

## Risks & open questions

- **This is the largest single spec in the project.** A new deployable service, a new
  transport layer touching most of `matrix/*.rs`, a new frontend adapter, a new
  security/trust model, and new CI/CD, where every other spec so far has been "one PR /
  one agent." Strongly recommend the implementing agent (re-)propose the phase
  breakdown above as separate PRs rather than attempting it as one.
- **Server-held session state is a genuine trust/privacy shift** from the on-device
  model the rest of the project (and the planning doc) is built around — low-stakes at
  the current personal/small-scale scope (same person owns the client and the server),
  but revisit explicitly, with a real security review, if the audience ever changes.
- **`matrix-rust-sdk` version/feature compatibility as a server dependency** — confirm
  the pinned version's `sqlite`/`e2e-encryption` features work the same way outside a
  Tauri-managed app-data-dir (needs an explicit server-side data directory + its own
  key-management story, since there's no OS keychain to lean on server-side — likely an
  env-provided master key or a secrets manager).
- **Concurrent-session scaling**: how many simultaneous `Client`/`Timeline` instances one
  server process can hold is untested; fine for PR-preview traffic levels, would need
  real load-testing before any production web offering.
- **Cost/ownership of the always-on preview instance** (Design's deployment option (a))
  — someone needs to operate and monitor it; confirm this is acceptable ongoing
  operational surface before committing to it over the ephemeral-per-PR alternative.
- **matrix-vps capacity** — confirm the existing VPS has headroom for an additional
  persistent Rust service alongside Synapse/Dex/MAS, or provision separately.

## Effort estimate

**L** (revised down from XL on 2026-07-06, given the personal/small-scale scope
decision). Still not a "one PR / one agent" Day-1 spec — it's a new server crate, an
`_impl` extraction across most of `matrix/*.rs`, and a frontend transport adapter — but
dropping the Cloudflare-Containers spike, load-testing, and the production-grade
security review (all deferred to a later, separate decision if the audience ever
changes) removes most of what made this XL. Phase into the four sequenced sub-PRs above;
each is independently mergeable and testable.


## Known gaps found post-ship (2026-07-09)

Discovered via live testing of the deployed web build, after the spec's phases
had all merged. These are real functional deficiencies, not previously-known
non-goals — recorded here so they don't get lost.

1. **Resolved 2026-07-09: device cross-signing/verification now runs on web.**
   Original root cause identified: `OnboardingScreen.tsx`
   explicitly omits the "verify this device" pane on web builds
   (`if (!webBuild && !isVerified) list.push("verify")`) and disables its
   underlying `useCrossSigningStatus`/`useDevices` queries
   (`enabled: !webBuild`). The backend/transport support is NOT missing —
   `charm-web-server`'s verification routes and WS events
   (`verification:request`, `verification:sas_update`) are fully wired, and
   `VerificationOverlay.tsx` has no web-specific gating. This is a frontend
   onboarding-gating bug, not a missing backend feature. Fixed by restoring
   web onboarding/status-query parity, exposing web device listing, mounting
   the verification overlay during onboarding, and covering the round trip
   with a live Playwright check: fresh web session verifies against another
   session, then decrypts and renders an encrypted message.
2. **Accepted limitation: web supports password login only for now; SSO is
   not offered on web.** Browser SSO would need a server-owned redirect/callback
   flow, not Tauri's `charm://sso-callback` deep-link flow: `charm-web-server`
   would have to create and hold the pending Matrix `Client`, validate the SSO
   `state`, exchange the returned `loginToken`, then mint the existing
   HttpOnly `charm_session` cookie after `finish_login` creates the server-held
   session. That is outside the current personal/small-scale web scope, so
   the web build intentionally remains password-login-only unless a later
   production web-client decision reopens this.
3. **PR preview comment reliability unconfirmed.** `web-preview.yml` already
   has a "Comment preview URL" step (matching Charm 1.0's pattern), but it
   wasn't observed posting on recent PRs. Possibly masked by an earlier step
   failing first (the proxy-verification curl check), or by PR #106's
   in-flight Pages→Workers migration leaving the workflow in a transitional
   state. Needs live debugging against an actual PR run, not just a code
   read.
