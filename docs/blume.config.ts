import { defineConfig } from "blume";

export default defineConfig({
	title: "infra-ts",
	description:
		"Typed, live-reconciled infrastructure and config as code for TypeScript.",
	logo: "/logo.svg",
	favicon: "/icon.svg",
	content: {
		root: "content",
	},
	deployment: {
		site: "https://infra-ts.dev",
		output: "static",
	},
	github: {
		owner: "andrelandgraf",
		repo: "infra-ts",
		branch: "main",
		dir: "docs",
	},
	banner: {
		content: "infra-ts is early and moving fast.",
		dismissible: true,
		id: "early",
		link: {
			href: "https://www.npmjs.com/package/infra-ts",
			text: "npm",
		},
	},
	navbar: {
		links: [
			{
				href: "https://github.com/andrelandgraf/infra-ts",
				type: "github",
			},
		],
		primary: {
			href: "https://www.npmjs.com/package/infra-ts",
			label: "npm",
		},
	},
	footer: {
		socials: {
			github: "https://github.com/andrelandgraf/infra-ts",
			npm: "https://www.npmjs.com/package/infra-ts",
		},
		links: [
			{
				header: "Project",
				items: [
					{
						href: "https://github.com/andrelandgraf/infra-ts",
						label: "GitHub",
					},
					{ href: "https://www.npmjs.com/package/infra-ts", label: "npm" },
				],
			},
			{
				header: "Reference",
				items: [
					{ href: "/cli", label: "CLI" },
					{ href: "/standard", label: "Standard" },
				],
			},
		],
	},
	search: {
		provider: "orama",
	},
	ai: {
		llmsTxt: true,
	},
	seo: {
		robots: true,
		sitemap: true,
		structuredData: true,
	},
	theme: {
		accent: "oklch(0.58 0.18 250)",
		accentDark: "oklch(0.76 0.16 240)",
		action: "oklch(0.68 0.13 196)",
		backgroundDecoration: "grid",
		fonts: {
			body: "inter",
			display: "inter-tight",
			mono: "ibm-plex-mono",
		},
		mode: "dark",
		radius: "md",
	},
});
