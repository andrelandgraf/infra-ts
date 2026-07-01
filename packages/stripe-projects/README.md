# @infra-ts/stripe-projects

Declare infrastructure that **[Stripe Projects](https://projects.dev)** provisions across
providers, instead of going to each provider individually — as typed infra-ts entities.

These entities **compose the Stripe CLI** (`stripe projects …`) rather than a REST API:

- **Identity is the declared entity `name`** (`stripe projects add … --name <name>`).
- **Live truth** comes from `stripe projects status --json` — nothing is persisted to
  `.infra`. Stripe Projects' own `.projects/` manifest stays its own business.
- **No captured credentials** — auth is your local Stripe CLI session.

```ts
import { defineInfra } from "infra-ts";
import {
	NeonPostgres,
	UpstashRedis,
	StripeProjectsService,
} from "infra-ts/stripe-projects";

const db = new NeonPostgres({ name: "db", tier: "launch" });
const cache = new UpstashRedis({ name: "cache" });
const search = new StripeProjectsService({
	name: "search",
	provider: "algolia",
	service: "application",
	exposes: ["algoliaAppId", "algoliaApiKey"],
});

export default defineInfra({ entities: [db, cache, search] });
```

Requires the Stripe CLI and the `projects` plugin
(`brew install stripe/stripe-cli/stripe && stripe plugin install projects`); the infra-ts
engine detects and offers to install them.

See the repo's `DESIGN.md` for the composition model behind this provider.
