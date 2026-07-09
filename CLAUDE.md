# Claude Code instructions for Charm (2.0)

Charm 2.0 is a ground-up rewrite of the Charm Matrix client (matrix-rust-sdk over
typed Tauri IPC, new design language). Scope, architecture, and design decisions
live in the vault planning doc:
`Knowledge-Platform/10-19 Personal Life/15 Personal projects/15.12 Charm 2.0.md` —
treat it as the source of truth until it's explicitly revised there. Charm 1.0 (the
matrix-js-sdk client) lives at `~/git/Charm-1.0` (GitHub `CloudHub-Social/Charm-1.0`).

## Identity — keep it clean

Publishes as plain **Charm**. Never reintroduce a version suffix into a
published-facing identifier: package `charm`, Tauri `productName` `Charm` /
`identifier` `social.cloudhub.charm`, deep-link `charm://`, Cargo `charm`/`charm_lib`.
No `charm2` / `charm-2.0` / `Charm 2` / `social.cloudhub.charm2` anywhere user- or
store-visible.

## Branch and PR rules

**All PRs must target the `main` branch.** Always pass `--base main` when running
`gh pr create`.

- `main` is the default branch. Branch off current `main` for features/fixes/chores.
- Release branches (e.g. `release/2.1.0`) may also be PR targets for backports.
- (1.0 used an `integration` trunk with a `dev` upstream mirror. 2.0 has no upstream
  fork and no integration/dev branches. If that model is adopted later, update
  `ALLOWED_BASES` in `.claude/hooks/check-pr-base.py` and this section together.)

## Parallel sessions — always isolate with a git worktree

Multiple Claude Code sessions are routinely run in parallel against this same local
clone (e.g. implementing several specs at once). **Set up an isolated git worktree
for every implementation task — never work directly in the shared `~/git/Charm`
checkout.** A session can't reliably tell whether another session is mid-turn in that
same directory, and a plain `git checkout` there can land in the middle of another
session's branch switch. This isn't hypothetical: on 2026-07-06, several parallel
spec sessions rapidly switching branches in the shared checkout left it in a
confusing (though ultimately recoverable — no git history was lost) state.

At the start of any task that will edit files:

```
git fetch origin --quiet
git worktree add -b <branch-name> ~/git/Charm-<short-suffix> origin/main --no-track
cd ~/git/Charm-<short-suffix>
```

A repo-tracked `post-checkout` git hook (`scripts/git-hooks/post-checkout`, installed
into the shared hooks dir by `pnpm install`'s `prepare` step — see
`scripts/install-git-hooks.sh`) fires automatically on that `worktree add` and:

- symlinks `node_modules` from `~/git/Charm` into the new worktree when its
  `pnpm-lock.yaml` matches main's exactly, instead of running a full `pnpm install`;
- symlinks `graphify-out` from `~/git/Charm` so `graphify query`/`explain`/`path`
  work immediately, without a rebuild.

If your task's branch changes `package.json`/`pnpm-lock.yaml`, the hook won't create
the `node_modules` symlink (lockfiles no longer match) and you still need
`pnpm install --frozen-lockfile`. If it changes *after* the worktree was created
(lockfiles matched at creation, then diverged), `rm node_modules` before installing —
installing straight through the stale symlink writes into main's real
`node_modules`, corrupting it for every worktree linked to it. A Claude Code hook
(`.claude/hooks/guard-symlinked-node-modules.py`) blocks install-like commands
(`pnpm install`/`add`/`remove`/`update`/`prune`, `npm`/`yarn` equivalents) from
running through a symlinked `node_modules` at all, specifically to catch this. If
the `post-checkout` hook didn't fire for some other reason (e.g. hooks installed
after the worktree already existed), fall back to the same two `ln -s` commands
yourself, or just `pnpm install --frozen-lockfile`.

The `graphify-out` symlink points at main's graph, so **never run `graphify
update .` from inside a worktree** — it writes through the symlink into main's
real graph, overwriting it with a snapshot of this branch's unmerged code and
misleading every other worktree reading that same symlink. (Another Claude Code
hook, `.claude/hooks/guard-worktree-graphify-update.py`, blocks this.) Instead, a
local launchd job — install once with `sh scripts/install-launchd-agent.sh`, it's
opt-in and not run automatically by `pnpm install` — polls `origin/main` every 15
minutes via `scripts/sync-main-graphify.sh`, fast-forwards the *main* worktree when
it's moved (never touching main if it has uncommitted changes or has diverged), and
reruns `graphify update .` there. Worktrees generally see a graph that's at most
~15 minutes stale without anyone needing to refresh it by hand; if you need it
fresher right now, run `graphify update .` from `~/git/Charm` (main) directly.

For a release backport, branch from `origin/release/X.Y.Z` instead of `origin/main`,
matching the branch rules above.

`--no-track` matters: without it, the new branch's upstream is set to `origin/main`
(confirmed via `git branch -vv`). What a later bare `git push` does next depends on
your `push.default` config: with `simple` (git's default since 2.0, and what's in
effect if you haven't changed it) it fails outright — but its error message's first
suggested fix, `git push origin HEAD:main`, would push your feature branch's commits
straight onto `main` if followed blindly; with `push.default=upstream`/`tracking`
configured instead, it pushes straight to the tracked branch with no error at all.
Either way, don't rely on push.default — always push explicitly:

```
git push -u origin <branch-name>
```

Do all work — edits, tests, commits, that push, `gh pr create` — from inside the
isolated directory. When done, remove the worktree **without `--force`**:

```
cd ~/git/Charm
git worktree remove ~/git/Charm-<short-suffix>
```

`git worktree remove --force` deletes the directory outright, including any
uncommitted changes inside it (confirmed empirically: all such changes are lost and
unrecoverable) — exactly the loss this section exists to prevent. If the plain form
refuses ("contains modified or untracked files"), that's git telling you something
in there isn't committed or pushed yet — go commit/push it, don't force past the
warning.

If the shared `~/git/Charm` checkout itself has uncommitted changes (a session that
didn't isolate), **do not stash, reset, or discard them** — that's someone else's
in-progress work. Isolate your own task in a worktree regardless and leave the
shared checkout exactly as you found it; flag it to the user rather than trying to
clean it up yourself.

## Quality gate

Run before committing and fix all failures. These mirror the `frontend` job in
`.github/workflows/quality-checks.yml`:

```
pnpm lint             # oxlint
pnpm fmt:check        # oxfmt --check
pnpm typecheck        # tsc --noEmit
pnpm test:coverage    # vitest run --coverage — enforces the coverage floor
pnpm knip             # dead-code / unused-dependency check
pnpm build            # tsc && vite build — must succeed with no errors
```

A separate `storybook-a11y` CI job builds Storybook and runs every story through
axe in a real browser (Playwright); **any accessibility violation fails the build.**
To reproduce locally: `pnpm build-storybook && pnpm test-storybook:ci`. The one rule
scoped out is `color-contrast` (a design-token issue owned by Charm 2.0 Spec 09 —
see the comment in `.storybook/preview.tsx`); re-enable it there when the tokens are
fixed. Component stories live at `src/components/ui/*.stories.tsx`; `pnpm storybook`
opens them locally.

A separate `e2e` CI job runs Playwright end-to-end tests (`e2e/*.spec.ts`) against
the plain Vite dev server — not the native Tauri app, and not a real homeserver.
`e2e/support/mockTauri.ts` fakes the `@tauri-apps/api` IPC layer in-browser
(`window.__TAURI_INTERNALS__`) against an in-memory fake backend, so these exercise
real React code paths (e.g. `ChatShell`'s send/reconcile logic, `MessageActions`,
`ReplyPreview`) without `tauri-driver` or Synapse. Run locally with `pnpm test:e2e`
(`pnpm test:e2e:ui` for the interactive runner); `playwright.config.ts` starts
`pnpm dev` for you.

Coverage thresholds are an enforced **ratchet** in `vitest.config.ts` (set just
under current actual coverage): when you add tests and coverage rises, raise the
floor in the same PR — never lower it to make CI pass. The Rust side has its own
gate (`cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`) — see the
`rust` jobs in the same workflow.

**IPC types** are generated from the Rust structs by ts-rs into
`src-tauri/src/bindings/` (regenerated as a side effect of `cargo test --lib`) and
re-exported through `src/lib/matrix.ts`; the frontend imports them via the
`@bindings/*` alias. Don't hand-write or edit a binding file — change the Rust struct
(add `#[ts(type = "number")]` on a `u64`/`i64` field that should be a JS `number`
rather than the default `bigint`), regenerate, and commit. CI fails if the committed
bindings drift from the Rust source.

## macOS local dev code-signing

`src-tauri/tauri.conf.json` has no `bundle.macOS.signingIdentity` set — CI and a
default local build both get the OS's implicit ad-hoc-equivalent signing, which
hashes the binary itself. That hash changes on every rebuild, so a locally-stored
Keychain item's ACL (e.g. `keyring`'s entries from Spec 15) stops matching the app's
signature each time you rebuild, and macOS re-prompts for Keychain access even after
choosing "Always Allow" on a previous build.

Fix it locally with a **stable, self-signed Code Signing certificate** (no Apple
Developer account needed): Keychain Access → **Certificate Assistant → Create a
Certificate…** → Identity Type **Self-Signed Root**, Certificate Type **Code
Signing**, name it something specific (e.g. `Charm Dev Self-Signed`). Then export
`APPLE_SIGNING_IDENTITY="Charm Dev Self-Signed"` in your shell before `pnpm tauri
dev` / `pnpm tauri build` — Tauri's env var overrides `tauri.conf.json` regardless of
what's committed there. Because the identity is now your certificate's stable hash
instead of a fresh ad-hoc hash per build, the Keychain ACL keeps matching across
rebuilds.

Do not hardcode a personal certificate name into the committed `tauri.conf.json` —
it only exists in the machine's own keychain that created it, so CI's macOS/iOS
platform-build jobs (and any other contributor's machine) would fail to find it.
Keep this override local-only, via the env var.

## Real-device Apple testing with a free Apple Account

Free Apple Account / Xcode Personal Team signing is enough for local
real-device smoke testing, but it is not the same thing as the self-signed
macOS certificate above:

- The self-signed `APPLE_SIGNING_IDENTITY` flow is only for local macOS rebuild
  stability, especially Keychain ACL prompts. It is not suitable for installing
  an app on an iPhone.
- iOS device deployment uses Xcode automatic signing with the owner's Apple
  Account selected as a **Personal Team**. Xcode creates the local development
  certificate and provisioning profile for that Apple ID.
- Apple's current Personal Team limits are tight: up to 10 App IDs, up to 3
  devices per platform, up to 3 installed apps per device, and 7-day App
  ID/device/profile validity. After the profile expires, rebuild and reinstall.
- Personal Team builds are for personal on-device testing only. They cannot use
  TestFlight/App Store distribution, Developer ID/notarized Mac distribution, or
  paid-program-only capabilities — including end-to-end APNs push testing,
  which needs a paid-program push key/certificate. (Current per-spec testing
  status under this signing tier — e.g. Spec 11 push, Spec 10 desktop shell —
  lives in the Charm 2.0 vault spec notes, not here; this section is build/
  install mechanics only.)
- The generated iOS entitlements currently include `aps-environment` and
  `com.apple.security.application-groups` for Spec 11. If Xcode refuses to sign
  a Personal Team build because those capabilities are unavailable, remove them
  only in a local throwaway working copy for launch/manual UI smoke testing; do
  not commit that downgrade.

Useful sources for the current Apple boundary:

- https://developer.apple.com/support/compare-memberships/
- https://developer.apple.com/help/account/basics/about-your-developer-account/
- https://developer.apple.com/help/account/reference/supported-capabilities-ios/
- https://developer.apple.com/help/account/identifiers/enable-app-capabilities/

### macOS local run

For a local macOS native build:

```sh
pnpm install
pnpm tauri dev
```

If Keychain access prompts repeat across rebuilds, create the self-signed Code
Signing certificate described above and run:

```sh
export APPLE_SIGNING_IDENTITY="Charm Dev Self-Signed"
pnpm tauri dev
```

For a distributable local macOS bundle, use:

```sh
pnpm tauri build
```

That bundle is useful for local smoke testing. It is not a notarized Developer
ID distribution unless signed with a paid Apple Developer Program identity.

### iPhone install with a free Apple ID

Do not try to script certificate/profile creation. Let Xcode manage the
account-bound signing material:

1. Install full Xcode, open it once, and sign in under **Xcode → Settings… →
   Accounts** with the owner's Apple ID.
2. Add the iOS Rust targets if they are missing:

   ```sh
   rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
   ```

3. Open the generated iOS project from this repo:

   ```sh
   pnpm tauri ios dev --open
   ```

   For a release-style archive/build flow instead:

   ```sh
   pnpm tauri ios build --open
   ```

4. In Xcode, select the `charm_iOS` target, then **Signing & Capabilities**.
   Enable **Automatically manage signing** and choose the owner's Personal Team.
5. Connect the iPhone, select it as the run destination, unlock it, and press
   **Run** in Xcode. If iOS blocks the developer app on first launch, approve the
   developer under the device's VPN & Device Management / Developer App settings,
   then run again.
6. Expect to repeat the Xcode run/reinstall after the 7-day Personal Team
   provisioning period expires.

What's actually testable on this signing tier per current spec — day-one basics
(launch, login, sync, local storage) vs. specific gaps like Spec 11 push — is
tracked in the Charm 2.0 vault (`15.12 Charm 2.0/specs/`), not here.

## Code navigation (graphify)

Build a local graphify graph with `graphify update .` (it lands in `graphify-out/`,
which is gitignored — not committed, since it goes stale on every change). Once built,
prefer it over an open-ended `grep`/`Explore` sweep for architecture / "how does X
work" / "what calls Y" / cross-file questions:

- `graphify query "<question>"` — BFS traversal for broad context.
- `graphify explain "<Symbol>"` — plain-language explanation of a node and its neighbors.
- `graphify path "<A>" "<B>"` — shortest path between two concepts/symbols.

Fall back to `grep`/`Explore` for exact string/symbol lookups. Refresh incrementally
with `graphify update .` only when a task depends on freshness.

## Automated hooks

Two repo-local `python3` hooks run automatically for every Claude Code session in
this repo (see `.claude/settings.json` and `.claude/hooks/`). Both are invoked in
exec form (`command`/`args`, not a shell string) so they run the same way regardless
of platform shell:

- **`check-pr-base.py`** (PreToolUse on `Bash`/`PowerShell`) — blocks any
  `gh pr create` that doesn't pass `--base main` (or `--base release/*`). Tokenizes
  with `shlex` rather than regex-matching the raw string, so it isn't fooled by a
  `--base` value quoted inside an unrelated flag, a `--base` belonging to a different
  chained command (`;`/`&&`/`||`), or `gh`'s global flags (`-R`/`--repo`) before
  `pr create`. If a PR create is blocked, fix the `--base` flag.
- **`lint-on-edit.py`** (PostToolUse on `Edit`/`Write`) — runs `oxlint` against a
  `.ts`/`.tsx` file immediately after edit and surfaces issues inline. Self-gating:
  it no-ops until `node_modules/.bin/oxlint` exists, then activates automatically.

Both require `python3` on `PATH`; if missing, the hook fails to spawn and silently
doesn't run (fail-open, not blocking).
