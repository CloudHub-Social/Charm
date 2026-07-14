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
const loader = `// Generated from sitemap.json; source-sha256: ${sourceHash}
(() => {
	const sitemap = ${JSON.stringify(graph)};
	const serialized = JSON.stringify(sitemap);
	document.querySelectorAll('graph-component[data-sitemap="{}"]')
		.forEach((component) => component.setAttribute('data-sitemap', serialized));
})();
`;

fs.writeFileSync(loaderPath, loader);
console.log(`Graph data loader generated (${Object.keys(graph).length} nodes).`);
