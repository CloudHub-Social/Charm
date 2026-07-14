import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const graphPath = path.join(siteRoot, 'dist/sitegraph/sitemap.json');
const assetsPath = path.join(siteRoot, 'dist/_astro');
const galleryPath = path.join(siteRoot, 'src/data/feature-gallery.json');
const roadmapPath = path.join(siteRoot, 'src/data/roadmap.json');
const errors = [];

if (!fs.existsSync(graphPath)) {
	console.error('Site graph check failed: run pnpm build before pnpm check:graph.');
	process.exit(1);
}

for (const [file, description] of [
	[galleryPath, 'feature gallery data'],
	[roadmapPath, 'roadmap data'],
]) {
	if (!fs.existsSync(file)) {
		console.error(`Site graph check failed: ${description} is missing.`);
		process.exit(1);
	}
}

const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
const gallery = JSON.parse(fs.readFileSync(galleryPath, 'utf8'));
const roadmap = JSON.parse(fs.readFileSync(roadmapPath, 'utf8'));
const internalPath = (href) => href.replace(/^\//, '').split(/[?#]/)[0];

const graphBundles = fs.existsSync(assetsPath)
	? fs.readdirSync(assetsPath).filter((filename) => /^Graph\..+\.js$/.test(filename))
	: [];

if (graphBundles.length === 0) {
	errors.push('generated graph client bundle is missing');
}

for (const filename of graphBundles) {
	const source = fs.readFileSync(path.join(assetsPath, filename), 'utf8');
	if (/\bprocess\.(?:platform|version)\b/.test(source)) {
		errors.push(`${filename} contains Node-only process globals and will fail in the browser`);
	}
}

for (const [route, node] of Object.entries(graph)) {
	if (!node.external && node.exists === false) {
		errors.push(`generated broken internal node ${route}`);
	}
}

const requiredBridges = new Map([
	['product/roadmap/', roadmap.specs.map((spec) => internalPath(spec.route))],
	[
		'operations/sentry/',
		[
			'specs/day-1/spec-21--sentry-observability-error-monitoring-tracing-replay-logs/',
			'features/maintaining/',
		],
	],
	[
		'operations/web-server/',
		[
			'specs/day-1/spec-16--web-client-via-companion-matrix-server/',
			'operations/cloudflare-previews/',
		],
	],
	[
		'operations/cloudflare-previews/',
		[
			'specs/day-1/spec-24--build-and-release-identification-short-sha-pr-previews/',
			'contributing/ci-tiers/',
		],
	],
	[
		'contributing/feature-flags/',
		[
			'specs/day-1/spec-35--feature-flags-openfeature--sentry-evaluation-tracking/',
			'features/',
		],
	],
]);

for (const feature of gallery.features ?? []) {
	for (const specLink of feature.specLinks ?? []) {
		requiredBridges.set('features/', [
			...(requiredBridges.get('features/') ?? []),
			internalPath(specLink.href),
		]);
	}
}

for (const [source, targets] of requiredBridges) {
	const node = graph[source];
	if (!node?.exists) {
		errors.push(`required graph source ${source} does not exist`);
		continue;
	}

	const links = new Set(node.links ?? []);
	for (const target of new Set(targets)) {
		if (!links.has(target)) errors.push(`${source} is missing required graph edge to ${target}`);
	}
}

if (errors.length > 0) {
	console.error(`Site graph check failed:\n- ${errors.join('\n- ')}`);
	process.exitCode = 1;
} else {
	console.log(
		`Site graph check passed (${Object.keys(graph).length} nodes, ${requiredBridges.size} guarded bridge pages).`,
	);
}
