// @ts-check
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightObsidian, { obsidianSidebarEntries } from 'starlight-obsidian';
import starlightContextualMenu from 'starlight-contextual-menu';
import starlightSidebarSwipe from 'starlight-sidebar-swipe';
import starlightMdTxt from 'starlight-md-txt';
import starlightChangelogs, { makeChangelogsSidebarLinks } from 'starlight-changelogs';
import starlightSiteGraph from 'starlight-site-graph';
import astroD2 from 'astro-d2';

// Path to the Charm 2.0 specs vault. In CI (docs-deploy.yml) this is set to
// where the Knowledge-Platform repo is sparse-checked-out — only the specs/
// subfolder, not the rest of that (private, personal) vault. Locally it
// falls back to the specs folder inside a sibling ~/git/Knowledge-Platform
// checkout, so `pnpm dev` renders specs without any extra setup on the
// machine that already has that vault cloned.
const vaultPath =
	process.env.OBSIDIAN_VAULT_PATH ??
	path.join(
		os.homedir(),
		'git/Knowledge-Platform/10-19 Personal Life/15 Personal projects/15.12 Charm 2.0/specs',
	);

// starlight-versions is deferred: it requires at least one configured
// version, and defining one archives the *current* docs state under that
// label the next time the dev server runs — there's no "just track current,
// no archives yet" mode. With no tagged Charm release to snapshot, any slug
// we'd add here would be a fake version number. Add it back
// (`pnpm add -D starlight-versions`) once a real release is tagged.

// The specs vault sync is gated off until someone has reviewed all files
// under specs/ for public-safety (internal asides, adjudication notes, etc.
// that are fine in a personal planning vault but not on a public site).
// Flip via `PUBLISH_SPECS=true` once that review is done, both locally and
// in docs-deploy.yml.
const publishSpecs = process.env.PUBLISH_SPECS === 'true';

// https://astro.build/config
export default defineConfig({
	site: 'https://cloudhub-social.github.io',
	base: '/Charm',
	integrations: [
		// Uses D2.js (pure JS) rather than the D2 binary so CI doesn't need a
		// separate D2 install step.
		astroD2({ experimental: { useD2js: true } }),
		starlight({
			title: 'Charm',
			tagline: 'A native Matrix client, rebuilt from the ground up.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/CloudHub-Social/Charm' },
			],
			editLink: {
				baseUrl: 'https://github.com/CloudHub-Social/Charm/edit/main/docs-site/',
			},
			plugins: [
				starlightObsidian({
					vault: vaultPath,
					output: 'specs',
					ignore: ['**/.DS_Store'],
					skipGeneration: !publishSpecs,
				}),
				// starlight-scroll-to-top is skipped: it and starlight-contextual-menu
				// both inject a raw client script ending in `export default` into
				// Astro's shared page-scoped script bundle, and two default exports
				// in one concatenated module is invalid JS. Confirmed by build
				// failure — not something fixable from our config; re-evaluate if
				// either plugin changes how it injects its client script upstream.
				starlightContextualMenu({ actions: ['copy', 'view', 'chatgpt', 'claude'] }),
				starlightSidebarSwipe(),
				// v0.1.0's `format` option defaults to '.md' in the actual code,
				// despite the README describing '.md.txt' as the default — set it
				// explicitly so page routes don't collide with Starlight's own.
				starlightMdTxt({ format: '.md.txt' }),
				starlightChangelogs(),
				starlightSiteGraph(),
			],
			sidebar: [
				{
					label: 'Getting started',
					items: [
						{ label: 'Overview', slug: 'index' },
						{ label: 'Local development', slug: 'getting-started/local-dev' },
					],
				},
				{
					label: 'Architecture',
					items: [{ label: 'Overview', slug: 'architecture/overview' }],
				},
				{
					label: 'Contributing',
					items: [
						{ label: 'Feature flags', slug: 'contributing/feature-flags' },
						{ label: 'CI / release tiers', slug: 'contributing/ci-tiers' },
					],
				},
				{
					label: 'Specs',
					items: [obsidianSidebarEntries],
					collapsed: true,
				},
				{
					label: 'Changelog',
					items: [...makeChangelogsSidebarLinks([{ base: 'changelog', type: 'all', label: 'All changes' }])],
				},
			],
		}),
	],
});
