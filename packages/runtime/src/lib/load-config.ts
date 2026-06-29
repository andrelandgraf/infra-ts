import { dirname, resolve } from "node:path";
import { ErrorCode, type Infra, InfraError } from "@infra-ts/core";
import { createJiti } from "jiti";
import { findUp } from "./find-up.js";

export const CONFIG_FILE_NAMES = ["infra.ts", "infra.js", "infra.mjs"];

export interface LoadedConfig {
	configPath: string;
	rootDir: string;
	infra: Infra;
}

export interface LoadConfigOptions {
	cwd?: string;
	configPath?: string;
}

/** Locate + load an `infra.ts` (jiti) and validate its default export is a `defineInfra` result. */
export async function loadConfig(
	options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
	const cwd = resolve(options.cwd ?? process.cwd());
	const configPath = options.configPath
		? resolve(cwd, options.configPath)
		: findUp(cwd, CONFIG_FILE_NAMES);
	if (!configPath) {
		throw new InfraError(
			ErrorCode.InvalidConfig,
			`No ${CONFIG_FILE_NAMES[0]} found from ${cwd} upward. Run \`infra init\` to scaffold one.`,
		);
	}

	const jiti = createJiti(import.meta.url, { interopDefault: true });
	let mod: unknown;
	try {
		mod = await jiti.import(configPath, { default: true });
	} catch (cause) {
		throw new InfraError(
			ErrorCode.InvalidConfig,
			`Failed to load ${configPath}: ${(cause as Error)?.message ?? String(cause)}`,
			{ cause, details: { configPath } },
		);
	}

	const infra = coerce(mod, configPath);
	return { configPath, rootDir: dirname(configPath), infra };
}

function coerce(value: unknown, configPath: string): Infra {
	const candidate =
		value && typeof value === "object" && "default" in value
			? (value as { default: unknown }).default
			: value;
	if (
		candidate &&
		typeof candidate === "object" &&
		Array.isArray((candidate as { ordered?: unknown }).ordered) &&
		Array.isArray((candidate as { entities?: unknown }).entities)
	) {
		return candidate as Infra;
	}
	throw new InfraError(
		ErrorCode.InvalidConfig,
		`${configPath} must \`export default defineInfra({ entities: [ … ] })\`.`,
		{ details: { configPath } },
	);
}
