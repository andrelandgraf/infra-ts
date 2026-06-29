# @infra-ts/neon

The [infra-ts](https://github.com/neon-solutions/infra-ts) provider for **Neon**. A thin,
typed wrapper around the Neon management REST API that provisions a Neon project, the default
branch's compute (autoscaling + scale-to-zero) and TTL, the **Neon Auth** and **Data API**
integrations, and **experimental** Neon platform features (AI Gateway, object-storage buckets,
and deployed functions — bundled with esbuild). The typed env (`env.neon`) grows with the
services you enable.

```ts
import { neon } from "@infra-ts/neon"; // or `infra-ts/neon`

neon({
	org: "org-…",
	project: { name: "my-app", region: "aws-us-east-1" },
	branch: {
		compute: { minCu: 0.25, maxCu: 1, suspendTimeout: "5m" },
		ttl: "30d",
	},
	auth: true, // env.neon.authBaseUrl / authJwksUrl
	dataApi: true, // env.neon.dataApiUrl
	experimental: {
		// Neon private-preview (region/account-gated)
		aiGateway: true, // env.neon.aiGatewayApiKey / aiGatewayBaseUrl
		buckets: { uploads: { access: "private" } },
		functions: { hello: { name: "Hello", source: "./functions/hello.ts" } },
	},
});
```

Credentials resolve from `NEON_API_KEY` or the `neonctl` OAuth token. Base env keys:
`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEON_BRANCH`, `NEON_PROJECT_ID` (plus `NEON_AUTH_*`,
`NEON_DATA_API_URL`, `NEON_AI_GATEWAY_*` once you enable those services). `auth` and `dataApi` are
GA; experimental features are Neon private-preview and surface a clear "unavailable" error where
not yet enabled.
