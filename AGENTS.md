# Charm 2.0 – Agent Instructions

Workflow and process rules for AI agents working on the Charm 2.0 rewrite. See
`CLAUDE.md` for the Claude-Code-specific setup (hooks, identity, branch rules) and
the vault planning doc `15.12 Charm 2.0` for scope and architecture.

---

## Git & Branching

- 2.0 is a standalone repo (`CloudHub-Social/Charm`) — no upstream fork, no `dev`
  mirror, no `integration` trunk (that was 1.0's model).
- `main` is the trunk. Never commit directly to `main`; branch off current `main`:
  ```
  git fetch origin
  git checkout main
  git pull --ff-only origin main
  git checkout -b fix/your-branch main
  ```
- Feature/fix/chore branches target `origin/main` for review/merge.

## Quality Gates

Run before committing and fix all failures. These mirror the `frontend` job in
`.github/workflows/quality-checks.yml` and are enforced in CI:

```
pnpm lint             # oxlint
pnpm fmt:check        # oxfmt --check
pnpm typecheck        # tsc --noEmit
pnpm test:coverage    # vitest run --coverage — enforces the coverage floor
pnpm knip             # dead-code / unused-dependency check
pnpm build            # tsc && vite build — must succeed with no errors
```

## Pull Requests

- Target `origin/main`.
- Keep descriptions short, clear, and human-readable.
- Search related open/merged PRs and issues on `origin` before opening one; link
  related issues (`Closes #N` / `Related to #N`) after confirming with the user.

## Matrix Spec Compliance

- New features and fixes must match the current Matrix spec, or the relevant MSC if
  the spec change is pending.
- Check how Element Web, FluffyChat, or Nheko implement the same thing before
  diverging from established client patterns.
- Link the relevant spec section or MSC in the PR description when spec-driven.

## Libraries over Custom Code

- **Default to established, well-maintained libraries; almost never roll our own** —
  especially for solved problems where bespoke code is an XSS/edge-case/maintenance
  trap: rich text & HTML rendering, markdown, sanitization, syntax highlighting, math
  (KaTeX), emoji, GIF handling, media playback, blurhash, waveforms, fuzzy-matching,
  i18n, and date/time formatting.
- Hand-roll only when no suitable library exists, licensing/bundle size is
  prohibitive, or a library can't meet a hard requirement — and justify it in the PR.
- Lazy-load heavy libraries (syntax highlighter, KaTeX) instead of bloating the base
  bundle. This composes with the confirmation rule below — prefer a library, but
  still confirm before adding it.

## Dependency Changes

- Adding or removing packages requires explicit user confirmation before running
  `pnpm install`.

## Merge Conflicts

- When resolving merge conflicts, prefer the version from the feature branch; ask if
  the intent is ambiguous.

## Destructive Actions

Always ask before:

- Deleting files or branches (`git branch -D`, `rm`, etc.)
- Force-pushing (`git push --force`)
- Hard-resetting local branches (`git reset --hard`)
- Dropping or truncating data

## graphify

Once a knowledge graph exists at `graphify-out/`, use it for codebase questions.

When the user types `/graphify`, invoke the `skill` tool with `skill: "graphify"`
before doing anything else.

Rules:

- For codebase questions, first run `graphify query "<question>"` when
  `graphify-out/graph.json` exists. Use `graphify path "<A>" "<B>"` for relationships
  and `graphify explain "<concept>"` for focused concepts.
- Dirty `graphify-out/` files after hooks/incremental updates are expected — not a
  reason to skip graphify. Only skip if the task is about stale/incorrect graph
  output, or the user says not to use it.
- After modifying code, run `graphify update .` to keep the graph current (AST-only,
  no API cost).

## Imported Claude Cowork project instructions

This is Charm 2.0, a ground-up rewrite of a Matrix client. It is unrelated to Charm 1.0 in every way except the name.
