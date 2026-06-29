/**
 * `@infra-ts/vercel` — Vercel entities for infra-ts (v2).
 *
 * Typed, live-reconciled wrappers around the Vercel REST API: `VercelProject` (project +
 * settings + env vars + custom domains), `VercelEdgeConfig`, and `VercelWebhook`. Credentials
 * resolve from `VERCEL_TOKEN` or the Vercel CLI's cached token.
 */

export {
	VercelEdgeConfig,
	VercelProject,
	VercelWebhook,
	type VercelEdgeConfigOptions,
	type VercelProjectOptions,
	type VercelWebhookOptions,
} from "./lib/entities.js";

export {
	DEFAULT_VERCEL_API_HOST,
	resolveVercelCredentials,
	vercelTokenFromBag,
	type ResolvedVercelCredentials,
	type VercelCredentialOptions,
} from "./lib/credentials.js";
export { VercelApi, VERCEL_SETTING_KEYS } from "./lib/api.js";
export type {
	VercelDomainSnapshot,
	VercelEnvTarget,
	VercelProjectSettings,
	VercelProjectSnapshot,
} from "./lib/api.js";
