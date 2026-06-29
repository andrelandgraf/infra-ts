/**
 * A typed, deferred reference to another entity's output (its `id` or an `env` field), resolved
 * by the engine at provision time. Referencing one is how you both **wire a value** and
 * **declare a dependency** — the engine derives the graph edge from the ref and substitutes the
 * concrete value before the consumer's lifecycle methods run.
 */
export interface Ref<T = string> {
	readonly __infraRef: true;
	/** The id of the entity this references. */
	readonly entity: string;
	/** What is referenced: the entity `id`, or a named `env` field. */
	readonly kind: "id" | "env";
	/** For `kind: "env"`, the logical env field name (e.g. `databaseUrl`). */
	readonly field?: string;
	/** Phantom carrier of the referenced value type. Always `undefined` at runtime. */
	readonly __valueType?: T;
}

/** Typed env output refs for an entity: one `Ref` per logical env field. */
export type EnvRefs<Env> = { readonly [K in keyof Env]: Ref<Env[K]> };

/** Recursively unwrap `Ref<X>` to `X` — the type of an entity's *resolved* options. */
export type Resolved<T> =
	T extends Ref<infer U>
		? U
		: T extends (infer E)[]
			? Resolved<E>[]
			: T extends object
				? { [K in keyof T]: Resolved<T[K]> }
				: T;

/** Construct the id ref for an entity. */
export function idRef(entity: string): Ref<string> {
	return { __infraRef: true, entity, kind: "id" };
}

/** Construct the env refs for an entity from its env field names. */
export function envRefs<Env>(
	entity: string,
	fields: readonly (keyof Env & string)[],
): EnvRefs<Env> {
	const refs: Record<string, Ref> = {};
	for (const field of fields) {
		refs[field] = { __infraRef: true, entity, kind: "env", field };
	}
	return refs as EnvRefs<Env>;
}

/** Type guard: is `value` a {@link Ref}? */
export function isRef(value: unknown): value is Ref {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { __infraRef?: unknown }).__infraRef === true
	);
}

/** Resolved outputs available to the engine: `{ [entityId]: { id, env: { … } } }`. */
export interface ResolvedOutput {
	id: string;
	env: Record<string, string>;
}
export type ResolvedOutputs = Record<string, ResolvedOutput>;

/** Resolve a single {@link Ref} against already-provisioned outputs. */
export function resolveRef(ref: Ref, outputs: ResolvedOutputs): unknown {
	const out = outputs[ref.entity];
	if (!out) return undefined;
	if (ref.kind === "id") return out.id;
	return ref.field ? out.env[ref.field] : undefined;
}

/**
 * Deep-walk an arbitrary value and replace every {@link Ref} with its resolved concrete value
 * from `outputs`. Used by the engine to turn an entity's ref-bearing options into the fully
 * resolved options its lifecycle methods see.
 */
export function deepResolve<T>(
	value: T,
	outputs: ResolvedOutputs,
): Resolved<T> {
	if (isRef(value)) return resolveRef(value, outputs) as Resolved<T>;
	if (Array.isArray(value)) {
		return value.map((v) => deepResolve(v, outputs)) as Resolved<T>;
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = deepResolve(v, outputs);
		}
		return out as Resolved<T>;
	}
	return value as Resolved<T>;
}

/** Collect the entity ids referenced anywhere within a value (for dependency-edge inference). */
export function collectRefEntities(value: unknown, into: Set<string>): void {
	if (isRef(value)) {
		into.add(value.entity);
		return;
	}
	if (Array.isArray(value)) {
		for (const v of value) collectRefEntities(v, into);
		return;
	}
	if (value && typeof value === "object") {
		for (const v of Object.values(value)) collectRefEntities(v, into);
	}
}
