import { spawnSync } from "node:child_process";
import {
	Account,
	type AnyEntity,
	ErrorCode,
	type Infra,
	InfraError,
	type Logger,
	silentLogger,
} from "@infra-ts/core";
import { resolveEntityCredentials } from "./credentials.js";
import { applyRenames, readState, writeState } from "./state-file.js";
import { resolveEnvironment } from "./engine.js";

/** Every Account node in the config (deduplicated, in declaration order). */
export function collectAccounts(infra: Infra): Account[] {
	const out: Account[] = [];
	for (const entity of infra.ordered) {
		if (entity instanceof Account) out.push(entity);
	}
	return out;
}

export interface LoginOptions {
	/** Limit to these provider ids (from `cliAuth().providerId`). */
	only?: string[];
	logger?: Logger;
}
export interface LoginResult {
	provider: string;
	accounts: string[];
	status: "already" | "logged-in" | "failed" | "unavailable";
}

/**
 * `infra login` — for each account's provider (deduped), run its detect command; if not
 * authenticated, run its interactive OAuth login (inherited stdio → real browser flow). The CLI
 * cache is the credential store, so nothing is written to `.infra`.
 */
export async function login(
	infra: Infra,
	options: LoginOptions = {},
): Promise<LoginResult[]> {
	const logger = options.logger ?? silentLogger;
	const byProvider = new Map<
		string,
		{ auth: ReturnType<Account["cliAuth"]>; accounts: string[] }
	>();
	for (const account of collectAccounts(infra)) {
		const auth = account.cliAuth();
		const entry = byProvider.get(auth.providerId) ?? { auth, accounts: [] };
		entry.accounts.push(account.name);
		byProvider.set(auth.providerId, entry);
	}

	const results: LoginResult[] = [];
	for (const [providerId, { auth, accounts }] of byProvider) {
		if (options.only && !options.only.includes(providerId)) continue;
		const [detectCmd, ...detectArgs] = auth.detect;
		if (!detectCmd) continue;
		const detect = spawnSync(detectCmd, detectArgs, { stdio: "ignore" });
		if (
			detect.error &&
			(detect.error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			logger.warn(
				`login: '${detectCmd}' not found — install the ${providerId} CLI or set ${auth.envVar}.`,
			);
			results.push({ provider: providerId, accounts, status: "unavailable" });
			continue;
		}
		if (detect.status === 0) {
			results.push({ provider: providerId, accounts, status: "already" });
			continue;
		}
		const [loginCmd, ...loginArgs] = auth.login;
		if (!loginCmd) continue;
		logger.info(
			`login: authenticating ${providerId} (\`${auth.login.join(" ")}\`)…`,
		);
		const run = spawnSync(loginCmd, loginArgs, { stdio: "inherit" });
		results.push({
			provider: providerId,
			accounts,
			status: run.status === 0 ? "logged-in" : "failed",
		});
	}
	return results;
}

export interface LinkOptions {
	rootDir?: string;
	environment?: string;
	/** Map of account name → chosen scope id (org/team). */
	scopes: Record<string, string>;
}
export interface LinkResult {
	account: string;
	scopeId: string;
}

/**
 * `infra link` (write side) — persist each account's chosen scope id into `.infra.<env>`. The CLI
 * resolves credentials, lists scopes via `account.listScopes`, and prompts the user, then calls this
 * with the chosen ids. Kept network-free + non-interactive so it's unit-testable.
 */
export async function link(
	infra: Infra,
	options: LinkOptions,
): Promise<LinkResult[]> {
	const environment = resolveEnvironment(infra, options);
	const rootDir = options.rootDir ?? process.cwd();
	const accounts = new Map(collectAccounts(infra).map((a) => [a.name, a]));
	let state = applyRenames(readState(rootDir, environment), infra.renames);
	const results: LinkResult[] = [];

	for (const [name, scopeId] of Object.entries(options.scopes)) {
		if (!accounts.has(name)) {
			throw new InfraError(
				ErrorCode.InvalidEntity,
				`link: "${name}" is not an Account in this config.`,
				{ details: { name } },
			);
		}
		state = {
			...state,
			entities: { ...state.entities, [name]: { scopeId } },
		};
		results.push({ account: name, scopeId });
	}
	writeState(rootDir, environment, state);
	return results;
}

/** Resolve an account's credentials (for the CLI to call `listScopes`). */
export function accountCredentials(
	infra: Infra,
	account: AnyEntity,
	environment: string,
): unknown {
	return resolveEntityCredentials(infra, account, environment);
}
