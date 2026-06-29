/**
 * `@infra-ts/runtime` — the infra-ts engine (imperative shell, v2).
 *
 * Loads `infra.ts` (jiti), reads/writes the per-environment `.infra.<env>` state, resolves
 * credentials, and runs the core operations across the entity graph in dependency order:
 * `plan` / `apply` / `status` / `checkout` / `destroy`, plus the hook runner and env-file writer.
 */

export {
	CONFIG_FILE_NAMES,
	loadConfig,
	type LoadConfigOptions,
	type LoadedConfig,
} from "./lib/load-config.js";

export {
	apply,
	checkout,
	destroy,
	plan,
	resolveEnvironment,
	status,
	type ApplyOptions,
	type ApplyReport,
	type CheckoutOptions,
	type CheckoutReport,
	type DestroyReport,
	type EngineOptions,
	type PlanReport,
	type StatusReport,
} from "./lib/engine.js";

export { resolveEntityCredentials } from "./lib/credentials.js";
export { runHook, type RunHookOptions } from "./lib/hooks-runner.js";
export { envFileFor, toEntries, writeEnvFile } from "./lib/dotenv.js";
export {
	applyRenames,
	emptyState,
	readState,
	STATE_VERSION,
	stateFilePath,
	writeState,
	type InfraState,
} from "./lib/state-file.js";
export { findUp } from "./lib/find-up.js";
