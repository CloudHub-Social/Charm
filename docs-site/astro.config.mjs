// @ts-check
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
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

// Reviewed 2026-07-14: the 79 spec files are public-safe (no PII, secrets,
// cost figures, or infra credentials). The two `00 — Day-N spec index.md`
// files are excluded below — they're written as internal planning logs
// ("owner adjudication" decision tables) rather than reader-facing docs.
// `**/00 *.md` also catches any future Johnny.Decimal-style index note
// (`00 — ...`) added to the specs folder later.
const publishSpecs = process.env.PUBLISH_SPECS === 'true';

// starlight-obsidian's `copyFrontmatter: 'starlight'` is all-or-nothing: it
// would pull in the vault's own `title` frontmatter alongside `sidebar`,
// and that title has its own "Charm 2.0 Spec — " prefix, making every spec's
// title longer, not just the ones that need shortening. So instead: leave
// copyFrontmatter at its default (title stays filename-derived, exactly as
// before), and after starlight-obsidian generates its pages, walk the
// vault for any `sidebar.label` frontmatter and stitch just that into the
// matching generated file. Runs after starlight() in the integrations
// array below so the files it's reading already exist.
function injectVaultSidebarLabels() {
	return {
		name: 'inject-vault-sidebar-labels',
		hooks: {
			'astro:config:setup': async () => {
				if (!publishSpecs) return;

				async function walk(dir) {
					let entries;
					try {
						entries = await fs.readdir(dir, { withFileTypes: true });
					} catch {
						return [];
					}
					let files = [];
					for (const entry of entries) {
						if (entry.name.startsWith('.')) continue;
						const full = path.join(dir, entry.name);
						if (entry.isDirectory()) files = files.concat(await walk(full));
						else if (entry.name.endsWith('.md')) files.push(full);
					}
					return files;
				}

				const labelByStem = new Map();
				for (const file of await walk(vaultPath)) {
					const raw = await fs.readFile(file, 'utf8');
					const match = raw.match(/^sidebar:\s*\n\s*label:\s*"([^"]+)"/m);
					if (match) labelByStem.set(path.basename(file, '.md'), match[1]);
				}
				if (labelByStem.size === 0) return;

				const specsDir = path.join(process.cwd(), 'src/content/docs/specs');
				for (const file of await walk(specsDir)) {
					const raw = await fs.readFile(file, 'utf8');
					if (raw.includes('\nsidebar:')) continue;
					const titleMatch = raw.match(/^title:\s*"?([^"\n]+)"?\s*$/m);
					const label = titleMatch && labelByStem.get(titleMatch[1].trim());
					if (!label) continue;
					const updated = raw.replace(/^(title:.*\n)/m, `$1sidebar:\n  label: "${label}"\n`);
					await fs.writeFile(file, updated, 'utf8');
				}
			},
		},
	};
}

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
					ignore: [
						'**/.DS_Store',
						'**/00 *.md',
						// These 3 have untagged code fences (` ``` `, no language) mixing
						// Rust/TS generics and JSX-like syntax with prose. starlight-md-txt
						// reparses every page body as MDX (remark-mdx) even for plain
						// Markdown pages, and its acorn-based JSX parser chokes on that —
						// a bug in the plugin, confirmed by testing all 79 spec files
						// directly against remark-mdx (only these 3 fail). Re-include once
						// starlight-md-txt stops blindly MDX-reparsing non-MDX content, or
						// route around it another way.
						'**/Spec 12 — First-run onboarding.md',
						'**/Spec 13 — Voice-video platform spike.md',
						// Prefix match, not a full filename: the real name has literal
						// parentheses, which micromatch treats as extglob syntax rather
						// than literal characters.
						'**/Spec 25 — Persistent crypto state*',
					],
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
		injectVaultSidebarLabels(),
	],
});
