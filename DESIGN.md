# infra-ts design: compose native tools, own only the graph

This is the guiding design note for infra-ts. It captures **what infra-ts is**, the
**API we want**, and the concrete plan behind the `stripe-projects` provider. It is
intentionally opinionated so the codebase stays coherent as providers are added.

## What infra-ts is

infra-ts is a **typed composition layer** over the tools you already use. You declare
your whole stack as typed entities in one `infra.ts`, and infra-ts wires them together
(refs, a dependency graph, a `plan`/`apply`) — but **every native CLI and file keeps
working, and you can walk away at any time.**

Three principles make that concrete:

1. **Compose, don't capture.** The native CLI is the engine for linking, auth,
   imperative actions, and provisioning. The native artifact (`.vercel/project.json`,
   `.projects/state.json`, a provider's context) is the source of truth for identity.
   infra-ts owns exactly one thing: `infra.ts`, the **composition graph**. Delete
   `infra.ts` and every native tool still works.

2. **Couple to the interface, never the files.** infra-ts issues vendor commands
   (`vercel …`, `stripe projects …`) and reads their `--json` output. It never parses
   another tool's private files (`.vercel/`, `.projects/`). The command surface is a
   stable contract; the file layout is an implementation detail.

3. **Providers own where their state lives.** A provider's `read`/`provision` decide
   where identity comes from — a native file, a native CLI (`stripe projects status
--json`), a global context, or infra-ts's own state file as an opt-in fallback.
   Whatever a provider persists to infra-ts state stays bounded by the standard:
   **stable ids and content hashes only — no secrets, no attributes, no snapshots.**

This is a different lane from Terraform/Pulumi (capture-all state engines) and from
Stripe Projects itself (an aggregation network). It's the version most compatible with
agents, because everything infra-ts does is a real command you (or the agent) could run
by hand, and it's reversible by construction.

## How this maps onto the existing contract

The `@infra-ts/core` `Entity` contract already supports all three principles — **no core
surgery is required** for composition:

- **Compose via `exec`.** `ctx.exec` runs a vendor CLI with resolved credentials injected
  as env; `requiredTools()` declares the CLIs an entity needs (the engine detects /
  installs them, preferring ephemeral `npx`/`bunx`). This is how `VercelDeployment`
  already delegates to the `vercel` CLI.
- **Provider-owned state.** `read`/`provision` receive `ctx.state` and return a `state`
  object. A provider that resolves identity live (e.g. by name via a CLI) simply returns
  `state: {}` — nothing is persisted to `.infra/<env>.json`, and the declared entity
  `name` is the join key. A provider without a native home returns `state: { id }` and
  the engine persists it.
- **The State invariant** is enforced by each entity's `stateSchema` (ids + hashes only).

## The env model (produced vs declared)

infra-ts's env is **"give me every credential needed to run the app locally"**, which is
_not_ the same as a hosting provider's "pull my stored env vars." Two classes:

- **Produced / pullable outputs** — values infra-ts derives from the resources it owns
  (`db.env.databaseUrl`). Modeled today by `envSchema` + `envKeys` + `pullEnv`, exposed as
  typed refs (`entity.env.field`) that wire into other entities.
- **Declared / non-pullable inputs** — values nothing in the graph can produce (your own
  third-party keys). You supply these locally; infra-ts's job is to declare/validate them.
  Today these ride on `credentialsSchema` (resolved from `process.env` / `defineInfra`).

File ownership mirrors the ecosystem: infra-ts writes the **managed** `.env.<env>`; your
**own** inputs live in `.env.local`, which infra-ts never overwrites (the same convention
[`better-env`](https://github.com/neondatabase/better-env) uses).

**Sibling layering:** `better-env` owns the _environment axis_ (canonical env name ↔ each
provider's native environment, plus dotenv distribution/validation). infra-ts _produces_
credentials from owned resources and declares required inputs; `better-env` can then
distribute that set into hosting environments. infra-ts feeds better-env, not the reverse.

> Future (not in this slice): a first-class `declaredEnv` on `EntityCommon` so an entity
> can list required-but-unproduced env for `plan`-time validation, distinct from
> credentials. Deferred to keep this change additive and regression-safe.

## The `stripe-projects` provider (this slice)

`@infra-ts/stripe-projects` lets you declare infra that **Stripe Projects provisions**,
instead of going to each provider directly. It's the canonical demonstration of the
three principles:

- **Composes the CLI.** Entities drive `stripe projects add/status/upgrade/remove/env`
  through `ctx.exec`; `requiredTools()` advertises the Stripe CLI + `projects` plugin.
- **Provider-owned state.** Identity is the declared entity `name` (`stripe projects add
… --name <name>`). `read` resolves live via `stripe projects status --json`; entities
  persist `state: {}` — infra-ts stores nothing, and Stripe Projects' `.projects/` manifest
  stays its own business.
- **No captured creds.** Auth is the local Stripe CLI session, so these entities need no
  infra-ts credentials. Credential distribution stays with Stripe Projects (`env --pull`
  writes `.env`); infra-ts reads the produced values back by their OS key.

### API

```ts
import { defineInfra } from "infra-ts";
import {
	NeonPostgres,
	UpstashRedis,
	StripeProjectsService,
} from "infra-ts/stripe-projects";
import { VercelProject } from "infra-ts/vercel";

const db = new NeonPostgres({ name: "db", tier: "launch" });
const cache = new UpstashRedis({ name: "cache" });

// Generic escape hatch for any provider/service in the Projects catalog:
const search = new StripeProjectsService({
	name: "search",
	provider: "algolia",
	service: "application",
	exposes: ["algoliaAppId", "algoliaApiKey"],
});

export default defineInfra({
	entities: [
		db,
		cache,
		search,
		new VercelProject({
			name: "web",
			team: "team_x",
			env: { DATABASE_URL: db.env.databaseUrl }, // produced output → wired via ref
		}),
	],
});
```

Typed wrappers (`NeonPostgres`, `UpstashRedis`) fix `provider`/`service` and expose typed
env; `StripeProjectsService` covers the rest of the catalog with a declared `exposes` list.
The subset is intentionally small to start and can grow (ideally codegen'd from
`stripe projects catalog --json`).

### Command mapping

| Lifecycle     | Command                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `read`        | `stripe projects status --json` → find resource by `name`                                                         |
| `diff`        | present? tier match? (small, honest surface: presence + tier)                                                     |
| `provision`   | `stripe projects add <provider>/<service> --name <name> [--tier …]` (+ `upgrade` on tier drift) then `env --pull` |
| `pullEnv`     | `env --pull`, then read produced values from `process.env` by OS key                                              |
| `deprovision` | `stripe projects remove <name>`                                                                                   |

All non-interactive (`--no-interactive`, `--auto-confirm`, `--accept-tos`) for agent use.

## Testing strategy

Following the repo's reverse pyramid and **no-mocks** rule, command-backed entities are
tested by injecting a **recording `exec`** (the same boundary `VercelDeployment`'s tests
use — the CLI process is the seam, not a fake provider). Coverage:

- **API-surface / type-level** (`test/types.test-d.ts`): entity option types, typed env
  refs, and cross-provider wiring (a Projects `db.env.databaseUrl` flows into a Vercel
  `env`), compiled by `tsc`.
- **Behavioral regression** (`packages/stripe-projects/test`): exact command
  construction, `status --json` parsing, identity-by-name, `diff` transitions
  (create/noop/update), `provision`/`pullEnv`/`deprovision`, `requiredTools`, and error
  paths (missing `exec`, malformed JSON).
- **Live e2e** (behind `INFRA_E2E=1`): deferred — requires a real Stripe account with a
  payment method and the `projects` plugin.
