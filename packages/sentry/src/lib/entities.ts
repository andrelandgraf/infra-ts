import {
	type Change,
	createRestClient,
	Entity,
	type EntityCommon,
	ErrorCode,
	InfraError,
	type ProvisionContext,
	type ProvisionResult,
	type ReadContext,
	type RestClient,
	type Ref,
	slugify,
	type StandardSchemaV1,
} from "@infra-ts/core";
import { z } from "zod";

const DEFAULT_API = "https://sentry.io/api/0";

type SentryCreds = { SENTRY_AUTH_TOKEN: string };
const credsSchema = z.object({
	SENTRY_AUTH_TOKEN: z.string().min(1),
}) as unknown as StandardSchemaV1<unknown, SentryCreds>;

abstract class SentryEntity<
	O extends EntityCommon<Env, State> & { org: string },
	Env extends Record<string, string>,
	State extends Record<string, unknown>,
	Remote,
> extends Entity<O, SentryCreds, Env, State, Remote> {
	readonly credentialsSchema = credsSchema;
	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return { SENTRY_AUTH_TOKEN: bag.SENTRY_AUTH_TOKEN ?? "" };
	}
	protected rest(ctx: { credentials: SentryCreds }): RestClient {
		return createRestClient({
			provider: "sentry",
			baseUrl: process.env.SENTRY_API_HOST ?? DEFAULT_API,
			auth: { type: "bearer", token: ctx.credentials.SENTRY_AUTH_TOKEN },
		});
	}
	protected get org(): string {
		return this.config.org;
	}
	protected get slug(): string {
		return slugify(this.name);
	}
}

const slugState = z.object({
	id: z.string(),
	slug: z.string(),
}) as unknown as StandardSchemaV1<unknown, { id: string; slug: string }>;

// ─── Team ─────────────────────────────────────────────────────────────────────

interface SentryRemoteTeam {
	id: string;
	slug: string;
}
export interface SentryTeamOptions extends EntityCommon<
	Record<string, never>,
	{ id: string; slug: string }
> {
	/** Sentry organization slug. */
	org: string;
}

export class SentryTeam extends SentryEntity<
	SentryTeamOptions,
	Record<string, never>,
	{ id: string; slug: string },
	SentryRemoteTeam
> {
	readonly envSchema = z.object({}) as unknown as StandardSchemaV1<
		unknown,
		Record<string, never>
	>;
	readonly stateSchema = slugState;
	readonly envKeys = [] as const;

	async read(
		ctx: ReadContext<SentryCreds, { id: string; slug: string }>,
	): Promise<SentryRemoteTeam | null> {
		const slug = ctx.state?.slug ?? this.slug;
		return this.rest(ctx).get<SentryRemoteTeam | null>(
			`/teams/${this.org}/${slug}/`,
			{ allowStatuses: [404] },
		);
	}
	diff(remote: SentryRemoteTeam | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "team", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<SentryCreds, { id: string; slug: string }>,
	): Promise<
		ProvisionResult<Record<string, never>, { id: string; slug: string }>
	> {
		const existing = await this.read(ctx);
		const team =
			existing ??
			(await this.rest(ctx).post<SentryRemoteTeam>(
				`/organizations/${this.org}/teams/`,
				{ body: { name: this.name, slug: this.slug } },
			));
		return {
			action: existing ? "noop" : "create",
			id: team.slug,
			state: { id: team.id, slug: team.slug },
			env: {},
		};
	}
	async pullEnv(): Promise<Record<string, never>> {
		return {};
	}
	async deprovision(
		ctx: ProvisionContext<SentryCreds, { id: string; slug: string }>,
	): Promise<void> {
		const slug = ctx.state?.slug ?? this.slug;
		await this.rest(ctx).delete(`/teams/${this.org}/${slug}/`, {
			allowStatuses: [404],
		});
	}
}

// ─── Project ──────────────────────────────────────────────────────────────────

interface SentryRemoteProject {
	id: string;
	slug: string;
}
export interface SentryProjectOptions extends EntityCommon<
	Record<string, never>,
	{ id: string; slug: string }
> {
	org: string;
	/** Team slug (or `team.id` ref). */
	team: string | Ref<string>;
	platform?: string;
}

export class SentryProject extends SentryEntity<
	SentryProjectOptions,
	Record<string, never>,
	{ id: string; slug: string },
	SentryRemoteProject
> {
	readonly envSchema = z.object({}) as unknown as StandardSchemaV1<
		unknown,
		Record<string, never>
	>;
	readonly stateSchema = slugState;
	readonly envKeys = [] as const;

	async read(
		ctx: ReadContext<SentryCreds, { id: string; slug: string }>,
	): Promise<SentryRemoteProject | null> {
		const slug = ctx.state?.slug ?? this.slug;
		return this.rest(ctx).get<SentryRemoteProject | null>(
			`/projects/${this.org}/${slug}/`,
			{ allowStatuses: [404] },
		);
	}
	diff(remote: SentryRemoteProject | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "project", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<SentryCreds, { id: string; slug: string }>,
	): Promise<
		ProvisionResult<Record<string, never>, { id: string; slug: string }>
	> {
		const existing = await this.read(ctx);
		const project =
			existing ??
			(await this.rest(ctx).post<SentryRemoteProject>(
				`/teams/${this.org}/${this.config.team}/projects/`,
				{
					body: {
						name: this.name,
						slug: this.slug,
						...(this.config.platform ? { platform: this.config.platform } : {}),
					},
				},
			));
		return {
			action: existing ? "noop" : "create",
			id: project.slug,
			state: { id: project.id, slug: project.slug },
			env: {},
		};
	}
	async pullEnv(): Promise<Record<string, never>> {
		return {};
	}
	async deprovision(
		ctx: ProvisionContext<SentryCreds, { id: string; slug: string }>,
	): Promise<void> {
		const slug = ctx.state?.slug ?? this.slug;
		await this.rest(ctx).delete(`/projects/${this.org}/${slug}/`, {
			allowStatuses: [404],
		});
	}
}

// ─── Client key (DSN) ─────────────────────────────────────────────────────────

type ClientKeyEnv = { sentryDsn: string };
interface SentryRemoteKey {
	id: string;
	dsn: { public: string };
}
export interface SentryClientKeyOptions extends EntityCommon<
	ClientKeyEnv,
	{ id: string }
> {
	org: string;
	/** Project slug (or `project.id` ref). */
	project: string | Ref<string>;
}

export class SentryClientKey extends SentryEntity<
	SentryClientKeyOptions,
	ClientKeyEnv,
	{ id: string },
	SentryRemoteKey
> {
	readonly envSchema = z.object({
		sentryDsn: z.string(),
	}) as unknown as StandardSchemaV1<unknown, ClientKeyEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["sentryDsn"] as const;

	private async find(
		ctx: ReadContext<SentryCreds, { id: string }>,
	): Promise<SentryRemoteKey | null> {
		if (!ctx.state?.id) return null;
		const keys = await this.rest(ctx).get<SentryRemoteKey[]>(
			`/projects/${this.org}/${this.config.project}/keys/`,
		);
		return keys.find((k) => k.id === ctx.state?.id) ?? null;
	}
	async read(
		ctx: ReadContext<SentryCreds, { id: string }>,
	): Promise<SentryRemoteKey | null> {
		return this.find(ctx);
	}
	diff(remote: SentryRemoteKey | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "client-key", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<SentryCreds, { id: string }>,
	): Promise<ProvisionResult<ClientKeyEnv, { id: string }>> {
		const existing = await this.find(ctx);
		const key =
			existing ??
			(await this.rest(ctx).post<SentryRemoteKey>(
				`/projects/${this.org}/${this.config.project}/keys/`,
				{ body: { name: this.name } },
			));
		return {
			action: existing ? "noop" : "create",
			id: key.id,
			state: { id: key.id },
			env: { sentryDsn: key.dsn.public },
		};
	}
	async pullEnv(
		ctx: ReadContext<SentryCreds, { id: string }>,
	): Promise<ClientKeyEnv> {
		const key = await this.find(ctx);
		if (!key) throw notProvisioned(this.name);
		return { sentryDsn: key.dsn.public };
	}
	async deprovision(
		ctx: ProvisionContext<SentryCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await this.rest(ctx).delete(
			`/projects/${this.org}/${this.config.project}/keys/${ctx.state.id}/`,
			{ allowStatuses: [404] },
		);
	}
}

function notProvisioned(name: string): InfraError {
	return new InfraError(
		ErrorCode.NotFound,
		`sentry: ${name} is not provisioned yet — run \`infra apply\` first.`,
	);
}
