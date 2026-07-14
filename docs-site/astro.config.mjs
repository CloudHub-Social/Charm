// @ts-check
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { createHash } from 'node:crypto';
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

// Reviewed 2026-07-14: the 77 spec files listed in reviewed-specs.json are
// public-safe (no PII, secrets, cost figures, or infra credentials). The two
// `00 — Day-N spec index.md` files are excluded below — they're written as
// internal planning logs ("owner adjudication" decision tables) rather than
// reader-facing docs. Beyond that, publication is allowlisted against
// reviewed-specs.json (see computeUnreviewedIgnorePatterns below) — any spec
// added to the vault later stays unpublished until a PR here adds it to that
// manifest, so a scheduled deploy can never publish unreviewed content.
const publishSpecs = process.env.PUBLISH_SPECS === 'true';

// Allowlist, not blocklist: only files listed in reviewed-specs.json (the 77
// reviewed on 2026-07-14) are ever published, and their path+content digest
// must still match that review. New files remain excluded and edits to an
// existing reviewed path fail the build until a PR updates the digest after
// another privacy review. Escapes glob metacharacters (several spec filenames
// contain literal parentheses, which micromatch would otherwise treat as
// extglob syntax — the same issue that broke a plain filename-based ignore).
function escapeGlob(value) {
	return value.replace(/[()[\]{}!?*+@|^$.\\]/g, '\\$&');
}

function computeUnreviewedIgnorePatterns() {
	const manifestPath = path.join(process.cwd(), 'reviewed-specs.json');
	const manifest = JSON.parse(fsSync.readFileSync(manifestPath, 'utf8'));
	const reviewed = new Set(manifest.paths);
	const contentHash = createHash('sha256');
	for (const rel of [...reviewed].sort()) {
		contentHash.update(rel);
		contentHash.update('\0');
		contentHash.update(fsSync.readFileSync(path.join(vaultPath, rel)));
		contentHash.update('\0');
	}
	const actualHash = contentHash.digest('hex');
	if (actualHash !== manifest.contentSha256) {
		throw new Error(
			'Reviewed spec content changed. Re-review the private specs and update ' +
				`reviewed-specs.json (expected ${manifest.contentSha256}, got ${actualHash}).`,
		);
	}

	function walk(dir, relDir) {
		let entries;
		try {
			entries = fsSync.readdirSync(dir, { withFileTypes: true });
		} catch {
			return [];
		}
		let unreviewed = [];
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				unreviewed = unreviewed.concat(walk(path.join(dir, entry.name), rel));
			} else if (entry.name.endsWith('.md') && !reviewed.has(rel)) {
				unreviewed.push(escapeGlob(rel));
			}
		}
		return unreviewed;
	}

	return walk(vaultPath, '');
}

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
					// Accepts double-quoted, single-quoted, or bare YAML scalars for
					// the label value (our own generator script always double-quotes,
					// but this shouldn't silently no-op if someone hand-edits a
					// vault note's frontmatter with a different quoting style).
					const match = raw.match(/^sidebar:\s*\n\s*label:\s*(?:"([^"]+)"|'([^']+)'|(\S.*))\s*$/m);
					const label = match?.[1] ?? match?.[2] ?? match?.[3]?.trim();
					if (label) labelByStem.set(path.basename(file, '.md'), label);
				}
				if (labelByStem.size === 0) return;

				const specsDir = path.join(process.cwd(), 'src/content/docs/specs');
				for (const file of await walk(specsDir)) {
					const raw = await fs.readFile(file, 'utf8');
					// Scoped to the frontmatter block only — a plain `raw.includes()`
					// would false-positive on any spec whose body happens to mention
					// "sidebar:" in prose or a code sample.
					const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---/);
					if (frontmatterMatch?.[1].includes('\nsidebar:')) continue;
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
						// Allowlist gate: anything in the vault not in
						// reviewed-specs.json, so a scheduled deploy can never
						// publish a newly-added, unreviewed spec.
						...(publishSpecs ? computeUnreviewedIgnorePatterns() : []),
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
