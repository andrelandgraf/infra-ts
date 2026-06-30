import { spawnSync } from "node:child_process";
import {
	Account,
	isAccount,
	type AnyEntity,
	type CliTool,
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
		if (isAccount(entity)) out.push(entity);
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

export interface ToolStatus {
	id: string;
	status: "available" | "npx" | "installed" | "declined" | "missing";
}
export interface EnsureToolsOptions {
	/** Skip the confirmation prompt and install directly (CI). */
	yes?: boolean;
	/** Prompt the user before a global install. Return true to proceed. */
	confirm?: (tool: CliTool) => Promise<boolean>;
	logger?: Logger;
}

function detectTool(tool: CliTool): boolean {
	const [cmd, ...args] = tool.detect;
	if (!cmd) return false;
	const res = spawnSync(cmd, args, { stdio: "ignore" });
	return !res.error && res.status === 0;
}

/**
 * Ensure the vendor CLIs declared by the config's entities (`requiredTools()`) are usable. A tool
 * already on PATH is fine; one with an `npx` spec runs ephemerally (no install); otherwise we offer
 * a confirmed global install. Run during `login`/`link` and before a CLI-backed `apply`.
 */
export async function ensureTools(
	infra: Infra,
	options: EnsureToolsOptions = {},
): Promise<ToolStatus[]> {
	const logger = options.logger ?? silentLogger;
	const tools = new Map<string, CliTool>();
	for (const entity of infra.ordered) {
		for (const tool of entity.requiredTools()) tools.set(tool.id, tool);
	}
	const results: ToolStatus[] = [];
	for (const tool of tools.values()) {
		if (detectTool(tool)) {
			results.push({ id: tool.id, status: "available" });
			continue;
		}
		if (tool.npx) {
			// Will run ephemerally via npx/bunx — nothing to install.
			results.push({ id: tool.id, status: "npx" });
			continue;
		}
		if (tool.install) {
			const ok =
				options.yes || (options.confirm ? await options.confirm(tool) : false);
			if (!ok) {
				logger.warn(
					`${tool.id} CLI not found. Install it with: ${tool.install.join(" ")}`,
				);
				results.push({ id: tool.id, status: "declined" });
				continue;
			}
			const [cmd, ...args] = tool.install;
			const run = cmd ? spawnSync(cmd, args, { stdio: "inherit" }) : null;
			results.push({
				id: tool.id,
				status: run && run.status === 0 ? "installed" : "missing",
			});
			continue;
		}
		logger.warn(`${tool.id} CLI not found and no install method is declared.`);
		results.push({ id: tool.id, status: "missing" });
	}
	return results;
}
