# Charm docs

The public docs site for [Charm](https://github.com/CloudHub-Social/Charm), built with
[Astro](https://astro.build) + [Starlight](https://starlight.astro.build). Deployed to
GitHub Pages by `.github/workflows/docs-deploy.yml` on every push to `main` that touches
this directory.

This is a standalone pnpm project (its own `package.json`/lockfile) — it does not share
dependencies with the root Tauri app.

## Commands

Run from `docs-site/`:

| Command         | Action                                      |
| :-------------- | :------------------------------------------- |
| `pnpm install`  | Install dependencies                          |
| `pnpm dev`      | Start local dev server at `localhost:4321`    |
| `pnpm build`    | Build the production site to `./dist/`        |
| `pnpm preview`  | Preview the build locally before deploying    |

## Structure

Pages live as Markdown/MDX in `src/content/docs/`; navigation is configured in
`astro.config.mjs`. A few pages (feature flags, CI tiers) summarize canonical docs
that live in the repo root `docs/` folder and link back to them — keep those in sync
when the source doc changes materially.
