/**
 * `@infra-ts/vercel` — Vercel entities for infra-ts (v2).
 *
 * Typed, live-reconciled wrappers around the Vercel REST API: `VercelProject` (project +
 * settings + env vars + custom domains), `VercelEdgeConfig`, `VercelWebhook`, `VercelDnsRecord`,
 * `VercelLogDrain`, and `VercelAccessGroup`. Credentials resolve from `VERCEL_TOKEN` or the Vercel
 * CLI's cached token.
 */

export {
	VercelAccessGroup,
	VercelAccount,
	VercelDnsRecord,
	VercelEdgeConfig,
	VercelLogDrain,
	VercelProject,
	VercelWebhook,
	type VercelAccessGroupOptions,
	type VercelAccountOptions,
	type VercelDnsRecordOptions,
	type VercelEdgeConfigOptions,
	type VercelLogDrainOptions,
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
	VercelAccessGroupSnapshot,
	VercelDnsRecordSnapshot,
	VercelDomainSnapshot,
	VercelEnvTarget,
	VercelLogDrainSnapshot,
	VercelProjectSettings,
	VercelProjectSnapshot,
} from "./lib/api.js";
