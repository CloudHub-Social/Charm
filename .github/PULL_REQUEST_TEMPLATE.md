<!-- Please read CONTRIBUTING.md before submitting. -->
<!-- ⚠️ IMPORTANT: All PRs must target the `main` branch (or a `release/*` backport branch). -->

### Description

<!-- Please include a summary of the change. Please also include relevant motivation and context. List any dependencies that are required for this change. -->

Fixes #

#### Type of change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] This change requires a documentation update

### Checklist:

- [ ] My code follows the style guidelines of this project
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings
- [ ] `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck`, `pnpm test:coverage`, `pnpm knip`, and `pnpm build` all pass locally

### Observability & e2e coverage:

<!--
These two items are enforced by the "PR checklist gate" CI check, which reads
this section of the PR body. Each line must either be checked `[x]` or contain
an `N/A:` explanation after it on the same line — an unchecked box with no
explanation fails the check. See SENTRY.md and CLAUDE.md's e2e section.
-->

- [ ] I added or updated Playwright e2e coverage (`e2e/*.spec.ts`) for this change.
- [ ] I added Sentry breadcrumbs/logging/metrics for new error paths, IPC calls, or user actions in this change.

### AI disclosure:

- [ ] Partially AI assisted (clarify which code was AI assisted and briefly explain what it does).
- [ ] Fully AI generated (explain what all the generated code does in moderate detail).
<!-- Write any explanation required here, but do not generate the explanation using AI!! You must prove you understand what the code in this PR does. -->
