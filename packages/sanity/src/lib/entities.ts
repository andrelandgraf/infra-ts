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
	type StandardSchemaV1,
} from "@infra-ts/core";
import { z } from "zod";

const DEFAULT_API = "https://api.sanity.io/v2021-06-07";

type SanityCreds = { SANITY_AUTH_TOKEN: string };
const credsSchema = z.object({
	SANITY_AUTH_TOKEN: z.string().min(1),
}) as unknown as StandardSchemaV1<unknown, SanityCreds>;

abstract class SanityEntity<
	O extends EntityCommon<Env, State> & { projectId: string | Ref<string> },
	Env extends Record<string, string>,
	State extends Record<string, unknown>,
	Remote,
> extends Entity<O, SanityCreds, Env, State, Remote> {
	readonly credentialsSchema = credsSchema;
	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return { SANITY_AUTH_TOKEN: bag.SANITY_AUTH_TOKEN ?? "" };
	}
	protected rest(ctx: { credentials: SanityCreds }): RestClient {
		return createRestClient({
			provider: "sanity",
			baseUrl: process.env.SANITY_API_HOST ?? DEFAULT_API,
			auth: { type: "bearer", token: ctx.credentials.SANITY_AUTH_TOKEN },
		});
	}
	protected get projectId(): string {
		return this.config.projectId;
	}
}

// ─── Dataset ────────────────────────────────────────────────────────────────

type DatasetEnv = { sanityDataset: string };
interface RawDataset {
	name: string;
	aclMode?: string;
}
export interface SanityDatasetOptions extends EntityCommon<
	DatasetEnv,
	{ name: string }
> {
	projectId: string | Ref<string>;
	/** Dataset name (lowercase). Defaults to the entity `name`. */
	dataset?: string;
	aclMode?: "public" | "private";
}

export class SanityDataset extends SanityEntity<
	SanityDatasetOptions,
	DatasetEnv,
	{ name: string },
	RawDataset
> {
	readonly envSchema = z.object({
		sanityDataset: z.string(),
	}) as unknown as StandardSchemaV1<unknown, DatasetEnv>;
	readonly stateSchema = z.object({
		name: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { name: string }>;
	readonly envKeys = ["sanityDataset"] as const;

	private get datasetName(): string {
		return this.config.dataset ?? this.name;
	}
	private async find(
		ctx: ReadContext<SanityCreds, { name: string }>,
	): Promise<RawDataset | null> {
		const list = await this.rest(ctx).get<RawDataset[]>(
			`/projects/${this.projectId}/datasets`,
		);
		return list.find((d) => d.name === this.datasetName) ?? null;
	}
	async read(
		ctx: ReadContext<SanityCreds, { name: string }>,
	): Promise<RawDataset | null> {
		return this.find(ctx);
	}
	diff(remote: RawDataset | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "dataset", identifier: this.datasetName }];
	}
	async provision(
		ctx: ProvisionContext<SanityCreds, { name: string }>,
	): Promise<ProvisionResult<DatasetEnv, { name: string }>> {
		const existing = await this.find(ctx);
		if (!existing) {
			await this.rest(ctx).put(
				`/projects/${this.projectId}/datasets/${this.datasetName}`,
				{ body: { aclMode: this.config.aclMode ?? "public" } },
			);
		}
		return {
			action: existing ? "noop" : "create",
			id: this.datasetName,
			state: { name: this.datasetName },
			env: { sanityDataset: this.datasetName },
		};
	}
	async pullEnv(): Promise<DatasetEnv> {
		return { sanityDataset: this.datasetName };
	}
	async deprovision(
		ctx: ProvisionContext<SanityCreds, { name: string }>,
	): Promise<void> {
		await this.rest(ctx).delete(
			`/projects/${this.projectId}/datasets/${this.datasetName}`,
			{ allowStatuses: [404] },
		);
	}
}

// ─── Token (write-once secret) ────────────────────────────────────────────────

type TokenEnv = { sanityApiToken: string };
interface RawToken {
	id: string;
	label: string;
}
export interface SanityTokenOptions extends EntityCommon<
	TokenEnv,
	{ id: string }
> {
	projectId: string | Ref<string>;
	roleName?: "administrator" | "editor" | "viewer" | "deploy-studio";
}

export class SanityToken extends SanityEntity<
	SanityTokenOptions,
	TokenEnv,
	{ id: string },
	RawToken
> {
	readonly envSchema = z.object({
		sanityApiToken: z.string(),
	}) as unknown as StandardSchemaV1<unknown, TokenEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["sanityApiToken"] as const;

	private async find(
		ctx: ReadContext<SanityCreds, { id: string }>,
	): Promise<RawToken | null> {
		if (!ctx.state?.id) return null;
		const list = await this.rest(ctx).get<RawToken[]>(
			`/projects/${this.projectId}/tokens`,
		);
		return list.find((t) => t.id === ctx.state?.id) ?? null;
	}
	async read(
		ctx: ReadContext<SanityCreds, { id: string }>,
	): Promise<RawToken | null> {
		return this.find(ctx);
	}
	diff(remote: RawToken | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "token", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<SanityCreds, { id: string }>,
	): Promise<ProvisionResult<TokenEnv, { id: string }>> {
		const existing = await this.find(ctx);
		if (existing) {
			return {
				action: "noop",
				id: existing.id,
				state: { id: existing.id },
				env: { sanityApiToken: process.env.SANITY_API_TOKEN ?? "" },
			};
		}
		const created = await this.rest(ctx).post<{ id: string; key: string }>(
			`/projects/${this.projectId}/tokens`,
			{
				body: {
					label: this.name,
					roleName: this.config.roleName ?? "viewer",
				},
			},
		);
		return {
			action: "create",
			id: created.id,
			state: { id: created.id },
			env: { sanityApiToken: created.key },
		};
	}
	async pullEnv(): Promise<TokenEnv> {
		return { sanityApiToken: process.env.SANITY_API_TOKEN ?? "" };
	}
	async deprovision(
		ctx: ProvisionContext<SanityCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await this.rest(ctx).delete(
			`/projects/${this.projectId}/tokens/${ctx.state.id}`,
			{ allowStatuses: [404] },
		);
	}
}

// ─── CORS origin ──────────────────────────────────────────────────────────────

interface RawCors {
	id: number | string;
	origin: string;
}
export interface SanityCorsOriginOptions extends EntityCommon<
	Record<string, never>,
	{ id: string }
> {
	projectId: string | Ref<string>;
	origin: string;
	allowCredentials?: boolean;
}

export class SanityCorsOrigin extends SanityEntity<
	SanityCorsOriginOptions,
	Record<string, never>,
	{ id: string },
	RawCors
> {
	readonly envSchema = z.object({}) as unknown as StandardSchemaV1<
		unknown,
		Record<string, never>
	>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = [] as const;

	private async find(
		ctx: ReadContext<SanityCreds, { id: string }>,
	): Promise<RawCors | null> {
		const list = await this.rest(ctx).get<RawCors[]>(
			`/projects/${this.projectId}/cors`,
		);
		return list.find((c) => c.origin === this.config.origin) ?? null;
	}
	async read(
		ctx: ReadContext<SanityCreds, { id: string }>,
	): Promise<RawCors | null> {
		return this.find(ctx);
	}
	diff(remote: RawCors | null): Change[] {
		return remote
			? []
			: [
					{
						action: "create",
						kind: "cors-origin",
						identifier: this.config.origin,
					},
				];
	}
	async provision(
		ctx: ProvisionContext<SanityCreds, { id: string }>,
	): Promise<ProvisionResult<Record<string, never>, { id: string }>> {
		const existing = await this.find(ctx);
		const cors =
			existing ??
			(await this.rest(ctx).post<RawCors>(`/projects/${this.projectId}/cors`, {
				body: {
					origin: this.config.origin,
					allowCredentials: this.config.allowCredentials ?? false,
				},
			}));
		return {
			action: existing ? "noop" : "create",
			id: String(cors.id),
			state: { id: String(cors.id) },
			env: {},
		};
	}
	async pullEnv(): Promise<Record<string, never>> {
		return {};
	}
	async deprovision(
		ctx: ProvisionContext<SanityCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await this.rest(ctx).delete(
			`/projects/${this.projectId}/cors/${ctx.state.id}`,
			{ allowStatuses: [404] },
		);
	}
}
