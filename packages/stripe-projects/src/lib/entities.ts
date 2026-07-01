import {
	type Change,
	type ChangeAction,
	type CliTool,
	Entity,
	type EntityCommon,
	ErrorCode,
	type Exec,
	InfraError,
	osKeyFor,
	type ProvisionContext,
	type ProvisionResult,
	type ReadContext,
	type StandardSchemaV1,
	validate,
} from "@infra-ts/core";
import { z } from "zod";

/**
 * Stripe Projects authenticates through the local Stripe CLI session, so infra-ts holds no
 * credentials of its own for these entities ("compose, don't capture").
 */
type ProjectsCreds = Record<string, never>;
const credsSchema = z.object({}) as unknown as StandardSchemaV1<
	unknown,
	ProjectsCreds
>;

/**
 * Identity is the declared entity `name` (`stripe projects add … --name <name>`), and live truth
 * comes from `stripe projects status`. Nothing is persisted to `.infra/<env>.json`, so the state
 * is empty — this is the "provider owns where its state lives" model in its purest form.
 */
type ProjectsState = Record<string, never>;
const stateSchema = z.object({}) as unknown as StandardSchemaV1<
	unknown,
	ProjectsState
>;

/** A resource as reported by `stripe projects status --json`, matched to an entity by `name`. */
export interface StripeProjectsResource {
	name: string;
	provider?: string | undefined;
	service?: string | undefined;
	tier?: string | undefined;
	status?: string | undefined;
}

// `stripe projects status --json` shape (assumed; parsed tolerantly). The command may key the
// list under `resources` or `services` depending on version — accept either and coalesce.
const resourceSchema = z.object({
	name: z.string(),
	provider: z.string().optional(),
	service: z.string().optional(),
	tier: z.string().optional(),
	status: z.string().optional(),
});
const statusSchema = z.object({
	resources: z.array(resourceSchema).optional(),
	services: z.array(resourceSchema).optional(),
});

/** Parse CLI stdout as JSON without casting to a concrete type (callers validate the shape). */
function parseJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) return {};
	try {
		const value: unknown = JSON.parse(trimmed);
		return value;
	} catch (cause) {
		throw new InfraError(
			ErrorCode.RequestFailed,
			`stripe-projects: expected JSON from the Stripe CLI but got: ${trimmed.slice(0, 200)}`,
			{ cause },
		);
	}
}

/** Validate and coalesce the `status` payload into a flat resource list. */
function parseResources(raw: unknown): StripeProjectsResource[] {
	const parsed = statusSchema.safeParse(raw);
	if (!parsed.success) {
		throw new InfraError(
			ErrorCode.RequestFailed,
			`stripe-projects: could not parse \`stripe projects status --json\` output: ${parsed.error.message}`,
		);
	}
	return parsed.data.resources ?? parsed.data.services ?? [];
}

/**
 * Base for a Stripe Projects–backed entity. Subclasses supply the provider/service slugs and their
 * typed env; this class drives the `stripe projects` CLI via `ctx.exec` and resolves identity by
 * name. `read`/`diff`/`provision`/`pullEnv`/`deprovision` are implemented here so a new service is
 * usually just a few lines.
 */
export abstract class StripeProjectsEntity<
	O extends EntityCommon<Env, ProjectsState>,
	Env extends Record<string, string>,
> extends Entity<O, ProjectsCreds, Env, ProjectsState, StripeProjectsResource> {
	readonly credentialsSchema = credsSchema;
	readonly stateSchema = stateSchema;

	/** The Stripe Projects provider slug, e.g. `"neon"`. */
	protected abstract providerSlug(): string;
	/** The provider's service slug, e.g. `"postgres"`. */
	protected abstract serviceSlug(): string;
	/** Desired plan tier, if the entity manages one. */
	protected tier(): string | undefined {
		return undefined;
	}

	override resolveCredentials(): unknown {
		// No infra-ts credentials — the Stripe CLI session is the auth.
		return {};
	}

	override requiredTools(): CliTool[] {
		return [
			{
				id: "stripe",
				detect: ["stripe", "version"],
				install: ["brew", "install", "stripe/stripe-cli/stripe"],
			},
			{
				id: "stripe-projects",
				detect: ["stripe", "projects", "--help"],
				install: ["stripe", "plugin", "install", "projects"],
			},
		];
	}

	private requireExec(ctx: { exec?: Exec }): Exec {
		if (!ctx.exec) {
			throw new InfraError(
				ErrorCode.RequestFailed,
				`stripe-projects: "${this.name}" needs the exec capability — run it through the infra-ts CLI/engine.`,
			);
		}
		return ctx.exec;
	}

	/** Reference passed to `stripe projects add`, e.g. `neon/postgres`. */
	private serviceRef(): string {
		return `${this.providerSlug()}/${this.serviceSlug()}`;
	}

	/** Run a side-effecting `stripe projects <args>` command (non-interactive). */
	protected async run(ctx: { exec?: Exec }, args: string[]): Promise<void> {
		await this.requireExec(ctx)([
			"stripe",
			"projects",
			...args,
			"--no-interactive",
		]);
	}

	/** Run `stripe projects <args> --json` and return the parsed (unvalidated) payload. */
	protected async runJson(
		ctx: { exec?: Exec },
		args: string[],
	): Promise<unknown> {
		const res = await this.requireExec(ctx)([
			"stripe",
			"projects",
			...args,
			"--json",
			"--no-interactive",
		]);
		return parseJson(res.stdout);
	}

	/** Locate this entity's resource in `stripe projects status` by its declared name. */
	protected async find(ctx: {
		exec?: Exec;
	}): Promise<StripeProjectsResource | null> {
		const resources = parseResources(await this.runJson(ctx, ["status"]));
		return resources.find((resource) => resource.name === this.name) ?? null;
	}

	async read(
		ctx: ReadContext<ProjectsCreds, ProjectsState>,
	): Promise<StripeProjectsResource | null> {
		return this.find(ctx);
	}

	diff(remote: StripeProjectsResource | null): Change[] {
		if (!remote) {
			return [
				{
					action: "create",
					kind: "stripe-projects-service",
					identifier: this.serviceRef(),
					detail: this.name,
				},
			];
		}
		const tier = this.tier();
		if (tier && remote.tier && remote.tier !== tier) {
			return [
				{
					action: "update",
					kind: "stripe-projects-service",
					identifier: this.serviceRef(),
					detail: `tier ${remote.tier} → ${tier}`,
				},
			];
		}
		return [];
	}

	async provision(
		ctx: ProvisionContext<ProjectsCreds, ProjectsState>,
	): Promise<ProvisionResult<Env, ProjectsState>> {
		const existing = await this.find(ctx);
		const tier = this.tier();
		let action: ChangeAction = "noop";
		if (!existing) {
			await this.run(ctx, [
				"add",
				this.serviceRef(),
				"--name",
				this.name,
				...(tier ? ["--tier", tier] : []),
				"--auto-confirm",
				"--accept-tos",
			]);
			action = "create";
		} else if (tier && existing.tier && existing.tier !== tier) {
			await this.run(ctx, ["upgrade", this.name, tier, "--auto-confirm"]);
			action = "update";
		}
		// Stripe Projects owns credential distribution — sync its vault into the local .env.
		await this.run(ctx, ["env", "--pull"]);
		return { action, id: this.name, state: {}, env: this.readEnv() };
	}

	async pullEnv(ctx: ReadContext<ProjectsCreds, ProjectsState>): Promise<Env> {
		await this.run(ctx, ["env", "--pull"]);
		return this.readEnv();
	}

	async deprovision(
		ctx: ProvisionContext<ProjectsCreds, ProjectsState>,
	): Promise<void> {
		await this.run(ctx, ["remove", this.name, "--auto-confirm"]);
	}

	/**
	 * Read this entity's produced env back from the process environment. Stripe Projects writes the
	 * real values into `.env` via `env --pull`; infra-ts reads them by their OS key. Identity is the
	 * name, so nothing is persisted to `.infra`.
	 */
	private readEnv(): Env {
		const out: Record<string, string> = {};
		for (const key of this.envKeys) {
			out[key] = process.env[osKeyFor(key, this.envKeyOverride)] ?? "";
		}
		return validate(
			this.envSchema,
			out,
			`stripe-projects env for "${this.name}"`,
		);
	}
}

// ─── Generic service (catalog escape hatch) ───────────────────────────────────

export interface StripeProjectsServiceOptions extends EntityCommon<
	Record<string, string>,
	ProjectsState
> {
	/** Stripe Projects provider slug, e.g. `"algolia"`. */
	provider: string;
	/** Provider service slug, e.g. `"application"`. */
	service: string;
	/** Plan tier to select on `add` and reconcile via `upgrade`. */
	tier?: string;
	/** Logical env fields this resource exposes as typed outputs (OS keys via CONSTANT_CASE / `envNames`). */
	exposes?: readonly string[];
}

/**
 * Provision any provider/service in the Stripe Projects catalog. Env fields are declared via
 * `exposes`; for a typed, first-class DX prefer a dedicated subclass (see {@link NeonPostgres}).
 */
export class StripeProjectsService extends StripeProjectsEntity<
	StripeProjectsServiceOptions,
	Record<string, string>
> {
	readonly envSchema = z.record(
		z.string(),
		z.string(),
	) as unknown as StandardSchemaV1<unknown, Record<string, string>>;

	get envKeys(): readonly string[] {
		return this.options.exposes ?? [];
	}

	protected providerSlug(): string {
		return this.options.provider;
	}
	protected serviceSlug(): string {
		return this.options.service;
	}
	protected override tier(): string | undefined {
		return this.options.tier;
	}
}

// ─── Typed convenience wrappers ───────────────────────────────────────────────

type NeonPostgresEnv = { databaseUrl: string };
export interface NeonPostgresOptions extends EntityCommon<
	NeonPostgresEnv,
	ProjectsState
> {
	/** Neon plan tier, e.g. `"free"` or `"launch"`. */
	tier?: string;
}

/** A Neon Postgres database provisioned through Stripe Projects (`neon/postgres`). */
export class NeonPostgres extends StripeProjectsEntity<
	NeonPostgresOptions,
	NeonPostgresEnv
> {
	readonly envSchema = z.object({
		databaseUrl: z.string(),
	}) as unknown as StandardSchemaV1<unknown, NeonPostgresEnv>;
	readonly envKeys = ["databaseUrl"] as const;

	protected providerSlug(): string {
		return "neon";
	}
	protected serviceSlug(): string {
		return "postgres";
	}
	protected override tier(): string | undefined {
		return this.options.tier;
	}
}

type UpstashRedisEnv = { redisRestUrl: string; redisRestToken: string };
export interface UpstashRedisOptions extends EntityCommon<
	UpstashRedisEnv,
	ProjectsState
> {
	/** Upstash plan tier. */
	tier?: string;
}

/** An Upstash Redis database provisioned through Stripe Projects (`upstash/redis`). */
export class UpstashRedis extends StripeProjectsEntity<
	UpstashRedisOptions,
	UpstashRedisEnv
> {
	readonly envSchema = z.object({
		redisRestUrl: z.string(),
		redisRestToken: z.string(),
	}) as unknown as StandardSchemaV1<unknown, UpstashRedisEnv>;
	readonly envKeys = ["redisRestUrl", "redisRestToken"] as const;

	protected providerSlug(): string {
		return "upstash";
	}
	protected serviceSlug(): string {
		return "redis";
	}
	protected override tier(): string | undefined {
		return this.options.tier;
	}
}
