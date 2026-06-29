/**
 * `@infra-ts/neon` — Neon entities for infra-ts (v2).
 *
 * Typed, live-reconciled wrappers around the Neon management REST API: a `NeonProject`
 * (region, Postgres version, default-branch compute + TTL), `NeonPostgres` (connection strings),
 * `NeonAuth` (Neon Auth / Better Auth), and `NeonDataApi` (PostgREST). Credentials resolve from
 * `NEON_API_KEY` or the `neonctl` OAuth cache.
 */

export {
	NeonAuth,
	NeonDataApi,
	NeonPostgres,
	NeonProject,
	type NeonAuthOptions,
	type NeonComputeConfig,
	type NeonDataApiOptions,
	type NeonPostgresOptions,
	type NeonProjectOptions,
} from "./lib/entities.js";

export {
	DEFAULT_NEON_API_HOST,
	neonTokenFromBag,
	resolveNeonCredentials,
	type NeonCredentialOptions,
	type ResolvedNeonCredentials,
} from "./lib/credentials.js";
export { NeonApi } from "./lib/api.js";
export type {
	EnableDataApiInput,
	NeonAuthSnapshot,
	NeonBranchSnapshot,
	NeonBucketSnapshot,
	NeonDataApiSettings,
	NeonDataApiSnapshot,
	NeonEndpointSnapshot,
	NeonFunctionSnapshot,
	NeonProjectSnapshot,
} from "./lib/api.js";
export { bundleFunction } from "./lib/bundle.js";
export { parseDurationSeconds } from "./lib/duration.js";
