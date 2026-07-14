---
title: "Charm 2.0 Spec — Feature flags (OpenFeature + Sentry evaluation tracking)"
type: spec
project: "Charm 2.0"
created: "2026-07-13"
status: draft
sidebar:
  label: "Feature flags"
---

**Workstream:** single non-phased capability — remote flip, local override, and
Sentry correlation are all Day-1 (see [Why not phased](#why-not-phased)). Likely ~2 PRs at
implementation time for size, but no *capability* is deferred. **Tier:** Day-1
scope (owner request, 2026-07-13) — needed *before* Day-2 features so they can
ship dark, roll out in stages, and be killed remotely without a client release.

**Chosen stack (decided 2026-07-13):** OpenFeature on both sides, backed by
**[GO Feature Flag](https://gofeatureflag.org)** (MIT) as the provider —
relay-proxy container on **DigitalOcean App Platform** (smallest instance),
reading a flag config **published to DigitalOcean Spaces by a GitHub Action**
whose source of truth is a **PR-reviewed Git repo** (with a documented
break-glass path for emergency kills). See [Remote layer](#remote-layer) and
[Config delivery pipeline](#config-delivery-pipeline).

## Problem & why now

Charm 2.0 has **no feature-flag mechanism of any kind** — confirmed by the same
`grep` sweep [Spec 21 — Sentry observability](/specs/day-1/spec-21--sentry-observability-error-monitoring-tracing-replay-logs/)
did (`src/`, `src-tauri/` turn up nothing for "feature flag" or any provider
name), and re-confirmed by the Day-1 sub-feature audit that produced
[Spec 34 — Labs and experimental settings panel](/specs/day-1/spec-34--labs-and-experimental-settings-panel/) ("Charm 2.0 has no labs/flag
mechanism at all — infrastructure gap that'll matter for staging Day-2 features
(threads, calling, etc.) too").

Two things now depend on this not existing:

1. **Day-2 features need to ship behind flags — and be controllable in the
   wild.** The Day-2 folder (`../day-2/`) is threads, native voice/video
   calling, polls, message pinning, custom emoji, etc. — several are large,
   cross-boundary (JS ↔ IPC ↔ Rust ↔ matrix-rust-sdk), and risky to enable for
   everyone the moment they merge. The three things flags buy — **dark launch**
   (ship disabled), **staged rollout** (enable for a growing cohort), and
   **kill-switch** (turn a broken feature off for everyone *without shipping a
   new build*) — are the whole point. The last two are impossible with
   local-only flags: a percentage rollout needs a cohort context, and a
   kill-switch that requires a client release to flip isn't a kill-switch. Spec
   13's voice/video work was *already* called out in Spec 21's non-goals as the
   motivating example ("staged rollout of Spec 13's voice/video work").

2. **Sentry can't correlate flag state with errors yet.** Spec 21 shipped the
   full Sentry surface (#81–#97) but **explicitly deferred the Feature Flags
   product** because there was nothing to hook into (Spec 21 → Non-goals →
   "Feature Flags product… nothing to hook into… revisit if/when Charm 2.0
   adopts a feature-flag system… at which point wiring Sentry's flag tracking
   in is a small addition to whichever spec introduces flags"). This is that
   spec. Once flags exist, Sentry's **evaluation tracking** shows which flags
   were on for the user who hit an issue, and **change tracking** shows when a
   flag was flipped — directly answering "did enabling `threads` cause this
   crash, and when did we turn it on."

The owner's ask: implement a feature-flag system that is **open-source / free**
and **supported by Sentry**, as Day-1 scope, and ship it next.

## Why not phased

An earlier draft of this spec put the remote-flip layer in a "Phase 2." That was
wrong and is corrected here (owner feedback, 2026-07-13): the motivations above
(kill-switch, staged rollout) *are* the remote layer — deferring it would ship a
"feature-flag system" that can't do the two things it's being built for.
Local-only flags give you dark launch and a labs toggle and nothing else. So the
remote layer is **in Day-1 scope**.

What stays **out** (and why it's genuinely not a hidden phase): a **heavy,
DB-backed managed flag platform** (Unleash needs Postgres; Flagsmith needs
Django + Postgres + Redis), and anything **paid** (Unleash's *Autonomous Feature
Management* — metrics-guided auto-rollout/auto-rollback — is enterprise-tier,
confirmed 2026-07-13; not in the free edition). GFF is the lean middle: a single
**stateless Go relay-proxy container** that reads a config file — essentially the
"fetched flag document" this spec originally described, but productized (real
OFREP/OpenFeature support, progressive/percentage rollout, targeting) instead of
hand-rolled. One small container on infrastructure Charm already runs is a fair
Day-1 cost; a Postgres-backed service or a paid tier is not.

## Current state (in repo, verified 2026-07-13)

- **No flag infrastructure.** No provider, no config, no gating helper, no
  settings surface. Feature availability today is purely compile-time.
- **Sentry is fully wired** (Spec 21, shipped). `@sentry/react` is at
  `^10.63.0` (well above the `8.43.0` floor the OpenFeature integration
  requires) and the Rust `sentry` crate is at `0.48.3`. Both SDKs already run
  through the opt-in consent gate and the JS/Rust PII scrubbers from Spec 21 —
  **flag data must flow through those same hooks** (see [PII & consent](#pii--consent)).
- **`tauri-plugin-store`** is already a dependency and is the cross-process,
  filesystem-backed settings store Spec 21 reads synchronously from the Rust
  core at startup. Local overrides and the OFREP-response cache reuse it (see
  [Local override store](#local-override-store)).
- **DO App Platform + DO Spaces are already in use.** `charm-web-server` (Spec
  16) is a Docker service on DO App Platform; a DO Spaces bucket already backs
  sccache. The GFF proxy is a *second small container* there; the published flag
  config is a Spaces object — no new vendor, no new billing relationship.
- **CI already publishes to DO Spaces** (sccache bucket) — the credentials/
  pattern for a GitHub Action writing a Spaces object already exist to copy.
- **An anonymized per-install ID already exists** (Spec 21 generates a random,
  non-reversible per-install identifier at first Sentry opt-in). It's reused as
  the OFREP **targeting key** for cohorting — see [PII & consent](#pii--consent). Note the
  web build persists it in the same store; confirm it exists independently of
  the Sentry opt-in (Spec 21 generates it *at* opt-in — if Sentry is off there
  may be no ID yet, so the flag layer must generate/persist its own anonymized
  ID if Spec 21's isn't present; see [PII & consent](#pii--consent)).
- **`@bindings/*` ts-rs pipeline** is wired — Rust-side flag types that cross IPC
  are `#[ts(export)]` structs, not hand-mirrored TS (repo convention).
- **Existing `environment` concept** (Spec 21 tags dev/preview/production) — the
  flag environments (see [Environments](#environments)) mirror it, don't invent a new axis.

## Non-goals

- **A DB-backed or paid flag platform.** GFF's stateless relay proxy + a config
  file is the deliberate choice over Unleash/Flagsmith and over any paid tier.
  A managed OSS provider stays OpenFeature-swappable later, not this delivery.
- **Metrics-driven automatic rollback as Day-1 scope.** GFF gives *progressive*
  (time-ramped) and percentage rollout, not auto-pause-on-error-spike. A cheap
  DIY equivalent (Sentry alert → flip the config off) is noted as a **future
  option** in [Remote layer](#remote-layer), not built here.
- **Server-side / homeserver flagging.** Client feature-gating only.
- **A/B experimentation / exposure analytics on flags.** Rollout control +
  Sentry error-correlation, not product analytics. (GFF can do experimentation;
  we don't use that surface.)
- **A per-user targeting rules engine beyond percentage/simple rules.** A flag is
  off, on, or on-for-N-percent-of-installs (GFF-computed, deterministic on the
  anonymized install ID). No attribute-based audience builder on real user data.
- **The Labs settings UI itself.** [Spec 34 — Labs and experimental settings panel](/specs/day-1/spec-34--labs-and-experimental-settings-panel/)'s territory — this spec is the plumbing. Spec 34 is a thin consumer of
  the local-override layer. See [Relationship to Spec 34](#relationship-to-spec-34).
- **Replacing compile-time cfg for platform gating.** Platform differences stay
  compile-time; flags are for runtime rollout of behavior that ships in every
  binary.

## Design & approach

### Provider abstraction: OpenFeature over GFF

Adopt **[OpenFeature](https://openfeature.dev)** as the flag API on both sides,
with **GO Feature Flag** as the concrete provider behind it:

- **JS:** `@openfeature/web-sdk` + the OpenFeature **OFREP web provider**
  (points at the GFF relay proxy's OFREP endpoint).
- **Rust:** the official `open-feature` crate + the **`open-feature-ofrep`**
  provider (same OFREP endpoint).

Why this pairing, against the two hard constraints (open-source/free **and**
Sentry-supported):

- **OpenFeature** is the CNCF vendor-neutral standard — keeps "free/OSS" and
  "swappable later" from being in tension. Call sites use `useFlag()`/`flag()`;
  swapping GFF for another provider later touches **zero call sites**.
- **GFF** is MIT, the leanest real tool (single stateless Go binary, no DB),
  OpenFeature-native via OFREP (how it reaches both JS and Rust cleanly), and
  does percentage/progressive rollout + targeting out of the box. Config is a
  plain file — flip a flag by changing the file, no redeploy.
- **Sentry evaluation tracking** works through OpenFeature regardless of provider
  (JS `Sentry.openFeatureIntegration()` + `OpenFeatureIntegrationHook()`; Rust
  flag-context API). **Change tracking** uses Sentry's *Generic* webhook (GFF
  isn't one of Sentry's five native providers) — see [Sentry evaluation + change tracking](#sentry-evaluation--change-tracking).

**Boolean-first.** Sentry's evaluation tracking currently captures **boolean**
evaluations only (verified 2026-07-13). Design the catalog as boolean flags so
every flag is Sentry-visible. Non-boolean flags are allowed by OpenFeature/GFF
but won't show in Sentry's flag context — document that gap at any such call site.

### Resolution model: three layers

The OpenFeature client resolves each flag from three layers, **highest
precedence first**:

1. **Local override** — a per-key boolean from the `tauri-plugin-store` file
   (see [Local override store](#local-override-store)). Written by the Labs panel (Spec 34) and dev
   tooling; the developer/tester escape hatch, always wins. Absent for most keys.
2. **GFF via OFREP** — the relay proxy computes the value for this install,
   including percentage cohort (see [Remote layer](#remote-layer)). Where **production
   rollout control lives**: kill-switch and staged/percentage rollout.
3. **Static default** — the flag's compiled-in default from the **flag catalog**
   (see [Flag catalog](#flag-catalog)). The **offline / proxy-unreachable backstop**
   (`false` for anything not yet fully rolled out).

The OFREP layer is **fail-open to the last-known-good cached response, then to
the catalog default** — an unreachable proxy must never crash startup, block the
UI, or flip a flag unexpectedly. Cache the last successful OFREP response in the
store so an offline launch honors the last known rollout state.

### Remote layer

**GFF relay proxy on DO App Platform; config published to DO Spaces (see
[Config delivery pipeline](#config-delivery-pipeline) for how the config gets there).**

- **Relay proxy** = the official [`gofeatureflag/go-feature-flag` Docker
  image](https://hub.docker.com/r/gofeatureflag/go-feature-flag), **pinned to a
  specific version** (GFF's config schema evolves across releases — don't track
  `latest`), as a **new App Platform component on the smallest instance** (it's
  stateless — no DB). Sits alongside `charm-web-server`; exposes the OFREP
  endpoint clients hit. Configured with the **DO Spaces (S3) retriever** pointed
  at the published config object, on a short poll interval so a republish
  propagates within seconds.
- **Clients** (web + desktop/mobile core) evaluate against that OFREP endpoint
  through their OpenFeature OFREP providers, on a **startup fetch + interval
  refresh + on-focus/on-reconnect refresh**. **Apply-on-refresh, not
  restart-to-apply** — a kill-switch that needs a restart is a weak kill-switch.

**Refresh cadence & kill-switch latency.** Total worst-case time from "edit the
config" to "every online client honors it" = GFF's Spaces-poll interval + the
client refresh interval. Target **each ≤ 60s** so kill-switch latency is ≈2min
worst case, faster typically. State the chosen intervals in `FEATURE_FLAGS.md` —
this number *is* the kill-switch SLA and should be a conscious choice, not a
default. Refresh on window-focus and network-reconnect in addition to the timer,
so a backgrounded/just-woke client doesn't sit on a stale kill.

**First-paint / no flag-flicker contract.** On cold start the OFREP fetch hasn't
resolved yet. Gated UI must render against **cache-or-default synchronously** and
reconcile when the first fetch lands — never block first paint on the network.
For a feature that would be jarring to flash in then out (a whole panel
appearing then vanishing), the call site should prefer the *conservative* value
until the first evaluation resolves (treat "unknown" as off). Call this out as a
UX rule so Day-2 features don't each re-decide it inconsistently.

**Why not Cloudflare Workers** (asked, answered 2026-07-13): the GFF proxy is a
Go binary — Workers run V8/WASM isolates and can't host it (CF's beta *Container
Workers* could, but heavier and beta; CF-native flag tools like Flargd aren't
OpenFeature-standard, so we'd lose the abstraction). DO App Platform runs Docker
containers — the same mechanism `charm-web-server` already uses.

**Future (not Day-1): DIY autonomous rollback.** The paid Unleash feature can be
approximated once this ships: a Sentry alert webhook → a tiny function that
commits a flag-off change (via the break-glass path in
[Config delivery pipeline](#config-delivery-pipeline)). Both ends already exist. Noted, out of scope.

### Config delivery pipeline

Resolves the earlier "Spaces vs GitHub retriever" question by using **both, each
for what it's good at** (decided 2026-07-13):

- **Source of truth: a PR-reviewed Git file.** The flag config lives in a
  **small dedicated repo (`charm-flags`)**, not the main Charm repo — so a
  rollout change isn't gated behind the full Charm build/CI and doesn't add
  commit noise to the app history. It gets its own light CI: schema-validate the
  GFF config + run the catalog↔config key-agreement check (see [Flag catalog](#flag-catalog))
  against the catalog published from the main repo (a generated `flag-keys.json`
  artifact the main repo's CI publishes for `charm-flags` CI to consume — so the
  two repos can't silently drift). `CODEOWNERS` gates who can approve flag
  changes.
- **Publish step: a GitHub Action on merge** validates and **uploads the config
  object to DO Spaces**, then fires the Sentry Generic change-tracking webhook
  (see [Sentry evaluation + change tracking](#sentry-evaluation--change-tracking)). GFF reads the **Spaces object**,
  never GitHub directly — so runtime flag reads don't depend on GitHub
  availability/rate limits.
- **Break-glass (emergency kill):** a documented path to upload a
  flipped-to-`off` config **straight to the Spaces object**, bypassing the PR
  gate, when something is actively broken at 2am. A follow-up PR reconciles Git
  afterward (and CI will flag Git-vs-Spaces divergence until it does). This keeps
  the kill-switch sub-minute while normal rollouts stay PR-reviewed. Access to
  the break-glass upload is limited to the same owners in `CODEOWNERS`.

Normal rollout = PR (reviewed, validated, audited). Emergency = break-glass
(fast, un-gated, reconciled after). This is the whole reason to split source of
truth (GitHub) from runtime read (Spaces).

### Environments

One flag config **per environment**, mirroring Spec 21's `environment` axis
(dev / preview / production) — never one shared config across environments (a
staged-in-preview flag must not leak to production installs):

- **production** — the real published config; what shipped clients read.
- **preview** — used by the Spec 16 Cloudflare Pages preview / any preview build,
  so features can be exercised pre-prod without touching prod rollout.
- **dev / local** — local development should **not require the hosted proxy**:
  default to catalog defaults + local overrides, and optionally point at a
  locally-run GFF container or the preview endpoint via an env var. A developer
  with no network still gets a working app (all flags at catalog default) plus
  the override store to force any flag on.

Each environment is a distinct Spaces object (and OFREP endpoint or GFF
environment); the client picks its config by the same build-time `environment`
value Spec 21 already sets. Document the mapping.

### Flag definition format

To keep the catalog and GFF config legible and prevent drift, pin the shape. A
GFF flag entry (illustrative — confirm exact syntax against the pinned GFF
version) for a 25%-rollout boolean:

```yaml
threads:
  variations:
    on: true
    off: false
  defaultRule:
    percentage:
      on: 25
      off: 75
  # kill-switch: set disable:true or defaultRule -> variation: off
```

- The GFF flag **key must exactly match the Rust catalog key** (`threads`).
- Percentage cohorting keys on the OpenFeature **targeting key** = the anonymized
  install ID (see [PII & consent](#pii--consent)), so a given install stays on one side as
  the percentage grows.
- Kill = flip `defaultRule` to the `off` variation (or GFF's disable field) —
  document the exact one-line edit in `FEATURE_FLAGS.md` so the emergency change
  is unambiguous under pressure.

### Proxy exposure, auth & CORS

The OFREP endpoint is now **publicly reachable** (desktop, mobile, and browser
clients all hit it). Address explicitly rather than shipping it wide open:

- **CORS:** the **web build calls OFREP cross-origin from a browser** — the GFF
  proxy must send CORS headers allowing the web app's origin(s) (prod + preview).
  Desktop/mobile don't need CORS but must not be broken by it. Get the allowed
  origins from the same place the web build's origin is already configured.
- **Auth / abuse:** flag config isn't secret, but an open OFREP endpoint invites
  abuse and receives the anonymized install ID. Decide between (a) GFF's
  **API-key** relay auth with a key shipped in the client build (obfuscation, not
  a real secret in a client app — deters casual abuse, honest about its limits),
  or (b) leaving it open behind **rate limiting** at the App Platform / proxy
  layer. Recommend **API key + rate limiting**; document that the key is not a
  security boundary. Do **not** put anything sensitive behind this endpoint.
- **Availability posture:** the proxy is in the rollout-control path but **not**
  the app critical path — fail-open (see [Resolution model](#resolution-model)) means proxy
  downtime freezes flags at last-known-good/default, never bricks the app. Note
  the one real consequence: a brand-new install during a proxy outage (no cache)
  sees all flags at catalog default (i.e. Day-2 features off) until the proxy
  recovers — acceptable and fail-safe; document it.

### Flag catalog

**One source of truth**, defined Rust-side as the authoritative list:

- A Rust enum/const list of flag keys + static default + one-line description,
  `#[ts(export)]`'d so the frontend imports the key set via `@bindings/*` and
  can't typo a key or drift from the Rust list.
- Each entry: `key`, `default` (bool), `description` (shown in the Labs panel),
  `owner`/`spec` reference (which Day-2 spec it gates).
- The catalog default is the **offline backstop**, not rollout control — rollout
  lives in GFF. Defaults `false` for anything not fully shipped.
- **Catalog↔GFF-config agreement is CI-enforced** (see
  [Config delivery pipeline](#config-delivery-pipeline)): the main repo publishes a generated
  `flag-keys.json`; `charm-flags` CI fails if a catalog key is missing from the
  config or a config key has no catalog entry. A key present in one and
  misspelled in the other would otherwise silently resolve to the catalog
  default — this check is the guard.
- **Retirement is part of the contract:** a flag at 100% that's no longer a
  kill-switch is deleted (catalog key + GFF config entry + call sites) in the PR
  that declares the feature stable — a line in each Day-2 spec's acceptance
  criteria so flags don't accumulate as dead config.

Keep the catalog small and boolean. Add a flag in the Day-2 spec that needs it,
`default: false`; delete it when the feature is proven and fully rolled out.

### Local override store

Reuse Spec 21's exact `tauri-plugin-store` pattern — proven readable
synchronously by the Rust core early in `lib.rs::run()` before the frontend
loads. Overrides under a namespaced key (`feature_flags.overrides.<key>`), the
cached OFREP response under a sibling key. Precedent, gotchas (on-disk format
changing between plugin versions; reading it outside the plugin's own API at Rust
startup), and the "confirm the exact mechanism" open question are identical to
Spec 21's
[Cross-process consent](/specs/day-1/spec-21--sentry-observability-error-monitoring-tracing-replay-logs/#design--approach)
section — follow what that work settled on. Overrides win over GFF so a tester
can pin a flag regardless of rollout; persist across restarts; per-install.

### Consuming a flag

- **JS:** `useFlag('threads')` over the OpenFeature web client's
  `getBooleanValue`, subscribed so a GFF refresh or override flip re-renders.
  Non-React call sites use the client directly.
- **Rust:** `flag(FlagKey::Threads)` over the `open-feature` client returning
  `bool`, picking up the refreshed OFREP result on its next read.

Both sides read the **same three layers** so a flag reads identically in the
frontend and the core for the same install at the same moment — critical for a
feature like threads/calling whose gated logic straddles IPC (on in the UI but
off in the core = confusing half-on state). **Ownership split:** the **Rust core
owns the OFREP fetch + cache** and passes the targeting key; the frontend reads
the cached result (and runs its own OpenFeature client purely for the Sentry
evaluation hook), so there's one fetcher, not two racing ones. On web (no Rust
core) the frontend owns the single fetch. Confirm this split at implementation.

### Sentry evaluation + change tracking

- **Evaluation tracking, JS:** add `Sentry.openFeatureIntegration()` to
  `instrument.ts`'s `integrations` (Spec 21's file) and register
  `Sentry.OpenFeatureIntegrationHook()` (`OpenFeature.addHooks(...)`). Every
  `getBooleanValue` is captured and attached to subsequent error/transaction
  events. Requires `@sentry/react` ≥ 8.43.0 — satisfied.
- **Evaluation tracking, Rust:** the `sentry` crate implements the same Feature
  Flag Context API (100 most recent unique evaluations on the scope, forked to
  children). Call it from `flag()`. Confirm the exact `0.48.3` API surface.
- **Change tracking:** the GitHub Action publish step (see
  [Config delivery pipeline](#config-delivery-pipeline)) POSTs to Sentry's **Generic** change-tracking
  webhook so flag flips land on the Sentry timeline. Webhook signing secret in
  CI secrets. The break-glass path should fire the same webhook on a best-effort
  basis (and the reconciling PR fires it for certain).

**Gating:** flag→Sentry reporting only when Spec 21's `sentry_enabled` is on.
Flags still work with Sentry off; nothing is reported. No new consent toggle.

### PII & consent

- **Flag keys and boolean values are not PII** — app-internal config identifiers,
  deliberately not encoding user/room identity. No Matrix IDs ever go into a
  key, value, or the GFF config. Lint/review rule: keys come from the fixed
  catalog only, never built from user/room data.
- **The one thing sent up: an anonymized install ID, to our own proxy.** OFREP
  evaluation passes a random, non-reversible per-install ID as the targeting key
  so GFF can compute the cohort. This is a real change from the earlier
  static-file design (which sent nothing) and must be stated plainly: the ID goes
  only to **Charm's own GFF proxy on our own DO infrastructure**, is **never**
  the Matrix ID / email / display name, and carries no other context (room, user
  attributes, message data). **ID sourcing:** reuse Spec 21's anonymized
  per-install ID; but Spec 21 generates it *at Sentry opt-in*, so if Sentry is
  off there may be none — in that case the flag layer generates and persists its
  **own** equivalent anonymized ID (same shape, same store), so cohorting works
  regardless of Sentry consent and the two never cross-reference real identity.
  Disclose the outbound ID in `PRIVACY.md` and `FEATURE_FLAGS.md`.
- **Still flows through Spec 21's scrubbers on the Sentry side.** Flag data
  reaches Sentry via the same `beforeSend`/`add_feature_flag` paths — no bypass.

### Relationship to Spec 34 (Labs panel)

- **This spec (35):** flag client, catalog, three-layer resolver, override +
  OFREP-cache stores, GFF proxy + config pipeline + environments, OFREP wiring,
  Sentry wiring, `useFlag()`/`flag()`. No user-visible UI beyond a dev affordance.
- **[Spec 34 — Labs and experimental settings panel](/specs/day-1/spec-34--labs-and-experimental-settings-panel/):** the Settings → Labs
  panel listing catalog flags with a toggle each, writing the **local-override**
  layer. Thin consumer. Land 35 first; update 34's note to depend on it (one-line
  edit in this spec's PR). If 34 is picked up first, it stubs against this spec's
  store shape, not its own mechanism.

## Scope (in) — summary

1. Deps: `@openfeature/web-sdk` + OFREP web provider (JS); `open-feature` +
   `open-feature-ofrep` (Rust). (Lockfile changes → follow `CLAUDE.md`'s
   `pnpm install --frozen-lockfile` worktree guidance.)
2. **Flag catalog** — Rust-authoritative, `#[ts(export)]`'d via `@bindings/*`;
   seed with imminent Day-2 keys `default: false` (or a `__canary` flag if none
   ready). Generated `flag-keys.json` artifact for cross-repo drift checking.
3. **Three-layer resolver** (override → GFF/OFREP → catalog default) with
   fail-open-to-cache-then-default, first-paint contract, single Rust-owned
   fetcher passing the targeting key, apply-on-refresh (+focus/+reconnect).
4. **GFF deployment:** pinned relay-proxy container on DO App Platform (smallest
   instance) with Spaces-retriever + CORS + API-key/rate-limit config, one
   component **per environment** (prod/preview; local optional).
5. **Config delivery pipeline:** the `charm-flags` repo (config + light CI +
   `CODEOWNERS`), the GitHub Action that validates → publishes to Spaces → fires
   the Sentry Generic webhook, and the documented **break-glass** direct-to-Spaces
   path.
6. **Local override store + OFREP-response cache** on `tauri-plugin-store`
   (reusing Spec 21's cross-process approach); anonymized-ID sourcing (reuse
   Spec 21's or generate own).
7. **`useFlag()` (JS) + `flag()` (Rust)** helpers.
8. **Sentry** evaluation tracking (both sides, gated on `sentry_enabled`) +
   Generic-webhook change tracking from the publish step.
9. **Build config / secrets:** OFREP endpoint URL per environment baked into
   client builds (`VITE_*` + Rust env); GFF proxy env (Spaces creds, API key,
   allowed CORS origins); Sentry change-webhook secret; `charm-flags` repo
   deploy token. Enumerate in the PR so nothing is discovered at deploy time.
10. **Docs:** `docs/FEATURE_FLAGS.md` — add a flag (catalog + config), local
    override, **flip / roll out / kill in production** (exact one-line edit) +
    **break-glass runbook**, refresh-cadence/kill-switch-SLA numbers, retire rule,
    boolean-only-Sentry caveat, provider-swap path, environments, and the
    install-ID disclosure (also in `PRIVACY.md`).
11. **One-line dependency edit** to [Spec 34 — Labs and experimental settings panel](/specs/day-1/spec-34--labs-and-experimental-settings-panel/).
12. **Tests** (see [Testing](#testing)).

## Acceptance criteria

1. A catalog flag `default: false`, absent from the GFF config, no override,
   reads `false` from both `useFlag()` and `flag()` on a fresh install; gated
   path inert.
2. Setting it `on` in the config and letting the client refresh flips both sides
   `true` **without restarting**, consistently across the IPC boundary.
3. Setting it back `off` (kill-switch) flips both sides `false` on next refresh,
   no client release — a distinct test from #2 (kill-switch is load-bearing).
4. A percentage rollout resolves **deterministically per install** (same install
   same side across refreshes) and splits synthetic install IDs ≈ to the set
   percentage — via GFF targeting-key hashing, no user identity in context.
5. A local override wins over GFF and catalog default (tester forces on with GFF
   `off`).
6. Proxy unreachable + no cache → catalog defaults, startup/UI unaffected
   (fail-open); with a cached response → offline launch honors cached state; a
   brand-new install during outage → all-off, recovers on reconnect.
7. **First paint** renders against cache-or-default without a network round-trip;
   no gated feature flashes in then out on cold start.
8. `sentry_enabled` **on**: a flag evaluation + captured error puts the flag in
   the Sentry event's flag context (JS integration; Rust flag-context API) —
   verified without a live DSN via Spec 21's fake-transport/snapshot pattern.
9. `sentry_enabled` **off**: flags evaluate correctly and no Sentry event leaves
   the app. (OFREP to our own proxy still carries the anonymized install ID —
   independent of the Sentry toggle, disclosed per [PII & consent](#pii--consent).)
10. Catalog is Rust-authoritative; frontend consumes generated `@bindings/*` keys
    (typo'd key fails to compile); the **cross-repo catalog↔config drift check**
    fails CI on a mismatch.
11. **Environment isolation:** a preview-only flip does not affect production
    installs (distinct configs verified).
12. **CORS:** the web build successfully evaluates flags cross-origin against the
    proxy from an allowed origin; a disallowed origin is rejected.
13. **Config pipeline:** a merged PR publishes to Spaces and fires the Sentry
    change webhook; the break-glass direct-to-Spaces path flips a flag with the
    proxy picking it up on its poll; CI flags Git-vs-Spaces divergence until
    reconciled.
14. `docs/FEATURE_FLAGS.md` documents add / override / **prod flip & kill** /
    **break-glass** / retire, the kill-switch-latency number, and the install-ID
    disclosure; doc accuracy is a PR-review blocker.
15. Full quality gate passes (`pnpm lint|fmt:check|typecheck|test:coverage|knip|
    build`, `cargo fmt --check|clippy -D warnings|test`); `knip` doesn't flag the
    new deps as unused.

## Testing

- **Unit (Rust):** resolver precedence override > GFF > default; fail-open on
  unreachable/malformed OFREP; cache read on offline start; unknown-key behavior;
  anonymized-ID sourcing (reuse Spec 21's vs generate-own).
- **Unit (JS):** `useFlag()` default / override / GFF-flip / re-render on refresh;
  first-paint conservative value before first evaluation resolves.
- **OFREP against a mock** (no live GFF in CI): fetch success updates state;
  failure → cache → default; mid-session change propagates to a live subscriber;
  cohorting deterministic for a fixed targeting key and ≈correct in aggregate.
- **Sentry (both sides):** evaluation-then-error carries the flag in the event's
  flag context — Spec 21's fake-transport/snapshot harness (`e2e/support` +
  `mockTauri.ts`), no real DSN.
- **Consent gate:** flags work + no Sentry event when `sentry_enabled` off.
- **e2e / test determinism (important):** e2e and component tests must **pin flag
  state** (seed the override store, or point the OFREP provider at a mock) and
  **never read the live prod GFF config** — otherwise a prod rollout change makes
  CI flaky. Provide a test-only mechanism (env var / mockTauri hook / seeded
  overrides) to force any flag on/off deterministically; assert it works.
- **Drift & pipeline:** cross-repo key-agreement check catches a missing/extra
  key; the publish Action validates schema and rejects a malformed config.
- **Binding drift:** `#[ts(export)]` catalog regenerates cleanly under CI's
  existing check (no hand-mirrored TS).

## Dependencies & sequencing

- **Depends on Spec 21 (shipped)** for the Sentry SDKs, consent toggle, scrubbers,
  the anonymized per-install ID pattern, the `environment` axis, and the
  `tauri-plugin-store` cross-process pattern. No Spec 21 changes needed.
- **Depends on the DO App Platform / DO Spaces account** used by
  [Spec 16 — Web client via companion Matrix server](/specs/day-1/spec-16--web-client-via-companion-matrix-server/); adds a GFF component and
  a config object there. Confirm smallest instance suffices (it should — GFF is
  stateless) and that the sccache Spaces-publish CI pattern is reusable for the
  config publish. New: the `charm-flags` repo + its light CI + `CODEOWNERS`.
- **Blocks / precedes [Spec 34 — Labs and experimental settings panel](/specs/day-1/spec-34--labs-and-experimental-settings-panel/)** — 34
  consumes this override layer and catalog. Land 35 first.
- **Enables the Day-2 folder** — each Day-2 spec adds its own `default: false`
  catalog flag + GFF config entry, ships gated, rolls out via the config, deletes
  the flag when stable. Add this as a standing line to the Day-2 index when this
  lands.
- **Identity hygiene** (`CLAUDE.md`): keep names clean — `charm-flags` repo, the
  DO component, the OFREP URL — no version suffix in anything published-facing.
- Otherwise independent of other Day-1 specs (shared files: `instrument.ts`,
  appended to; the DO App Platform app definition shared with `charm-web-server`).

## Effort estimate

**L**, non-phased. OpenFeature/Sentry wiring is small (SDKs do the standardized
work), but the remote layer + delivery pipeline earn the L: standing up the
pinned GFF proxy per environment with Spaces-retriever/CORS/API-key config, the
`charm-flags` repo + validate→publish→webhook Action + break-glass path + drift
check, the OFREP providers on both JS and Rust, the three-layer resolver with
fail-open + first-paint semantics, the single Rust-owned fetch/refresh/cache
across IPC, the anonymized-ID sourcing, and the runbook/disclosure docs. Reusing
Spec 21's store pattern, anonymized ID, Sentry consent gate, `environment` axis,
and the existing DO/Spaces + sccache-publish footprint de-risks a good chunk.
Likely ~2 PRs for review size (client resolver + local layers + GFF deploy; then
config pipeline + OFREP wiring + Sentry evaluation/change tracking), but no
capability is deferred across them.
