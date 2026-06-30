# infra-ts — Specification

> Status: **design locked**. This document is the source of truth for the v2 redesign. Nothing
> has been published, so this fully replaces the v1 "provider" API — it is not a breaking change,
> it is _the_ design.

infra-ts is a **typed, live-reconciled, open standard for infrastructure & config as code** — it
keeps **no attribute state**, only a per-environment _identity_ link file, and treats the live
remote as the source of truth. You
declare a graph of **entities** (a Neon project, a Postgres database, a Vercel project, a
function, a Redis cache, …) in a single `infra.ts` file. `infra plan` shows what would change;
`infra apply` reconciles the live remote to your declaration; `infra checkout` pulls a typed
`.env` for an environment. There is **no resource state store** — only a tiny per-environment
link file (`.infra.<env>`) holding stable identifiers. Everything else is re-read live from each
provider's REST API on every command.

This document is long on purpose and full of code. Read it top to bottom once; after that the
"Engine algorithm" and "Authoring an entity" sections are the working references.

---

## Table of contents

1. [Principles](#1-principles)
2. [Core concepts & glossary](#2-core-concepts--glossary)
3. [`defineInfra` — the top-level config](#3-defineinfra--the-top-level-config)
4. [The `Entity` contract](#4-the-entity-contract)
5. [Identity & uniqueness](#5-identity--uniqueness)
6. [Composition & dependencies (the graph)](#6-composition--dependencies-the-graph)
7. [Environments](#7-environments)
8. [Credentials](#8-credentials)
9. [Environment variables (typed env)](#9-environment-variables-typed-env)
10. [State (`.infra.<env>`)](#10-state-infraenv)
11. [Lifecycle in detail](#11-lifecycle-in-detail)
12. [`checkout` & drift](#12-checkout--drift)
13. [Hooks](#13-hooks)
14. [Renames](#14-renames)
15. [Deletion / pruning](#15-deletion--pruning)
16. [The engine algorithm](#16-the-engine-algorithm)
17. [CLI surface](#17-cli-surface)
18. [Runtime: `parseEnv`](#18-runtime-parseenv)
19. [Worked examples](#19-worked-examples)
20. [Authoring an entity (provider author guide)](#20-authoring-an-entity-provider-author-guide)
21. [Open questions / future](#21-open-questions--future)

---

## 1. Principles

- **No attribute state — identity state only.** infra-ts never stores resource _attributes_. It
  persists only **identity state** — _bindings_ (provider ids, and content hashes for deployments)
  — in `.infra.<env>`. There is no attribute state to "store wrong": the remote API _is_ the
  source of truth, and every command reads it live and diffs against your `infra.ts`. The
  reconciler is stateless; only your entity↔remote identity is persisted.
- **Typed end to end.** Entities declare their credentials, env, and state with
  [Standard Schema](https://github.com/standard-schema/standard-schema), so `ctx.credentials`,
  the resolved `env`, and the persisted `state` are all statically typed and runtime-validated.
- **An open standard.** An entity is a thin, typed wrapper around a remote REST API implementing
  one small contract (`Entity`). Supporting a new platform/resource = publishing a class. No fork
  of infra-ts required.
- **Functional core, imperative shell.** `diff` is pure. `read` / `provision` / `deprovision`
  are the imperative shell. Entity constructors are pure (store config, do no I/O).
- **Fine-grained entities.** A "resource" is the unit (Postgres, DataAPI, Function) — not a
  whole provider bundle. Granularity makes each entity's env **static**, makes the dependency
  graph explicit, and makes deletion safe.

---

## 2. Core concepts & glossary

- **Entity** — a single provisionable resource (`new Postgres({...})`). Implements the
  [`Entity`](#4-the-entity-contract) contract.
- **`defineInfra`** — the default export of `infra.ts`; collects entities + global config.
- **Environment** — a named target (`local`, `preview`, `production`, …). Selects credentials,
  the state file (`.infra.<env>`), and the env file (`.env.<env>`). Never changes the _set_ of
  env vars an entity exposes (see [§7](#7-environments)).
- **Ref** — a typed, deferred reference to another entity's output (`postgres.env.databaseUrl`,
  `project.id`). Creates a dependency edge; resolved by the engine at provision time.
- **State** — the persisted `.infra.<env>` entry for an entity: stable ids + content hashes.
  **Never secrets.**
- **Remote** — the live snapshot an entity's `read()` returns, used to diff/render. Ephemeral
  (not persisted).
- **Env** — the typed output an entity exposes (logical camelCase keys, e.g. `databaseUrl`),
  serialized to `.env.<env>` as OS-style keys (e.g. `DATABASE_URL`).
- **Change** — one planned/applied mutation, rendered by `plan`/`apply`/`status`.

---

## 3. `defineInfra` — the top-level config

```ts
// infra.ts
import { defineInfra } from "infra-ts";
import { Project, Postgres } from "@infra-ts/neon";

const project = new Project({ name: "todo-app", region: "aws-us-east-1" });
const db = new Postgres({ name: "todo-db", projectId: project.id });

export default defineInfra({
	/** Entities to manage. Nested entities are registered transitively (see §6). */
	entities: [project, db],

	/**
	 * Default environment when none is passed. Selection precedence:
	 * `--env` > `INFRA_ENV` > `defaultEnvironment` > `"local"`. infra-ts **never** reads
	 * `NODE_ENV` (see §7.1) — the default must be the safe environment, not an ambient var that
	 * frequently defaults to "production".
	 */
	defaultEnvironment: "local",

	/**
	 * Source the input bag for a run (credentials + any user values). Defaults to
	 * `process.env`. Runs once per command, before any entity. See §8.
	 */
	loadEnv: (environment) => ({
		...process.env,
		...dotenv(`.env.${environment}`), // illustrative; bring your own loader
	}),

	/**
	 * Credentials inherited by every entity (each entity validates the slice it needs against
	 * its own `credentialsSchema`). Entity-level `credentials` shallow-merge over this. See §8.
	 * May be a static object or a function of the environment.
	 */
	credentials: (environment) => ({
		NEON_API_KEY: process.env.NEON_API_KEY,
		VERCEL_TOKEN: process.env.VERCEL_TOKEN,
	}),

	/** In-place identity migrations (see §14). Idempotent; safe to leave in. */
	renames: [{ old: "todo-postgres", new: "todo-db" }],
});
```

`defineInfra` is **pure**: it validates the entity graph (unique ids, no cycles, no env-key
collisions — see the relevant sections) and freezes the result. No I/O.

### Type

```ts
interface InfraConfig {
	entities: Entity[];
	defaultEnvironment?: string; // default "local"
	loadEnv?: (environment: string) => Record<string, string | undefined>;
	credentials?:
		| Record<string, string | undefined>
		| ((environment: string) => Record<string, string | undefined>);
	renames?: { old: string; new: string }[];
}

function defineInfra(config: InfraConfig): Infra;
```

---

## 4. The `Entity` contract

Entities are **classes**. The constructor stores config (pure — no I/O, no remote access).
Lifecycle methods are called by the engine. Authors extend the abstract `Entity` base, which
supplies the typed output refs (`id`, `env`) and shared plumbing.

```ts
import type { StandardSchemaV1 } from "@standard-schema/spec";

abstract class Entity<
	Creds = unknown,
	Env extends Record<string, string> = Record<string, string>,
	State extends Record<string, unknown> = Record<string, unknown>,
	Remote = unknown,
> {
	/** Stable, user-facing unique id. Config-only — never derived from a remote value. §5 */
	abstract readonly name: string;

	/** What this entity needs to provision (API keys, tokens). Validated → typed `ctx.credentials`. */
	abstract readonly credentialsSchema: StandardSchemaV1<unknown, Creds>;

	/** The typed env this entity outputs. Logical camelCase keys (e.g. `databaseUrl`). §9 */
	abstract readonly envSchema: StandardSchemaV1<unknown, Env>;

	/** The persisted `.infra.<env>` shape for this entity: ids + content hashes. No secrets. §10 */
	abstract readonly stateSchema: StandardSchemaV1<unknown, State>;

	/** Optional: rename specific env vars on disk. Logical key → OS key. Values pass through. §9 */
	readonly envNames?: Partial<Record<Extract<keyof Env, string>, string>>;
	readonly envName?: (key: Extract<keyof Env, string>) => string;

	/** Optional: imperative side-effect hooks bracketing provision/checkout. §13 */
	readonly hooks?: EntityHooks<Env, State>;

	// ── lifecycle ────────────────────────────────────────────────────────────

	/** Read the live remote (using `ctx.state` ids). `null` = does not exist remotely. */
	abstract read(ctx: ReadContext<Creds, State>): Promise<Remote | null>;

	/** PURE. Compare this entity's desired config to `remote`; return the changeset. */
	abstract diff(remote: Remote | null, ctx: DiffContext): Change[];

	/**
	 * Reconcile remote to desired. Idempotent (called for both create and update). Returns the
	 * new persisted `state`, the resolved `env`, and what happened. No-op returns `action: "noop"`.
	 */
	abstract provision(
		ctx: ProvisionContext<Creds, State>,
	): Promise<ProvisionResult<Env, State>>;

	/** Tear this entity down (destructive). Used by `destroy` and prune. */
	abstract deprovision(ctx: ProvisionContext<Creds, State>): Promise<void>;

	// ── outputs (provided by the base class) ─────────────────────────────────

	/** Typed deferred reference to this entity's id (resolved at provision time). */
	get id(): Ref<string>;

	/** Typed deferred references to this entity's env, e.g. `db.env.databaseUrl: Ref<string>`. */
	get env(): { readonly [K in keyof Env]: Ref<Env[K]> };

	/**
	 * This entity's whole env as an **OS-keyed** bundle of refs (applies `envNames`/`envName`),
	 * ready to spread into a consumer's `env`, e.g. `{ ...db.toEnv() }` → `{ DATABASE_URL: Ref, … }`.
	 * Spreading carries refs, so it also creates the dependency edge. §6.3, §9.4
	 */
	toEnv(): Record<string, Ref<string>>;
}
```

### Supporting types

```ts
type ChangeAction = "create" | "update" | "delete" | "noop";

interface Change {
	action: ChangeAction;
	/** Resource kind, e.g. "project", "compute", "env-var". */
	kind: string;
	/** Human-readable identifier, e.g. "todo-db" or "env:DATABASE_URL". */
	identifier: string;
	/** One-line summary rendered by plan/status. */
	detail?: string;
	/** Structured extras for --json consumers. */
	data?: Record<string, unknown>;
}

interface ProvisionResult<Env, State> {
	action: ChangeAction; // "created" maps to "create", etc.; "noop" when nothing changed
	state: State; // persisted to .infra.<env>
	env: Env; // logical typed env this entity exposes
	message?: string;
}

interface BaseContext<Creds> {
	/** The active environment, e.g. "production". */
	environment: string;
	/** Validated against this entity's `credentialsSchema`. */
	credentials: Creds;
	logger: Logger;
}

interface ReadContext<Creds, State> extends BaseContext<Creds> {
	/** The persisted binding from `.infra.<env>`, or `null` if never provisioned. */
	state: State | null;
}

interface DiffContext {
	environment: string;
}

interface ProvisionContext<Creds, State> extends BaseContext<Creds> {
	state: State | null;
}
```

> **Refs are values by provision time.** Any `Ref` the author passed into the constructor
> (`projectId: project.id`, `env: { REDIS_URL: redis.env.redisUrl }`) is **resolved by the engine
> before `read`/`diff`/`provision` run** (guaranteed: dependencies are provisioned first, see
> §6/§16). Lifecycle methods see fully-resolved option values — never a `Ref`. The base class
> exposes the resolved view; e.g. inside `provision`, `this.config.projectId` is a `string`.

```ts
/** Unwraps Ref<X> to X recursively — the type of an entity's *resolved* options. */
type Resolved<T> =
	T extends Ref<infer U>
		? U
		: T extends object
			? { [K in keyof T]: Resolved<T[K]> }
			: T;
```

---

## 5. Identity & uniqueness

- Every entity has a **stable `name`** that is its unique id across the whole config. It is the
  key under which its [state](#10-state-infraenv) lives.
- `name` may be **assembled** by the entity implementor (e.g. a Postgres could default to
  `${projectName}-postgres`), but it **must be deterministic and must not depend on a remote
  value** — otherwise a rename upstream silently orphans state.
- **Duplicate ids are a hard error.** If two entities resolve to the same `name`, the engine
  stops immediately and names both offenders. (This is the v1 `defineConfig` duplicate-provider
  check, generalized.)
- Renaming an entity = orphan + recreate, **unless** you declare the move in
  [`renames`](#14-renames).

---

## 6. Composition & dependencies (the graph)

Entities form a DAG. There are a few ways to express a relationship; they all compile to the
**same graph**. Reach for them in this order:

### 6.1 Implicit edges via typed refs (the 90% path)

Reference another entity's output (`entity.id`, `entity.env.field`). The edge is inferred
automatically, and the value is typed.

```ts
const project = new Project({ name: "todo-app", region: "aws-us-east-1" });

const db = new Postgres({
	name: "todo-db",
	projectId: project.id, // Ref<string> → edge project → db, resolved at provision time
});

const fn = new Function({
	name: "todo-api",
	projectId: project.id,
	source: "src/api/index.ts",
	env: {
		DATABASE_URL: db.env.databaseUrl, // Ref<string> → edge db → fn, fully type-safe
	},
});
```

### 6.2 Bulk env wiring via `toEnv()` spread

When a consumer wants **all** of another entity's env (not one field), spread `entity.toEnv()` —
an OS-keyed bundle of refs. Because the values are refs, the spread also **creates the edge**:

```ts
const web = new VercelProject({
	name: "todo-web",
	env: {
		...db.toEnv(), // → { DATABASE_URL, DATABASE_URL_UNPOOLED } (edges db → web)
		...auth.toEnv(), // → { NEON_AUTH_BASE_URL, NEON_AUTH_JWKS_URL }
		ANALYTICS_DATABASE_URL: analytics.env.databaseUrl, // single-field grab / rename
	},
});
```

Object spread is plain JS: **duplicate keys silently last-win**. If you want a collision to throw,
use `mergeEnv` (§9.4) instead of spread:

```ts
env: mergeEnv(db.toEnv(), analytics.toEnv()); // throws if both expose DATABASE_URL
```

> **No standalone ordering option (yet).** Edges are inferred **only** from refs (`entity.id`,
> `entity.env.*`, `entity.toEnv()`). If you ever need ordering with no data flowing, reference any
> output of the dependency (even just `.id`). A dedicated ordering option can be re-added later if a
> real need emerges.

### 6.3 Nesting (grouping + constraints)

A parent can **own and constrain** its children — e.g. enforce a single Postgres per Project, and
auto-inject `projectId`. Nesting is sugar that registers the children in the same graph and wires
the parent ref for you.

```ts
const project = new Project({
	name: "todo-app",
	region: "aws-us-east-1",
	postgres: new Postgres({ name: "todo-db" }), // projectId injected by the parent
	dataApi: new DataAPI({ name: "todo-dataapi" }), // Project can enforce: at most one of each
});

export default defineInfra({ entities: [project] }); // children registered transitively
```

### 6.4 Rules

- **Both flat and nested are supported** and produce identical graphs. Pick flat for cross-
  provider/independent wiring; pick nesting when a parent must own/constrain children.
- The engine **collects** all entities by walking `defineInfra({ entities })` plus every nested
  child, deduplicating by identity.
- **Cycles are a hard error** ("two entities can't depend on each other") — detected before any
  I/O, naming the cycle.
- Independent entities (no path between them) **may be provisioned in parallel**; dependents wait
  for their dependencies' `provision` (and `afterApply` hooks) to complete.

---

## 7. Environments

Every command runs against an **environment** (a string). Selection precedence:

```
--env  >  INFRA_ENV  >  defaultEnvironment  >  "local"
```

The environment selects:

- the **credentials** (`loadEnv(environment)` / `credentials(environment)`),
- the **state file** `.infra.<environment>`,
- the **env file** `.env.<environment>`,
- any **dynamic config** an entity computes via `configure(environment)`.

### 7.1 infra-ts never reads `NODE_ENV` (decided)

The environment selector is **dedicated** (`--env` / `INFRA_ENV` / `defaultEnvironment`) and infra-ts
**never** reads `NODE_ENV` — not even as a fallback. Reasons:

- **`NODE_ENV` is overloaded and effectively closed** to `production | development | test` (Next.js
  even locks it). Our environments are open-ended (`local`, `preview`, `staging`, `prod-eu`,
  per-developer envs) and can't be expressed in it.
- **It's a footgun for a tool that mutates infrastructure.** `NODE_ENV` is auto-set to `production`
  in many contexts (`next build`, CI images, `npm ci --production`, Docker bases). Inheriting it
  would let `infra apply` **silently target production**. The default must be the safe environment
  (`local`); production is always an explicit opt-in.
- **Infra tools use their own selector** — Terraform workspaces, Pulumi stacks, SST/Serverless
  `--stage`, Rails `RAILS_ENV`, Vercel `VERCEL_ENV` (Vercel sets `NODE_ENV=production` for _both_
  production and preview, which is exactly why it added a separate `VERCEL_ENV`). infra-ts is in
  this category. `NODE_ENV` describes _how the app runs_; infra-ts's environment describes _which
  infrastructure you're managing_.

**Naming (recommended, not enforced):** prefer the vocabulary `production | preview | development |
local` so the written `.env.<environment>` files line up with what frameworks (Next/Vite/…) load at
runtime — the _values_ align even though the _selector_ doesn't. Any string is allowed.

### 7.2 The static-env-set invariant (critical)

> **An entity's set of env keys is static — identical across every environment.** Only the
> _values_ differ per environment.

Dynamic config (below) may change _how_ a resource is provisioned per environment, but it **must
not** change which env vars the entity exposes (that's fixed by `envSchema`). If you need a
different env shape, that's a different entity — split it.

```ts
const dataApi = new DataAPI({
	name: "todo-dataapi",
	projectId: project.id,
	// Per-environment provisioning config — allowed.
	configure: (environment) => ({
		corsOrigins:
			environment === "production"
				? ["https://todo.app"]
				: ["http://localhost:3000"],
	}),
	// ❌ configure() must NOT change the env *set* (envSchema is static).
	// If prod needs different env keys than preview, make sub-entities instead.
});
```

This invariant is what keeps `parseEnv` (the runtime typed env) sound regardless of which
environment an app boots in.

---

## 8. Credentials

Two schemas exist and never cross:

- **`credentialsSchema`** = the **inputs infra-ts needs to provision** (e.g. `NEON_API_KEY`).
- **`envSchema`** = the **outputs an entity emits** (e.g. `databaseUrl`). _(See §9.)_

Do not validate inputs against output schemas.

### 8.1 Resolution order (per entity, per run)

1. `loadEnv(environment)` produces the run's input bag (defaults to `process.env`).
2. Credentials are merged: `{ ...defineInfra.credentials, ...entity.credentials }` (entity-level
   shallow-merges over global). Either side may be a function of `environment`.
3. The merged slice is **validated against the entity's `credentialsSchema`** → typed
   `ctx.credentials`.
4. **Fallback auto-resolution:** if a required credential is absent, the entity may resolve it
   itself (e.g. Neon → `neonctl` OAuth cache; Vercel → `vercel` CLI token). This keeps zero-config
   working — you don't have to wire `credentials` for the common local case.

```ts
class Postgres extends Entity<{ NEON_API_KEY: string }, …> {
  credentialsSchema = z.object({ NEON_API_KEY: z.string().min(1) });

  async provision(ctx) {
    const api = new NeonApi({ token: ctx.credentials.NEON_API_KEY }); // typed
    …
  }
}
```

### 8.2 Rules

- **Credentials are never written to `.infra` state** (§10) or echoed in logs.
- Credentials are **environment-scoped** — prod and preview can use different keys/orgs.

### 8.3 Accounts — provider scope + linking

Before infra-ts can provision anything it needs to know **which account/org/team to provision
into** — base identity that exists _before_ the first `apply` and is **per-developer**, so it must
not be hardcoded in `infra.ts`. This is modeled as an **Account node**: a first-class entity that
owns a provider's auth anchor and scope.

```ts
import { NeonAccount, NeonProject, NeonPostgres } from "@infra-ts/neon";

const personal = new NeonAccount({ name: "personal" });
const work = new NeonAccount({ name: "work" });

const project = new NeonProject({ name: "app", org: personal.id }); // org from the account
const db = new NeonPostgres({ name: "app-db", projectId: project.id });
const tools = new NeonProject({ name: "tools", org: work.id });

export default defineInfra({ entities: [personal, work, project, db, tools] });
```

An Account:

- **Is a named entity** (`new NeonAccount({ name })`) — the `name` is its identifier and the key
  under which its scope lives in `.infra.<env>` (`entities.personal = { scopeId: "org-…" }`).
  Two accounts ⇒ two names; duplicate names are the usual hard error.
- **Exposes `account.id`** = the bound scope id (e.g. a Neon `org-…` / Vercel `team_…`). Entities
  wire it where they'd otherwise hardcode an org/team: `org: personal.id`. That ref creates the
  edge, so the account resolves first.
- **Is bound by `infra-ts link`, not `apply`.** `link` lists your orgs/teams (via the authed CLI /
  REST), you pick one, and the id is written to `.infra.<env>` under the account name. `apply`
  reads it; the account's `provision` **creates no remote resource** — it just verifies a scope is
  bound (else errors _“run `infra-ts link <name>`”_) and never deletes the org on `destroy`.
- **Anchors auth.** `infra-ts login` authenticates the account's provider (CLI OAuth passthrough
  for Neon/Vercel; see §8.1 fallback). Credentials resolve per account: explicit option → creds
  store keyed by account name → provider env var → CLI cache.

**Multi-account credentials.** The common case is _one login, many orgs_ — entities share the
cached token and differ only by `account.id`, which works out of the box. Two genuinely separate
logins need per-account tokens (`new NeonAccount({ name: "work", apiKey: process.env.WORK_NEON_API_KEY })`),
since a provider CLI holds a single cached session.

**Auto-bind.** When exactly one account of a provider is present, entities may omit the scope ref;
with two or more, it becomes required (else a clear error names the candidates).

---

## 9. Environment variables (typed env)

### 9.1 Logical keys + conventional serialization

- `envSchema` keys are **logical camelCase** (`databaseUrl`, `databaseUrlUnpooled`). That's what
  you read in code and wire across entities (`db.env.databaseUrl` is a `Ref<string>`).
- On disk, each key is written to `.env.<env>` using **camelCase → CONSTANT_CASE** by default:
  `databaseUrl → DATABASE_URL`, `databaseUrlUnpooled → DATABASE_URL_UNPOOLED`.

### 9.2 Renaming OS keys (escape hatch) — **keys only, never values**

The override exists so you can change the on-disk name. It **must remain a bijective key rename**
(values pass through unchanged) so `parseEnv` can read the env back into the logical shape. A
value-transforming callback would make the env unreadable at runtime and is therefore **not**
allowed as the standard override.

```ts
new Postgres({
	name: "cache-db",
	// logical key → custom OS var name. Unspecified keys keep the CONSTANT_CASE default.
	envNames: { databaseUrl: "CACHE_DATABASE_URL" },
});

// or the callback form (returns a NAME, never a value):
new Postgres({
	name: "cache-db",
	envName: (key) => `CACHE_${constantCase(key)}`,
});
```

Write (`apply`/`checkout`): `osKey = envNames[key] ?? envName?.(key) ?? constantCase(key)` →
`OS_KEY=value`.
Read (`parseEnv`): for each logical key, read `process.env[osKey]`, validate via `envSchema`,
return `{ databaseUrl: … }`. Bijective ⇒ round-trips.

### 9.3 Collisions

Collisions are handled at **two independent layers**:

1. **Automatic layer — the `.env.<env>` union.** When the engine writes every entity's own env to
   `.env.<env>`, it **detects duplicate OS keys across all entities and crashes loud**, naming the
   conflicting entities. You didn't ask for the overlap, so it's an error. The fix is the rename
   override (§9.2) — so the rename feature _is_ the collision remedy.
2. **Explicit layer — a consumer's `env`.** When you build a consumer's `env` yourself, you own the
   merge. A plain object spread (`{ ...a.toEnv(), ...b.toEnv() }`) is JS — **duplicate keys silently
   last-win**. Opt into a loud merge with `mergeEnv` (§9.4).

> Authoring note: avoid acronym **runs** in logical keys (`databaseUrl` ✅; `databaseURL` →
> messy CONSTANT_CASE). Use the override for anything unusual.

### 9.4 Spreading an entity's env into a consumer (`toEnv` + `mergeEnv`)

`entity.toEnv()` returns the entity's whole env as an **OS-keyed bundle of refs** (applying any
`envNames`/`envName` rename), so you can spread it straight into a consumer's `env`:

```ts
import { mergeEnv } from "infra-ts";

new VercelProject({
	name: "web",
	env: {
		...db.toEnv(), // { DATABASE_URL: Ref, DATABASE_URL_UNPOOLED: Ref }
		...auth.toEnv(), // { NEON_AUTH_BASE_URL: Ref, NEON_AUTH_JWKS_URL: Ref }
		CUSTOM_URL: db.env.databaseUrl, // single-field grab (camelCase typed accessor)
	},
});
```

- `entity.toEnv()` → spread the **whole** entity (OS keys). Carries refs ⇒ creates the edge.
- `entity.env.field` → grab **one** field by its logical name (typed `Ref`), e.g. to rename it.
- `mergeEnv(...maps)` → merge OS-keyed maps and **throw on any overlapping key** (the loud
  alternative to silent spread):

```ts
env: mergeEnv(db.toEnv(), analytics.toEnv()); // ✗ throws if both define DATABASE_URL
```

There is intentionally **no** `prefix`/`rename`/`only` DSL: it's just TypeScript — spread,
destructure, and override with the single-field accessor.

---

## 10. State (`.infra.<env>`)

The **only** thing infra-ts persists. Per environment, a JSON file `.infra.<environment>` mapping
entity id → its `state` (validated by `stateSchema`).

```jsonc
// .infra.production
{
	"version": 2,
	"environment": "production",
	"entities": {
		"todo-app": { "projectId": "quiet-snow-68514765", "orgId": "org-…" },
		"todo-db": { "branchId": "br-…", "endpointId": "ep-…" },
		"todo-api": { "functionId": "fn-…", "sourceHash": "9f2c…" },
	},
}
```

Rules:

- **Bindings + content hashes only — never secrets.** (Ids, org/project/branch ids, source
  hashes for idempotent deploys.) This is what makes it safe to commit.
- **Per-environment gitignore strategy:** ignore `.infra.local` / `.infra.preview`; **commit
  `.infra.production`** so the team targets the same prod resources. Safe because it's only ids.
- State is written **incrementally** during `apply` (the moment an entity records ids) so a
  mid-run failure never orphans a just-created resource.
- Light concurrency note: committed prod state is shared, but two simultaneous prod applies don't
  corrupt anything — reconcile reads remote live; state is just ids. No locking needed (that's the
  payoff of keeping no attribute state — only identity).

---

## 11. Lifecycle in detail

### 11.1 `read(ctx) → Remote | null`

Fetch the live remote using `ctx.state` ids. `null` means "does not exist remotely". Used by both
`status` (render `remote`) and `plan` (feed `diff`). No mutations.

### 11.2 `diff(remote, ctx) → Change[]` (pure)

Compare the entity's desired config to `remote`. Return the changeset. **Pure** — no I/O — so
`plan`/`status`/`checkout` are side-effect-free and deterministic.

### 11.3 `provision(ctx) → { action, state, env, message? }`

Idempotent reconcile (create **and** update). Returns:

- `action`: `"create"` (didn't exist), `"update"` (drift fixed), or `"noop"` (already matched).
- `state`: the new persisted binding.
- `env`: the resolved logical env this entity exposes.

```ts
async provision(ctx) {
  const existing = ctx.state?.projectId ? await this.read(ctx) : null;
  if (!existing) {
    const project = await api.createProject(this.config);
    return {
      action: "create",
      state: { projectId: project.id, orgId: project.orgId },
      env: { /* none for a bare project */ },
    };
  }
  const drift = this.diff(existing, ctx);
  if (drift.length === 0) return { action: "noop", state: ctx.state!, env: {} };
  await api.update(/* … */);
  return { action: "update", state: ctx.state!, env: {} };
}
```

### 11.4 Deployments & content-hash idempotency

For entities that deploy **code** (a `Function`), "idempotent" means "ensure the latest source is
deployed". Store a **source hash** in `state` and short-circuit to `action: "noop"` when it's
unchanged:

```ts
async provision(ctx) {
  const bundle = await bundle(this.config.source);
  const sourceHash = sha256(bundle);
  if (ctx.state?.sourceHash === sourceHash) {
    return { action: "noop", state: ctx.state, env: this.envFor(ctx) };
  }
  const fn = await api.deploy(this.config.name, bundle);
  return {
    action: ctx.state ? "update" : "create",
    state: { functionId: fn.id, sourceHash },
    env: this.envFor(ctx),
  };
}
```

### 11.4.1 Command-backed entities (transport is the entity's choice)

An entity's lifecycle may talk to its provider over **REST**, a **vendor CLI**, or **both** — the
engine is transport-agnostic (it only calls the lifecycle methods). Use REST for **reconciled
config** (projects, env, domains); for **imperative, vendor-owned actions** (build + deploy) the
vendor CLI _is_ the reference implementation, so delegating to it matches default behavior exactly
rather than re-implementing it. (`infra login` already drives the provider's OAuth CLI.)

Two capabilities make this first-class:

- **`ctx.exec(command, { cwd?, env?, input? })`** — the runtime injects the entity's resolved
  credentials as env (so e.g. `VERCEL_TOKEN` is present without leaking on the command line),
  streams stderr, captures stdout, and throws `InfraError` on a non-zero exit. Available to
  `provision`/`pullEnv`/`deprovision`; keep `read`/`diff` read-only.
- **`requiredTools(): CliTool[]`** — declare the CLIs an entity needs (`{ id, detect, npx?,
install? }`). `login`/`link` (and a CLI-apply preflight) detect them, prefer ephemeral
  `npx`/`bunx` (no global install), and offer a **confirmed** global install otherwise.

Command-backed entities still obey the full contract: persist **only identity state** (capture the
CLI's output id/url; never adopt its own state files like `.vercel/project.json` — inject ids via
env so `.infra` stays the single source of truth), stay **idempotent** (content hash, above), and
emit **typed env**. `VercelDeployment` is the first example: it defaults to `vercel pull` → `build`
→ `deploy --prebuilt` (the documented CI flow), with a `mode: "rest"` source-upload fallback.

### 11.5 `deprovision(ctx)`

Tear the resource down. Called by `destroy` and by prune (§15). Destructive; never called by
`apply`'s normal path. Command-backed deployments typically **no-op** here — a deployment is
immutable history backing the live alias, not something to auto-delete.

---

## 12. `checkout` & drift

`infra checkout` resolves and writes the typed `.env.<environment>` from the **live remote**
without provisioning — for switching environments or refreshing credentials. It also runs a
**drift guard**: if the live remote differs from your declared config, it errors (so you don't
develop against an env that no longer matches your `infra.ts`).

```bash
infra checkout --env preview              # pull env + guard against drift
infra checkout --env preview --ignore-diff # pull anyway, skip the guard
```

### 12.1 Two independent layers (why `--ignore-diff` doesn't break type-safety)

- **checkout drift guard** answers _"does my config match the live remote?"_ — `--ignore-diff`
  skips it.
- **runtime `parseEnv`** (§18) answers _"are the env vars present & valid per `envSchema`?"_ —
  **always on**, at app boot.

So `--ignore-diff` only moves _where_ you find out about a mismatch (a boot-time `parseEnv` throw
instead of a checkout-time error). It never hands your app an untyped/incomplete env. Because
env sets are static per entity (§7.2), the validated shape is stable across environments.

---

## 13. Hooks

Imperative side effects bracketing the CLI commands you run. Hook names mirror the commands
one-to-one (`apply`, `checkout`, `destroy`), each with a `before*` and `after*` phase. **Hooks
never run during `plan` / `status`** — that's what keeps those read-only and deterministic. A hook
is a function or a shell command (string / string[]); shell hooks run non-interactively (`CI=1`,
stdin detached) with the resolved env injected.

```ts
interface EntityHooks<Env, State> {
	/** Before this entity is provisioned during `infra apply`. */
	beforeApply?: Hook<{ environment: string }>;
	/** After provision + env resolution. Gets the full provision result (typed env). */
	afterApply?: Hook<{
		environment: string;
		action: ChangeAction;
		state: State;
		env: Env;
	}>;
	/** Around `infra checkout` (pulling typed env from the live remote). */
	beforeCheckout?: Hook<{ environment: string }>;
	afterCheckout?: Hook<{ environment: string; env: Env }>;
	/** Around `infra destroy` (deprovision). */
	beforeDestroy?: Hook<{ environment: string }>;
	afterDestroy?: Hook<{ environment: string }>;
}

type Hook<Ctx> = ((ctx: Ctx) => void | Promise<void>) | string | string[];
```

The keys are **flat and named after the CLI verbs** (`infra apply` ⇒ `beforeApply`/`afterApply`),
so there's no command-to-event mapping to learn. (There is intentionally no `.on()` registration —
hooks are declarative data on the entity, not imperatively registered callbacks.)

Canonical example — migrate right after the DB is provisioned, ordered before dependents:

```ts
const db = new Postgres({
	name: "todo-db",
	projectId: project.id,
	hooks: {
		afterApply: async ({ env }) => {
			await drizzleMigrate(env.databaseUrlUnpooled); // typed env
		},
	},
});

const fn = new Function({
	name: "todo-api",
	source: "…",
	env: { DATABASE_URL: db.env.databaseUrl }, // ref ⇒ edge: db.provision + db.afterApply run first
});
```

---

## 14. Renames

In-place identity migrations so renaming an entity doesn't orphan + recreate its remote resource.

```ts
export default defineInfra({
	entities: [project, db],
	renames: [{ old: "todo-postgres", new: "todo-db" }],
});
```

Semantics:

- Before reconciling, the engine **re-keys** `.infra.<env>` state from `old` → `new`.
- **Idempotent & safe to leave in:** if `old` isn't in state, it's a no-op. You don't have to
  remove the entry after it applies.
- **Hard error** if both `old` and `new` already exist in state (ambiguous), or if `new` is not a
  declared entity.
- (Prior art: Terraform `moved` blocks; `renames` is the same idea with a clearer name.)

---

## 15. Deletion / pruning

Because every entity is individually tracked in `.infra.<env>`, infra-ts can safely detect
**entity-in-state-but-not-in-config** and offer to remove it (the thing the v1 additive model
could not do).

- `infra apply` reports orphaned entities and, with `--prune` (or interactive confirm),
  `deprovision`s them in reverse dependency order.
- Pruning is **destructive** ⇒ opt-in / confirmed; never silent.
- `infra destroy` deprovisions **all** declared + state-known entities (reverse topo order).

---

## 16. The engine algorithm

For every command, the engine:

1. **Load** `infra.ts` (jiti) → `defineInfra` result.
2. **Resolve environment**: `--env` → `INFRA_ENV` → `defaultEnvironment` → `"local"`.
3. **Collect entities**: walk `entities` + nested children; dedupe by identity.
4. **Validate graph** (pure, before any I/O):
   - duplicate ids → error;
   - cycles → error;
   - compute each entity's OS env keys (default + overrides) → duplicate OS keys across entities →
     error.
5. **Topologically sort** by edges (inferred from refs + nesting).
6. **Load inputs**: `loadEnv(environment)`; build per-entity credentials (merge + validate).
7. **Read state** `.infra.<environment>`; **apply `renames`** (re-key).
8. **Per entity, in topo order** (independent entities may run in parallel):
   - resolve any `Ref`s in its options from already-provisioned outputs;
   - **`plan` / `status`**: `read` → `diff` (or render remote); collect `Change[]`. _No mutations,
     no hooks, no state writes._
   - **`apply`**: run `provision.before` hook → `provision(ctx)` → persist returned `state` to
     `.infra.<env>` immediately → record `env` outputs for dependents → run `afterApply` hook.
   - **`destroy` / prune**: `deprovision` in reverse order; remove from state.
9. **Write env**: merge every entity's `env` → OS keys → `.env.<environment>` (merge-in-place,
   preserving unmanaged lines). Skipped for `plan` / `status`.
10. **`checkout`**: like a read-only env resolve + drift guard (§12), then write `.env.<env>` and
    run `checkout.*` hooks.

State is written incrementally (step 8) so a failure never leaks an untracked resource.

---

## 17. CLI surface

Everything is also an SDK function (`import { apply, plan, … } from "infra-ts"`).

| Command                                    | Description                                                         |
| ------------------------------------------ | ------------------------------------------------------------------- |
| `infra login [provider…]`                  | Authenticate each account's provider (CLI OAuth passthrough). §8.3  |
| `infra link [account…] [--env e]`          | Pick an org/team per account; write the scope to `.infra.<e>`. §8.3 |
| `infra plan [--env e]`                     | Dry run: the changes `apply` would make. No mutations, no hooks.    |
| `infra apply [--env e] [--prune]`          | Reconcile remote to `infra.ts`; write `.env.<e>`; run hooks.        |
| `infra status [--env e]`                   | Live state of every entity. Read-only.                              |
| `infra checkout [--env e] [--ignore-diff]` | Pull typed `.env.<e>` from remote + drift guard.                    |
| `infra destroy [--env e] [-y]`             | Deprovision all entities (reverse order). Destructive.              |
| `infra run [--env e] -- <cmd>`             | Resolve env and inject into a child process (nothing written).      |

Global: `--env`, `--json`, `--only <ids…>`, `--cwd`, `--config`, `--verbose`.

The typical first-run flow is **`infra login` → `infra link` → `infra apply`**: authenticate, bind
each account to an org/team, then provision.

---

## 18. Runtime: `parseEnv`

The app-side counterpart to `checkout`. Synchronous, network-free, and **environment-agnostic** —
it takes no `environment` argument and never reads `NODE_ENV`. By app-boot time your framework has
already loaded the right `.env.<env>` (via its own conventions), so `parseEnv` just reads
`process.env` and validates it against the **union of every entity's `envSchema`**, returning the
typed env **namespaced by entity id**.

```ts
import infra from "./infra";
import { parseEnv } from "infra-ts";

const env = parseEnv(infra); // throws (listing every missing/invalid var) if not satisfied
env["todo-db"].databaseUrl; // string, typed
env["todo-api"].someKey; // string, typed
```

- Namespacing by entity id avoids logical-key collisions and mirrors config-time
  `entity.env.databaseUrl`.
- The OS-key mapping (default CONSTANT_CASE + per-entity overrides, §9) is applied in reverse to
  reconstruct the logical shape — works because the mapping is a bijective key rename.
- This is the layer that keeps runtime type-safety intact even when `checkout --ignore-diff` was
  used (§12.1).

---

## 19. Worked examples

### 19.1 Neon: project + Postgres + Auth + Data API (flat)

```ts
import { defineInfra } from "infra-ts";
import { Project, Postgres, Auth, DataAPI } from "@infra-ts/neon";

const project = new Project({
	name: "todo-app",
	region: "aws-us-east-1",
	compute: { minCu: 0.25, maxCu: 1, suspendTimeout: "5m" },
});

const db = new Postgres({ name: "todo-db", projectId: project.id });
const auth = new Auth({ name: "todo-auth", projectId: project.id });
const dataApi = new DataAPI({
	name: "todo-dataapi",
	projectId: project.id,
	authProvider: auth.id, // Data API verifies tokens from this Auth → edge auth → dataApi
});

export default defineInfra({ entities: [project, db, auth, dataApi] });
```

`.env.local` after `apply` (logical → OS keys):

```
DATABASE_URL=…           # todo-db.databaseUrl
DATABASE_URL_UNPOOLED=…  # todo-db.databaseUrlUnpooled
AUTH_BASE_URL=…          # todo-auth.baseUrl
AUTH_JWKS_URL=…          # todo-auth.jwksUrl
DATA_API_URL=…           # todo-dataapi.url
```

### 19.2 Cross-provider: Neon → Vercel

```ts
import { defineInfra } from "infra-ts";
import { Project, Postgres } from "@infra-ts/neon";
import { VercelProject } from "@infra-ts/vercel";

const project = new Project({ name: "todo-app", region: "aws-us-east-1" });
const db = new Postgres({ name: "todo-db", projectId: project.id });

const web = new VercelProject({
	name: "todo-web",
	framework: "nextjs",
	settings: { buildCommand: "next build", nodeVersion: "20.x" },
	env: { DATABASE_URL: db.env.databaseUrl }, // typed cross-provider wiring
});

export default defineInfra({ entities: [project, db, web] });
```

### 19.3 Nested style + singleton enforcement

```ts
const project = new Project({
	name: "todo-app",
	region: "aws-us-east-1",
	postgres: new Postgres({ name: "todo-db" }), // Project injects projectId
	// new Postgres again here → Project constructor throws (singleton)
});

export default defineInfra({ entities: [project] });
```

### 19.4 Code deployment wired by refs + a migration hook

```ts
import { Redis } from "@infra-ts/upstash";
import { Project, Postgres, Function } from "@infra-ts/neon";

const project = new Project({ name: "todo-app", region: "aws-us-east-1" });
const cache = new Redis({ name: "todo-cache" });

const db = new Postgres({
	name: "todo-db",
	projectId: project.id,
	hooks: {
		afterApply: async ({ env }) => drizzleMigrate(env.databaseUrlUnpooled),
	},
});

const api = new Function({
	name: "todo-api",
	projectId: project.id,
	source: "src/api/index.ts",
	env: {
		// typed refs → edges + values; db's afterApply migration runs before this deploy
		DATABASE_URL: db.env.databaseUrl,
		REDIS_URL: cache.env.redisUrl,
	},
});

export default defineInfra({ entities: [project, cache, db, api] });
```

### 19.5 Multiple environments

```bash
infra apply --env preview     # → .infra.preview + .env.preview, preview org creds
infra apply --env production  # → .infra.production (committed) + .env.production
infra checkout --env preview  # pull preview env locally
```

```ts
const project = new Project({
	name: "todo-app",
	region: "aws-us-east-1",
	configure: (environment) => ({
		// VALUES vary by env; the env *set* never does (§7.2)
		compute:
			environment === "production"
				? { minCu: 0.5, maxCu: 4, suspendTimeout: false }
				: { minCu: 0.25, maxCu: 1, suspendTimeout: "5m" },
	}),
});
```

---

## 20. Authoring an entity (provider author guide)

A minimal, complete entity. Note: pure constructor, Standard Schema fields, `read` + pure `diff`

- idempotent `provision`, and credentials resolved from the typed `ctx`.

```ts
import { Entity, type Change, constantCase } from "@infra-ts/core";
import { z } from "zod";
import { NeonApi } from "./api.js";

interface PostgresOptions {
	name: string;
	projectId: string | Ref<string>; // accept a literal or a ref
}

export class Postgres extends Entity<
	{ NEON_API_KEY: string }, // Creds
	{ databaseUrl: string; databaseUrlUnpooled: string }, // Env (logical)
	{ branchId: string; endpointId: string }, // State
	{ branchId: string; computeMinCu: number } // Remote
> {
	readonly name: string;
	constructor(private readonly options: PostgresOptions) {
		super();
		this.name = options.name; // stable id; no I/O here
	}

	readonly credentialsSchema = z.object({ NEON_API_KEY: z.string().min(1) });
	readonly envSchema = z.object({
		databaseUrl: z.string().url(),
		databaseUrlUnpooled: z.string().url(),
	});
	readonly stateSchema = z.object({
		branchId: z.string(),
		endpointId: z.string(),
	});

	async read(ctx) {
		if (!ctx.state) return null;
		const api = new NeonApi({ token: ctx.credentials.NEON_API_KEY });
		return api.readBranch(this.config.projectId, ctx.state.branchId); // Remote | null
	}

	diff(remote, _ctx): Change[] {
		if (!remote)
			return [{ action: "create", kind: "postgres", identifier: this.name }];
		// …compare desired compute vs remote.computeMinCu, etc. (pure)
		return [];
	}

	async provision(ctx) {
		const api = new NeonApi({ token: ctx.credentials.NEON_API_KEY });
		// this.config: refs already resolved → projectId is a string here
		const branch = ctx.state
			? await api.getBranch(this.config.projectId, ctx.state.branchId)
			: await api.createBranch(this.config.projectId, this.name);
		const env = await api.connectionStrings(branch.id);
		return {
			action: ctx.state ? "noop" : "create",
			state: { branchId: branch.id, endpointId: branch.endpointId },
			env: { databaseUrl: env.pooled, databaseUrlUnpooled: env.direct },
		};
	}

	async deprovision(ctx) {
		if (!ctx.state) return;
		const api = new NeonApi({ token: ctx.credentials.NEON_API_KEY });
		await api.deleteBranch(this.config.projectId, ctx.state.branchId);
	}
}
```

`@infra-ts/core` provides: `Entity`, `Ref` / output helpers, `constantCase`, the REST client
(`createRestClient`), `InfraError` / `ErrorCode`, the Standard Schema plumbing, and the engine
(`plan` / `apply` / `status` / `checkout` / `destroy` / `parseEnv`). Providers depend only on
`@infra-ts/core`.

---

## 21. Open questions / future

- **Parallelism policy.** Independent entities _may_ run in parallel; default concurrency limit
  and whether it's opt-in for the first cut is TBD.
- **Write-only / derived env.** A value-transforming or combining output (e.g. a composed DSN)
  can't round-trip through `parseEnv`, so it's intentionally **not** part of the standard rename
  override. If demand appears, add an explicit `writeOnlyEnv` that's emitted to `.env` but
  excluded from the typed runtime env.
- **`moved`/rename ergonomics.** Possibly support per-entity `previousNames` in addition to the
  top-level `renames` list.
- **Drift granularity in `status`.** How much per-field diff detail to render by default vs behind
  `--verbose` / `--json`.
- **First implementation scope.** Land the contract + engine with one provider re-expressed as
  entities (Neon: `Project` / `Postgres` / `Auth` / `DataAPI`) before going wide, then Vercel,
  then experimental Neon (buckets/functions/AI gateway) and a third-party (Upstash) to prove the
  open standard.
