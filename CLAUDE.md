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
pnpm install --frozen-lockfile   # node_modules isn't shared across worktrees
```

For a release backport, branch from `origin/release/X.Y.Z` instead of `origin/main`,
matching the branch rules above.

`--no-track` matters: without it, the new branch's upstream is set to `origin/main`
(confirmed via `git branch -vv`), and a later bare `git push` fails — with an error
whose first suggested fix, `git push origin HEAD:main`, would push your feature
branch's commits straight onto `main` if followed blindly. Always push explicitly
instead:

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
uncommitted changes inside it (confirmed empirically: nothing is trashed or
recoverable) — exactly the loss this section exists to prevent. If the plain form
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
