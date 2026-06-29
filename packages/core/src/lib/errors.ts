/**
 * Stable, machine-readable error codes surfaced by infra-ts. Providers and the engine throw
 * {@link InfraError} with one of these so callers (and agents) can branch on `error.code`
 * instead of matching message strings.
 */
export const ErrorCode = {
	/** An `infra.ts` (or programmatic) config was structurally invalid. */
	InvalidConfig: "INFRA_INVALID_CONFIG",
	/** A provider was misconfigured (bad options, duplicate name, …). */
	InvalidProvider: "INFRA_INVALID_PROVIDER",
	/** An entity was misconfigured (bad options, missing name, …). */
	InvalidEntity: "INFRA_INVALID_ENTITY",
	/** Two entities resolved to the same id. */
	DuplicateId: "INFRA_DUPLICATE_ID",
	/** The entity graph contains a dependency cycle. */
	Cycle: "INFRA_CYCLE",
	/** Two entities map to the same OS-level env var key. */
	EnvCollision: "INFRA_ENV_COLLISION",
	/** Live remote drifted from the declared config (checkout guard). */
	Drift: "INFRA_DRIFT",
	/** The `.infra` link/binding file was missing or malformed. */
	InvalidState: "INFRA_INVALID_STATE",
	/** No credentials could be resolved for a provider. */
	MissingCredentials: "INFRA_MISSING_CREDENTIALS",
	/** A remote REST call failed (non-2xx). Carries `status` + `body` in `details`. */
	RequestFailed: "INFRA_REQUEST_FAILED",
	/** A required remote resource was not found. */
	NotFound: "INFRA_NOT_FOUND",
	/** A typed env var was missing or empty when reading `process.env`. */
	EnvNotInjected: "INFRA_ENV_NOT_INJECTED",
	/** A lifecycle hook (shell command) exited non-zero. */
	HookFailed: "INFRA_HOOK_FAILED",
	/** An operation was aborted (e.g. the user declined a confirmation). */
	Aborted: "INFRA_ABORTED",
	/** Catch-all for unexpected platform failures. */
	Platform: "INFRA_PLATFORM_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface InfraErrorOptions {
	/** Structured, JSON-serializable context for logs / agents. */
	details?: Record<string, unknown>;
	/** The underlying error, preserved for stack traces. */
	cause?: unknown;
}

/**
 * The single error type infra-ts throws. It pairs a stable {@link ErrorCode} with a
 * human-readable message and optional structured `details`, so both humans and agents get a
 * clear, actionable failure (and can branch on `error.code`).
 */
export class InfraError extends Error {
	readonly code: ErrorCode;
	readonly details: Record<string, unknown> | undefined;

	constructor(
		code: ErrorCode,
		message: string,
		options: InfraErrorOptions = {},
	) {
		super(
			message,
			options.cause !== undefined ? { cause: options.cause } : undefined,
		);
		this.name = "InfraError";
		this.code = code;
		this.details = options.details;
	}
}

/** Type guard for {@link InfraError}, robust across realms/bundles (checks the brand). */
export function isInfraError(value: unknown): value is InfraError {
	return (
		value instanceof InfraError ||
		(typeof value === "object" &&
			value !== null &&
			(value as { name?: unknown }).name === "InfraError" &&
			typeof (value as { code?: unknown }).code === "string")
	);
}
