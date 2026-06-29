import {
	type AnyEntity,
	type Change,
	ErrorCode,
	type Infra,
	type InfraEnv,
	InfraError,
	type Logger,
	type ProvisionResult,
	type ResolvedOutputs,
	silentLogger,
	validate,
} from "@infra-ts/core";
import { resolveEntityCredentials } from "./credentials.js";
import { envFileFor, toEntries, writeEnvFile } from "./dotenv.js";
import { runHook } from "./hooks-runner.js";
import {
	applyRenames,
	type InfraState,
	readState,
	writeState,
} from "./state-file.js";

export interface EngineOptions {
	environment?: string;
	rootDir?: string;
	logger?: Logger;
	only?: string[];
}
export interface ApplyOptions extends EngineOptions {
	writeEnv?: boolean;
	prune?: boolean;
}
export interface CheckoutOptions extends EngineOptions {
	writeEnv?: boolean;
	ignoreDiff?: boolean;
}

export interface PlanReport {
	environment: string;
	changes: Change[];
}
export interface ApplyReport {
	environment: string;
	changes: Change[];
	env: InfraEnv;
	envFile?: string;
	envKeysWritten: string[];
	orphans: string[];
}
export interface StatusReport {
	environment: string;
	entities: { name: string; exists: boolean; changes: Change[] }[];
}
export interface CheckoutReport {
	environment: string;
	env: InfraEnv;
	envFile?: string;
	envKeysWritten: string[];
	drift: Change[];
}
export interface DestroyReport {
	environment: string;
	changes: Change[];
}

/** Resolve the active environment: explicit option → `INFRA_ENV` → config default → "local". */
export function resolveEnvironment(
	infra: Infra,
	options: EngineOptions,
): string {
	return (
		options.environment ??
		process.env.INFRA_ENV ??
		infra.defaultEnvironment ??
		"local"
	);
}

function selected(infra: Infra, only: string[] | undefined): AnyEntity[] {
	if (!only) return infra.ordered;
	const set = new Set(only);
	return infra.ordered.filter((e) => set.has(e.name));
}

function stateId(
	state: Record<string, unknown> | undefined,
): string | undefined {
	const id = state?.id;
	return typeof id === "string" ? id : undefined;
}

function tagged(changes: Change[], provider: string): Change[] {
	return changes.map((c) => ({ ...c, provider }));
}

/** `infra plan` — dry run; reads live remote and diffs. No mutations, no hooks, no state writes. */
export async function plan(
	infra: Infra,
	options: EngineOptions = {},
): Promise<PlanReport> {
	const environment = resolveEnvironment(infra, options);
	const rootDir = options.rootDir ?? process.cwd();
	const logger = options.logger ?? silentLogger;
	const state = applyRenames(readState(rootDir, environment), infra.renames);
	const outputs: ResolvedOutputs = {};
	const changes: Change[] = [];

	for (const entity of selected(infra, options.only)) {
		const credentials = resolveEntityCredentials(infra, entity, environment);
		entity.bindOutputs(outputs);
		const entState = state.entities[entity.name] ?? null;
		const ctx = { environment, credentials, logger, state: entState };
		const remote = await entity.read(ctx);
		changes.push(...tagged(entity.diff(remote, { environment }), entity.name));
		if (remote !== null) {
			// Existing: resolve outputs so downstream refs read against real values (best-effort).
			try {
				const env = await entity.pullEnv(ctx);
				outputs[entity.name] = {
					id: stateId(entState ?? undefined) ?? entity.name,
					env: stringify(env),
				};
			} catch {
				/* not fully ready; downstream sees an unresolved ref */
			}
		}
	}
	return { environment, changes };
}

/** `infra apply` — reconcile remote to config, persist state, write env, run hooks. */
export async function apply(
	infra: Infra,
	options: ApplyOptions = {},
): Promise<ApplyReport> {
	const environment = resolveEnvironment(infra, options);
	const rootDir = options.rootDir ?? process.cwd();
	const logger = options.logger ?? silentLogger;
	let state = applyRenames(readState(rootDir, environment), infra.renames);
	writeState(rootDir, environment, state);
	const outputs: ResolvedOutputs = {};
	const envByEntity: InfraEnv = {};
	const changes: Change[] = [];

	for (const entity of selected(infra, options.only)) {
		const credentials = resolveEntityCredentials(infra, entity, environment);
		entity.bindOutputs(outputs);
		const entState = state.entities[entity.name] ?? null;
		const ctx = { environment, credentials, logger, state: entState };

		await runHook(
			entity.hooks?.provision?.before,
			{ environment },
			{ cwd: rootDir },
		);

		const result: ProvisionResult<
			Record<string, string>,
			Record<string, unknown>
		> = await entity.provision(ctx);
		const stateVal = validate(
			entity.stateSchema,
			result.state,
			`${entity.name} state`,
		) as Record<string, unknown>;
		const envVal = validate(
			entity.envSchema,
			result.env,
			`${entity.name} env`,
		) as Record<string, string>;

		state = {
			...state,
			entities: { ...state.entities, [entity.name]: stateVal },
		};
		writeState(rootDir, environment, state); // incremental

		outputs[entity.name] = {
			id: result.id ?? stateId(stateVal) ?? entity.name,
			env: stringify(envVal),
		};
		envByEntity[entity.name] = envVal;
		changes.push({
			provider: entity.name,
			action: result.action,
			kind: "entity",
			identifier: entity.name,
			...(result.message ? { detail: result.message } : {}),
		});

		await runHook(
			entity.hooks?.provision?.after,
			{ environment, action: result.action, state: stateVal, env: envVal },
			{ cwd: rootDir, env: stringify(envVal) },
		);
	}

	const written = writeResolvedEnv(
		infra,
		rootDir,
		environment,
		envByEntity,
		options,
	);
	const declared = new Set(infra.entities.map((e) => e.name));
	const orphans = Object.keys(state.entities).filter((n) => !declared.has(n));

	const report: ApplyReport = {
		environment,
		changes,
		env: envByEntity,
		envKeysWritten: written.keys,
		orphans,
	};
	if (written.file) report.envFile = written.file;
	return report;
}

/** `infra status` — live state of every entity + per-entity drift. Read-only. */
export async function status(
	infra: Infra,
	options: EngineOptions = {},
): Promise<StatusReport> {
	const environment = resolveEnvironment(infra, options);
	const rootDir = options.rootDir ?? process.cwd();
	const logger = options.logger ?? silentLogger;
	const state = applyRenames(readState(rootDir, environment), infra.renames);
	const outputs: ResolvedOutputs = {};
	const entities: { name: string; exists: boolean; changes: Change[] }[] = [];

	for (const entity of selected(infra, options.only)) {
		const credentials = resolveEntityCredentials(infra, entity, environment);
		entity.bindOutputs(outputs);
		const entState = state.entities[entity.name] ?? null;
		const ctx = { environment, credentials, logger, state: entState };
		const remote = await entity.read(ctx);
		entities.push({
			name: entity.name,
			exists: remote !== null,
			changes: entity.diff(remote, { environment }),
		});
		if (remote !== null) {
			try {
				outputs[entity.name] = {
					id: stateId(entState ?? undefined) ?? entity.name,
					env: stringify(await entity.pullEnv(ctx)),
				};
			} catch {
				/* ignore */
			}
		}
	}
	return { environment, entities };
}

/** `infra checkout` — pull typed env from live remote + drift guard. */
export async function checkout(
	infra: Infra,
	options: CheckoutOptions = {},
): Promise<CheckoutReport> {
	const environment = resolveEnvironment(infra, options);
	const rootDir = options.rootDir ?? process.cwd();
	const logger = options.logger ?? silentLogger;
	const state = applyRenames(readState(rootDir, environment), infra.renames);
	const outputs: ResolvedOutputs = {};
	const envByEntity: InfraEnv = {};
	const drift: Change[] = [];

	for (const entity of selected(infra, options.only)) {
		const credentials = resolveEntityCredentials(infra, entity, environment);
		entity.bindOutputs(outputs);
		const entState = state.entities[entity.name] ?? null;
		const ctx = { environment, credentials, logger, state: entState };
		const remote = await entity.read(ctx);
		drift.push(...tagged(entity.diff(remote, { environment }), entity.name));
		const env = await entity.pullEnv(ctx);
		const envVal = validate(
			entity.envSchema,
			env,
			`${entity.name} env`,
		) as Record<string, string>;
		envByEntity[entity.name] = envVal;
		outputs[entity.name] = {
			id: stateId(entState ?? undefined) ?? entity.name,
			env: stringify(envVal),
		};
	}

	if (drift.length > 0 && !options.ignoreDiff) {
		throw new InfraError(
			ErrorCode.Drift,
			`checkout: live remote differs from your config for ${environment} (${drift.length} change(s)). Run \`infra apply\`, or pass --ignore-diff to pull anyway.`,
			{ details: { drift } },
		);
	}

	const written = writeResolvedEnv(
		infra,
		rootDir,
		environment,
		envByEntity,
		options,
	);
	const report: CheckoutReport = {
		environment,
		env: envByEntity,
		envKeysWritten: written.keys,
		drift,
	};
	if (written.file) report.envFile = written.file;
	return report;
}

/** `infra destroy` — deprovision all entities in reverse order; clear state. */
export async function destroy(
	infra: Infra,
	options: EngineOptions = {},
): Promise<DestroyReport> {
	const environment = resolveEnvironment(infra, options);
	const rootDir = options.rootDir ?? process.cwd();
	const logger = options.logger ?? silentLogger;
	let state = applyRenames(readState(rootDir, environment), infra.renames);
	const outputs: ResolvedOutputs = {};
	const changes: Change[] = [];

	for (const entity of [...selected(infra, options.only)].reverse()) {
		const credentials = resolveEntityCredentials(infra, entity, environment);
		entity.bindOutputs(outputs);
		const entState = state.entities[entity.name] ?? null;
		const ctx = { environment, credentials, logger, state: entState };
		await entity.deprovision(ctx);
		const entities = { ...state.entities };
		delete entities[entity.name];
		state = { ...state, entities };
		writeState(rootDir, environment, state);
		changes.push({
			provider: entity.name,
			action: "delete",
			kind: "entity",
			identifier: entity.name,
		});
	}
	return { environment, changes };
}

function stringify(env: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env))
		if (v !== undefined) out[k] = String(v);
	return out;
}

function writeResolvedEnv(
	infra: Infra,
	rootDir: string,
	environment: string,
	envByEntity: InfraEnv,
	options: { writeEnv?: boolean },
): { file?: string; keys: string[] } {
	if (options.writeEnv === false) return { keys: [] };
	const entries = toEntries(infra, envByEntity);
	const file = envFileFor(environment);
	const keys = writeEnvFile(rootDir, file, entries);
	return { file, keys };
}
