import type { Infra, InfraEnv } from "./config.js";
import { osKeyFor } from "./env-keys.js";
import { ErrorCode, InfraError } from "./errors.js";
import { validate } from "./standard-schema.js";

/**
 * Synchronous, network-free, environment-agnostic runtime env reader. Reads `process.env`
 * (already populated from `.env.<env>` by your framework), reconstructs each entity's logical env
 * via its OS-key mapping, validates it against the entity's `envSchema`, and returns the typed env
 * keyed by entity id. Never reads `NODE_ENV`. Throws {@link InfraError} (`EnvNotInjected`) listing
 * every missing/invalid var.
 */
export function parseEnv(
	infra: Infra,
	env: NodeJS.ProcessEnv = process.env,
): InfraEnv {
	const result: InfraEnv = {};
	const missing: string[] = [];

	for (const entity of infra.entities) {
		const logical: Record<string, string> = {};
		let anyMissing = false;
		for (const field of entity.envKeys) {
			const osKey = osKeyFor(field, entity.envKeyOverride);
			const value = env[osKey];
			if (value === undefined || value === "") {
				missing.push(`${osKey} (${entity.name}.${field})`);
				anyMissing = true;
			} else {
				logical[field] = value;
			}
		}
		// Validate against the entity's schema only when fully present (so the aggregated
		// "missing" list stays the primary, actionable error).
		if (!anyMissing && entity.envKeys.length > 0) {
			result[entity.name] = validate(
				entity.envSchema,
				logical,
				`parseEnv(${entity.name})`,
			) as Record<string, string>;
		} else if (entity.envKeys.length > 0) {
			result[entity.name] = logical;
		}
	}

	if (missing.length > 0) {
		throw new InfraError(
			ErrorCode.EnvNotInjected,
			[
				"parseEnv: required env vars are not present in process.env:",
				...missing.map((m) => `  - ${m}`),
				"Inject them with `infra checkout`, `infra run -- <cmd>`, or your platform integration.",
			].join("\n"),
			{ details: { missing } },
		);
	}
	return result;
}
