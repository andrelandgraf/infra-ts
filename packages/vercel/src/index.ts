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
	VercelDeployment,
	VercelDnsRecord,
	VercelEdgeConfig,
	VercelLogDrain,
	VercelProject,
	VercelTeam,
	VercelWebhook,
	type VercelAccessGroupOptions,
	type VercelAccountOptions,
	type VercelDeploymentOptions,
	type VercelDnsRecordOptions,
	type VercelEdgeConfigOptions,
	type VercelLogDrainOptions,
	type VercelProjectOptions,
	type VercelTeamOptions,
	type VercelWebhookOptions,
} from "./lib/entities.js";
export { collectFiles, contentHash, type DeployFile } from "./lib/deploy.js";

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
	VercelDeploymentSnapshot,
	VercelDnsRecordSnapshot,
	VercelDomainSnapshot,
	VercelEnvTarget,
	VercelLogDrainSnapshot,
	VercelProjectSettings,
	VercelProjectSnapshot,
} from "./lib/api.js";
