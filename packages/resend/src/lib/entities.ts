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

const API = "https://api.resend.com";

type ResendCreds = { RESEND_API_KEY: string };
const credsSchema = z.object({
	RESEND_API_KEY: z.string().min(1),
}) as unknown as StandardSchemaV1<unknown, ResendCreds>;

abstract class ResendEntity<
	O extends EntityCommon<Env, State>,
	Env extends Record<string, string>,
	State extends Record<string, unknown>,
	Remote,
> extends Entity<O, ResendCreds, Env, State, Remote> {
	readonly credentialsSchema = credsSchema;
	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return { RESEND_API_KEY: bag.RESEND_API_KEY ?? "" };
	}
	protected rest(ctx: { credentials: ResendCreds }): RestClient {
		return createRestClient({
			provider: "resend",
			baseUrl: API,
			auth: { type: "bearer", token: ctx.credentials.RESEND_API_KEY },
			headers: { "User-Agent": "infra-ts" },
		});
	}
}

// ─── Domain ─────────────────────────────────────────────────────────────────

type DomainEnv = { resendDomainId: string };
export interface ResendDomainOptions extends EntityCommon<
	DomainEnv,
	{ id: string }
> {
	/** The domain to add, e.g. "mail.example.com". */
	domain: string;
	region?: "us-east-1" | "eu-west-1" | "sa-east-1" | "ap-northeast-1";
}

export class ResendDomain extends ResendEntity<
	ResendDomainOptions,
	DomainEnv,
	{ id: string },
	{ id: string }
> {
	readonly envSchema = z.object({
		resendDomainId: z.string(),
	}) as unknown as StandardSchemaV1<unknown, DomainEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["resendDomainId"] as const;

	async read(
		ctx: ReadContext<ResendCreds, { id: string }>,
	): Promise<{ id: string } | null> {
		if (!ctx.state?.id) return null;
		return this.rest(ctx).get<{ id: string } | null>(
			`/domains/${ctx.state.id}`,
			{ allowStatuses: [404] },
		);
	}
	diff(remote: { id: string } | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "domain", identifier: this.config.domain }];
	}
	async provision(
		ctx: ProvisionContext<ResendCreds, { id: string }>,
	): Promise<ProvisionResult<DomainEnv, { id: string }>> {
		const rest = this.rest(ctx);
		let dom = ctx.state?.id
			? await rest.get<{ id: string } | null>(`/domains/${ctx.state.id}`, {
					allowStatuses: [404],
				})
			: null;
		let action: "create" | "noop" = "noop";
		if (!dom) {
			dom = await rest.post<{ id: string }>("/domains", {
				body: {
					name: this.config.domain,
					...(this.config.region ? { region: this.config.region } : {}),
				},
			});
			action = "create";
		}
		return {
			action,
			id: dom.id,
			state: { id: dom.id },
			env: { resendDomainId: dom.id },
		};
	}
	async pullEnv(
		ctx: ReadContext<ResendCreds, { id: string }>,
	): Promise<DomainEnv> {
		if (!ctx.state?.id) throw notProvisioned(this.name);
		return { resendDomainId: ctx.state.id };
	}
	async deprovision(
		ctx: ProvisionContext<ResendCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await this.rest(ctx).delete(`/domains/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
}

// ─── API key (write-once secret; reused from env on checkout) ─────────────────

type ApiKeyEnv = { resendSendingApiKey: string };
export interface ResendApiKeyOptions extends EntityCommon<
	ApiKeyEnv,
	{ id: string }
> {
	permission?: "full_access" | "sending_access";
}

export class ResendApiKey extends ResendEntity<
	ResendApiKeyOptions,
	ApiKeyEnv,
	{ id: string },
	{ id: string }
> {
	readonly envSchema = z.object({
		resendSendingApiKey: z.string(),
	}) as unknown as StandardSchemaV1<unknown, ApiKeyEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["resendSendingApiKey"] as const;

	async read(
		ctx: ReadContext<ResendCreds, { id: string }>,
	): Promise<{ id: string } | null> {
		if (!ctx.state?.id) return null;
		const res = await this.rest(ctx).get<{ data?: { id: string }[] }>(
			"/api-keys",
		);
		const found = (res.data ?? []).find((k) => k.id === ctx.state?.id);
		return found ? { id: found.id } : null;
	}
	diff(remote: { id: string } | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "api-key", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<ResendCreds, { id: string }>,
	): Promise<ProvisionResult<ApiKeyEnv, { id: string }>> {
		// Keys can't be re-fetched (the token is shown once). If one already exists in state,
		// reuse the persisted token from the local env rather than minting a new one.
		if (ctx.state?.id) {
			const res = await this.rest(ctx).get<{ data?: { id: string }[] }>(
				"/api-keys",
			);
			if ((res.data ?? []).some((k) => k.id === ctx.state?.id)) {
				return {
					action: "noop",
					id: ctx.state.id,
					state: { id: ctx.state.id },
					env: {
						resendSendingApiKey: process.env.RESEND_SENDING_API_KEY ?? "",
					},
				};
			}
		}
		const created = await this.rest(ctx).post<{ id: string; token: string }>(
			"/api-keys",
			{
				body: {
					name: this.name,
					permission: this.config.permission ?? "sending_access",
				},
			},
		);
		return {
			action: "create",
			id: created.id,
			state: { id: created.id },
			env: { resendSendingApiKey: created.token },
		};
	}
	async pullEnv(): Promise<ApiKeyEnv> {
		// One-time secret: reuse the value persisted in the local env (set at apply time).
		return { resendSendingApiKey: process.env.RESEND_SENDING_API_KEY ?? "" };
	}
	async deprovision(
		ctx: ProvisionContext<ResendCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await this.rest(ctx).delete(`/api-keys/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
}

// ─── Audience ─────────────────────────────────────────────────────────────────

type AudienceEnv = { resendAudienceId: string };
export type ResendAudienceOptions = EntityCommon<AudienceEnv, { id: string }>;

export class ResendAudience extends ResendEntity<
	ResendAudienceOptions,
	AudienceEnv,
	{ id: string },
	{ id: string }
> {
	readonly envSchema = z.object({
		resendAudienceId: z.string(),
	}) as unknown as StandardSchemaV1<unknown, AudienceEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["resendAudienceId"] as const;

	async read(
		ctx: ReadContext<ResendCreds, { id: string }>,
	): Promise<{ id: string } | null> {
		if (!ctx.state?.id) return null;
		return this.rest(ctx).get<{ id: string } | null>(
			`/audiences/${ctx.state.id}`,
			{ allowStatuses: [404] },
		);
	}
	diff(remote: { id: string } | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "audience", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<ResendCreds, { id: string }>,
	): Promise<ProvisionResult<AudienceEnv, { id: string }>> {
		const rest = this.rest(ctx);
		let aud = ctx.state?.id
			? await rest.get<{ id: string } | null>(`/audiences/${ctx.state.id}`, {
					allowStatuses: [404],
				})
			: null;
		let action: "create" | "noop" = "noop";
		if (!aud) {
			aud = await rest.post<{ id: string }>("/audiences", {
				body: { name: this.name },
			});
			action = "create";
		}
		return {
			action,
			id: aud.id,
			state: { id: aud.id },
			env: { resendAudienceId: aud.id },
		};
	}
	async pullEnv(
		ctx: ReadContext<ResendCreds, { id: string }>,
	): Promise<AudienceEnv> {
		if (!ctx.state?.id) throw notProvisioned(this.name);
		return { resendAudienceId: ctx.state.id };
	}
	async deprovision(
		ctx: ProvisionContext<ResendCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await this.rest(ctx).delete(`/audiences/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

interface RawWebhook {
	id: string;
}
export interface ResendWebhookOptions extends EntityCommon<
	Record<string, never>,
	{ id: string }
> {
	endpointUrl: string | Ref<string>;
	events: string[];
}

export class ResendWebhook extends ResendEntity<
	ResendWebhookOptions,
	Record<string, never>,
	{ id: string },
	RawWebhook
> {
	readonly envSchema = z.object({}) as unknown as StandardSchemaV1<
		unknown,
		Record<string, never>
	>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = [] as const;

	async read(
		ctx: ReadContext<ResendCreds, { id: string }>,
	): Promise<RawWebhook | null> {
		if (!ctx.state?.id) return null;
		return this.rest(ctx).get<RawWebhook | null>(`/webhooks/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
	diff(remote: RawWebhook | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "webhook", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<ResendCreds, { id: string }>,
	): Promise<ProvisionResult<Record<string, never>, { id: string }>> {
		const existing = ctx.state?.id
			? await this.rest(ctx).get<RawWebhook | null>(
					`/webhooks/${ctx.state.id}`,
					{ allowStatuses: [404] },
				)
			: null;
		const hook =
			existing ??
			(await this.rest(ctx).post<RawWebhook>("/webhooks", {
				body: {
					endpoint_url: this.config.endpointUrl,
					events: this.config.events,
				},
			}));
		return {
			action: existing ? "noop" : "create",
			id: hook.id,
			state: { id: hook.id },
			env: {},
		};
	}
	async pullEnv(): Promise<Record<string, never>> {
		return {};
	}
	async deprovision(
		ctx: ProvisionContext<ResendCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await this.rest(ctx).delete(`/webhooks/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
}

function notProvisioned(name: string): InfraError {
	return new InfraError(
		ErrorCode.NotFound,
		`resend: ${name} is not provisioned yet — run \`infra apply\` first.`,
	);
}
