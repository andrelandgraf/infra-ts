import {
	type Change,
	createRestClient,
	Entity,
	type EntityCommon,
	type ProvisionContext,
	type ProvisionResult,
	type ReadContext,
	type Ref,
	type RestClient,
	type StandardSchemaV1,
} from "@infra-ts/core";
import { z } from "zod";

const API = "https://api.openai.com/v1";

type OpenAiCreds = { OPENAI_ADMIN_KEY: string };
const credsSchema = z.object({
	OPENAI_ADMIN_KEY: z.string().min(1),
}) as unknown as StandardSchemaV1<unknown, OpenAiCreds>;

abstract class OpenAiEntity<
	O extends EntityCommon<Env, State>,
	Env extends Record<string, string>,
	State extends Record<string, unknown>,
	Remote,
> extends Entity<O, OpenAiCreds, Env, State, Remote> {
	readonly credentialsSchema = credsSchema;
	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return { OPENAI_ADMIN_KEY: bag.OPENAI_ADMIN_KEY ?? "" };
	}
	protected rest(ctx: { credentials: OpenAiCreds }): RestClient {
		return createRestClient({
			provider: "openai",
			baseUrl: API,
			auth: { type: "bearer", token: ctx.credentials.OPENAI_ADMIN_KEY },
		});
	}
}

// ─── Organization project ─────────────────────────────────────────────────────

interface RawProject {
	id: string;
	name: string;
	status: string;
}
export interface OpenAiProjectOptions extends EntityCommon<
	Record<string, never>,
	{ id: string }
> {
	/** Display name. Defaults to the entity `name`. */
	projectName?: string;
}

export class OpenAiProject extends OpenAiEntity<
	OpenAiProjectOptions,
	Record<string, never>,
	{ id: string },
	RawProject
> {
	readonly envSchema = z.object({}) as unknown as StandardSchemaV1<
		unknown,
		Record<string, never>
	>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = [] as const;

	private get projectName(): string {
		return this.config.projectName ?? this.name;
	}
	async read(
		ctx: ReadContext<OpenAiCreds, { id: string }>,
	): Promise<RawProject | null> {
		if (!ctx.state?.id) return null;
		const project = await this.rest(ctx).get<RawProject | null>(
			`/organization/projects/${ctx.state.id}`,
			{ allowStatuses: [404] },
		);
		// An archived project is effectively gone for reconcile purposes.
		return project && project.status !== "archived" ? project : null;
	}
	diff(remote: RawProject | null): Change[] {
		if (!remote) {
			return [
				{ action: "create", kind: "project", identifier: this.projectName },
			];
		}
		return remote.name !== this.projectName
			? [
					{
						action: "update",
						kind: "project",
						identifier: this.projectName,
						detail: "name",
					},
				]
			: [];
	}
	async provision(
		ctx: ProvisionContext<OpenAiCreds, { id: string }>,
	): Promise<ProvisionResult<Record<string, never>, { id: string }>> {
		const existing = await this.read(ctx);
		if (existing) {
			let action: "noop" | "update" = "noop";
			if (existing.name !== this.projectName) {
				await this.rest(ctx).post(`/organization/projects/${existing.id}`, {
					body: { name: this.projectName },
				});
				action = "update";
			}
			return { action, id: existing.id, state: { id: existing.id }, env: {} };
		}
		const created = await this.rest(ctx).post<RawProject>(
			"/organization/projects",
			{ body: { name: this.projectName } },
		);
		return {
			action: "create",
			id: created.id,
			state: { id: created.id },
			env: {},
		};
	}
	async pullEnv(): Promise<Record<string, never>> {
		return {};
	}
	async deprovision(
		ctx: ProvisionContext<OpenAiCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		// OpenAI projects can't be deleted — archive.
		await this.rest(ctx).post(
			`/organization/projects/${ctx.state.id}/archive`,
			{ allowStatuses: [404] },
		);
	}
}

// ─── Project service-account key (write-once secret) ──────────────────────────

type ServiceAccountEnv = { openaiApiKey: string };
interface RawServiceAccount {
	id: string;
}
export interface OpenAiServiceAccountOptions extends EntityCommon<
	ServiceAccountEnv,
	{ id: string }
> {
	/** Project id (or `project.id` ref). */
	project: string | Ref<string>;
}

export class OpenAiServiceAccount extends OpenAiEntity<
	OpenAiServiceAccountOptions,
	ServiceAccountEnv,
	{ id: string },
	RawServiceAccount
> {
	readonly envSchema = z.object({
		openaiApiKey: z.string(),
	}) as unknown as StandardSchemaV1<unknown, ServiceAccountEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["openaiApiKey"] as const;

	private get project(): string {
		return this.config.project;
	}
	async read(
		ctx: ReadContext<OpenAiCreds, { id: string }>,
	): Promise<RawServiceAccount | null> {
		if (!ctx.state?.id) return null;
		return this.rest(ctx).get<RawServiceAccount | null>(
			`/organization/projects/${this.project}/service_accounts/${ctx.state.id}`,
			{ allowStatuses: [404] },
		);
	}
	diff(remote: RawServiceAccount | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "service-account", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<OpenAiCreds, { id: string }>,
	): Promise<ProvisionResult<ServiceAccountEnv, { id: string }>> {
		const existing = await this.read(ctx);
		if (existing) {
			return {
				action: "noop",
				id: existing.id,
				state: { id: existing.id },
				env: { openaiApiKey: process.env.OPENAI_API_KEY ?? "" },
			};
		}
		const created = await this.rest(ctx).post<{
			id: string;
			api_key: { value: string };
		}>(`/organization/projects/${this.project}/service_accounts`, {
			body: { name: this.name },
		});
		return {
			action: "create",
			id: created.id,
			state: { id: created.id },
			env: { openaiApiKey: created.api_key.value },
		};
	}
	async pullEnv(): Promise<ServiceAccountEnv> {
		return { openaiApiKey: process.env.OPENAI_API_KEY ?? "" };
	}
	async deprovision(
		ctx: ProvisionContext<OpenAiCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await this.rest(ctx).delete(
			`/organization/projects/${this.project}/service_accounts/${ctx.state.id}`,
			{ allowStatuses: [404] },
		);
	}
}
