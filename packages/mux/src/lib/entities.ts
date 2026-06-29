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
	type StandardSchemaV1,
} from "@infra-ts/core";
import { z } from "zod";

const API = "https://api.mux.com";

type MuxCreds = { MUX_TOKEN_ID: string; MUX_TOKEN_SECRET: string };
const credsSchema = z.object({
	MUX_TOKEN_ID: z.string().min(1),
	MUX_TOKEN_SECRET: z.string().min(1),
}) as unknown as StandardSchemaV1<unknown, MuxCreds>;

abstract class MuxEntity<
	O extends EntityCommon<Env, State>,
	Env extends Record<string, string>,
	State extends Record<string, unknown>,
	Remote,
> extends Entity<O, MuxCreds, Env, State, Remote> {
	readonly credentialsSchema = credsSchema;
	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return {
			MUX_TOKEN_ID: bag.MUX_TOKEN_ID ?? "",
			MUX_TOKEN_SECRET: bag.MUX_TOKEN_SECRET ?? "",
		};
	}
	protected rest(ctx: { credentials: MuxCreds }): RestClient {
		return createRestClient({
			provider: "mux",
			baseUrl: API,
			auth: {
				type: "basic",
				username: ctx.credentials.MUX_TOKEN_ID,
				password: ctx.credentials.MUX_TOKEN_SECRET,
			},
		});
	}
}

// ─── Signing key (write-once private key; reused from env on checkout) ─────────

type SigningKeyEnv = { muxSigningKeyId: string; muxPrivateKey: string };
export type MuxSigningKeyOptions = EntityCommon<SigningKeyEnv, { id: string }>;

export class MuxSigningKey extends MuxEntity<
	MuxSigningKeyOptions,
	SigningKeyEnv,
	{ id: string },
	{ id: string }
> {
	readonly envSchema = z.object({
		muxSigningKeyId: z.string(),
		muxPrivateKey: z.string(),
	}) as unknown as StandardSchemaV1<unknown, SigningKeyEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["muxSigningKeyId", "muxPrivateKey"] as const;

	async read(
		ctx: ReadContext<MuxCreds, { id: string }>,
	): Promise<{ id: string } | null> {
		if (!ctx.state?.id) return null;
		const res = await this.rest(ctx).get<{ data: { id: string } } | null>(
			`/system/v1/signing-keys/${ctx.state.id}`,
			{ allowStatuses: [404] },
		);
		return res ? { id: res.data.id } : null;
	}
	diff(remote: { id: string } | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "signing-key", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<MuxCreds, { id: string }>,
	): Promise<ProvisionResult<SigningKeyEnv, { id: string }>> {
		if (ctx.state?.id) {
			const existing = await this.rest(ctx).get<{
				data: { id: string };
			} | null>(`/system/v1/signing-keys/${ctx.state.id}`, {
				allowStatuses: [404],
			});
			if (existing) {
				return {
					action: "noop",
					id: ctx.state.id,
					state: { id: ctx.state.id },
					env: {
						muxSigningKeyId: ctx.state.id,
						muxPrivateKey: process.env.MUX_PRIVATE_KEY ?? "",
					},
				};
			}
		}
		const res = await this.rest(ctx).post<{
			data: { id: string; private_key: string };
		}>("/system/v1/signing-keys");
		return {
			action: "create",
			id: res.data.id,
			state: { id: res.data.id },
			env: {
				muxSigningKeyId: res.data.id,
				muxPrivateKey: res.data.private_key,
			},
		};
	}
	async pullEnv(
		ctx: ReadContext<MuxCreds, { id: string }>,
	): Promise<SigningKeyEnv> {
		if (!ctx.state?.id) throw notProvisioned(this.name);
		return {
			muxSigningKeyId: ctx.state.id,
			muxPrivateKey: process.env.MUX_PRIVATE_KEY ?? "",
		};
	}
	async deprovision(
		ctx: ProvisionContext<MuxCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await this.rest(ctx).delete(`/system/v1/signing-keys/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
}

// ─── Live stream ──────────────────────────────────────────────────────────────

type LiveStreamEnv = {
	muxLiveStreamId: string;
	muxStreamKey: string;
	muxPlaybackId: string;
};
export interface MuxLiveStreamOptions extends EntityCommon<
	LiveStreamEnv,
	{ id: string }
> {
	playbackPolicy?: ("public" | "signed")[];
	latencyMode?: "low" | "reduced" | "standard";
}
interface RawLiveStream {
	id: string;
	stream_key: string;
	playback_ids?: { id: string; policy: string }[];
}

export class MuxLiveStream extends MuxEntity<
	MuxLiveStreamOptions,
	LiveStreamEnv,
	{ id: string },
	RawLiveStream
> {
	readonly envSchema = z.object({
		muxLiveStreamId: z.string(),
		muxStreamKey: z.string(),
		muxPlaybackId: z.string(),
	}) as unknown as StandardSchemaV1<unknown, LiveStreamEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = [
		"muxLiveStreamId",
		"muxStreamKey",
		"muxPlaybackId",
	] as const;

	async read(
		ctx: ReadContext<MuxCreds, { id: string }>,
	): Promise<RawLiveStream | null> {
		if (!ctx.state?.id) return null;
		const res = await this.rest(ctx).get<{ data: RawLiveStream } | null>(
			`/video/v1/live-streams/${ctx.state.id}`,
			{ allowStatuses: [404] },
		);
		return res ? res.data : null;
	}
	diff(remote: RawLiveStream | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "live-stream", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<MuxCreds, { id: string }>,
	): Promise<ProvisionResult<LiveStreamEnv, { id: string }>> {
		const existing = await this.read(ctx);
		const stream =
			existing ??
			(
				await this.rest(ctx).post<{ data: RawLiveStream }>(
					"/video/v1/live-streams",
					{
						body: {
							playback_policy: this.config.playbackPolicy ?? ["public"],
							...(this.config.latencyMode
								? { latency_mode: this.config.latencyMode }
								: {}),
						},
					},
				)
			).data;
		return {
			action: existing ? "noop" : "create",
			id: stream.id,
			state: { id: stream.id },
			env: liveStreamEnv(stream),
		};
	}
	async pullEnv(
		ctx: ReadContext<MuxCreds, { id: string }>,
	): Promise<LiveStreamEnv> {
		const stream = await this.read(ctx);
		if (!stream) throw notProvisioned(this.name);
		return liveStreamEnv(stream);
	}
	async deprovision(
		ctx: ProvisionContext<MuxCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await this.rest(ctx).delete(`/video/v1/live-streams/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
}
function liveStreamEnv(s: RawLiveStream): LiveStreamEnv {
	return {
		muxLiveStreamId: s.id,
		muxStreamKey: s.stream_key,
		muxPlaybackId: s.playback_ids?.[0]?.id ?? "",
	};
}

// ─── Playback restriction ─────────────────────────────────────────────────────

type PlaybackRestrictionEnv = { muxPlaybackRestrictionId: string };
export interface MuxPlaybackRestrictionOptions extends EntityCommon<
	PlaybackRestrictionEnv,
	{ id: string }
> {
	allowedDomains: string[];
	allowNoReferrer?: boolean;
}

export class MuxPlaybackRestriction extends MuxEntity<
	MuxPlaybackRestrictionOptions,
	PlaybackRestrictionEnv,
	{ id: string },
	{ id: string }
> {
	readonly envSchema = z.object({
		muxPlaybackRestrictionId: z.string(),
	}) as unknown as StandardSchemaV1<unknown, PlaybackRestrictionEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["muxPlaybackRestrictionId"] as const;

	async read(
		ctx: ReadContext<MuxCreds, { id: string }>,
	): Promise<{ id: string } | null> {
		if (!ctx.state?.id) return null;
		const res = await this.rest(ctx).get<{ data: { id: string } } | null>(
			`/video/v1/playback-restrictions/${ctx.state.id}`,
			{ allowStatuses: [404] },
		);
		return res ? { id: res.data.id } : null;
	}
	diff(remote: { id: string } | null): Change[] {
		return remote
			? []
			: [
					{
						action: "create",
						kind: "playback-restriction",
						identifier: this.name,
					},
				];
	}
	async provision(
		ctx: ProvisionContext<MuxCreds, { id: string }>,
	): Promise<ProvisionResult<PlaybackRestrictionEnv, { id: string }>> {
		const existing = await this.read(ctx);
		const id =
			existing?.id ??
			(
				await this.rest(ctx).post<{ data: { id: string } }>(
					"/video/v1/playback-restrictions",
					{
						body: {
							referrer: {
								allowed_domains: this.config.allowedDomains,
								allow_no_referrer: this.config.allowNoReferrer ?? false,
							},
						},
					},
				)
			).data.id;
		return {
			action: existing ? "noop" : "create",
			id,
			state: { id },
			env: { muxPlaybackRestrictionId: id },
		};
	}
	async pullEnv(
		ctx: ReadContext<MuxCreds, { id: string }>,
	): Promise<PlaybackRestrictionEnv> {
		if (!ctx.state?.id) throw notProvisioned(this.name);
		return { muxPlaybackRestrictionId: ctx.state.id };
	}
	async deprovision(
		ctx: ProvisionContext<MuxCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await this.rest(ctx).delete(
			`/video/v1/playback-restrictions/${ctx.state.id}`,
			{
				allowStatuses: [404],
			},
		);
	}
}

function notProvisioned(name: string): InfraError {
	return new InfraError(
		ErrorCode.NotFound,
		`mux: ${name} is not provisioned yet — run \`infra apply\` first.`,
	);
}
