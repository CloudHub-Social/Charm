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
console.log(`Graph data loader generated (${Object.keys(graph).length} nodes).`);
