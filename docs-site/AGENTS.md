## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Source of truth

- All durable Charm product docs, architecture, feature specs, contributor
  guidance, and operations runbooks live under `src/content/docs/`.
- Specs are repository-native. Do not restore an Obsidian/vault checkout,
  private deploy key, or content-copy step to the build pipeline.
- Use standard Markdown links. Do not commit Obsidian wikilinks, private
  workspace paths, credentials, or owner-only dashboard URLs.
- Update the relevant spec in the same PR when implementation changes its
  behavior, scope, acceptance criteria, dependencies, or status.
- Feature gallery entries describe deterministic user journeys, not isolated
  Storybook controls. Follow `src/content/docs/features/maintaining.md`.

## Validation

Run both checks before committing documentation changes:

```
pnpm check:content
pnpm build
```

`check:content` catches private-path leakage, Obsidian links, missing linked
Markdown files, and incomplete spec frontmatter. The production build catches
MDX parsing, route, and integration failures.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
