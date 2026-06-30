import {
	type Change,
	Entity,
	type EntityCommon,
	type ProvisionContext,
	type ProvisionResult,
	type ReadContext,
} from "./entity.js";
import { ErrorCode, InfraError } from "./errors.js";
import type { StandardSchemaV1 } from "./standard-schema.js";

/** A selectable provider scope (a Neon org, a Vercel team, …) shown by `infra link`. */
export interface AccountScope {
	id: string;
	name: string;
}

/** The persisted scope binding for an account in `.infra.<env>`. */
export type AccountState = { scopeId: string };

export interface AccountOptions extends EntityCommon<
	Record<string, never>,
	AccountState
> {
	/** Explicit scope id (org/team) — overrides the value bound by `infra link`. */
	scope?: string;
}

/** How `infra login` authenticates this account's provider (CLI OAuth passthrough). */
export interface CliAuth {
	/** Stable provider id, used to dedup `login` across accounts (e.g. "neon"). */
	providerId: string;
	/** The env var that also satisfies the credential (e.g. "NEON_API_KEY"). */
	envVar: string;
	/** Command that exits 0 when already authenticated (e.g. `["neonctl", "me"]`). */
	detect: string[];
	/** Command that runs the interactive OAuth login (e.g. `["neonctl", "auth"]`). */
	login: string[];
}

// Hand-rolled Standard Schemas (core stays validator-agnostic — no zod dependency).
const emptyEnvSchema: StandardSchemaV1<unknown, Record<string, never>> = {
	"~standard": {
		version: 1,
		vendor: "infra-ts",
		validate: () => ({ value: {} }),
	},
};
const scopeStateSchema: StandardSchemaV1<unknown, AccountState> = {
	"~standard": {
		version: 1,
		vendor: "infra-ts",
		validate: (value) => {
			if (
				value &&
				typeof value === "object" &&
				typeof (value as Record<string, unknown>).scopeId === "string"
			) {
				return {
					value: {
						scopeId: (value as Record<string, unknown>).scopeId as string,
					},
				};
			}
			return { issues: [{ message: "expected { scopeId: string }" }] };
		},
	},
};

/**
 * A provider **scope + auth anchor** (a Neon org, a Vercel team). Unlike normal entities, an
 * account creates no remote resource: its scope is bound by `infra link` (written to `.infra.<env>`)
 * and authenticated by `infra login`. Entities reference `account.id` (the scope id) where they'd
 * otherwise hardcode an org/team. See SPEC §8.3.
 */
export abstract class Account<Creds = unknown> extends Entity<
	AccountOptions,
	Creds,
	Record<string, never>,
	AccountState,
	AccountScope | null
> {
	readonly envSchema = emptyEnvSchema;
	readonly stateSchema = scopeStateSchema;
	readonly envKeys = [] as const;

	/** List the scopes (orgs/teams) the authenticated user can pick from, for `infra link`. */
	abstract listScopes(credentials: Creds): Promise<AccountScope[]>;
	/** How `infra login` authenticates this provider. */
	abstract cliAuth(): CliAuth;

	/** The bound scope id: explicit option → linked state. */
	protected boundScope(state: AccountState | null): string | undefined {
		return this.options.scope ?? state?.scopeId ?? undefined;
	}

	async read(
		ctx: ReadContext<Creds, AccountState>,
	): Promise<AccountScope | null> {
		const id = this.boundScope(ctx.state);
		return id ? { id, name: this.name } : null;
	}
	diff(remote: AccountScope | null): Change[] {
		return remote
			? []
			: [
					{
						action: "create",
						kind: "account",
						identifier: this.name,
						detail: `not linked — run \`infra link ${this.name}\``,
					},
				];
	}
	async provision(
		ctx: ProvisionContext<Creds, AccountState>,
	): Promise<ProvisionResult<Record<string, never>, AccountState>> {
		const id = this.boundScope(ctx.state);
		if (!id) {
			throw new InfraError(
				ErrorCode.MissingCredentials,
				`account "${this.name}" is not linked to an org/team — run \`infra link ${this.name}\` first (or pass \`scope\`).`,
			);
		}
		return { action: "noop", id, state: { scopeId: id }, env: {} };
	}
	async pullEnv(): Promise<Record<string, never>> {
		return {};
	}
	async deprovision(): Promise<void> {
		// An account never creates or deletes the remote org/team.
	}
}
