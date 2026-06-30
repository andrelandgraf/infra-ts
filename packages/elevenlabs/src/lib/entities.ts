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

const API = "https://api.elevenlabs.io";

type ElevenLabsCreds = { ELEVENLABS_API_KEY: string };
const credsSchema = z.object({
	ELEVENLABS_API_KEY: z.string().min(1),
}) as unknown as StandardSchemaV1<unknown, ElevenLabsCreds>;

function rest(ctx: { credentials: ElevenLabsCreds }): RestClient {
	return createRestClient({
		provider: "elevenlabs",
		baseUrl: API,
		auth: {
			type: "header",
			name: "xi-api-key",
			value: ctx.credentials.ELEVENLABS_API_KEY,
		},
	});
}

// ─── Conversational AI agent ──────────────────────────────────────────────────

type AgentEnv = { elevenLabsAgentId: string };
interface RawAgent {
	agent_id: string;
}
export interface ElevenLabsAgentOptions extends EntityCommon<
	AgentEnv,
	{ id: string }
> {
	/** System prompt for the agent's LLM. */
	prompt?: string;
	/** The agent's opening line. */
	firstMessage?: string;
	/** Voice id for TTS. */
	voiceId?: string;
	/**
	 * Raw `conversation_config` passthrough, merged over the fields above for full control.
	 * See the ElevenLabs Conversational AI API.
	 */
	conversationConfig?: Record<string, unknown>;
}

export class ElevenLabsAgent extends Entity<
	ElevenLabsAgentOptions,
	ElevenLabsCreds,
	AgentEnv,
	{ id: string },
	RawAgent
> {
	readonly credentialsSchema = credsSchema;
	readonly envSchema = z.object({
		elevenLabsAgentId: z.string(),
	}) as unknown as StandardSchemaV1<unknown, AgentEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["elevenLabsAgentId"] as const;

	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return { ELEVENLABS_API_KEY: bag.ELEVENLABS_API_KEY ?? "" };
	}

	private conversationConfig(): Record<string, unknown> {
		const agent: Record<string, unknown> = {};
		if (this.config.prompt) agent.prompt = { prompt: this.config.prompt };
		if (this.config.firstMessage)
			agent.first_message = this.config.firstMessage;
		const base: Record<string, unknown> =
			Object.keys(agent).length > 0 ? { agent } : {};
		if (this.config.voiceId) base.tts = { voice_id: this.config.voiceId };
		return { ...base, ...(this.config.conversationConfig ?? {}) };
	}

	async read(
		ctx: ReadContext<ElevenLabsCreds, { id: string }>,
	): Promise<RawAgent | null> {
		if (!ctx.state?.id) return null;
		return rest(ctx).get<RawAgent | null>(`/v1/convai/agents/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
	diff(remote: RawAgent | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "agent", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<ElevenLabsCreds, { id: string }>,
	): Promise<ProvisionResult<AgentEnv, { id: string }>> {
		const existing = await this.read(ctx);
		if (existing) {
			return {
				action: "noop",
				id: existing.agent_id,
				state: { id: existing.agent_id },
				env: { elevenLabsAgentId: existing.agent_id },
			};
		}
		const created = await rest(ctx).post<RawAgent>("/v1/convai/agents/create", {
			body: {
				name: this.name,
				conversation_config: this.conversationConfig(),
			},
		});
		return {
			action: "create",
			id: created.agent_id,
			state: { id: created.agent_id },
			env: { elevenLabsAgentId: created.agent_id },
		};
	}
	async pullEnv(
		ctx: ReadContext<ElevenLabsCreds, { id: string }>,
	): Promise<AgentEnv> {
		if (!ctx.state?.id) {
			throw new InfraError(
				ErrorCode.NotFound,
				`elevenlabs: ${this.name} is not provisioned yet — run \`infra apply\` first.`,
			);
		}
		return { elevenLabsAgentId: ctx.state.id };
	}
	async deprovision(
		ctx: ProvisionContext<ElevenLabsCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await rest(ctx).delete(`/v1/convai/agents/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
}
