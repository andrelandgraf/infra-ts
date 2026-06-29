import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ErrorCode, InfraError } from "@infra-ts/core";

/** Default Vercel REST API base URL. */
export const DEFAULT_VERCEL_API_HOST = "https://api.vercel.com";

export interface ResolvedVercelCredentials {
	token: string;
	apiHost: string;
	source: string;
}

export interface VercelCredentialOptions {
	token?: string;
	apiHost?: string;
}

/**
 * Resolve a Vercel API token, in order:
 *
 * 1. an explicit `token` option,
 * 2. `VERCEL_TOKEN` in the environment,
 * 3. the token cached by the Vercel CLI in its `auth.json` (the OS-specific data dir).
 *
 * Throws {@link InfraError} (`MissingCredentials`) when nothing is found.
 */
export function resolveVercelCredentials(
	options: VercelCredentialOptions = {},
	env: NodeJS.ProcessEnv = process.env,
): ResolvedVercelCredentials {
	const apiHost =
		options.apiHost ?? env.VERCEL_API_HOST ?? DEFAULT_VERCEL_API_HOST;

	if (options.token && options.token.length > 0) {
		return { token: options.token, apiHost, source: "option" };
	}
	if (env.VERCEL_TOKEN && env.VERCEL_TOKEN.length > 0) {
		return { token: env.VERCEL_TOKEN, apiHost, source: "VERCEL_TOKEN" };
	}

	const fromCli = readVercelCliToken(env);
	if (fromCli) {
		return { token: fromCli.token, apiHost, source: fromCli.path };
	}

	throw new InfraError(
		ErrorCode.MissingCredentials,
		[
			"No Vercel credentials found.",
			"Set VERCEL_TOKEN, pass `vercel({ token })`, or run `vercel login` to authenticate the Vercel CLI.",
		].join(" "),
	);
}

/** Candidate `auth.json` locations across platforms (Vercel CLI uses an XDG-style data dir). */
function vercelAuthPaths(env: NodeJS.ProcessEnv): string[] {
	const home = homedir();
	const dirName = "com.vercel.cli";
	const candidates: string[] = [];
	if (env.XDG_DATA_HOME) {
		candidates.push(join(env.XDG_DATA_HOME, dirName, "auth.json"));
	}
	// macOS
	candidates.push(
		join(home, "Library", "Application Support", dirName, "auth.json"),
	);
	// Linux / XDG default
	candidates.push(join(home, ".local", "share", dirName, "auth.json"));
	return candidates;
}

/**
 * Resolve a Vercel token for an entity: `VERCEL_TOKEN` from the bag → the Vercel CLI cache.
 * Returns `undefined` (never throws) so schema validation reports a missing credential clearly.
 */
export function vercelTokenFromBag(
	bag: Record<string, string | undefined>,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (bag.VERCEL_TOKEN && bag.VERCEL_TOKEN.length > 0) return bag.VERCEL_TOKEN;
	return readVercelCliToken(env)?.token;
}

function readVercelCliToken(
	env: NodeJS.ProcessEnv,
): { token: string; path: string } | undefined {
	for (const path of vercelAuthPaths(env)) {
		try {
			const raw = readFileSync(path, "utf8");
			const json: unknown = JSON.parse(raw);
			if (json && typeof json === "object") {
				const token = (json as Record<string, unknown>).token;
				if (typeof token === "string" && token.length > 0) {
					return { token, path };
				}
			}
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}
