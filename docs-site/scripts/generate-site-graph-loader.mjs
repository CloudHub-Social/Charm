import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const graphPath = path.join(siteRoot, 'dist/sitegraph/sitemap.json');
const loaderPath = path.join(siteRoot, 'dist/sitegraph/sitemap.js');

if (!fs.existsSync(graphPath)) {
	console.error('Graph loader generation failed: run astro build before generating the loader.');
	process.exit(1);
}

const graphSource = fs.readFileSync(graphPath, 'utf8');
const graph = JSON.parse(graphSource);
const sourceHash = createHash('sha256').update(graphSource).digest('hex');
const compactGraph = Object.fromEntries(
	Object.entries(graph).map(([route, node]) => [
		route,
		{
			...node,
			// The full titles remain on their pages and in backlinks. The canvas
			// benefits from dropping the repeated migration-era title prefix.
			title: node.title
				?.replace(/^Charm 2\.0 Spec(?: \d+)? — /, '')
				.replace(/^Charm 2\.0 — /, ''),
		},
	]),
);
const loader = `// Generated from sitemap.json; source-sha256: ${sourceHash}
(() => {
	const sitemap = ${JSON.stringify(compactGraph)};
	const serialized = JSON.stringify(sitemap);
	document.querySelectorAll('graph-component[data-sitemap="{}"]')
		.forEach((component) => {
			const config = JSON.parse(component.getAttribute('data-config') ?? '{}');
			Object.assign(config, {
				// Dense or fullscreen graphs should read as a map first. Labels
				// become fully legible on hover or after zooming in.
				labelOpacityScale: 1,
				labelMutedOpacity: 0,
				labelHoverOpacity: 1,
				labelAdjacentOpacity: 0.55,
				labelFontSize: 11,
			});
			component.setAttribute('data-config', JSON.stringify(config));
			component.setAttribute('data-sitemap', serialized);
		});
})();
`;

fs.writeFileSync(loaderPath, loader);
const loaderHash = createHash('sha256').update(loader).digest('hex').slice(0, 12);
const versionedLoaderPath = `/sitegraph/sitemap.js?v=${loaderHash}`;
const pendingDirectories = [path.join(siteRoot, 'dist')];
let updatedPages = 0;

while (pendingDirectories.length > 0) {
	const directory = pendingDirectories.pop();
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			pendingDirectories.push(entryPath);
			continue;
		}
		if (!entry.name.endsWith('.html')) continue;

		const html = fs.readFileSync(entryPath, 'utf8');
		const versionedHtml = html.replaceAll(
			'src="/sitegraph/sitemap.js"',
			`src="${versionedLoaderPath}"`,
		);
		if (versionedHtml === html) continue;

		fs.writeFileSync(entryPath, versionedHtml);
		updatedPages += 1;
	}
}

if (updatedPages === 0) {
	console.error('Graph loader generation failed: no generated pages referenced the loader.');
	process.exit(1);
}

console.log(
	`Graph data loader generated (${Object.keys(graph).length} nodes, ${updatedPages} versioned pages).`,
);
