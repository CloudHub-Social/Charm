import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentRoot = path.join(siteRoot, 'src/content/docs');
const outputPath = path.join(siteRoot, 'src/data/roadmap.json');
const repository = process.env.GITHUB_REPOSITORY || 'CloudHub-Social/Charm';
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const generatedAt = process.env.ROADMAP_GENERATED_AT || new Date().toISOString();

function frontmatter(source) {
	const match = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
	if (!match) return new Map();

	return new Map(
		match[1]
			.split('\n')
			.map((line) => line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/))
			.filter(Boolean)
			.map((line) => [line[1], line[2].trim()]),
	);
}

function unquote(value) {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function routeFor(file, tier) {
	const name = path.parse(file).name
		.toLowerCase()
		.replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
		.replace(/\s/g, '-');
	return `/specs/${tier}/${name}/`;
}

function canonicalSpecs(tier) {
	const directory = path.join(contentRoot, 'specs', tier);
	return fs
		.readdirSync(directory)
		.filter((name) => /^Spec \d{2} —/.test(name) && name.endsWith('.md'))
		.map((name) => {
			const file = path.join(directory, name);
			const source = fs.readFileSync(file, 'utf8');
			const metadata = frontmatter(source);
			const number = Number(name.match(/^Spec (\d{2})/)[1]);
			return {
				id: `${tier}-${String(number).padStart(2, '0')}`,
				tier,
				number,
				title: unquote(metadata.get('title') || name.replace(/\.md$/, '')).replace(
					/^Charm 2\.0 Spec — /,
					'',
				),
				route: routeFor(name, tier),
				frontmatterStatus: metadata.get('status') || 'draft',
			};
		})
		.sort((left, right) => left.number - right.number);
}

function normalizeStatus(value) {
	const status = value.toLowerCase().replaceAll('*', '');
	if (/shipped|complete|merged|\bgo\b/.test(status)) return 'shipped';
	if (/progress|partial|active|implement/.test(status)) return 'in-progress';
	return 'planned';
}

function indexMetadata(tier) {
	const source = fs.readFileSync(path.join(contentRoot, 'specs', tier, 'index.md'), 'utf8');
	const metadata = new Map();

	for (const line of source.split('\n')) {
		if (!line.startsWith('|') || !line.includes(`](/specs/${tier}/`)) continue;
		const link = line.match(/\[[^\]]+\]\((\/specs\/(?:day-1|day-2)\/[^)]+\/)\)/);
		if (!link) continue;

		const cells = line
			.split('|')
			.slice(1, -1)
			.map((cell) => cell.trim());
		const statusCell = cells.find((cell) =>
			/shipped|complete|merged|\bgo\b|progress|partial|active|draft|unbuilt|not started/i.test(
				cell,
			),
		);
		const pullRequests = [...line.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
		const current = metadata.get(link[1]) || { statuses: [], pullRequests: [] };
		if (statusCell) current.statuses.push(normalizeStatus(statusCell));
		current.pullRequests.push(...pullRequests);
		current.pullRequests = [...new Set(current.pullRequests)];
		metadata.set(link[1], current);
	}

	return metadata;
}

async function github(pathname) {
	const response = await fetch(`https://api.github.com${pathname}`, {
		headers: {
			Accept: 'application/vnd.github+json',
			'User-Agent': 'charm-docs-roadmap',
			'X-GitHub-Api-Version': '2022-11-28',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
	});
	if (!response.ok) {
		throw new Error(`GitHub API ${response.status} for ${pathname}: ${await response.text()}`);
	}
	return response.json();
}

async function paginated(endpoint, limit = 10) {
	const items = [];
	for (let page = 1; page <= limit; page += 1) {
		const separator = endpoint.includes('?') ? '&' : '?';
		const batch = await github(`${endpoint}${separator}per_page=100&page=${page}`);
		items.push(...batch);
		if (batch.length < 100) break;
	}
	return items;
}

function mentionsSpec(item, spec) {
	const title = item.title || '';
	const body = item.body || '';
	if (body.includes(spec.route)) return true;

	const number = String(spec.number).padStart(2, '0');
	if (spec.tier === 'day-2') {
		const explicit = new RegExp(
			`day[-\\s]?2\\s+spec(?:ification)?\\s+0*${number}\\b`,
			'i',
		);
		return explicit.test(title) || explicit.test(body);
	}

	const titleReference = new RegExp(`\\bspec(?:ification)?\\s+0*${number}\\b`, 'i');
	const dayTwoTitleReference = new RegExp(
		`day[-\\s]?2\\s+spec(?:ification)?\\s+0*${number}\\b`,
		'i',
	);
	const explicitBodyReference = new RegExp(
		`day[-\\s]?1\\s+spec(?:ification)?\\s+0*${number}\\b`,
		'i',
	);
	return (
		(titleReference.test(title) && !dayTwoTitleReference.test(title)) ||
		explicitBodyReference.test(body)
	);
}

function specLabel(specId) {
	return specId.replace(/^day-([12])-(\d{2})$/, 'Day-$1 Spec $2');
}

function publicPullRequest(pullRequest) {
	return {
		number: pullRequest.number,
		title: pullRequest.title,
		url: pullRequest.html_url,
		state: pullRequest.merged_at ? 'merged' : pullRequest.state,
		draft: Boolean(pullRequest.draft),
		updatedAt: pullRequest.updated_at,
	};
}

function publicIssue(issue) {
	return {
		number: issue.number,
		title: issue.title,
		url: issue.html_url,
		updatedAt: issue.updated_at,
		labels: issue.labels
			.map((label) => (typeof label === 'string' ? label : label.name))
			.filter(Boolean),
	};
}

function finalStatus(baseline, pullRequests, issues) {
	const hasMerged = pullRequests.some((pullRequest) => pullRequest.state === 'merged');
	const hasOpen = pullRequests.some((pullRequest) => pullRequest.state === 'open');
	if (hasOpen) return hasMerged || baseline === 'shipped' ? 'follow-up' : 'in-progress';
	if (issues.length > 0 && (hasMerged || baseline === 'shipped')) return 'follow-up';
	if (hasMerged || baseline === 'shipped') return 'shipped';
	return baseline;
}

function statusCounts(specs) {
	return specs.reduce(
		(counts, spec) => {
			counts[spec.status] += 1;
			return counts;
		},
		{ shipped: 0, 'follow-up': 0, 'in-progress': 0, planned: 0 },
	);
}

function issuePriority(issue) {
	const labels = issue.labels.map((label) => (typeof label === 'string' ? label : label.name || ''));
	if (labels.some((label) => /critical|blocker|p0/i.test(label))) return 0;
	if (labels.some((label) => /high|p1|regression|sentry/i.test(label))) return 1;
	if (labels.some((label) => /bug/i.test(label))) return 2;
	return 3;
}

const specs = [...canonicalSpecs('day-1'), ...canonicalSpecs('day-2')];
const indexByTier = {
	'day-1': indexMetadata('day-1'),
	'day-2': indexMetadata('day-2'),
};
const [allPullRequests, allIssues] = await Promise.all([
	paginated(`/repos/${repository}/pulls?state=all&sort=updated&direction=desc`),
	paginated(`/repos/${repository}/issues?state=open&sort=updated&direction=desc`, 3),
]);

const issues = allIssues.filter((issue) => !issue.pull_request);
const hydratedSpecs = specs.map((spec) => {
	const index = indexByTier[spec.tier].get(spec.route) || { statuses: [], pullRequests: [] };
	const baselineStatuses = [normalizeStatus(spec.frontmatterStatus), ...index.statuses];
	const baseline = baselineStatuses.includes('shipped')
		? 'shipped'
		: baselineStatuses.includes('in-progress')
			? 'in-progress'
			: 'planned';
	const pullRequests = allPullRequests
		.filter(
			(pullRequest) =>
				index.pullRequests.includes(pullRequest.number) || mentionsSpec(pullRequest, spec),
		)
		.map(publicPullRequest)
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	const linkedIssues = issues
		.filter((issue) => mentionsSpec(issue, spec))
		.map(publicIssue)
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

	return {
		id: spec.id,
		tier: spec.tier,
		number: spec.number,
		title: spec.title,
		route: spec.route,
		status: finalStatus(baseline, pullRequests, linkedIssues),
		pullRequests,
		issues: linkedIssues,
	};
});

const openSpecPulls = hydratedSpecs
	.flatMap((spec) =>
		spec.pullRequests
			.filter((pullRequest) => pullRequest.state === 'open')
			.map((pullRequest) => ({ ...pullRequest, specId: spec.id })),
	)
	.filter(
		(pullRequest, index, items) =>
			items.findIndex((candidate) => candidate.number === pullRequest.number) === index,
	)
	.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

const linkedIssueNumbers = new Set(hydratedSpecs.flatMap((spec) => spec.issues.map((issue) => issue.number)));
const openIssues = issues
	.filter((issue) => linkedIssueNumbers.has(issue.number) || issuePriority(issue) < 3)
	.sort(
		(left, right) =>
			issuePriority(left) - issuePriority(right) || right.updated_at.localeCompare(left.updated_at),
	);

const attention = [
	...openSpecPulls.slice(0, 4).map((pullRequest) => ({
		type: 'pull-request',
		number: pullRequest.number,
		title: pullRequest.title,
		url: pullRequest.url,
		detail: `${specLabel(pullRequest.specId)} · ${pullRequest.draft ? 'draft' : 'ready for review'}`,
	})),
	...openIssues.slice(0, 4).map((issue) => ({
		type: 'issue',
		number: issue.number,
		title: issue.title,
		url: issue.html_url,
		detail: issue.labels
			.map((label) => (typeof label === 'string' ? label : label.name))
			.filter(Boolean)
			.slice(0, 3)
			.join(' · '),
	})),
].slice(0, 6);

const workstreams = [
	{
		id: 'foundation',
		label: 'Foundation',
		description: 'Original Day-1 and post-Day-1 specs 01–27.',
		specIds: hydratedSpecs
			.filter((spec) => spec.tier === 'day-1' && spec.number <= 27)
			.map((spec) => spec.id),
	},
	{
		id: 'parity',
		label: 'Parity and platform depth',
		description: 'Day-1 parity, native integration, and product-depth specs 28–62.',
		specIds: hydratedSpecs
			.filter((spec) => spec.tier === 'day-1' && spec.number >= 28)
			.map((spec) => spec.id),
	},
	{
		id: 'day-2',
		label: 'Day 2',
		description: 'Independent power-user and administration capabilities.',
		specIds: hydratedSpecs.filter((spec) => spec.tier === 'day-2').map((spec) => spec.id),
	},
].map((workstream) => ({
	...workstream,
	counts: statusCounts(hydratedSpecs.filter((spec) => workstream.specIds.includes(spec.id))),
}));

const output = {
	schemaVersion: 1,
	repository,
	generatedAt,
	source: 'GitHub pull requests, prioritized issues, and repository-native specs',
	summary: statusCounts(hydratedSpecs),
	attention,
	workstreams,
	specs: hydratedSpecs,
};

fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(
	`Roadmap generated (${hydratedSpecs.length} specs, ${allPullRequests.length} PRs scanned, ${attention.length} attention items).`,
);
