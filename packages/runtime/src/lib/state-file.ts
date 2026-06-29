import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, InfraError, type Rename } from "@infra-ts/core";

export const STATE_VERSION = 2 as const;

/** The per-environment `.infra.<env>` link file: identity state only (ids + content hashes). */
export interface InfraState {
	version: typeof STATE_VERSION;
	environment: string;
	/** entity id → its persisted state (validated by each entity's `stateSchema`). */
	entities: Record<string, Record<string, unknown>>;
}

/** Path to the link file for an environment, e.g. `.infra.production`. */
export function stateFilePath(rootDir: string, environment: string): string {
	return join(rootDir, `.infra.${environment}`);
}

export function emptyState(environment: string): InfraState {
	return { version: STATE_VERSION, environment, entities: {} };
}

export function readState(rootDir: string, environment: string): InfraState {
	try {
		const raw = readFileSync(stateFilePath(rootDir, environment), "utf8");
		const json: unknown = JSON.parse(raw);
		if (!json || typeof json !== "object") return emptyState(environment);
		const obj = json as Record<string, unknown>;
		const entities: Record<string, Record<string, unknown>> = {};
		if (obj.entities && typeof obj.entities === "object") {
			for (const [name, st] of Object.entries(obj.entities)) {
				if (st && typeof st === "object") {
					entities[name] = st as Record<string, unknown>;
				}
			}
		}
		return { version: STATE_VERSION, environment, entities };
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return emptyState(environment);
		}
		throw new InfraError(
			ErrorCode.InvalidState,
			`Failed to read ${stateFilePath(rootDir, environment)}: ${(error as Error)?.message ?? String(error)}`,
			{ cause: error },
		);
	}
}

export function writeState(
	rootDir: string,
	environment: string,
	state: InfraState,
): void {
	const ordered: InfraState = {
		version: STATE_VERSION,
		environment,
		entities: sortRecord(state.entities),
	};
	writeFileSync(
		stateFilePath(rootDir, environment),
		`${JSON.stringify(ordered, null, 2)}\n`,
		"utf8",
	);
}

/** Apply `renames` in place (re-key state from old → new). Throws on ambiguity. */
export function applyRenames(state: InfraState, renames: Rename[]): InfraState {
	const entities = { ...state.entities };
	for (const { old, new: next } of renames) {
		if (!(old in entities)) continue; // idempotent: nothing to move
		if (next in entities) {
			throw new InfraError(
				ErrorCode.InvalidState,
				`Rename conflict: both "${old}" and "${next}" exist in .infra.${state.environment}. Resolve manually.`,
			);
		}
		entities[next] = entities[old] as Record<string, unknown>;
		delete entities[old];
	}
	return { ...state, entities };
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
	const out: Record<string, T> = {};
	for (const key of Object.keys(record).sort()) out[key] = record[key] as T;
	return out;
}
