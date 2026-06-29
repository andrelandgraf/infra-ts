/**
 * Convert a logical camelCase env field to its default OS-level CONSTANT_CASE key.
 * `databaseUrl → DATABASE_URL`, `databaseUrlUnpooled → DATABASE_URL_UNPOOLED`,
 * `redisRestUrl → REDIS_REST_URL`. Avoid acronym *runs* in logical keys (`databaseURL` is
 * messy) — use the per-entity rename override for anything unusual.
 */
export function constantCase(input: string): string {
	return input
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.toUpperCase();
}

/** Per-entity OS-key rename override: a map (logical → OS) and/or a callback. **Keys only.** */
export interface EnvKeyOverride {
	envNames?: Record<string, string>;
	envName?: (key: string) => string;
}

/**
 * Resolve the OS-level env var name for a logical field: explicit `envNames` map →
 * `envName` callback → default {@link constantCase}. Values always pass through unchanged
 * (a bijective key rename), so `parseEnv` can read the env back into the logical shape.
 */
export function osKeyFor(field: string, override: EnvKeyOverride = {}): string {
	if (override.envNames && field in override.envNames) {
		return override.envNames[field] as string;
	}
	if (override.envName) return override.envName(field);
	return constantCase(field);
}
