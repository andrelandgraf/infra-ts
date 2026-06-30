/**
 * `@infra-ts/elevenlabs` — ElevenLabs entities for infra-ts.
 *
 * `ElevenLabsAgent` (Conversational AI; emits `ELEVENLABS_AGENT_ID`). Credentials resolve from
 * `ELEVENLABS_API_KEY` (sent as the `xi-api-key` header). Speech synthesis itself is a runtime API,
 * so it's out of scope for config-as-code.
 */
export {
	ElevenLabsAgent,
	type ElevenLabsAgentOptions,
} from "./lib/entities.js";
