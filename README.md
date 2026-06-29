# infra-ts

**Typed, live-reconciled infrastructure & config as code — an open standard.**

infra-ts is what you get if you take [`neon.ts`](https://neon.com/blog/introducing-neon-ts) (Neon's
branch config + infrastructure-as-code file) and generalize it into an open standard that any
provider can implement. You declare your infrastructure as **typed entities** in a single
`infra.ts` file, `infra-ts apply` reconciles them against live REST APIs, and everything stays
**fully typed** with **no attribute-state backend** — just TypeScript.

```ts
// infra.ts
import { defineInfra } from "infra-ts";
import { NeonProject, NeonPostgres } from "infra-ts/neon";
import { VercelProject } from "infra-ts/vercel";

const project = new NeonProject({ name: "my-app", region: "aws-us-east-1" });
const db = new NeonPostgres({ name: "my-db", projectId: project.id });

export default defineInfra({
	entities: [
		project,
		db,
		new VercelProject({
			name: "my-app",
			framework: "nextjs",
			// Typed cross-entity wiring: Neon's connection string → a Vercel env var.
			env: { DATABASE_URL: db.env.databaseUrl },
		}),
	],
});
```

```bash
infra-ts plan      # show what would change (dry run, no mutations)
infra-ts apply     # provision everything, wire env, write .env.<env>
infra-ts status    # live state of every entity
infra-ts destroy   # tear it all down
```

---

## Why infra-ts

IaC is a beautiful idea with one persistent wart: **state**. Terraform and Pulumi keep a
stateful snapshot of your resources that drifts from reality and has to be reconciled, locked,
and stored somewhere. SST is lovely but wraps Pulumi, so it inherits the same state engine.

infra-ts takes the opposite bet:

- **No attribute state — identity state only.** infra-ts never stores resource attributes. The
  only thing it persists is a tiny `.infra.<env>` _identity link file_ that maps each entity to its
  remote id (like `.vercel` or `.neon`). Every command re-reads live state from the provider's API
  and diffs against your `infra.ts`. There is no attribute-state store to drift, lock, or corrupt —
  the remote API _is_ the source of truth.
- **Typed.** Your infrastructure is plain TypeScript. Entity options, the resolved environment,
  and cross-entity wiring are all type-checked. Misconfigurations are compile errors, not runtime
  surprises — for you and your coding agents.
- **An open standard.** An entity is a thin, typed wrapper around a REST resource implementing one
  small [`Entity`](#authoring-an-entity) contract. Shipping support for a new platform means
  publishing a `@infra-ts/<name>` package — no fork of infra-ts required.

|               | Terraform / Pulumi      | SST                      | **infra-ts**                       |
| ------------- | ----------------------- | ------------------------ | ---------------------------------- |
| Language      | HCL / general           | TS (wraps Pulumi)        | **TS (native)**                    |
| State         | attribute-state backend | attribute state (Pulumi) | **identity state only (live API)** |
| Config file   | `*.tf` / `Pulumi.ts`    | `sst.config.ts`          | **`infra.ts`**                     |
| Local pointer | state backend           | Pulumi stack             | **`.infra.<env>` link file**       |
| Extensibility | providers (Go plugins)  | Pulumi providers         | **`@infra-ts/*` REST wrappers**    |

> **Identity state, not attribute state:** infra-ts keeps a per-environment `.infra.<env>` pointer
> (entity → remote id) so it knows _which_ remote resource each entity maps to. That file holds
> **bindings, never resource attributes** — the live remote is the source of truth. The reconciler
> itself is stateless.

---

## Install

```bash
npm i -g infra-ts     # or: bun add -g infra-ts
# or run ad-hoc:
npx infra-ts --help
bunx infra-ts --help
```

infra-ts resolves provider credentials from environment variables or the CLIs you already have
authenticated (see [each provider](#providers)). For example:

- **Neon** — `NEON_API_KEY`, or the OAuth token cached by `neonctl auth`.
- **Vercel** — `VERCEL_TOKEN`, or the token cached by `vercel login`.

## Quickstart

```bash
infra-ts init                 # scaffold an infra.ts
# edit infra.ts: declare your entities
infra-ts plan                 # preview the changes
infra-ts apply                # provision everything + write .env.local
infra-ts status               # inspect live state
```

---

## Concepts

### `infra.ts`

The config file (think `vite.config.ts`, but for your infrastructure). It default-exports
`defineInfra({ entities: [...] })`. infra-ts searches upward from the current directory for it
(`infra.ts`, `infra.config.ts`).

### Entities

Every provisionable resource is an **entity** — a class instance like `new NeonPostgres({...})`.
An entity is a thin, typed wrapper around a REST resource that knows how to `read`, `diff`,
`provision`, `pullEnv`, and `deprovision` itself. You list them in `defineInfra({ entities })`;
infra-ts builds a dependency graph and reconciles them in the right order.

### Dependencies & refs

Entities expose typed **output references**:

- `entity.id` — a `Ref<string>` for the resource id.
- `entity.env.<field>` — a `Ref<string>` for each declared env output.

Hand one entity's ref to another and infra-ts (a) records an edge in the dependency graph and (b)
resolves it to the real value at apply time — fully typed, order-independent:

```ts
const project = new NeonProject({ name: "app" });
const db = new NeonPostgres({ name: "db", projectId: project.id }); // depends on project
new VercelProject({ name: "app", env: { DATABASE_URL: db.env.databaseUrl } }); // depends on db
```

Entities form a DAG that infra-ts topologically sorts; a cycle is a hard error. Use `deps: [other]`
to force ordering without a data dependency.

### Environments

Every command targets a named **environment** (`local` by default), selected by
`--env`/`-e`, then `INFRA_ENV`, then `defaultEnvironment` in your config, then `local`. The
environment selects the state file (`.infra.<env>`), the env file (`.env.<env>`), and which
credentials to use. infra-ts deliberately does **not** use `NODE_ENV`.

> **Invariant:** an entity's _set_ of env keys is static across environments; only the _values_
> change. This keeps `parseEnv` types identical everywhere.

### The `.infra.<env>` link file

A small, git-ignored JSON file written at your project root, one per environment:

```json
{
	"version": 1,
	"environment": "local",
	"entities": {
		"my-app": { "id": "wandering-frost-12345678" },
		"my-db": { "id": "br-…" },
		"my-app-web": { "id": "prj_…" }
	}
}
```

It's just **bindings** — the ids that tie each entity to a concrete remote resource. Delete it and
`infra-ts apply` creates fresh resources; commit nothing here.

### Typed env mapping

Each entity declares env outputs with **logical camelCase keys** (`databaseUrl`). On disk they map
to **CONSTANT_CASE** OS vars (`DATABASE_URL`) by default. Override per entity with `envNames`:

```ts
new NeonPostgres({
	name: "db",
	projectId: project.id,
	envNames: { databaseUrl: "POSTGRES_URL" }, // → POSTGRES_URL instead of DATABASE_URL
});
```

If two entities would write the **same OS key**, `defineInfra` throws an env-collision error at
load time — fix it with an `envNames` rename.

### `parseEnv` — runtime, network-free

At app boot, validate `process.env` against your entities' env schemas and get back a typed,
namespaced object — synchronous, no network:

```ts
import infra from "./infra";
import { parseEnv } from "infra-ts";

const env = parseEnv(infra);
env["my-db"].databaseUrl; // string
// throws InfraError listing every missing OS var
```

### Lifecycle hooks

Per-entity imperative side effects bracketing `provision` (and `checkout`). A hook is a function
or a shell command (or a list); `after` hooks receive the **exact typed env**.

```ts
new NeonPostgres({
	name: "db",
	projectId: project.id,
	hooks: {
		provision: {
			before: "echo migrating",
			after: ({ env }) => migrate(env.databaseUrl),
		},
	},
});
```

Shell hooks run **non-interactively** (stdin detached, `CI=1` set) with the resolved env injected.

### Renames

Renaming an entity's `name` would otherwise orphan its remote resource. Declare a rename to migrate
the binding in place:

```ts
defineInfra({
	entities: [
		/* … */
	],
	renames: [{ old: "my-old-db", new: "my-db" }],
});
```

---

## CLI reference

All commands accept these global options:

| Option                    | Description                                             |
| ------------------------- | ------------------------------------------------------- |
| `-C, --cwd <dir>`         | Run as if started in `<dir>`.                           |
| `--config <path>`         | Explicit path to an `infra.ts`.                         |
| `-e, --env <environment>` | Target environment (default `local`; also `INFRA_ENV`). |
| `--only <ids...>`         | Limit the command to these entity ids.                  |
| `--json`                  | Machine-readable JSON output.                           |
| `--verbose`               | Print debug logging.                                    |

| Command                             | Description                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `infra-ts init`                     | Scaffold an `infra.ts` in the current directory.                                       |
| `infra-ts plan`                     | Show the changes `apply` would make (dry run; no mutations, no state writes).          |
| `infra-ts apply [--prune]`          | Reconcile remote to `infra.ts`, persist `.infra.<env>`, write `.env.<env>`, run hooks. |
| `infra-ts status`                   | Print the live state of every entity (exists + pending drift).                         |
| `infra-ts checkout [--ignore-diff]` | Pull typed env from the live remote into `.env.<env>` (errors on drift).               |
| `infra-ts destroy [-y]`             | Tear down every entity (destructive; reverse dependency order).                        |
| `infra-ts run -- <cmd>`             | Inject the resolved env into a child command (nothing written to disk).                |

Examples:

```bash
infra-ts apply --json | jq '.changes'
infra-ts apply -e production           # target the production environment
infra-ts apply --only my-db            # reconcile just one entity
infra-ts run -- npm run dev            # run your dev server with the resolved env injected
infra-ts destroy --yes                 # non-interactive teardown
```

---

## SDK reference

Everything the CLI does is a function. Import from `infra-ts` (umbrella) or the individual
`@infra-ts/*` packages. The umbrella re-exports all of `@infra-ts/core` and `@infra-ts/runtime`.

### Config

```ts
import { defineInfra, type Infra } from "infra-ts";

const infra = defineInfra({
	entities: [/* … */],     // required, non-empty, unique names
	defaultEnvironment: "local",
	renames: [{ old, new }],
});
```

`defineInfra` validates everything up front: unique ids, no dependency cycles, no OS env-key
collisions. It returns a frozen `Infra` with `entities`, `ordered` (topologically sorted),
`defaultEnvironment`, and `renames`.

### Engine

```ts
import { plan, apply, status, checkout, destroy, parseEnv, toEntries } from "infra-ts";

await plan(infra, options);     // { environment, changes }
await apply(infra, options);    // { environment, changes, env, envFile?, envKeysWritten, orphans }
await status(infra, options);   // { environment, entities: [{ name, exists, changes }] }
await checkout(infra, options); // { environment, env, envFile?, envKeysWritten, drift }
await destroy(infra, options);  // { environment, changes }
parseEnv(infra, env?);          // InfraEnv — sync, validates process.env
toEntries(infra, env);          // InfraEnv → { OS_KEY: value } (the .env projection)
```

`options` (`EngineOptions` / `ApplyOptions` / `CheckoutOptions`):
`{ rootDir?, environment?, logger?, only?, writeEnv? , ignoreDiff?, prune? }`.

- `apply` / `checkout` write `.env.<env>` (disable with `writeEnv: false`). `apply` writes state
  incrementally and runs each entity's `provision` hooks.
- `checkout` re-reads the live remote and refuses to overwrite your env if it has drifted from
  config, unless `ignoreDiff: true`.
- `parseEnv` is the **synchronous, network-free** reader for app bootstrap; throws `InfraError`
  listing every missing OS var.

### Config loading & state

```ts
import { loadConfig, readState, writeState, applyRenames } from "infra-ts";

const { infra, rootDir, configPath } = await loadConfig({ cwd, configPath });
const state = readState(rootDir, "local");
```

### Errors & logging

```ts
import {
	InfraError,
	ErrorCode,
	isInfraError,
	consoleLogger,
	silentLogger,
} from "infra-ts";
```

`InfraError` carries a stable `code` (see `ErrorCode`) and structured `details`, so you (and
agents) can branch on failures programmatically.

---

## Providers

Each provider is a `@infra-ts/<name>` package, re-exported from the umbrella as `infra-ts/<name>`.
Entities resolve credentials from environment variables (or a provider CLI cache) and never persist
them in state.

### `infra-ts/neon` — Neon Postgres

Credentials: `NEON_API_KEY` or the `neonctl` OAuth cache.

| Entity         | Manages                                                             | Env outputs (→ OS var)                                                         |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `NeonProject`  | the project, default-branch compute (autoscale/scale-to-zero) + TTL | _none_ (exposes `.id` for wiring)                                              |
| `NeonPostgres` | a database/role on the project's branch                             | `databaseUrl`, `databaseUrlUnpooled` → `DATABASE_URL`, `DATABASE_URL_UNPOOLED` |
| `NeonAuth`     | the Neon Auth integration                                           | `authBaseUrl`, `authJwksUrl` → `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL`      |
| `NeonDataApi`  | the Neon Data API (PostgREST)                                       | `dataApiUrl` → `NEON_DATA_API_URL`                                             |

```ts
import {
	NeonProject,
	NeonPostgres,
	NeonAuth,
	NeonDataApi,
} from "infra-ts/neon";

const project = new NeonProject({
	org: "org-…", // omit → personal account
	name: "app",
	region: "aws-us-east-1",
	pgVersion: 17,
	compute: { minCu: 0.25, maxCu: 1, suspendTimeout: "5m" },
	ttl: "30d", // branch auto-expiry (duration string or seconds)
});
const db = new NeonPostgres({
	name: "app-db",
	projectId: project.id,
	database: "app",
	role: "app",
});
const auth = new NeonAuth({ name: "app-auth", projectId: project.id });
const dataApi = new NeonDataApi({ name: "app-data", projectId: project.id });
```

### `infra-ts/vercel` — Vercel

Credentials: `VERCEL_TOKEN` or the `vercel` CLI cache. Pass `team` (id or slug) for team scope.

| Entity             | Manages                                                                                                                                        | Env outputs (→ OS var)                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `VercelProject`    | the project, full **settings** (build/dev/install, node version, region, …) as drift, **env vars** (additive + update), and **custom domains** | `projectId`, `projectName` → `VERCEL_PROJECT_ID`, `VERCEL_PROJECT_NAME` |
| `VercelEdgeConfig` | an Edge Config store + its items (idempotent upsert)                                                                                           | `edgeConfigId` → `EDGE_CONFIG_ID`                                       |
| `VercelWebhook`    | a project/account webhook                                                                                                                      | `webhookId` → `WEBHOOK_ID`                                              |

```ts
import {
	VercelProject,
	VercelEdgeConfig,
	VercelWebhook,
} from "infra-ts/vercel";

new VercelProject({
	team: "team_…",
	name: "app",
	framework: "nextjs",
	settings: {
		buildCommand: "next build",
		installCommand: "npm ci",
		nodeVersion: "20.x",
	},
	domains: ["app.example.com"],
	env: { DATABASE_URL: db.env.databaseUrl },
	envTargets: ["production", "preview", "development"],
});
new VercelEdgeConfig({
	name: "app-flags",
	slug: "app-flags",
	items: { newUi: true },
});
```

> **Out of scope (by design):** Web Analytics / Speed Insights toggles aren't in Vercel's public
> REST API, and deployments are a build concern (left to Vercel's own tooling).

### `infra-ts/upstash` — Upstash

`UpstashRedis`/`UpstashVector` use the developer API (HTTP basic `UPSTASH_EMAIL`:`UPSTASH_API_KEY`);
`UpstashQStashQueue` uses the QStash API (`QSTASH_TOKEN`).

| Entity               | Env outputs (→ OS var)                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `UpstashRedis`       | `upstashRedisRestUrl`, `upstashRedisRestToken`, `redisUrl` → `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `REDIS_URL` |
| `UpstashVector`      | `upstashVectorRestUrl`, `upstashVectorRestToken` → `UPSTASH_VECTOR_REST_URL`, `UPSTASH_VECTOR_REST_TOKEN`                      |
| `UpstashQStashQueue` | `qstashQueueName` → `QSTASH_QUEUE_NAME`                                                                                        |

```ts
import {
	UpstashRedis,
	UpstashVector,
	UpstashQStashQueue,
} from "infra-ts/upstash";

new UpstashRedis({ name: "cache", region: "us-east-1" });
new UpstashVector({
	name: "embeddings",
	dimensionCount: 1536,
	similarityFunction: "COSINE",
});
new UpstashQStashQueue({ name: "emails", parallelism: 5 });
```

### `infra-ts/resend` — Resend

Credentials: `RESEND_API_KEY`.

| Entity           | Env outputs (→ OS var)                                                |
| ---------------- | --------------------------------------------------------------------- |
| `ResendDomain`   | `resendDomainId` → `RESEND_DOMAIN_ID`                                 |
| `ResendApiKey`   | `resendSendingApiKey` → `RESEND_SENDING_API_KEY` (write-once secret¹) |
| `ResendAudience` | `resendAudienceId` → `RESEND_AUDIENCE_ID`                             |

```ts
import { ResendDomain, ResendApiKey, ResendAudience } from "infra-ts/resend";

new ResendDomain({ name: "mail", domain: "mail.example.com" });
new ResendApiKey({ name: "sending", permission: "sending_access" });
```

> ¹ Resend (and Mux signing keys) return their secret **once** at creation. infra-ts writes it to
> `.env.<env>` at apply and reuses that value on `checkout` rather than minting a new one.

### `infra-ts/mux` — Mux

Credentials: HTTP basic `MUX_TOKEN_ID`:`MUX_TOKEN_SECRET`.

| Entity                   | Env outputs (→ OS var)                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `MuxSigningKey`          | `muxSigningKeyId`, `muxPrivateKey` → `MUX_SIGNING_KEY_ID`, `MUX_PRIVATE_KEY` (write-once¹)                     |
| `MuxLiveStream`          | `muxLiveStreamId`, `muxStreamKey`, `muxPlaybackId` → `MUX_LIVE_STREAM_ID`, `MUX_STREAM_KEY`, `MUX_PLAYBACK_ID` |
| `MuxPlaybackRestriction` | `muxPlaybackRestrictionId` → `MUX_PLAYBACK_RESTRICTION_ID`                                                     |

```ts
import {
	MuxSigningKey,
	MuxLiveStream,
	MuxPlaybackRestriction,
} from "infra-ts/mux";

new MuxSigningKey({ name: "playback-key" });
new MuxLiveStream({
	name: "main-stream",
	playbackPolicy: ["public"],
	latencyMode: "low",
});
new MuxPlaybackRestriction({
	name: "domains",
	allowedDomains: ["example.com"],
});
```

---

## Authoring an entity

An entity is a thin, typed REST wrapper extending the `Entity` base class from `@infra-ts/core`.
You declare schemas (any [Standard Schema](https://standardschema.dev) validator, e.g. Zod) and
implement the lifecycle:

```ts
import {
	Entity,
	type EntityCommon,
	type ReadContext,
	type ProvisionContext,
	type ProvisionResult,
	type Change,
	createRestClient,
	type StandardSchemaV1,
} from "@infra-ts/core";
import { z } from "zod";

type MyEnv = { apiUrl: string };

export class MyResource extends Entity<
	EntityCommon<MyEnv, { id: string }>, // options
	{ MY_TOKEN: string }, // credentials
	MyEnv, // env outputs
	{ id: string }, // identity state
	{ id: string } | null // remote snapshot
> {
	readonly credentialsSchema = z.object({
		MY_TOKEN: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { MY_TOKEN: string }>;
	readonly envSchema = z.object({
		apiUrl: z.string(),
	}) as unknown as StandardSchemaV1<unknown, MyEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["apiUrl"] as const;

	override resolveCredentials(bag: Record<string, string | undefined>) {
		return { MY_TOKEN: bag.MY_TOKEN ?? "" };
	}
	private rest(ctx: { credentials: { MY_TOKEN: string } }) {
		return createRestClient({
			provider: "mine",
			baseUrl: "https://api.mine.dev",
			auth: { type: "bearer", token: ctx.credentials.MY_TOKEN },
		});
	}
	async read(ctx: ReadContext<{ MY_TOKEN: string }, { id: string }>) {
		return ctx.state?.id
			? this.rest(ctx).get(`/things/${ctx.state.id}`, { allowStatuses: [404] })
			: null;
	}
	diff(remote: { id: string } | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "thing", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<{ MY_TOKEN: string }, { id: string }>,
	): Promise<ProvisionResult<MyEnv, { id: string }>> {
		const thing =
			ctx.state?.id ??
			(
				await this.rest(ctx).post<{ id: string }>("/things", {
					body: { name: this.name },
				})
			).id;
		return {
			action: ctx.state ? "noop" : "create",
			id: thing,
			state: { id: thing },
			env: { apiUrl: `https://api.mine.dev/${thing}` },
		};
	}
	async pullEnv(ctx: ReadContext<{ MY_TOKEN: string }, { id: string }>) {
		return { apiUrl: `https://api.mine.dev/${ctx.state?.id}` };
	}
	async deprovision(
		ctx: ProvisionContext<{ MY_TOKEN: string }, { id: string }>,
	) {
		if (ctx.state?.id)
			await this.rest(ctx).delete(`/things/${ctx.state.id}`, {
				allowStatuses: [404],
			});
	}
}
```

`createRestClient({ baseUrl, auth, provider })` handles auth (bearer / basic / header), JSON, and
error normalization to `InfraError`. Publish your class as `@infra-ts/mine` and it composes with
every other entity.

---

## Packages

| Package                                 | Description                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`infra-ts`](packages/cli)              | Umbrella: the `infra-ts` CLI + SDK + bundled providers (`infra-ts/neon`, `/vercel`, `/upstash`, `/resend`, `/mux`). |
| [`@infra-ts/core`](packages/core)       | The open standard: `Entity` contract, `defineInfra`, refs/DAG, env mapping, REST client, `parseEnv`, errors.        |
| [`@infra-ts/runtime`](packages/runtime) | The engine: config loading (jiti), `.infra.<env>` I/O, `plan`/`apply`/`status`/`checkout`/`destroy`, hooks, dotenv. |
| [`@infra-ts/neon`](packages/neon)       | Neon entities: `NeonProject`, `NeonPostgres`, `NeonAuth`, `NeonDataApi`.                                            |
| [`@infra-ts/vercel`](packages/vercel)   | Vercel entities: `VercelProject`, `VercelEdgeConfig`, `VercelWebhook`.                                              |
| [`@infra-ts/upstash`](packages/upstash) | Upstash entities: `UpstashRedis`, `UpstashVector`, `UpstashQStashQueue`.                                            |
| [`@infra-ts/resend`](packages/resend)   | Resend entities: `ResendDomain`, `ResendApiKey`, `ResendAudience`.                                                  |
| [`@infra-ts/mux`](packages/mux)         | Mux entities: `MuxSigningKey`, `MuxLiveStream`, `MuxPlaybackRestriction`.                                           |

Architecture: **functional core, imperative shell.** `@infra-ts/core` is pure (types + validation +
pure helpers, no filesystem or child processes). `@infra-ts/runtime` is the imperative shell (I/O,
network, processes). Entities are thin REST adapters in between.

---

## Development

```bash
bun install
bun run typecheck      # tsc across the whole monorepo (incl. type-level tests)
bun test               # unit + type tests (no network)
bun run build          # build all packages (JS + d.ts); CLI is a self-contained bundle
bun run fmt            # prettier
```

### Tests

infra-ts follows a **reverse test pyramid with no mocks**: pure functions and the engine (over an
in-memory fake entity) get unit tests; provider behavior is verified **end to end against the real
Neon and Vercel APIs**.

```bash
bun test                       # fast unit + type tests (e2e skipped)
INFRA_E2E=1 bun run test:e2e   # live e2e (creates + destroys real throwaway projects)
```

Live e2e creates uniquely-named, clearly-marked throwaway projects (`infra-ts-e2e-*`) in your
personal Neon org / Vercel scope and **always cleans up after itself** (per-suite `afterAll`
teardown). Target a Neon org with `NEON_ORG_ID` and a Vercel team with `VERCEL_TEAM`.

---

## License

Apache-2.0
