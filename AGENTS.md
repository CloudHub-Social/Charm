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

Run before committing and fix all failures:

```
pnpm build   # tsc && vite build — must succeed with no errors
```

Lint / format / unit-test / dead-code gates aren't set up yet. Add them mirroring
1.0's stack (oxlint, oxfmt, vitest, knip) as the codebase grows, and extend this list.

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
