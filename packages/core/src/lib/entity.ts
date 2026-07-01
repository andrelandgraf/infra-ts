import type { Logger } from "./logger.js";
import {
	collectRefEntities,
	deepResolve,
	type EnvRefs,
	envRefs,
	idRef,
	type Ref,
	type Resolved,
	type ResolvedOutputs,
} from "./ref.js";
import type { StandardSchemaV1 } from "./standard-schema.js";
import { type EnvKeyOverride, osKeyFor } from "./env-keys.js";

export type ChangeAction = "create" | "update" | "delete" | "noop";

/** One planned/applied change, rendered by `plan` / `apply` / `status`. */
export interface Change {
	/** Owning entity id (set by the engine when rendering). */
	provider?: string;
	action: ChangeAction;
	/** Resource kind, e.g. "project", "compute", "env-var". */
	kind: string;
	/** Human-readable identifier, e.g. "todo-db" or "env:DATABASE_URL". */
	identifier: string;
	/** One-line summary. */
	detail?: string;
	/** Structured extras for `--json`. */
	data?: Record<string, unknown>;
}

export interface ProvisionResult<
	Env extends Record<string, string>,
	State extends Record<string, unknown>,
> {
	action: ChangeAction;
	/**
	 * The canonical remote id this entity exposes via `entity.id` (e.g. the Neon project id).
	 * Defaults to the entity's `name` when omitted.
	 */
	id?: string;
	/** Persisted to `.infra/<env>.json`. */
	state: State;
	/** Logical typed env this entity exposes. */
	env: Env;
	message?: string;
}

/** A lifecycle hook: a function, or a shell command (string / string[]). */
export type Hook<Ctx> =
	| ((ctx: Ctx) => void | Promise<void>)
	| string
	| string[];

/**
 * Per-entity lifecycle hooks. Keys mirror the CLI commands (`apply`, `checkout`, `destroy`), each
 * with a `before*`/`after*` phase. Declarative data — not imperatively registered. Hooks never run
 * during `plan`/`status`.
 */
/**
 * Common fields every hook receives. `rootDir`/`cwd` (same value) anchor relative paths to the
 * config's root — function hooks should resolve paths against these, since (unlike shell hooks,
 * which run with `cwd: rootDir`) they execute in-process with the ambient `process.cwd()`.
 */
export interface HookContext {
	environment: string;
	/** The directory containing the resolved `infra.ts`. */
	rootDir: string;
	/** Alias of `rootDir`, for readability. */
	cwd: string;
}

export interface EntityHooks<
	Env extends Record<string, string>,
	State extends Record<string, unknown>,
> {
	/** Before this entity is provisioned during `infra apply`. */
	beforeApply?: Hook<HookContext>;
	/** After provision + env resolution; receives the full provision result (typed env). */
	afterApply?: Hook<
		HookContext & {
			action: ChangeAction;
			state: State;
			env: Env;
		}
	>;
	/** Around `infra checkout` (pulling typed env from the live remote). */
	beforeCheckout?: Hook<HookContext>;
	afterCheckout?: Hook<HookContext & { env: Env }>;
	/** Around `infra destroy` (deprovision). */
	beforeDestroy?: Hook<HookContext>;
	afterDestroy?: Hook<HookContext>;
}

/** Common fields every entity's options object carries (alongside provider-specific config). */
export interface EntityCommon<
	Env extends Record<string, string> = Record<string, string>,
	State extends Record<string, unknown> = Record<string, unknown>,
> {
	/** Stable, unique id (config-only, deterministic). */
	name: string;
	/** Imperative side-effect hooks bracketing provision / checkout. */
	hooks?: EntityHooks<Env, State>;
	/** Rename specific env vars on disk (logical → OS key). Values pass through. */
	envNames?: Record<string, string>;
	envName?: (key: string) => string;
}

/** Result of running a subprocess via {@link Exec}. */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}
/** Options for {@link Exec}. */
export interface ExecOptions {
	cwd?: string;
	/** Extra env merged over `process.env` + the entity's resolved credentials. */
	env?: Record<string, string>;
	/** Data to write to stdin. */
	input?: string;
}
/**
 * Run a vendor CLI from inside an entity (the runtime injects the entity's resolved credentials as
 * env, so e.g. `VERCEL_TOKEN` is present without leaking it on the command line). Throws
 * `InfraError` on a non-zero exit. Use this for **command-backed** entities (deploys, etc.); keep
 * `read`/`diff` read-only.
 */
export type Exec = (
	command: string[],
	options?: ExecOptions,
) => Promise<ExecResult>;

/** A vendor CLI an entity/account depends on — detected (and optionally installed) by the engine. */
export interface CliTool {
	/** Stable id for dedup, e.g. "vercel". */
	id: string;
	/** Command that exits 0 when the tool is available, e.g. `["vercel", "--version"]`. */
	detect: string[];
	/** Package spec for ephemeral `npx`/`bunx` execution (preferred; no global install). */
	npx?: string;
	/** Command to install the tool globally (run only after confirmation). */
	install?: string[];
}

export interface BaseContext<Creds> {
	environment: string;
	credentials: Creds;
	logger: Logger;
	/** Runs a vendor CLI with resolved credentials injected as env. Provided by the runtime. */
	exec?: Exec;
}
export interface ReadContext<Creds, State> extends BaseContext<Creds> {
	state: State | null;
}
export interface DiffContext {
	environment: string;
}
export interface ProvisionContext<Creds, State> extends BaseContext<Creds> {
	state: State | null;
}

/**
 * A provisionable resource — the unit of infra-ts. Subclass this to wrap a remote REST resource.
 * Constructor is **pure** (stores options); the engine drives the lifecycle. Refs in options are
 * resolved to concrete values before lifecycle methods run, available via {@link config}.
 *
 * @typeParam O      - the options object (provider-specific config + {@link EntityCommon}).
 * @typeParam Creds  - credentials (validated against {@link credentialsSchema} → typed `ctx.credentials`).
 * @typeParam Env    - the typed env this entity outputs (logical camelCase keys).
 * @typeParam State  - the persisted `.infra/<env>.json` shape (ids + content hashes; no secrets).
 * @typeParam Remote - the live snapshot {@link read} returns (for diff/status).
 */
export abstract class Entity<
	// biome-ignore lint/suspicious/noExplicitAny: framework variance over heterogeneous entities; concrete generics are recovered via `infer` (see EntityEnv/EntityName).
	O extends EntityCommon<any, any> = EntityCommon,
	Creds = unknown,
	Env extends Record<string, string> = Record<string, string>,
	State extends Record<string, unknown> = Record<string, unknown>,
	Remote = unknown,
> {
	constructor(protected readonly options: O) {}

	get name(): string {
		return this.options.name;
	}
	get hooks(): EntityHooks<Env, State> | undefined {
		return this.options.hooks as EntityHooks<Env, State> | undefined;
	}

	abstract readonly credentialsSchema: StandardSchemaV1<unknown, Creds>;
	abstract readonly envSchema: StandardSchemaV1<unknown, Env>;
	abstract readonly stateSchema: StandardSchemaV1<unknown, State>;
	/** Logical env field names — drives output refs, `.env` writing, and `parseEnv`. */
	abstract readonly envKeys: readonly (keyof Env & string)[];

	/** Entity ids this one depends on, inferred from refs found in its options. */
	dependencyIds(): string[] {
		const ids = new Set<string>();
		collectRefEntities(this.options, ids);
		return [...ids];
	}

	/** The OS-key rename override derived from options. */
	get envKeyOverride(): EnvKeyOverride {
		const override: EnvKeyOverride = {};
		if (this.options.envNames) override.envNames = this.options.envNames;
		if (this.options.envName) override.envName = this.options.envName;
		return override;
	}

	private outputs: ResolvedOutputs = {};
	/** @internal — the engine injects resolved upstream outputs before lifecycle methods run. */
	bindOutputs(outputs: ResolvedOutputs): void {
		this.outputs = outputs;
	}
	/** Resolve a value (deep) against the injected outputs — refs become concrete values. */
	protected resolve<T>(value: T): Resolved<T> {
		return deepResolve(value, this.outputs);
	}
	/** This entity's options with every ref resolved to its concrete value. */
	protected get config(): Resolved<O> {
		return deepResolve(this.options, this.outputs);
	}

	/** Typed deferred reference to this entity's id. */
	get id(): Ref<string> {
		return idRef(this.name);
	}
	/** Typed deferred references to this entity's env, e.g. `db.env.databaseUrl`. */
	get env(): EnvRefs<Env> {
		return envRefs<Env>(this.name, this.envKeys);
	}

	/**
	 * This entity's whole env as an **OS-keyed** bundle of refs (applies `envNames`/`envName`),
	 * ready to spread into a consumer's `env`: `{ ...db.toEnv() }` → `{ DATABASE_URL: Ref, … }`.
	 * The values are refs, so spreading also creates the dependency edge.
	 */
	toEnv(): Record<string, Ref<string>> {
		const refs = this.env;
		const out: Record<string, Ref<string>> = {};
		for (const key of this.envKeys) {
			out[osKeyFor(key, this.envKeyOverride)] = refs[key];
		}
		return out;
	}

	/**
	 * Resolve credentials from the run's input bag (env + `defineInfra.credentials`). Override to
	 * add provider-specific fallback (e.g. read the `neonctl` / `vercel` CLI cache when the env
	 * var is absent). The engine validates the return value against {@link credentialsSchema}.
	 * Default: pass the bag through (the schema picks the fields it needs).
	 */
	resolveCredentials(bag: Record<string, string | undefined>): unknown {
		return bag;
	}

	/**
	 * Vendor CLIs this entity needs (for command-backed entities). The engine detects them during
	 * `login`/`link` and before a CLI-backed `apply`, preferring ephemeral `npx`/`bunx` and offering
	 * a confirmed global install. Default: none.
	 */
	requiredTools(): CliTool[] {
		return [];
	}

	/** Read the live remote (using `ctx.state`). `null` = does not exist remotely. */
	abstract read(ctx: ReadContext<Creds, State>): Promise<Remote | null>;
	/** PURE. Compare this entity's desired config to `remote`; return the changeset. */
	abstract diff(remote: Remote | null, ctx: DiffContext): Change[];
	/** Reconcile remote to desired (idempotent). Returns action + id + state + env. */
	abstract provision(
		ctx: ProvisionContext<Creds, State>,
	): Promise<ProvisionResult<Env, State>>;
	/** Resolve this entity's typed env from live remote, read-only (used by `checkout`). */
	abstract pullEnv(ctx: ReadContext<Creds, State>): Promise<Env>;
	/** Tear this entity down (destructive). */
	abstract deprovision(ctx: ProvisionContext<Creds, State>): Promise<void>;
}

/** Any entity, generics erased for collection/iteration in the engine. */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous entity collection; exact generics recovered structurally.
export type AnyEntity = Entity<any, any, any, any, any>;

/** Recover an entity's env type. */
export type EntityEnv<E> =
	E extends Entity<infer _O, infer _C, infer Env, infer _S, infer _R>
		? Env
		: never;
