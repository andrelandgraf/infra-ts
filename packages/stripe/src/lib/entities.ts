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
import { toForm } from "./form.js";

const API = "https://api.stripe.com/v1";

type StripeCreds = { STRIPE_SECRET_KEY: string };
const credsSchema = z.object({
	STRIPE_SECRET_KEY: z.string().min(1),
}) as unknown as StandardSchemaV1<unknown, StripeCreds>;

abstract class StripeEntity<
	O extends EntityCommon<Env, State>,
	Env extends Record<string, string>,
	State extends Record<string, unknown>,
	Remote,
> extends Entity<O, StripeCreds, Env, State, Remote> {
	readonly credentialsSchema = credsSchema;
	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return { STRIPE_SECRET_KEY: bag.STRIPE_SECRET_KEY ?? "" };
	}
	protected rest(ctx: { credentials: StripeCreds }): RestClient {
		return createRestClient({
			provider: "stripe",
			baseUrl: API,
			auth: { type: "bearer", token: ctx.credentials.STRIPE_SECRET_KEY },
		});
	}
}

function notProvisioned(name: string): InfraError {
	return new InfraError(
		ErrorCode.NotFound,
		`stripe: ${name} is not provisioned yet — run \`infra apply\` first.`,
	);
}

// ─── Webhook endpoint (write-once signing secret) ─────────────────────────────

type WebhookEnv = { stripeWebhookSecret: string };
interface RawWebhook {
	id: string;
	url: string;
	enabled_events: string[];
}
export interface StripeWebhookEndpointOptions extends EntityCommon<
	WebhookEnv,
	{ id: string }
> {
	url: string | Ref<string>;
	/** Event types to subscribe to. Defaults to `["*"]` (all events). */
	events?: string[];
	description?: string;
}

export class StripeWebhookEndpoint extends StripeEntity<
	StripeWebhookEndpointOptions,
	WebhookEnv,
	{ id: string },
	RawWebhook
> {
	readonly envSchema = z.object({
		stripeWebhookSecret: z.string(),
	}) as unknown as StandardSchemaV1<unknown, WebhookEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["stripeWebhookSecret"] as const;

	private get events(): string[] {
		return this.config.events ?? ["*"];
	}
	async read(
		ctx: ReadContext<StripeCreds, { id: string }>,
	): Promise<RawWebhook | null> {
		if (!ctx.state?.id) return null;
		return this.rest(ctx).get<RawWebhook | null>(
			`/webhook_endpoints/${ctx.state.id}`,
			{ allowStatuses: [404] },
		);
	}
	diff(remote: RawWebhook | null): Change[] {
		if (!remote) {
			return [
				{ action: "create", kind: "webhook-endpoint", identifier: this.name },
			];
		}
		const sameEvents = sameSet(remote.enabled_events, this.events);
		const sameUrl =
			typeof this.config.url === "string"
				? remote.url === this.config.url
				: true;
		return sameEvents && sameUrl
			? []
			: [{ action: "update", kind: "webhook-endpoint", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<StripeCreds, { id: string }>,
	): Promise<ProvisionResult<WebhookEnv, { id: string }>> {
		const existing = await this.read(ctx);
		if (existing) {
			const sameEvents = sameSet(existing.enabled_events, this.events);
			const sameUrl =
				typeof this.config.url === "string"
					? existing.url === this.config.url
					: true;
			let action: "noop" | "update" = "noop";
			if (!sameEvents || !sameUrl) {
				await this.rest(ctx).post(`/webhook_endpoints/${existing.id}`, {
					form: toForm({
						url: this.config.url,
						enabled_events: this.events,
						disabled: false,
					}),
				});
				action = "update";
			}
			return {
				action,
				id: existing.id,
				state: { id: existing.id },
				env: { stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "" },
			};
		}
		const created = await this.rest(ctx).post<{ id: string; secret: string }>(
			"/webhook_endpoints",
			{
				form: toForm({
					url: this.config.url,
					enabled_events: this.events,
					...(this.config.description
						? { description: this.config.description }
						: {}),
				}),
			},
		);
		return {
			action: "create",
			id: created.id,
			state: { id: created.id },
			env: { stripeWebhookSecret: created.secret },
		};
	}
	async pullEnv(): Promise<WebhookEnv> {
		return { stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "" };
	}
	async deprovision(
		ctx: ProvisionContext<StripeCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await this.rest(ctx).delete(`/webhook_endpoints/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
}

// ─── Product ──────────────────────────────────────────────────────────────────

type ProductEnv = { stripeProductId: string };
interface RawProduct {
	id: string;
	name: string;
	active: boolean;
}
export interface StripeProductOptions extends EntityCommon<
	ProductEnv,
	{ id: string }
> {
	/** Display name. Defaults to the entity `name`. */
	productName?: string;
}

export class StripeProduct extends StripeEntity<
	StripeProductOptions,
	ProductEnv,
	{ id: string },
	RawProduct
> {
	readonly envSchema = z.object({
		stripeProductId: z.string(),
	}) as unknown as StandardSchemaV1<unknown, ProductEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["stripeProductId"] as const;

	private get productName(): string {
		return this.config.productName ?? this.name;
	}
	async read(
		ctx: ReadContext<StripeCreds, { id: string }>,
	): Promise<RawProduct | null> {
		if (!ctx.state?.id) return null;
		return this.rest(ctx).get<RawProduct | null>(`/products/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
	diff(remote: RawProduct | null): Change[] {
		if (!remote) {
			return [
				{ action: "create", kind: "product", identifier: this.productName },
			];
		}
		return remote.name !== this.productName
			? [
					{
						action: "update",
						kind: "product",
						identifier: this.productName,
						detail: "name",
					},
				]
			: [];
	}
	async provision(
		ctx: ProvisionContext<StripeCreds, { id: string }>,
	): Promise<ProvisionResult<ProductEnv, { id: string }>> {
		const existing = await this.read(ctx);
		if (existing) {
			let action: "noop" | "update" = "noop";
			if (existing.name !== this.productName) {
				await this.rest(ctx).post(`/products/${existing.id}`, {
					form: toForm({ name: this.productName, active: true }),
				});
				action = "update";
			}
			return {
				action,
				id: existing.id,
				state: { id: existing.id },
				env: { stripeProductId: existing.id },
			};
		}
		const created = await this.rest(ctx).post<RawProduct>("/products", {
			form: toForm({ name: this.productName }),
		});
		return {
			action: "create",
			id: created.id,
			state: { id: created.id },
			env: { stripeProductId: created.id },
		};
	}
	async pullEnv(
		ctx: ReadContext<StripeCreds, { id: string }>,
	): Promise<ProductEnv> {
		if (!ctx.state?.id) throw notProvisioned(this.name);
		return { stripeProductId: ctx.state.id };
	}
	async deprovision(
		ctx: ProvisionContext<StripeCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		// Products in use can't be hard-deleted — archive instead (Stripe best practice).
		await this.rest(ctx).post(`/products/${ctx.state.id}`, {
			form: toForm({ active: false }),
			allowStatuses: [404],
		});
	}
}

// ─── Price (immutable; archived on destroy) ───────────────────────────────────

type PriceEnv = { stripePriceId: string };
interface RawPrice {
	id: string;
	active: boolean;
}
export interface StripePriceOptions extends EntityCommon<
	PriceEnv,
	{ id: string }
> {
	product: string | Ref<string>;
	currency: string;
	/** Amount in the currency's smallest unit (e.g. cents). */
	unitAmount: number;
	/** Set for recurring (subscription) prices. */
	recurring?: {
		interval: "day" | "week" | "month" | "year";
		intervalCount?: number;
	};
}

export class StripePrice extends StripeEntity<
	StripePriceOptions,
	PriceEnv,
	{ id: string },
	RawPrice
> {
	readonly envSchema = z.object({
		stripePriceId: z.string(),
	}) as unknown as StandardSchemaV1<unknown, PriceEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["stripePriceId"] as const;

	async read(
		ctx: ReadContext<StripeCreds, { id: string }>,
	): Promise<RawPrice | null> {
		if (!ctx.state?.id) return null;
		return this.rest(ctx).get<RawPrice | null>(`/prices/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
	diff(remote: RawPrice | null): Change[] {
		// Stripe prices are immutable — only create/exists matters.
		return remote
			? []
			: [{ action: "create", kind: "price", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<StripeCreds, { id: string }>,
	): Promise<ProvisionResult<PriceEnv, { id: string }>> {
		const existing = await this.read(ctx);
		if (existing) {
			return {
				action: "noop",
				id: existing.id,
				state: { id: existing.id },
				env: { stripePriceId: existing.id },
			};
		}
		const created = await this.rest(ctx).post<RawPrice>("/prices", {
			form: toForm({
				product: this.config.product,
				currency: this.config.currency,
				unit_amount: this.config.unitAmount,
				...(this.config.recurring
					? {
							recurring: {
								interval: this.config.recurring.interval,
								...(this.config.recurring.intervalCount
									? { interval_count: this.config.recurring.intervalCount }
									: {}),
							},
						}
					: {}),
			}),
		});
		return {
			action: "create",
			id: created.id,
			state: { id: created.id },
			env: { stripePriceId: created.id },
		};
	}
	async pullEnv(
		ctx: ReadContext<StripeCreds, { id: string }>,
	): Promise<PriceEnv> {
		if (!ctx.state?.id) throw notProvisioned(this.name);
		return { stripePriceId: ctx.state.id };
	}
	async deprovision(
		ctx: ProvisionContext<StripeCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		// Prices can't be deleted — deactivate.
		await this.rest(ctx).post(`/prices/${ctx.state.id}`, {
			form: toForm({ active: false }),
			allowStatuses: [404],
		});
	}
}

function sameSet(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	return b.every((x) => set.has(x));
}
