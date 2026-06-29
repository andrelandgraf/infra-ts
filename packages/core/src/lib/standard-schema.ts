import { ErrorCode, InfraError } from "./errors.js";

/**
 * The [Standard Schema](https://github.com/standard-schema/standard-schema) v1 interface — the
 * shared contract implemented by zod, valibot, arktype, and friends. Entities declare their
 * `credentialsSchema` / `envSchema` / `stateSchema` with any Standard-Schema validator, and the
 * engine validates + infers types through this one interface (no validator lock-in).
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
	readonly "~standard": {
		readonly version: 1;
		readonly vendor: string;
		readonly validate: (
			value: unknown,
		) => StandardResult<Output> | Promise<StandardResult<Output>>;
		readonly types?: { readonly input: Input; readonly output: Output };
	};
}

type StandardResult<Output> =
	| { readonly value: Output; readonly issues?: undefined }
	| {
			readonly issues: ReadonlyArray<{
				readonly message: string;
				readonly path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
			}>;
	  };

/** Infer a Standard Schema's output type. */
export type InferOutput<S extends StandardSchemaV1> =
	S extends StandardSchemaV1<unknown, infer O> ? O : never;

/**
 * Validate `value` against a Standard Schema synchronously, returning the typed output or
 * throwing {@link InfraError}. Most validators (zod/valibot/arktype) validate synchronously; an
 * async validator here is a programming error and is reported as such.
 */
export function validate<S extends StandardSchemaV1>(
	schema: S,
	value: unknown,
	context: string,
): InferOutput<S> {
	const result = schema["~standard"].validate(value);
	if (result instanceof Promise) {
		throw new InfraError(
			ErrorCode.InvalidConfig,
			`${context}: schema validation returned a Promise; infra-ts requires synchronous schemas.`,
		);
	}
	if (result.issues) {
		const messages = result.issues.map((issue) => {
			const path = issue.path
				?.map((p) => (typeof p === "object" ? String(p.key) : String(p)))
				.join(".");
			return path ? `${path}: ${issue.message}` : issue.message;
		});
		throw new InfraError(
			ErrorCode.InvalidConfig,
			`${context}: ${messages.join("; ")}`,
			{ details: { issues: messages } },
		);
	}
	return result.value as InferOutput<S>;
}

/** The keys of a Standard Schema's output (used to enumerate env / credential fields). */
export type OutputKeys<S extends StandardSchemaV1> = Extract<
	keyof InferOutput<S>,
	string
>;
