import {
	type Change,
	createRestClient,
	Entity,
	type EntityCommon,
	type ProvisionContext,
	type ProvisionResult,
	type ReadContext,
	type RestClient,
	type StandardSchemaV1,
} from "@infra-ts/core";
import { z } from "zod";

const DEFAULT_API = "https://statsigapi.net/console/v1";

type StatsigCreds = { STATSIG_CONSOLE_API_KEY: string };
const credsSchema = z.object({
	STATSIG_CONSOLE_API_KEY: z.string().min(1),
}) as unknown as StandardSchemaV1<unknown, StatsigCreds>;

type StatsigState = { id: string };
const stateSchema = z.object({
	id: z.string(),
}) as unknown as StandardSchemaV1<unknown, StatsigState>;
const emptyEnv = z.object({}) as unknown as StandardSchemaV1<
	unknown,
	Record<string, never>
>;

export interface StatsigResourceOptions extends EntityCommon<
	Record<string, never>,
	StatsigState
> {
	description?: string;
	isEnabled?: boolean;
}

interface StatsigEnvelope {
	data: { id: string };
}

/** Shared lifecycle for Statsig console resources (gates / dynamic configs / experiments). */
abstract class StatsigResource extends Entity<
	StatsigResourceOptions,
	StatsigCreds,
	Record<string, never>,
	StatsigState,
	{ id: string }
> {
	readonly credentialsSchema = credsSchema;
	readonly envSchema = emptyEnv;
	readonly stateSchema = stateSchema;
	readonly envKeys = [] as const;

	/** REST path segment, e.g. `gates`, `dynamic_configs`, `experiments`. */
	protected abstract readonly resourcePath: string;
	/** Change kind label. */
	protected abstract readonly kind: string;

	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return { STATSIG_CONSOLE_API_KEY: bag.STATSIG_CONSOLE_API_KEY ?? "" };
	}
	private rest(ctx: { credentials: StatsigCreds }): RestClient {
		return createRestClient({
			provider: "statsig",
			baseUrl: process.env.STATSIG_API_HOST ?? DEFAULT_API,
			auth: {
				type: "header",
				name: "STATSIG-API-KEY",
				value: ctx.credentials.STATSIG_CONSOLE_API_KEY,
			},
		});
	}

	async read(
		ctx: ReadContext<StatsigCreds, StatsigState>,
	): Promise<{ id: string } | null> {
		if (!ctx.state?.id) return null;
		const res = await this.rest(ctx).get<StatsigEnvelope | null>(
			`/${this.resourcePath}/${ctx.state.id}`,
			{ allowStatuses: [404] },
		);
		return res ? { id: res.data.id } : null;
	}
	diff(remote: { id: string } | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: this.kind, identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<StatsigCreds, StatsigState>,
	): Promise<ProvisionResult<Record<string, never>, StatsigState>> {
		const existing = await this.read(ctx);
		if (existing) {
			return {
				action: "noop",
				id: existing.id,
				state: { id: existing.id },
				env: {},
			};
		}
		const res = await this.rest(ctx).post<StatsigEnvelope>(
			`/${this.resourcePath}`,
			{
				body: {
					name: this.name,
					...(this.config.description
						? { description: this.config.description }
						: {}),
					...(this.config.isEnabled !== undefined
						? { isEnabled: this.config.isEnabled }
						: {}),
				},
			},
		);
		return {
			action: "create",
			id: res.data.id,
			state: { id: res.data.id },
			env: {},
		};
	}
	async pullEnv(): Promise<Record<string, never>> {
		return {};
	}
	async deprovision(
		ctx: ProvisionContext<StatsigCreds, StatsigState>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await this.rest(ctx).delete(`/${this.resourcePath}/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
}

export class StatsigGate extends StatsigResource {
	protected readonly resourcePath = "gates";
	protected readonly kind = "feature-gate";
}
export class StatsigDynamicConfig extends StatsigResource {
	protected readonly resourcePath = "dynamic_configs";
	protected readonly kind = "dynamic-config";
}
export class StatsigExperiment extends StatsigResource {
	protected readonly resourcePath = "experiments";
	protected readonly kind = "experiment";
}

// Exposed as a type for advanced authoring; the base is abstract (not constructed directly).
export type { StatsigResource };
