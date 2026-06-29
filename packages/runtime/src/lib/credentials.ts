import { type AnyEntity, type Infra, validate } from "@infra-ts/core";

/**
 * Resolve + validate an entity's credentials for an environment:
 * `loadEnv(env)` (default `process.env`) → merge `defineInfra.credentials` over it →
 * `entity.resolveCredentials` (adds provider-specific CLI fallback) → validate against the
 * entity's `credentialsSchema`. Returns the typed credentials.
 */
export function resolveEntityCredentials(
	infra: Infra,
	entity: AnyEntity,
	environment: string,
): unknown {
	const bag: Record<string, string | undefined> = infra.loadEnv
		? infra.loadEnv(environment)
		: { ...process.env };
	const infraCreds =
		typeof infra.credentials === "function"
			? infra.credentials(environment)
			: (infra.credentials ?? {});
	const merged = { ...bag, ...infraCreds };
	const resolved = entity.resolveCredentials(merged);
	return validate(
		entity.credentialsSchema,
		resolved,
		`${entity.name} credentials`,
	);
}
