# infra-ts

**Typed, live-reconciled infrastructure & config as code — an open standard.**

infra-ts is what you get if you take [`neon.ts`](https://neon.com/blog/introducing-neon-ts) (Neon's
branch config + infrastructure-as-code file) and generalize it into an open standard that any
provider can implement. You declare your infrastructure as **typed entities** in a single
`infra.ts` file, `infra apply` reconciles them against live REST APIs, and everything stays
**fully typed** with **no attribute-state backend** — just TypeScript.

```ts
// infra.ts
import { defineInfra } from "infra-ts";
import { NeonOrg, NeonProject, NeonPostgres } from "infra-ts/neon";
import { VercelProject, VercelTeam } from "infra-ts/vercel";

const neon = new NeonOrg({ name: "neon" });
const vercel = new VercelTeam({ name: "vercel" });
const project = new NeonProject({
	name: "my-app-neon",
	org: neon.id,
	region: "aws-us-east-1",
});
const db = new NeonPostgres({ name: "my-db", projectId: project.id });

export default defineInfra({
	entities: [
		neon,
		vercel,
		project,
		db,
		new VercelProject({
			name: "my-app-vercel",
			team: vercel.id,
			framework: "nextjs",
			// Typed cross-entity wiring: Neon's connection string → a Vercel env var.
			env: { DATABASE_URL: db.env.databaseUrl },
		}),
	],
});
```

```bash
infra plan      # show what would change (dry run, no mutations)
infra apply     # provision everything, wire env, write .env.<env>
infra status    # live state of every entity
infra destroy   # tear it all down
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

The global install exposes two equivalent commands, `infra` and `infra-ts` — use whichever you
prefer. Examples below use the shorter `infra`.

infra-ts resolves provider credentials from environment variables or the CLIs you already have
authenticated (see [each provider](#providers)). For example:

- **Neon** — `NEON_API_KEY`, or the OAuth token cached by `neonctl auth`.
- **Vercel** — `VERCEL_TOKEN`, or the token cached by `vercel login`.

## Quickstart

```bash
infra init                 # scaffold an infra.ts
# edit infra.ts: declare your entities
infra plan                 # preview the changes
infra apply                # provision everything + write .env.local
infra status               # inspect live state
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
const neon = new NeonOrg({ name: "neon" });
const vercel = new VercelTeam({ name: "vercel" });
const project = new NeonProject({ name: "app-neon", org: neon.id });
const db = new NeonPostgres({ name: "db", projectId: project.id }); // depends on project
new VercelProject({
	name: "app-vercel",
	team: vercel.id,
	env: { DATABASE_URL: db.env.databaseUrl },
}); // depends on db and team
```

To pull a consumer **all** of another entity's env at once, spread `entity.toEnv()` — an OS-keyed
bundle of refs. The refs carry the edge, so this is wiring _and_ dependency in one:

```ts
new VercelProject({
	name: "app",
	team: vercel.id,
	env: {
		...db.toEnv(), // → { DATABASE_URL, DATABASE_URL_UNPOOLED }
		...auth.toEnv(), // → { NEON_AUTH_BASE_URL, NEON_AUTH_JWKS_URL }
		CUSTOM_URL: db.env.databaseUrl, // single-field grab / rename
	},
});
```

Object spread is plain JS (duplicate keys silently last-win). For a loud merge that throws on
overlapping keys, use `mergeEnv(db.toEnv(), other.toEnv())`.

Entities form a DAG that infra-ts topologically sorts; a cycle is a hard error. Edges are inferred
**only** from refs — if you ever need ordering with no data flowing, just reference any output of
the dependency (e.g. its `.id`).

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
`infra apply` creates fresh resources; commit nothing here.

### Orgs/teams — auth + provider scope

Provisioning needs two per-developer things that don't belong hardcoded in `infra.ts`: a **token**
and the **org/team to provision into**. Both are modeled by a named scope entity
(`NeonOrg`, `VercelTeam`) that creates no remote resource. Its scope (org/team id) is bound by
`infra link` and stored in
`.infra.<env>`; auth comes from `infra login`.

```ts
import { NeonOrg, NeonProject } from "infra-ts/neon";

const neon = new NeonOrg({ name: "neon" });
const project = new NeonProject({ name: "app", org: neon.id }); // org from the scope entity
```

```bash
infra login    # authenticate (neonctl/vercel OAuth passthrough)
infra link     # pick an org/team per scope → written to .infra.<env>
infra apply    # provision into that scope
```

Scopes are named, so two of the same provider just get two names (`new NeonOrg({ name: "work" })`).
Entities reference a specific scope via `org: <scope>.id` / `team: <scope>.id`. The common
case is one login with many orgs (the token is shared, only the scope differs); two separate logins
should use separate shell/env credentials for now.

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

Per-entity imperative side effects, **named after the CLI verbs** (`apply`, `checkout`, `destroy`)
with a `before*`/`after*` phase each. A hook is a function or a shell command (or a list);
`after*` hooks receive the **exact typed env**. Hooks are declarative data on the entity (no
`.on()` registration), and never run during `plan`/`status`.

```ts
new NeonPostgres({
	name: "db",
	projectId: project.id,
	hooks: {
		beforeApply: "echo migrating",
		afterApply: ({ env }) => migrate(env.databaseUrl),
		afterCheckout: ({ env }) => regenerateTypes(env),
		// also: beforeCheckout, beforeDestroy, afterDestroy
	},
});
```

Shell hooks run **non-interactively** (stdin detached, `CI=1` set) with the resolved env injected,
in the config's root dir. Function hooks run in-process, so resolve relative paths against the
`rootDir`/`cwd` on the hook context (`afterApply: ({ env, rootDir }) => migrate(join(rootDir, "drizzle"))`).

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

| Command                          | Description                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `infra init`                     | Scaffold an `infra.ts` in the current directory.                                       |
| `infra login [providers...]`     | Authenticate each account's provider (CLI OAuth passthrough).                          |
| `infra link [accounts...]`       | Pick an org/team per account; write the scope to `.infra.<env>`.                       |
| `infra plan`                     | Show the changes `apply` would make (dry run; no mutations, no state writes).          |
| `infra apply [--prune]`          | Reconcile remote to `infra.ts`, persist `.infra.<env>`, write `.env.<env>`, run hooks. |
| `infra status`                   | Print the live state of every entity (exists + pending drift).                         |
| `infra checkout [--ignore-diff]` | Pull typed env from the live remote into `.env.<env>` (errors on drift).               |
| `infra destroy [-y]`             | Tear down every entity (destructive; reverse dependency order).                        |
| `infra run -- <cmd>`             | Inject the resolved env into a child command (nothing written to disk).                |

`infra` and `infra-ts` are aliases for the same CLI. Examples:

```bash
infra apply --json | jq '.changes'
infra apply -e production           # target the production environment
infra apply --only my-db            # reconcile just one entity
infra run -- npm run dev            # run your dev server with the resolved env injected
infra destroy --yes                 # non-interactive teardown
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

### Wiring helpers

```ts
import { mergeEnv } from "infra-ts";

db.toEnv(); // entity method → OS-keyed ref bundle (spread into a consumer's env)
db.env.databaseUrl; // single-field typed Ref
mergeEnv(db.toEnv(), x.toEnv()); // merge OS-keyed maps; throws on overlapping keys
```

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

| Entity            | Manages                                                                                      | Env outputs (→ OS var)                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `NeonOrg`         | org scope + auth anchor (`infra login`/`link`)                                               | _none_ (`.id` = org id)                                                                      |
| `NeonProject`     | the project, default-branch compute (autoscale/scale-to-zero) + TTL, **logical replication** | _none_ (exposes `.id` for wiring)                                                            |
| `NeonPostgres`    | a database/role on the project's branch                                                      | `databaseUrl`, `databaseUrlUnpooled` → `DATABASE_URL`, `DATABASE_URL_UNPOOLED`               |
| `NeonReadReplica` | a `read_only` compute endpoint (read replica) on a branch                                    | `readReplicaUrl`, `readReplicaUrlUnpooled` → `READ_REPLICA_URL`, `READ_REPLICA_URL_UNPOOLED` |
| `NeonAuth`        | the Neon Auth integration                                                                    | `authBaseUrl`, `authJwksUrl` → `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL`                    |
| `NeonDataApi`     | the Neon Data API (PostgREST)                                                                | `dataApiUrl` → `NEON_DATA_API_URL`                                                           |

```ts
import {
	NeonOrg,
	NeonProject,
	NeonPostgres,
	NeonReadReplica,
	NeonAuth,
	NeonDataApi,
} from "infra-ts/neon";

const neon = new NeonOrg({ name: "neon" });
const project = new NeonProject({
	org: neon.id,
	name: "app",
	region: "aws-us-east-1",
	pgVersion: 17,
	compute: { minCu: 0.25, maxCu: 1, suspendTimeout: "5m" },
	ttl: "30d", // branch auto-expiry (duration string or seconds)
	logicalReplication: true, // wal_level=logical for CDC / outbound replication (one-way)
});
const db = new NeonPostgres({
	name: "app-db",
	projectId: project.id,
	database: "app",
	role: "app",
});
const replica = new NeonReadReplica({
	name: "app-replica",
	projectId: project.id,
	compute: { minCu: 0.25, maxCu: 2 },
});
const auth = new NeonAuth({ name: "app-auth", projectId: project.id });
const dataApi = new NeonDataApi({ name: "app-data", projectId: project.id });
```

### `infra-ts/vercel` — Vercel

Credentials: `VERCEL_TOKEN` or the `vercel` CLI cache. Pass `team` (id/ref or slug) for team scope.

| Entity              | Manages                                                                                                                                        | Env outputs (→ OS var)                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `VercelTeam`        | team scope + auth anchor (`infra login`/`link`)                                                                                                | _none_ (`.id` = team id)                                                |
| `VercelProject`     | the project, full **settings** (build/dev/install, node version, region, …) as drift, **env vars** (additive + update), and **custom domains** | `projectId`, `projectName` → `VERCEL_PROJECT_ID`, `VERCEL_PROJECT_NAME` |
| `VercelEdgeConfig`  | an Edge Config store + its items (idempotent upsert)                                                                                           | `edgeConfigId` → `EDGE_CONFIG_ID`                                       |
| `VercelWebhook`     | a project/account webhook                                                                                                                      | `webhookId` → `WEBHOOK_ID`                                              |
| `VercelDnsRecord`   | a DNS record on an account domain                                                                                                              | —                                                                       |
| `VercelLogDrain`    | a configurable log drain                                                                                                                       | —                                                                       |
| `VercelAccessGroup` | an access group                                                                                                                                | `vercelAccessGroupId` → `VERCEL_ACCESS_GROUP_ID`                        |
| `VercelDeployment`  | a deployment — delegates to the `vercel` CLI by default (or REST), content-hash idempotent                                                     | `deploymentUrl` → `DEPLOYMENT_URL`                                      |

```ts
import {
	VercelTeam,
	VercelProject,
	VercelEdgeConfig,
	VercelWebhook,
} from "infra-ts/vercel";

const team = new VercelTeam({ name: "vercel" });
new VercelProject({
	team: team.id,
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
	team: team.id,
	slug: "app-flags",
	items: { newUi: true },
});
```

**Deployments** are a [command-backed entity](#command-backed-entities). `VercelDeployment` defaults
to delegating to the `vercel` CLI (the same `pull` → `build` → `deploy --prebuilt` flow Vercel
documents for CI) so it matches their default behavior exactly; a `mode: "rest"` uploads source via
the API instead. It's content-hash idempotent — unchanged source is a no-op.

```ts
import { VercelDeployment, VercelProject, VercelTeam } from "infra-ts/vercel";

const team = new VercelTeam({ name: "vercel" });
const web = new VercelProject({
	name: "app",
	team: team.id,
	framework: "nextjs",
});
new VercelDeployment({
	name: "app-deploy",
	team: team.id,
	project: web.id, // → VERCEL_PROJECT_ID (injected as env, never on the command line)
	cwd: "./apps/web",
	production: true, // else the target derives from the active environment
	// prebuilt: true,      // run `vercel build` locally; otherwise Vercel builds remotely
	// mode: "rest",        // upload source via REST instead of the CLI
});
```

> **Out of scope (by design):** Web Analytics / Speed Insights toggles aren't in Vercel's public
> REST API.

### `infra-ts/upstash` — Upstash

`UpstashRedis`/`UpstashVector` use the developer API (HTTP basic `UPSTASH_EMAIL`:`UPSTASH_API_KEY`);
the QStash entities use the QStash API (`QSTASH_TOKEN`).

| Entity                  | Env outputs (→ OS var)                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `UpstashRedis`          | `upstashRedisRestUrl`, `upstashRedisRestToken`, `redisUrl` → `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `REDIS_URL` |
| `UpstashVector`         | `upstashVectorRestUrl`, `upstashVectorRestToken` → `UPSTASH_VECTOR_REST_URL`, `UPSTASH_VECTOR_REST_TOKEN`                      |
| `UpstashQStashQueue`    | `qstashQueueName` → `QSTASH_QUEUE_NAME`                                                                                        |
| `UpstashQStashSchedule` | — (a cron schedule delivering to a URL/topic)                                                                                  |
| `UpstashQStashTopic`    | `qstashTopicName` → `QSTASH_TOPIC_NAME` (a URL group / fan-out topic)                                                          |

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
| `ResendWebhook`  | — (an event webhook)                                                  |

```ts
import { ResendDomain, ResendApiKey, ResendAudience } from "infra-ts/resend";

new ResendDomain({ name: "mail", domain: "mail.example.com" });
new ResendApiKey({ name: "sending", permission: "sending_access" });
```

> ¹ Resend (and Mux signing keys) return their secret **once** at creation. infra-ts writes it to
> `.env.<env>` at apply and reuses that value on `checkout` rather than minting a new one.

### `infra-ts/mux` — Mux

Credentials: HTTP basic `MUX_TOKEN_ID`:`MUX_TOKEN_SECRET`.

| Entity                         | Env outputs (→ OS var)                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `MuxSigningKey`                | `muxSigningKeyId`, `muxPrivateKey` → `MUX_SIGNING_KEY_ID`, `MUX_PRIVATE_KEY` (write-once¹)                     |
| `MuxLiveStream`                | `muxLiveStreamId`, `muxStreamKey`, `muxPlaybackId` → `MUX_LIVE_STREAM_ID`, `MUX_STREAM_KEY`, `MUX_PLAYBACK_ID` |
| `MuxPlaybackRestriction`       | `muxPlaybackRestrictionId` → `MUX_PLAYBACK_RESTRICTION_ID`                                                     |
| `MuxLiveStreamSimulcastTarget` | — (re-streams a live stream to YouTube/Twitch/…)                                                               |

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

### `infra-ts/sentry` — Sentry

Credentials: `SENTRY_AUTH_TOKEN`. Each entity takes the Sentry `org` slug.

| Entity            | Env outputs (→ OS var)     |
| ----------------- | -------------------------- |
| `SentryTeam`      | —                          |
| `SentryProject`   | —                          |
| `SentryClientKey` | `sentryDsn` → `SENTRY_DSN` |

```ts
import { SentryTeam, SentryProject, SentryClientKey } from "infra-ts/sentry";

const team = new SentryTeam({ name: "core", org: "acme" });
const project = new SentryProject({ name: "web", org: "acme", team: team.id });
new SentryClientKey({ name: "web-dsn", org: "acme", project: project.id });
```

### `infra-ts/workos` — WorkOS

Credentials: `WORKOS_API_KEY`. SSO/Directory connections are created through the WorkOS portal at
runtime, so they're out of scope.

| Entity               | Env outputs (→ OS var)                            |
| -------------------- | ------------------------------------------------- |
| `WorkosOrganization` | `workosOrganizationId` → `WORKOS_ORGANIZATION_ID` |

### `infra-ts/sanity` — Sanity

Credentials: `SANITY_AUTH_TOKEN`. Each entity takes a `projectId`.

| Entity             | Env outputs (→ OS var)                              |
| ------------------ | --------------------------------------------------- |
| `SanityDataset`    | `sanityDataset` → `SANITY_DATASET`                  |
| `SanityToken`      | `sanityApiToken` → `SANITY_API_TOKEN` (write-once¹) |
| `SanityCorsOrigin` | —                                                   |

### `infra-ts/statsig` — Statsig

Credentials: `STATSIG_CONSOLE_API_KEY` (sent as the `STATSIG-API-KEY` header). `StatsigGate`,
`StatsigDynamicConfig`, and `StatsigExperiment` are management-only (no env output).

```ts
import { StatsigGate, StatsigExperiment } from "infra-ts/statsig";

new StatsigGate({ name: "new-checkout", isEnabled: true });
new StatsigExperiment({ name: "pricing-test" });
```

### `infra-ts/dub` — Dub

Credentials: `DUB_API_KEY`.

| Entity      | Env outputs (→ OS var)            |
| ----------- | --------------------------------- |
| `DubDomain` | —                                 |
| `DubTag`    | —                                 |
| `DubLink`   | `dubShortLink` → `DUB_SHORT_LINK` |

### `infra-ts/stripe` — Stripe

Credentials: `STRIPE_SECRET_KEY`. Bodies are form-encoded per the Stripe API.

| Entity                  | Env outputs (→ OS var)                                        |
| ----------------------- | ------------------------------------------------------------- |
| `StripeWebhookEndpoint` | `stripeWebhookSecret` → `STRIPE_WEBHOOK_SECRET` (write-once¹) |
| `StripeProduct`         | `stripeProductId` → `STRIPE_PRODUCT_ID`                       |
| `StripePrice`           | `stripePriceId` → `STRIPE_PRICE_ID`                           |

```ts
import { StripeProduct, StripePrice } from "infra-ts/stripe";

const pro = new StripeProduct({ name: "Pro" });
new StripePrice({
	name: "pro-monthly",
	product: pro.id,
	currency: "usd",
	unitAmount: 1500,
	recurring: { interval: "month" },
});
```

### `infra-ts/posthog` — PostHog

Credentials: `POSTHOG_API_KEY` (a personal API key). Set `apiHost` / `POSTHOG_API_HOST` for EU or
self-hosted instances.

| Entity               | Env outputs (→ OS var)                                      |
| -------------------- | ----------------------------------------------------------- |
| `PosthogProject`     | `posthogKey`, `posthogHost` → `POSTHOG_KEY`, `POSTHOG_HOST` |
| `PosthogFeatureFlag` | —                                                           |

### `infra-ts/elevenlabs` — ElevenLabs

Credentials: `ELEVENLABS_API_KEY` (sent as the `xi-api-key` header). Speech synthesis itself is a
runtime API, so it's out of scope.

| Entity            | Env outputs (→ OS var)                      |
| ----------------- | ------------------------------------------- |
| `ElevenLabsAgent` | `elevenLabsAgentId` → `ELEVENLABS_AGENT_ID` |

### `infra-ts/openai` — OpenAI

Uses the OpenAI Administration API, so credentials resolve from `OPENAI_ADMIN_KEY` (an admin key,
`sk-admin-…`).

| Entity                 | Env outputs (→ OS var)                          |
| ---------------------- | ----------------------------------------------- |
| `OpenAiProject`        | —                                               |
| `OpenAiServiceAccount` | `openaiApiKey` → `OPENAI_API_KEY` (write-once¹) |

```ts
import { OpenAiProject, OpenAiServiceAccount } from "infra-ts/openai";

const project = new OpenAiProject({ name: "my-app" });
new OpenAiServiceAccount({ name: "backend", project: project.id });
```

> ¹ Write-once secrets (Sanity tokens, Stripe webhook secrets, OpenAI keys, …) are returned **once**
> at creation. infra-ts writes them to `.env.<env>` at apply and reuses that value on `checkout`
> rather than minting a new one.

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

## Command-backed entities

Transport is the entity's choice — REST, a vendor CLI, or both. For **reconciled config** (projects,
env vars, domains) stay on thin REST. For **imperative, vendor-owned actions** (build + deploy), the
vendor CLI _is_ the reference implementation, so delegating to it matches default behavior exactly
instead of re-implementing it. (infra-ts already does this for `infra login`, which drives the
provider's OAuth CLI.)

Two pieces make this first-class:

- **`ctx.exec`** — the runtime hands `provision` a process runner that injects the entity's resolved
  credentials as **env** (so e.g. `VERCEL_TOKEN` is present without leaking on the command line) and
  throws `InfraError` on a non-zero exit. Keep `read`/`diff` read-only.
- **`requiredTools()`** — an entity declares the CLIs it needs (`{ id, detect, npx?, install? }`).
  `infra login`/`link` detect them, prefer ephemeral `npx`/`bunx` (no global install), and offer a
  **confirmed** global install otherwise — turning infra-ts into a CLI orchestrator on top of the
  REST reconciler.

Command-backed entities still obey the full contract: persist **only identity state** (capture the
CLI's output id/url; don't adopt its `.vercel` snapshot), stay **idempotent** (content hash, §11.4),
and emit **typed env**. So REST vs CLI is a free, per-entity choice. `VercelDeployment` is the first
example.

The same `exec` capability powers **self-healing auth**: `createRestClient` takes an
`onUnauthorized` hook, and the reusable `refreshOnUnauthorized({ exec, refresh, reread, current })`
util refreshes a provider CLI's cached OAuth token on a `401` (e.g. Neon runs `neonctl me`,
re-reads the cache, retries once) — only when the in-use token is the cached one, so explicit keys
fail fast.

---

## Packages

| Package                                       | Description                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`infra-ts`](packages/cli)                    | Umbrella: the `infra-ts` CLI + SDK + bundled providers (`infra-ts/neon`, `/vercel`, `/upstash`, `/resend`, `/mux`).                                                |
| [`@infra-ts/core`](packages/core)             | The open standard: `Entity` contract, `defineInfra`, refs/DAG, env mapping, REST client, `parseEnv`, errors.                                                       |
| [`@infra-ts/runtime`](packages/runtime)       | The engine: config loading (jiti), `.infra.<env>` I/O, `plan`/`apply`/`status`/`checkout`/`destroy`, hooks, dotenv.                                                |
| [`@infra-ts/neon`](packages/neon)             | Neon entities: `NeonOrg`, `NeonProject` (incl. logical replication), `NeonPostgres`, `NeonReadReplica`, `NeonAuth`, `NeonDataApi`.                                 |
| [`@infra-ts/vercel`](packages/vercel)         | Vercel entities: `VercelTeam`, `VercelProject`, `VercelDeployment`, `VercelEdgeConfig`, `VercelWebhook`, `VercelDnsRecord`, `VercelLogDrain`, `VercelAccessGroup`. |
| [`@infra-ts/upstash`](packages/upstash)       | Upstash entities: `UpstashRedis`, `UpstashVector`, `UpstashQStashQueue`, `UpstashQStashSchedule`, `UpstashQStashTopic`.                                            |
| [`@infra-ts/resend`](packages/resend)         | Resend entities: `ResendDomain`, `ResendApiKey`, `ResendAudience`, `ResendWebhook`.                                                                                |
| [`@infra-ts/mux`](packages/mux)               | Mux entities: `MuxSigningKey`, `MuxLiveStream`, `MuxPlaybackRestriction`, `MuxLiveStreamSimulcastTarget`.                                                          |
| [`@infra-ts/sentry`](packages/sentry)         | Sentry entities: `SentryTeam`, `SentryProject`, `SentryClientKey`.                                                                                                 |
| [`@infra-ts/workos`](packages/workos)         | WorkOS entities: `WorkosOrganization`.                                                                                                                             |
| [`@infra-ts/sanity`](packages/sanity)         | Sanity entities: `SanityDataset`, `SanityToken`, `SanityCorsOrigin`.                                                                                               |
| [`@infra-ts/statsig`](packages/statsig)       | Statsig entities: `StatsigGate`, `StatsigDynamicConfig`, `StatsigExperiment`.                                                                                      |
| [`@infra-ts/dub`](packages/dub)               | Dub entities: `DubDomain`, `DubTag`, `DubLink`.                                                                                                                    |
| [`@infra-ts/stripe`](packages/stripe)         | Stripe entities: `StripeWebhookEndpoint`, `StripeProduct`, `StripePrice`.                                                                                          |
| [`@infra-ts/posthog`](packages/posthog)       | PostHog entities: `PosthogProject`, `PosthogFeatureFlag`.                                                                                                          |
| [`@infra-ts/elevenlabs`](packages/elevenlabs) | ElevenLabs entities: `ElevenLabsAgent`.                                                                                                                            |
| [`@infra-ts/openai`](packages/openai)         | OpenAI entities: `OpenAiProject`, `OpenAiServiceAccount`.                                                                                                          |

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
