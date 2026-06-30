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
	type Ref,
	type RestClient,
	slugify,
	type StandardSchemaV1,
} from "@infra-ts/core";
import { z } from "zod";

const DEFAULT_API = "https://us.posthog.com";
const DEFAULT_CLIENT_HOST = "https://us.i.posthog.com";

type PosthogCreds = { POSTHOG_API_KEY: string };
const credsSchema = z.object({
	POSTHOG_API_KEY: z.string().min(1),
}) as unknown as StandardSchemaV1<unknown, PosthogCreds>;

abstract class PosthogEntity<
	O extends EntityCommon<Env, State>,
	Env extends Record<string, string>,
	State extends Record<string, unknown>,
	Remote,
> extends Entity<O, PosthogCreds, Env, State, Remote> {
	readonly credentialsSchema = credsSchema;
	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return { POSTHOG_API_KEY: bag.POSTHOG_API_KEY ?? "" };
	}
	protected rest(
		ctx: { credentials: PosthogCreds },
		apiHost?: string,
	): RestClient {
		return createRestClient({
			provider: "posthog",
			baseUrl: apiHost ?? process.env.POSTHOG_API_HOST ?? DEFAULT_API,
			auth: { type: "bearer", token: ctx.credentials.POSTHOG_API_KEY },
		});
	}
}

// ─── Project ────────────────────────────────────────────────────────────────

type ProjectEnv = { posthogKey: string; posthogHost: string };
interface RawProject {
	id: number;
	name: string;
	api_token: string;
}
export interface PosthogProjectOptions extends EntityCommon<
	ProjectEnv,
	{ id: string }
> {
	/** PostHog organization id. */
	org: string;
	apiHost?: string;
	/** Ingestion host emitted as `POSTHOG_HOST` (default `https://us.i.posthog.com`). */
	clientHost?: string;
}

export class PosthogProject extends PosthogEntity<
	PosthogProjectOptions,
	ProjectEnv,
	{ id: string },
	RawProject
> {
	readonly envSchema = z.object({
		posthogKey: z.string(),
		posthogHost: z.string(),
	}) as unknown as StandardSchemaV1<unknown, ProjectEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["posthogKey", "posthogHost"] as const;

	private get clientHost(): string {
		return this.config.clientHost ?? DEFAULT_CLIENT_HOST;
	}
	private get apiHost(): string | undefined {
		return this.config.apiHost;
	}
	private envValues(project: RawProject): ProjectEnv {
		return { posthogKey: project.api_token, posthogHost: this.clientHost };
	}
	async read(
		ctx: ReadContext<PosthogCreds, { id: string }>,
	): Promise<RawProject | null> {
		if (!ctx.state?.id) return null;
		return this.rest(ctx, this.apiHost).get<RawProject | null>(
			`/api/projects/${ctx.state.id}/`,
			{ allowStatuses: [404] },
		);
	}
	diff(remote: RawProject | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "project", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<PosthogCreds, { id: string }>,
	): Promise<ProvisionResult<ProjectEnv, { id: string }>> {
		const existing = await this.read(ctx);
		const project =
			existing ??
			(await this.rest(ctx, this.apiHost).post<RawProject>(
				`/api/organizations/${this.config.org}/projects/`,
				{ body: { name: this.name } },
			));
		return {
			action: existing ? "noop" : "create",
			id: String(project.id),
			state: { id: String(project.id) },
			env: this.envValues(project),
		};
	}
	async pullEnv(
		ctx: ReadContext<PosthogCreds, { id: string }>,
	): Promise<ProjectEnv> {
		const project = await this.read(ctx);
		if (!project) {
			throw new InfraError(
				ErrorCode.NotFound,
				`posthog: ${this.name} is not provisioned yet — run \`infra apply\` first.`,
			);
		}
		return this.envValues(project);
	}
	async deprovision(
		ctx: ProvisionContext<PosthogCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await this.rest(ctx, this.apiHost).delete(
			`/api/projects/${ctx.state.id}/`,
			{ allowStatuses: [404] },
		);
	}
}

// ─── Feature flag ─────────────────────────────────────────────────────────────

interface RawFlag {
	id: number;
	key: string;
	active: boolean;
}
export interface PosthogFeatureFlagOptions extends EntityCommon<
	Record<string, never>,
	{ id: string }
> {
	/** PostHog project id (or `project.id` ref). */
	projectId: string | Ref<string>;
	/** Flag key. Defaults to a slug of the entity `name`. */
	key?: string;
	active?: boolean;
	apiHost?: string;
}

export class PosthogFeatureFlag extends PosthogEntity<
	PosthogFeatureFlagOptions,
	Record<string, never>,
	{ id: string },
	RawFlag
> {
	readonly envSchema = z.object({}) as unknown as StandardSchemaV1<
		unknown,
		Record<string, never>
	>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = [] as const;

	private get flagKey(): string {
		return this.config.key ?? slugify(this.name);
	}
	private get projectId(): string {
		return this.config.projectId;
	}
	private async findByKey(ctx: {
		credentials: PosthogCreds;
	}): Promise<RawFlag | null> {
		const res = await this.rest(ctx, this.config.apiHost).get<{
			results: RawFlag[];
		}>(`/api/projects/${this.projectId}/feature_flags/`, {
			query: { search: this.flagKey, limit: 100 },
		});
		return res.results.find((f) => f.key === this.flagKey) ?? null;
	}
	async read(
		ctx: ReadContext<PosthogCreds, { id: string }>,
	): Promise<RawFlag | null> {
		if (!ctx.state?.id) return null;
		return this.rest(ctx, this.config.apiHost).get<RawFlag | null>(
			`/api/projects/${this.projectId}/feature_flags/${ctx.state.id}/`,
			{ allowStatuses: [404] },
		);
	}
	diff(remote: RawFlag | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "feature-flag", identifier: this.flagKey }];
	}
	async provision(
		ctx: ProvisionContext<PosthogCreds, { id: string }>,
	): Promise<ProvisionResult<Record<string, never>, { id: string }>> {
		const existing = (await this.read(ctx)) ?? (await this.findByKey(ctx));
		const flag =
			existing ??
			(await this.rest(ctx, this.config.apiHost).post<RawFlag>(
				`/api/projects/${this.projectId}/feature_flags/`,
				{
					body: {
						key: this.flagKey,
						name: this.name,
						active: this.config.active ?? true,
						filters: {
							groups: [{ properties: [], rollout_percentage: 100 }],
						},
					},
				},
			));
		return {
			action: existing ? "noop" : "create",
			id: String(flag.id),
			state: { id: String(flag.id) },
			env: {},
		};
	}
	async pullEnv(): Promise<Record<string, never>> {
		return {};
	}
	async deprovision(
		ctx: ProvisionContext<PosthogCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		// PostHog soft-deletes flags via PATCH.
		await this.rest(ctx, this.config.apiHost).patch(
			`/api/projects/${this.projectId}/feature_flags/${ctx.state.id}/`,
			{ body: { deleted: true }, allowStatuses: [404] },
		);
	}
}
