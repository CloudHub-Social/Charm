// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightContextualMenu from 'starlight-contextual-menu';
import starlightSidebarSwipe from 'starlight-sidebar-swipe';
import starlightMdTxt from 'starlight-md-txt';
import starlightChangelogs, { makeChangelogsSidebarLinks } from 'starlight-changelogs';
import starlightSiteGraph from 'starlight-site-graph';
import astroD2 from 'astro-d2';

// starlight-versions is deferred: it requires at least one configured
// version, and defining one archives the *current* docs state under that
// label the next time the dev server runs — there's no "just track current,
// no archives yet" mode. With no tagged Charm release to snapshot, any slug
// we'd add here would be a fake version number. Add it back
// (`pnpm add -D starlight-versions`) once a real release is tagged.
// https://astro.build/config
export default defineConfig({
	// GitHub Pages serves this repository at the custom domain's root. Keeping
	// the project-site `/Charm` base makes every generated CSS/JS URL point at a
	// non-existent path once the request reaches that custom-domain origin.
	site: 'https://charm-docs.cloudhub.social',
	integrations: [
		// Uses D2.js (pure JS) rather than the D2 binary so CI doesn't need a
		// separate D2 install step.
		astroD2({ experimental: { useD2js: true } }),
		starlight({
			title: 'Charm',
			tagline: 'A native Matrix client, rebuilt from the ground up.',
			customCss: ['./src/styles/docs.css'],
			// The actual Charm app icon (public/favicon.png at the repo root) —
			// no SVG source exists for it, and Starlight's favicon option
			// accepts .png directly.
			favicon: '/favicon.png',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/CloudHub-Social/Charm' },
			],
			editLink: {
				baseUrl: 'https://github.com/CloudHub-Social/Charm/edit/main/docs-site/',
			},
			plugins: [
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
					label: 'Product',
					items: [
						{ label: 'Vision', slug: 'product/vision' },
						{ label: 'Roadmap', slug: 'product/roadmap' },
					],
				},
				{
					label: 'Architecture',
					items: [{ label: 'Overview', slug: 'architecture/overview' }],
				},
				{
					label: 'Features',
					items: [
						{ label: 'Feature gallery', slug: 'features' },
						{ label: 'Maintaining the gallery', slug: 'features/maintaining' },
					],
				},
				{
					label: 'Operations',
					items: [
						{ label: 'Platform overview', slug: 'operations/overview' },
						{ label: 'Sentry observability', slug: 'operations/sentry' },
						{ label: 'Rust companion API', slug: 'operations/web-server' },
						{ label: 'Cloudflare previews', slug: 'operations/cloudflare-previews' },
					],
				},
				{
					label: 'Contributing',
					items: [
						{ label: 'Documentation', slug: 'contributing/documentation' },
						{ label: 'Feature flags', slug: 'contributing/feature-flags' },
						{ label: 'CI / release tiers', slug: 'contributing/ci-tiers' },
					],
				},
				{
					label: 'Specs',
					items: [{ autogenerate: { directory: 'specs' } }],
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
