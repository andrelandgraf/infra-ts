import { type AnyEntity, Entity } from "./entity.js";
import { ErrorCode, InfraError } from "./errors.js";

/** Find Entity instances nested anywhere within an arbitrary value (options object). */
function findNested(value: unknown, into: AnyEntity[]): void {
	if (value instanceof Entity) {
		into.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const v of value) findNested(v, into);
		return;
	}
	if (value && typeof value === "object") {
		for (const v of Object.values(value)) findNested(v, into);
	}
}

/** Direct children of an entity: entity instances nested anywhere in its options. */
function childrenOf(entity: AnyEntity): AnyEntity[] {
	const nested: AnyEntity[] = [];
	// `options` is protected; reach it via a structural cast (engine-internal).
	const options = (entity as unknown as { options: unknown }).options;
	findNested(options, nested);
	return nested;
}

/**
 * Collect the full entity set reachable from `roots` (walking entity instances nested in options),
 * deduplicated by instance. Duplicate *ids* are caught later in validation.
 */
export function collectEntities(roots: readonly AnyEntity[]): AnyEntity[] {
	const seen = new Set<AnyEntity>();
	const out: AnyEntity[] = [];
	const stack = [...roots];
	while (stack.length > 0) {
		const entity = stack.pop() as AnyEntity;
		if (seen.has(entity)) continue;
		seen.add(entity);
		out.push(entity);
		for (const child of childrenOf(entity)) stack.push(child);
	}
	return out;
}

/** Assert every entity has a unique `name`; throw {@link InfraError} (`DuplicateId`) otherwise. */
export function assertUniqueIds(entities: readonly AnyEntity[]): void {
	const seen = new Map<string, AnyEntity>();
	for (const entity of entities) {
		if (!entity.name || typeof entity.name !== "string") {
			throw new InfraError(
				ErrorCode.InvalidEntity,
				"Every entity needs a non-empty string `name`.",
			);
		}
		if (seen.has(entity.name)) {
			throw new InfraError(
				ErrorCode.DuplicateId,
				`Duplicate entity id "${entity.name}" — two entities resolved to the same name. Ids must be unique (they key .infra state, env wiring, and the graph).`,
				{ details: { id: entity.name } },
			);
		}
		seen.set(entity.name, entity);
	}
}

/**
 * Topologically sort entities so every entity comes after the ones it depends on (inferred from
 * refs). Throws {@link InfraError} (`Cycle`) on a dependency cycle, naming the cycle.
 */
export function topoSort(entities: readonly AnyEntity[]): AnyEntity[] {
	const byName = new Map(entities.map((e) => [e.name, e] as const));
	const visited = new Set<string>();
	const inStack = new Set<string>();
	const order: AnyEntity[] = [];

	const visit = (entity: AnyEntity, path: string[]): void => {
		if (visited.has(entity.name)) return;
		if (inStack.has(entity.name)) {
			const cycle = [...path.slice(path.indexOf(entity.name)), entity.name];
			throw new InfraError(
				ErrorCode.Cycle,
				`Dependency cycle detected: ${cycle.join(" → ")}. Entities can't depend on each other.`,
				{ details: { cycle } },
			);
		}
		inStack.add(entity.name);
		for (const depId of entity.dependencyIds()) {
			const dep = byName.get(depId);
			if (dep) visit(dep, [...path, entity.name]);
		}
		inStack.delete(entity.name);
		visited.add(entity.name);
		order.push(entity);
	};

	for (const entity of entities) visit(entity, []);
	return order;
}
