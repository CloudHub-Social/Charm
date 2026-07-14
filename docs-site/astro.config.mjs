// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://cloudhub-social.github.io',
	base: '/Charm',
	integrations: [
		starlight({
			title: 'Charm',
			tagline: 'A native Matrix client, rebuilt from the ground up.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/CloudHub-Social/Charm' },
			],
			editLink: {
				baseUrl: 'https://github.com/CloudHub-Social/Charm/edit/main/docs-site/',
			},
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
			],
		}),
	],
});
