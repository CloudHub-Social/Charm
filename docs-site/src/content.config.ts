import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { changelogsLoader } from 'starlight-changelogs/loader';
import { pageSiteGraphSchema } from 'starlight-site-graph/schema';

export const collections = {
	docs: defineCollection({ loader: docsLoader(), schema: docsSchema({ extend: pageSiteGraphSchema }) }),
	// GitHub provider, not keep-a-changelog: Knope's CHANGELOG.md header format
	// ("## 0.1.0 (2026-07-14)") doesn't match what the keep-a-changelog parser
	// expects and produced a malformed slug. Knope also publishes a real
	// GitHub Release on every `knope release`, so read from there instead —
	// canonical source, no format coupling to CHANGELOG.md's exact shape.
	changelogs: defineCollection({
		loader: changelogsLoader([
			{
				provider: 'github',
				base: 'changelog',
				owner: 'CloudHub-Social',
				repo: 'Charm',
				token: process.env.GH_TOKEN,
			},
		]),
	}),
};
