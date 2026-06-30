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

const API = "https://api.dub.co";

type DubCreds = { DUB_API_KEY: string };
const credsSchema = z.object({
	DUB_API_KEY: z.string().min(1),
}) as unknown as StandardSchemaV1<unknown, DubCreds>;

abstract class DubEntity<
	O extends EntityCommon<Env, State>,
	Env extends Record<string, string>,
	State extends Record<string, unknown>,
	Remote,
> extends Entity<O, DubCreds, Env, State, Remote> {
	readonly credentialsSchema = credsSchema;
	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return { DUB_API_KEY: bag.DUB_API_KEY ?? "" };
	}
	protected rest(ctx: { credentials: DubCreds }): RestClient {
		return createRestClient({
			provider: "dub",
			baseUrl: API,
			auth: { type: "bearer", token: ctx.credentials.DUB_API_KEY },
		});
	}
}

function notProvisioned(name: string): InfraError {
	return new InfraError(
		ErrorCode.NotFound,
		`dub: ${name} is not provisioned yet — run \`infra apply\` first.`,
	);
}

// ─── Domain ─────────────────────────────────────────────────────────────────

interface RawDomain {
	id: string;
	slug: string;
}
export interface DubDomainOptions extends EntityCommon<
	Record<string, never>,
	{ slug: string }
> {
	/** The domain, e.g. "go.example.com". Defaults to the entity `name`. */
	slug?: string;
}

export class DubDomain extends DubEntity<
	DubDomainOptions,
	Record<string, never>,
	{ slug: string },
	RawDomain
> {
	readonly envSchema = z.object({}) as unknown as StandardSchemaV1<
		unknown,
		Record<string, never>
	>;
	readonly stateSchema = z.object({
		slug: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { slug: string }>;
	readonly envKeys = [] as const;

	private get domainSlug(): string {
		return this.config.slug ?? this.name;
	}
	private async find(
		ctx: ReadContext<DubCreds, { slug: string }>,
	): Promise<RawDomain | null> {
		const list = await this.rest(ctx).get<RawDomain[]>("/domains");
		return list.find((d) => d.slug === this.domainSlug) ?? null;
	}
	async read(
		ctx: ReadContext<DubCreds, { slug: string }>,
	): Promise<RawDomain | null> {
		return this.find(ctx);
	}
	diff(remote: RawDomain | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "domain", identifier: this.domainSlug }];
	}
	async provision(
		ctx: ProvisionContext<DubCreds, { slug: string }>,
	): Promise<ProvisionResult<Record<string, never>, { slug: string }>> {
		const existing = await this.find(ctx);
		if (!existing) {
			await this.rest(ctx).post<RawDomain>("/domains", {
				body: { slug: this.domainSlug },
			});
		}
		return {
			action: existing ? "noop" : "create",
			id: this.domainSlug,
			state: { slug: this.domainSlug },
			env: {},
		};
	}
	async pullEnv(): Promise<Record<string, never>> {
		return {};
	}
	async deprovision(
		ctx: ProvisionContext<DubCreds, { slug: string }>,
	): Promise<void> {
		await this.rest(ctx).delete(`/domains/${this.domainSlug}`, {
			allowStatuses: [404],
		});
	}
}

// ─── Tag ──────────────────────────────────────────────────────────────────────

interface RawTag {
	id: string;
	name: string;
}
export interface DubTagOptions extends EntityCommon<
	Record<string, never>,
	{ id: string }
> {
	color?: "red" | "yellow" | "green" | "blue" | "purple" | "pink" | "brown";
}

export class DubTag extends DubEntity<
	DubTagOptions,
	Record<string, never>,
	{ id: string },
	RawTag
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
		ctx: ReadContext<DubCreds, { id: string }>,
	): Promise<RawTag | null> {
		const list = await this.rest(ctx).get<RawTag[]>("/tags");
		return (
			list.find((t) => t.id === ctx.state?.id || t.name === this.name) ?? null
		);
	}
	async read(
		ctx: ReadContext<DubCreds, { id: string }>,
	): Promise<RawTag | null> {
		return this.find(ctx);
	}
	diff(remote: RawTag | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "tag", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<DubCreds, { id: string }>,
	): Promise<ProvisionResult<Record<string, never>, { id: string }>> {
		const existing = await this.find(ctx);
		const tag =
			existing ??
			(await this.rest(ctx).post<RawTag>("/tags", {
				body: {
					name: this.name,
					...(this.config.color ? { color: this.config.color } : {}),
				},
			}));
		return {
			action: existing ? "noop" : "create",
			id: tag.id,
			state: { id: tag.id },
			env: {},
		};
	}
	async pullEnv(): Promise<Record<string, never>> {
		return {};
	}
	async deprovision(
		ctx: ProvisionContext<DubCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await this.rest(ctx).delete(`/tags/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
}

// ─── Link ─────────────────────────────────────────────────────────────────────

type LinkEnv = { dubShortLink: string };
interface RawLink {
	id: string;
	shortLink: string;
}
export interface DubLinkOptions extends EntityCommon<LinkEnv, { id: string }> {
	/** Destination URL. */
	url: string | Ref<string>;
	/** Custom short domain (defaults to your Dub workspace default). */
	domain?: string | Ref<string>;
	/** Custom short key (the part after the slash). */
	key?: string;
}

export class DubLink extends DubEntity<
	DubLinkOptions,
	LinkEnv,
	{ id: string },
	RawLink
> {
	readonly envSchema = z.object({
		dubShortLink: z.string(),
	}) as unknown as StandardSchemaV1<unknown, LinkEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["dubShortLink"] as const;

	async read(
		ctx: ReadContext<DubCreds, { id: string }>,
	): Promise<RawLink | null> {
		if (!ctx.state?.id) return null;
		return this.rest(ctx).get<RawLink | null>(`/links/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
	diff(remote: RawLink | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "link", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<DubCreds, { id: string }>,
	): Promise<ProvisionResult<LinkEnv, { id: string }>> {
		const existing = ctx.state?.id
			? await this.rest(ctx).get<RawLink | null>(`/links/${ctx.state.id}`, {
					allowStatuses: [404],
				})
			: null;
		const link =
			existing ??
			(await this.rest(ctx).post<RawLink>("/links", {
				body: {
					url: this.config.url,
					...(this.config.domain ? { domain: this.config.domain } : {}),
					...(this.config.key ? { key: this.config.key } : {}),
				},
			}));
		return {
			action: existing ? "noop" : "create",
			id: link.id,
			state: { id: link.id },
			env: { dubShortLink: link.shortLink },
		};
	}
	async pullEnv(ctx: ReadContext<DubCreds, { id: string }>): Promise<LinkEnv> {
		const link = await this.read(ctx);
		if (!link) throw notProvisioned(this.name);
		return { dubShortLink: link.shortLink };
	}
	async deprovision(
		ctx: ProvisionContext<DubCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await this.rest(ctx).delete(`/links/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
}
