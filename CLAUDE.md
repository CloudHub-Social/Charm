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

## Quality gate

Run before committing and fix all failures:

```
pnpm build   # tsc && vite build — must succeed with no errors
```

Lint / format / unit-test / dead-code gates are not wired up yet. As oxlint, oxfmt,
vitest, etc. are added (mirroring 1.0's setup), extend this section and the
`lint-on-edit` hook activates automatically (see below).

## Code navigation (graphify)

No graphify graph is built for this repo yet (it's a fresh rewrite). Once
`graphify-out/graph.json` exists, prefer it over an open-ended `grep`/`Explore`
sweep for architecture / "how does X work" / "what calls Y" / cross-file questions:

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
