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

const DEV_API = "https://api.upstash.com/v2";
const QSTASH_API = "https://qstash.upstash.io";

// ─── Redis + Vector share the developer API (HTTP basic: email:apiKey) ────────

type DevCreds = { UPSTASH_EMAIL: string; UPSTASH_API_KEY: string };
const devCredsSchema = z.object({
	UPSTASH_EMAIL: z.string().min(1),
	UPSTASH_API_KEY: z.string().min(1),
}) as unknown as StandardSchemaV1<unknown, DevCreds>;

abstract class UpstashDevEntity<
	O extends EntityCommon<Env, State>,
	Env extends Record<string, string>,
	State extends Record<string, unknown>,
	Remote,
> extends Entity<O, DevCreds, Env, State, Remote> {
	readonly credentialsSchema = devCredsSchema;
	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return {
			UPSTASH_EMAIL: bag.UPSTASH_EMAIL ?? "",
			UPSTASH_API_KEY: bag.UPSTASH_API_KEY ?? "",
		};
	}
	protected rest(ctx: { credentials: DevCreds }): RestClient {
		return createRestClient({
			provider: "upstash",
			baseUrl: DEV_API,
			auth: {
				type: "basic",
				username: ctx.credentials.UPSTASH_EMAIL,
				password: ctx.credentials.UPSTASH_API_KEY,
			},
		});
	}
}

// ─── Redis ────────────────────────────────────────────────────────────────────

type RedisEnv = {
	upstashRedisRestUrl: string;
	upstashRedisRestToken: string;
	redisUrl: string;
};
export interface UpstashRedisOptions extends EntityCommon<
	RedisEnv,
	{ id: string }
> {
	/** Regional id (e.g. "us-east-1") or "global". */
	region?: string;
	tls?: boolean;
}
interface RawRedis {
	database_id: string;
	endpoint: string;
	port: number;
	password: string;
	rest_token: string;
}

export class UpstashRedis extends UpstashDevEntity<
	UpstashRedisOptions,
	RedisEnv,
	{ id: string },
	RawRedis
> {
	readonly envSchema = z.object({
		upstashRedisRestUrl: z.string(),
		upstashRedisRestToken: z.string(),
		redisUrl: z.string(),
	}) as unknown as StandardSchemaV1<unknown, RedisEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = [
		"upstashRedisRestUrl",
		"upstashRedisRestToken",
		"redisUrl",
	] as const;

	async read(
		ctx: ReadContext<DevCreds, { id: string }>,
	): Promise<RawRedis | null> {
		if (!ctx.state?.id) return null;
		return this.rest(ctx).get<RawRedis | null>(
			`/redis/database/${ctx.state.id}`,
			{ allowStatuses: [404] },
		);
	}
	diff(remote: RawRedis | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "redis", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<DevCreds, { id: string }>,
	): Promise<ProvisionResult<RedisEnv, { id: string }>> {
		const rest = this.rest(ctx);
		let db = ctx.state?.id
			? await rest.get<RawRedis | null>(`/redis/database/${ctx.state.id}`, {
					allowStatuses: [404],
				})
			: null;
		let action: ChangeActionLocal = "noop";
		if (!db) {
			db = await rest.post<RawRedis>("/redis/database", {
				body: {
					name: this.name,
					region: this.config.region ?? "us-east-1",
					tls: this.config.tls ?? true,
				},
			});
			action = "create";
		}
		return {
			action,
			id: db.database_id,
			state: { id: db.database_id },
			env: redisEnv(db),
		};
	}
	async pullEnv(ctx: ReadContext<DevCreds, { id: string }>): Promise<RedisEnv> {
		if (!ctx.state?.id) throw notProvisioned(this.name);
		const db = await this.rest(ctx).get<RawRedis>(
			`/redis/database/${ctx.state.id}`,
		);
		return redisEnv(db);
	}
	async deprovision(
		ctx: ProvisionContext<DevCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await this.rest(ctx).delete(`/redis/database/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
}
function redisEnv(db: RawRedis): RedisEnv {
	return {
		upstashRedisRestUrl: `https://${db.endpoint}`,
		upstashRedisRestToken: db.rest_token,
		redisUrl: `rediss://default:${db.password}@${db.endpoint}:${db.port}`,
	};
}

// ─── Vector ────────────────────────────────────────────────────────────────────

type VectorEnv = {
	upstashVectorRestUrl: string;
	upstashVectorRestToken: string;
};
export interface UpstashVectorOptions extends EntityCommon<
	VectorEnv,
	{ id: string }
> {
	region?: "eu-west-1" | "us-east-1" | "us-central1";
	similarityFunction?: "COSINE" | "EUCLIDEAN" | "DOT_PRODUCT";
	dimensionCount?: number;
	type?: "payg" | "fixed" | "paid";
}
interface RawVector {
	id: string;
	endpoint: string;
	token: string;
}

export class UpstashVector extends UpstashDevEntity<
	UpstashVectorOptions,
	VectorEnv,
	{ id: string },
	RawVector
> {
	readonly envSchema = z.object({
		upstashVectorRestUrl: z.string(),
		upstashVectorRestToken: z.string(),
	}) as unknown as StandardSchemaV1<unknown, VectorEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = [
		"upstashVectorRestUrl",
		"upstashVectorRestToken",
	] as const;

	async read(
		ctx: ReadContext<DevCreds, { id: string }>,
	): Promise<RawVector | null> {
		if (!ctx.state?.id) return null;
		return this.rest(ctx).get<RawVector | null>(
			`/vector/index/${ctx.state.id}`,
			{ allowStatuses: [404] },
		);
	}
	diff(remote: RawVector | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "vector", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<DevCreds, { id: string }>,
	): Promise<ProvisionResult<VectorEnv, { id: string }>> {
		const rest = this.rest(ctx);
		let idx = ctx.state?.id
			? await rest.get<RawVector | null>(`/vector/index/${ctx.state.id}`, {
					allowStatuses: [404],
				})
			: null;
		let action: ChangeActionLocal = "noop";
		if (!idx) {
			idx = await rest.post<RawVector>("/vector/index", {
				body: {
					name: this.name,
					region: this.config.region ?? "us-east-1",
					similarity_function: this.config.similarityFunction ?? "COSINE",
					dimension_count: this.config.dimensionCount ?? 1536,
					...(this.config.type ? { type: this.config.type } : {}),
				},
			});
			action = "create";
		}
		return { action, id: idx.id, state: { id: idx.id }, env: vectorEnv(idx) };
	}
	async pullEnv(
		ctx: ReadContext<DevCreds, { id: string }>,
	): Promise<VectorEnv> {
		if (!ctx.state?.id) throw notProvisioned(this.name);
		const idx = await this.rest(ctx).get<RawVector>(
			`/vector/index/${ctx.state.id}`,
		);
		return vectorEnv(idx);
	}
	async deprovision(
		ctx: ProvisionContext<DevCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await this.rest(ctx).delete(`/vector/index/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
}
function vectorEnv(idx: RawVector): VectorEnv {
	return {
		upstashVectorRestUrl: `https://${idx.endpoint}`,
		upstashVectorRestToken: idx.token,
	};
}

// ─── QStash queue (Bearer QSTASH_TOKEN) ───────────────────────────────────────

type QStashCreds = { QSTASH_TOKEN: string };
type QStashQueueEnv = { qstashQueueName: string };
export interface UpstashQStashQueueOptions extends EntityCommon<
	QStashQueueEnv,
	{ id: string }
> {
	parallelism?: number;
}

export class UpstashQStashQueue extends Entity<
	UpstashQStashQueueOptions,
	QStashCreds,
	QStashQueueEnv,
	{ id: string },
	{ name: string }
> {
	readonly credentialsSchema = z.object({
		QSTASH_TOKEN: z.string().min(1),
	}) as unknown as StandardSchemaV1<unknown, QStashCreds>;
	readonly envSchema = z.object({
		qstashQueueName: z.string(),
	}) as unknown as StandardSchemaV1<unknown, QStashQueueEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["qstashQueueName"] as const;
	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return { QSTASH_TOKEN: bag.QSTASH_TOKEN ?? "" };
	}
	private rest(ctx: { credentials: QStashCreds }): RestClient {
		return createRestClient({
			provider: "upstash-qstash",
			baseUrl: QSTASH_API,
			auth: { type: "bearer", token: ctx.credentials.QSTASH_TOKEN },
		});
	}
	async read(
		ctx: ReadContext<QStashCreds, { id: string }>,
	): Promise<{ name: string } | null> {
		return this.rest(ctx).get<{ name: string } | null>(
			`/v2/queues/${encodeURIComponent(this.name)}`,
			{ allowStatuses: [404] },
		);
	}
	diff(remote: { name: string } | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "qstash-queue", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<QStashCreds, { id: string }>,
	): Promise<ProvisionResult<QStashQueueEnv, { id: string }>> {
		await this.rest(ctx).post("/v2/queues/", {
			body: {
				queueName: this.name,
				...(this.config.parallelism
					? { parallelism: this.config.parallelism }
					: {}),
			},
		});
		return {
			action: ctx.state ? "noop" : "create",
			id: this.name,
			state: { id: this.name },
			env: { qstashQueueName: this.name },
		};
	}
	async pullEnv(): Promise<QStashQueueEnv> {
		return { qstashQueueName: this.name };
	}
	async deprovision(
		ctx: ProvisionContext<QStashCreds, { id: string }>,
	): Promise<void> {
		await this.rest(ctx).delete(`/v2/queues/${encodeURIComponent(this.name)}`, {
			allowStatuses: [404],
		});
	}
}

// ─── QStash schedules + topics (Bearer QSTASH_TOKEN) ──────────────────────────

const qstashCredsSchema = z.object({
	QSTASH_TOKEN: z.string().min(1),
}) as unknown as StandardSchemaV1<unknown, QStashCreds>;

function qstashRest(ctx: { credentials: QStashCreds }): RestClient {
	return createRestClient({
		provider: "upstash-qstash",
		baseUrl: QSTASH_API,
		auth: { type: "bearer", token: ctx.credentials.QSTASH_TOKEN },
	});
}

type ScheduleEnv = Record<string, never>;
export interface UpstashQStashScheduleOptions extends EntityCommon<
	ScheduleEnv,
	{ id: string }
> {
	/** Destination URL (or a topic/URL-group name) the schedule delivers to. */
	destination: string | Ref<string>;
	/** Cron expression, e.g. `"0 * * * *"`. */
	cron: string;
}

export class UpstashQStashSchedule extends Entity<
	UpstashQStashScheduleOptions,
	QStashCreds,
	ScheduleEnv,
	{ id: string },
	{ scheduleId: string }
> {
	readonly credentialsSchema = qstashCredsSchema;
	readonly envSchema = z.object({}) as unknown as StandardSchemaV1<
		unknown,
		ScheduleEnv
	>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = [] as const;
	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return { QSTASH_TOKEN: bag.QSTASH_TOKEN ?? "" };
	}
	async read(
		ctx: ReadContext<QStashCreds, { id: string }>,
	): Promise<{ scheduleId: string } | null> {
		if (!ctx.state?.id) return null;
		return qstashRest(ctx).get<{ scheduleId: string } | null>(
			`/v2/schedules/${ctx.state.id}`,
			{ allowStatuses: [404] },
		);
	}
	diff(remote: { scheduleId: string } | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "qstash-schedule", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<QStashCreds, { id: string }>,
	): Promise<ProvisionResult<ScheduleEnv, { id: string }>> {
		const existing = await this.read(ctx);
		if (existing) {
			return {
				action: "noop",
				id: existing.scheduleId,
				state: { id: existing.scheduleId },
				env: {},
			};
		}
		const created = await qstashRest(ctx).post<{ scheduleId: string }>(
			`/v2/schedules/${encodeURIComponent(this.config.destination)}`,
			{ headers: { "Upstash-Cron": this.config.cron }, body: {} },
		);
		return {
			action: "create",
			id: created.scheduleId,
			state: { id: created.scheduleId },
			env: {},
		};
	}
	async pullEnv(): Promise<ScheduleEnv> {
		return {};
	}
	async deprovision(
		ctx: ProvisionContext<QStashCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await qstashRest(ctx).delete(`/v2/schedules/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
}

type TopicEnv = { qstashTopicName: string };
export interface UpstashQStashTopicOptions extends EntityCommon<
	TopicEnv,
	{ name: string }
> {
	/** Endpoint URLs that belong to this topic (URL group). */
	endpoints: (string | Ref<string>)[];
}

export class UpstashQStashTopic extends Entity<
	UpstashQStashTopicOptions,
	QStashCreds,
	TopicEnv,
	{ name: string },
	{ name: string }
> {
	readonly credentialsSchema = qstashCredsSchema;
	readonly envSchema = z.object({
		qstashTopicName: z.string(),
	}) as unknown as StandardSchemaV1<unknown, TopicEnv>;
	readonly stateSchema = z.object({
		name: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { name: string }>;
	readonly envKeys = ["qstashTopicName"] as const;
	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return { QSTASH_TOKEN: bag.QSTASH_TOKEN ?? "" };
	}
	async read(
		ctx: ReadContext<QStashCreds, { name: string }>,
	): Promise<{ name: string } | null> {
		return qstashRest(ctx).get<{ name: string } | null>(
			`/v2/topics/${encodeURIComponent(this.name)}`,
			{ allowStatuses: [404] },
		);
	}
	diff(remote: { name: string } | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "qstash-topic", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<QStashCreds, { name: string }>,
	): Promise<ProvisionResult<TopicEnv, { name: string }>> {
		const existing = await this.read(ctx);
		if (!existing) {
			await qstashRest(ctx).post(
				`/v2/topics/${encodeURIComponent(this.name)}/endpoints`,
				{
					body: {
						endpoints: this.config.endpoints.map((url) => ({ url })),
					},
				},
			);
		}
		return {
			action: existing ? "noop" : "create",
			id: this.name,
			state: { name: this.name },
			env: { qstashTopicName: this.name },
		};
	}
	async pullEnv(): Promise<TopicEnv> {
		return { qstashTopicName: this.name };
	}
	async deprovision(
		ctx: ProvisionContext<QStashCreds, { name: string }>,
	): Promise<void> {
		await qstashRest(ctx).delete(
			`/v2/topics/${encodeURIComponent(this.name)}`,
			{
				allowStatuses: [404],
			},
		);
	}
}

type ChangeActionLocal = "create" | "update" | "noop" | "delete";
function notProvisioned(name: string): InfraError {
	return new InfraError(
		ErrorCode.NotFound,
		`upstash: ${name} is not provisioned yet — run \`infra apply\` first.`,
	);
}
