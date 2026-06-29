import type { AnyEntity } from "./entity.js";
import { osKeyFor } from "./env-keys.js";
import { ErrorCode, InfraError } from "./errors.js";
import { assertUniqueIds, collectEntities, topoSort } from "./graph.js";

/** A rename: re-key an entity's `.infra` state from `old` → `new` (in-place migration). */
export interface Rename {
	old: string;
	new: string;
}

export interface InfraConfigInput {
	/** Entities to manage. Nested entities are registered transitively. */
	entities: AnyEntity[];
	/** Default environment when none is passed. Selection: `--env` > `INFRA_ENV` > this > "local". */
	defaultEnvironment?: string;
	/** Source the input bag for a run (credentials + values). Defaults to `process.env`. */
	loadEnv?: (environment: string) => Record<string, string | undefined>;
	/** Credentials inherited by every entity (each validates the slice it needs). */
	credentials?:
		| Record<string, string | undefined>
		| ((environment: string) => Record<string, string | undefined>);
	/** In-place identity migrations. */
	renames?: Rename[];
}

/** A validated infra config — the value `defineInfra({ … })` returns and `infra.ts` exports. */
export interface Infra {
	/** The original top-level entities. */
	readonly roots: AnyEntity[];
	/** Every entity (roots + nested), deduped. */
	readonly entities: AnyEntity[];
	/** Entities in dependency (topological) order. */
	readonly ordered: AnyEntity[];
	readonly defaultEnvironment: string;
	readonly loadEnv:
		| ((environment: string) => Record<string, string | undefined>)
		| undefined;
	readonly credentials:
		| Record<string, string | undefined>
		| ((environment: string) => Record<string, string | undefined>)
		| undefined;
	readonly renames: Rename[];
}

/** The typed env shape, keyed by entity id. (Name-literal typing is intentionally relaxed; the
 * fully-typed surface is the per-entity `entity.env.<field>` refs and each entity's `envSchema`.) */
export type InfraEnv = Record<string, Record<string, string>>;

/**
 * Define an infra-ts config in `infra.ts`. Pure: collects the entity graph (incl. nested),
 * validates unique ids, no cycles, and no OS env-key collisions, then freezes the result.
 */
export function defineInfra(input: InfraConfigInput): Infra {
	if (!input || typeof input !== "object" || !Array.isArray(input.entities)) {
		throw new InfraError(
			ErrorCode.InvalidConfig,
			"defineInfra expects `{ entities: [ … ] }`.",
		);
	}
	if (input.entities.length === 0) {
		throw new InfraError(
			ErrorCode.InvalidConfig,
			"defineInfra: `entities` must be a non-empty array.",
		);
	}

	const entities = collectEntities(input.entities);
	assertUniqueIds(entities);
	const ordered = topoSort(entities);
	assertNoEnvCollisions(entities);

	return Object.freeze({
		roots: input.entities,
		entities,
		ordered,
		defaultEnvironment: input.defaultEnvironment ?? "local",
		loadEnv: input.loadEnv,
		credentials: input.credentials,
		renames: input.renames ?? [],
	});
}

/** Crash loud if two entities map a logical env field to the same OS-level key. */
function assertNoEnvCollisions(entities: readonly AnyEntity[]): void {
	const owner = new Map<string, string>();
	for (const entity of entities) {
		for (const field of entity.envKeys) {
			const osKey = osKeyFor(field, entity.envKeyOverride);
			const existing = owner.get(osKey);
			if (existing && existing !== entity.name) {
				throw new InfraError(
					ErrorCode.EnvCollision,
					`Env var collision: "${osKey}" is produced by both "${existing}" and "${entity.name}". Rename one via \`envNames\` / \`envName\` on the entity.`,
					{ details: { osKey, entities: [existing, entity.name] } },
				);
			}
			owner.set(osKey, entity.name);
		}
	}
}
