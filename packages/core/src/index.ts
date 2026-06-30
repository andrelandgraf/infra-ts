/**
 * `@infra-ts/core` — the infra-ts open standard (v2: the Entity model).
 *
 * Defines the `Entity` contract every provider implements (a thin, typed wrapper around a remote
 * REST API), plus the shared primitives: `defineInfra`, Standard Schema plumbing, typed output
 * refs + the dependency graph, the env-key mapping, a small REST client (bearer/basic), runtime
 * `parseEnv`, errors, and logging. Runtime-free (no filesystem, no child processes).
 */

export {
	defineInfra,
	type Infra,
	type InfraConfigInput,
	type InfraEnv,
	type Rename,
} from "./lib/config.js";

export {
	Entity,
	type AnyEntity,
	type BaseContext,
	type Change,
	type ChangeAction,
	type CliTool,
	type DiffContext,
	type EntityCommon,
	type EntityEnv,
	type EntityHooks,
	type Exec,
	type ExecOptions,
	type ExecResult,
	type Hook,
	type ProvisionContext,
	type ProvisionResult,
	type ReadContext,
} from "./lib/entity.js";

export { assertUniqueIds, collectEntities, topoSort } from "./lib/graph.js";

export {
	Account,
	type AccountOptions,
	type AccountScope,
	type AccountState,
	type CliAuth,
} from "./lib/account.js";

export {
	ErrorCode,
	InfraError,
	isInfraError,
	type InfraErrorOptions,
} from "./lib/errors.js";

export { consoleLogger, silentLogger, type Logger } from "./lib/logger.js";

export {
	collectRefEntities,
	deepResolve,
	envRefs,
	idRef,
	isRef,
	resolveRef,
	type EnvRefs,
	type Ref,
	type Resolved,
	type ResolvedOutput,
	type ResolvedOutputs,
} from "./lib/ref.js";

export { constantCase, osKeyFor, type EnvKeyOverride } from "./lib/env-keys.js";

export { mergeEnv, type EnvInput } from "./lib/env-merge.js";

export {
	createRestClient,
	type RequestOptions,
	type RestAuth,
	type RestClient,
	type RestClientOptions,
} from "./lib/rest.js";

export {
	validate,
	type InferOutput,
	type OutputKeys,
	type StandardSchemaV1,
} from "./lib/standard-schema.js";

export { parseEnv } from "./lib/parse-env.js";

export { slugify, type SlugifyOptions } from "./lib/slug.js";
