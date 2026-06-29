# @infra-ts/vercel

The [infra-ts](https://github.com/neon-solutions/infra-ts) provider for **Vercel**. A
thin, typed wrapper around the Vercel REST API that provisions a Vercel project, reconciles its
**project settings** (build/dev/install commands, output & root dir, node version, function
region, skew protection, …), **custom domains**, and **environment variables** — and can wire in
another provider's outputs (e.g. Neon's `DATABASE_URL`) via typed `Ref`s.

```ts
import { vercel } from "@infra-ts/vercel"; // or `infra-ts/vercel`

vercel({
	team: "team_…",
	project: { name: "my-app", framework: "nextjs" },
	settings: {
		buildCommand: "next build",
		nodeVersion: "20.x",
		outputDirectory: ".next",
	},
	domains: ["app.example.com"],
	env: { DATABASE_URL: db.outputs.databaseUrl },
});
```

Credentials resolve from `VERCEL_TOKEN` or the Vercel CLI's cached token. Settings drift is
reconciled via PATCH; env vars and domains are additive (create + update; never delete unmanaged).
Env keys: `VERCEL_PROJECT_ID`, `VERCEL_PROJECT_NAME`.

**Out of scope (by design):** Web Analytics / Speed Insights aren't in Vercel's public REST API,
so they're not supported here; deployments are left to `vercel deploy` / the git integration.
