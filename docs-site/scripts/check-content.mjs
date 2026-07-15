import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentRoot = path.join(siteRoot, 'src/content/docs');
const specsRoot = path.join(contentRoot, 'specs');
const featureGalleryPath = path.join(siteRoot, 'src/data/feature-gallery.json');
const roadmapPath = path.join(siteRoot, 'src/data/roadmap.json');
const errors = [];

function markdownFiles(directory) {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) return markdownFiles(fullPath);
		return /\.mdx?$/.test(entry.name) ? [fullPath] : [];
	});
}

function relative(file) {
	return path.relative(siteRoot, file);
}

function routeFor(file) {
	const parsed = path.parse(path.relative(contentRoot, file));
	const parts = parsed.dir.split(path.sep).filter(Boolean);
	if (parsed.name !== 'index') {
		parts.push(
			parsed.name
				.toLowerCase()
				.replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
				.replace(/\s/g, '-'),
		);
	}
	return `/${parts.join('/')}${parts.length ? '/' : ''}`;
}

function frontmatter(source) {
	const match = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
	if (!match) return null;

	return new Map(
		match[1]
			.split('\n')
			.map((line) => line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/))
			.filter(Boolean)
			.map((match) => [match[1], match[2].trim()]),
	);
}

const docs = markdownFiles(contentRoot);
const specs = markdownFiles(specsRoot);
const canonicalSpecCount = specs.filter((file) => /^Spec \d{2} —/.test(path.basename(file))).length;
const reviewedSpecStatusByRoute = new Map(
	specs
		.filter((file) => /^Spec \d{2} —/.test(path.basename(file)))
		.map((file) => [routeFor(file), frontmatter(fs.readFileSync(file, 'utf8'))?.get('status')]),
);
const routes = new Set(
	docs.map(routeFor),
);
routes.add('/changelog/');

const featureGallery = JSON.parse(fs.readFileSync(featureGalleryPath, 'utf8'));
for (const feature of featureGallery.features ?? []) {
	if (!Array.isArray(feature.specLinks) || feature.specLinks.length === 0) {
		errors.push(`feature ${feature.slug ?? '<unknown>'} has no governing spec links`);
		continue;
	}

	for (const specLink of feature.specLinks) {
		if (!specLink.label || !specLink.href) {
			errors.push(`feature ${feature.slug} has an incomplete governing spec link`);
		} else if (!routes.has(specLink.href)) {
			errors.push(`feature ${feature.slug} links to unknown spec route ${specLink.href}`);
		}
	}
}

if (!fs.existsSync(roadmapPath)) {
	console.error('Documentation content check failed: roadmap data is missing; run pnpm roadmap:generate.');
	process.exit(1);
}

const roadmap = JSON.parse(fs.readFileSync(roadmapPath, 'utf8'));
const roadmapStatuses = new Set(['shipped', 'follow-up', 'in-progress', 'planned']);
const roadmapIds = new Set();
if (roadmap.schemaVersion !== 1) errors.push('roadmap data has an unsupported schema version');
if (!Number.isFinite(Date.parse(roadmap.generatedAt))) {
	errors.push('roadmap data has an invalid generatedAt timestamp');
}
if (!Array.isArray(roadmap.specs) || roadmap.specs.length !== canonicalSpecCount) {
	errors.push(
		`roadmap data must contain all ${canonicalSpecCount} canonical specs, found ${roadmap.specs?.length ?? 0}`,
	);
} else {
	for (const spec of roadmap.specs) {
		if (roadmapIds.has(spec.id)) errors.push(`roadmap data repeats spec id ${spec.id}`);
		roadmapIds.add(spec.id);
		if (!routes.has(spec.route)) errors.push(`roadmap spec ${spec.id} uses unknown route ${spec.route}`);
		if (!roadmapStatuses.has(spec.status)) {
			errors.push(`roadmap spec ${spec.id} has unknown status ${spec.status}`);
		}

		const reviewedStatus = reviewedSpecStatusByRoute.get(spec.route);
		const allowedProjection = {
			shipped: new Set(['shipped', 'follow-up']),
			'in-progress': new Set(['in-progress', 'follow-up']),
			draft: new Set(['planned', 'in-progress', 'follow-up']),
		}[reviewedStatus];
		if (allowedProjection && !allowedProjection.has(spec.status)) {
			errors.push(
				`roadmap spec ${spec.id} status ${spec.status} contradicts reviewed status ${reviewedStatus}`,
			);
		}
	}
}
const roadmapTotal = Object.values(roadmap.summary ?? {}).reduce((total, count) => total + count, 0);
if (roadmapTotal !== roadmap.specs?.length) {
	errors.push(`roadmap summary totals ${roadmapTotal}, expected ${roadmap.specs?.length ?? 0}`);
}

for (const file of docs) {
	const source = fs.readFileSync(file, 'utf8');
	if (source.includes('[[')) {
		errors.push(`${relative(file)} contains an Obsidian wikilink`);
	}
	if (/\/Users\/|~\/git\/|Knowledge-Platform/.test(source)) {
		errors.push(`${relative(file)} contains a private workspace path or name`);
	}

	if (/\]\(<[^>]+\.md(?:#[^>]*)?>\)/.test(source)) {
		errors.push(`${relative(file)} links to a source Markdown file instead of its site route`);
	}

	const internalLinks = [
		...source.matchAll(/\]\((\/[^)\s]+)\)/g),
		...source.matchAll(/href=["'](\/[^"']+)["']/g),
	];
	for (const match of internalLinks) {
		const target = match[1].split(/[?#]/)[0];
		if (!routes.has(target)) {
			errors.push(`${relative(file)} links to unknown docs route ${target}`);
		}
	}
}

for (const file of specs) {
	const metadata = frontmatter(fs.readFileSync(file, 'utf8'));
	if (!metadata) {
		errors.push(`${relative(file)} has no YAML frontmatter`);
		continue;
	}

	for (const key of ['title', 'type', 'project', 'created', 'status']) {
		if (!metadata.get(key)) errors.push(`${relative(file)} is missing frontmatter key ${key}`);
	}

	const allowedStatuses = path.basename(file) === 'index.md'
		? new Set(['active'])
		: new Set(['draft', 'in-progress', 'shipped']);
	if (metadata.get('status') && !allowedStatuses.has(metadata.get('status'))) {
		errors.push(
			`${relative(file)} has unsupported status ${metadata.get('status')}; expected ${[...allowedStatuses].join(', ')}`,
		);
	}
}

function normalizedIndexStatus(row) {
	const statusCell = row
		.split('|')
		.slice(1, -1)
		.map((cell) => cell.trim())[2];
	if (/\bshipped\b/i.test(statusCell)) return 'shipped';
	if (/\bfollow-up\b|\bin progress\b/i.test(statusCell)) return 'in-progress';
	if (/\bplanned\b|\bdraft\b/i.test(statusCell)) return 'draft';
	return null;
}

for (const tier of ['day-1', 'day-2']) {
	const indexFile = path.join(specsRoot, tier, 'index.md');
	const indexLines = fs.readFileSync(indexFile, 'utf8').split('\n');
	const canonical = specs.filter(
		(file) => path.dirname(file) === path.dirname(indexFile) && /^Spec \d{2} —/.test(path.basename(file)),
	);

	for (const file of canonical) {
		const route = routeFor(file);
		const rows = indexLines.filter((line) => line.startsWith('|') && line.includes(`](${route})`));
		if (rows.length !== 1) {
			errors.push(`${relative(file)} must appear exactly once in ${tier}/index.md; found ${rows.length}`);
			continue;
		}

		const indexedStatus = normalizedIndexStatus(rows[0]);
		const metadataStatus = frontmatter(fs.readFileSync(file, 'utf8')).get('status');
		if (!indexedStatus) {
			errors.push(`${tier}/index.md has no recognized status for ${route}`);
		} else if (indexedStatus !== metadataStatus) {
			errors.push(
				`${relative(file)} status ${metadataStatus} disagrees with ${tier}/index.md status ${indexedStatus}`,
			);
		}
	}
}

if (specs.length < 79) {
	errors.push(`expected at least 79 spec documents, found ${specs.length}`);
}

if (errors.length > 0) {
	console.error(`Documentation content check failed:\n- ${errors.join('\n- ')}`);
	process.exitCode = 1;
} else {
	console.log(`Documentation content check passed (${docs.length} pages, ${specs.length} specs).`);
}
