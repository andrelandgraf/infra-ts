import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ErrorCode, InfraError } from "@infra-ts/core";

/** Default Neon management API base URL. */
export const DEFAULT_NEON_API_HOST = "https://console.neon.tech/api/v2";

export interface ResolvedNeonCredentials {
	token: string;
	apiHost: string;
	/** Where the token came from, for diagnostics. */
	source: string;
}

export interface NeonCredentialOptions {
	apiKey?: string;
	apiHost?: string;
}

/**
 * Resolve a Neon API credential the same way `neonctl` and `@neondatabase/config` do, in order:
 *
 * 1. an explicit `apiKey` option,
 * 2. `NEON_API_KEY` in the environment,
 * 3. the OAuth `access_token` cached by `neonctl` at `~/.config/neonctl/credentials.json`.
 *
 * The host is the `apiHost` option, then `NEON_API_HOST`, then production. Throws
 * {@link InfraError} (`MissingCredentials`) when nothing is found, with a fix hint.
 */
export function resolveNeonCredentials(
	options: NeonCredentialOptions = {},
	env: NodeJS.ProcessEnv = process.env,
): ResolvedNeonCredentials {
	const apiHost = options.apiHost ?? env.NEON_API_HOST ?? DEFAULT_NEON_API_HOST;

	if (options.apiKey && options.apiKey.length > 0) {
		return { token: options.apiKey, apiHost, source: "option" };
	}
	if (env.NEON_API_KEY && env.NEON_API_KEY.length > 0) {
		return { token: env.NEON_API_KEY, apiHost, source: "NEON_API_KEY" };
	}

	const fromCli = readNeonctlToken();
	if (fromCli) {
		return {
			token: fromCli,
			apiHost,
			source: "~/.config/neonctl/credentials.json",
		};
	}

	throw new InfraError(
		ErrorCode.MissingCredentials,
		[
			"No Neon credentials found.",
			"Set NEON_API_KEY, pass `neon({ apiKey })`, or run `neonctl auth` to authenticate the Neon CLI.",
		].join(" "),
	);
}

/**
 * Resolve a Neon API token for an entity: `NEON_API_KEY` from the bag → the `neonctl` OAuth
 * cache. Returns `undefined` (never throws) so `resolveCredentials` can decide; the engine's
 * schema validation reports a missing credential clearly.
 */
export function neonTokenFromBag(
	bag: Record<string, string | undefined>,
): string | undefined {
	if (bag.NEON_API_KEY && bag.NEON_API_KEY.length > 0) return bag.NEON_API_KEY;
	return readNeonctlToken();
}

/** Read the OAuth access token cached by neonctl, if present and readable. */
function readNeonctlToken(): string | undefined {
	const path = join(homedir(), ".config", "neonctl", "credentials.json");
	try {
		const raw = readFileSync(path, "utf8");
		const json: unknown = JSON.parse(raw);
		if (json && typeof json === "object") {
			const token = (json as Record<string, unknown>).access_token;
			if (typeof token === "string" && token.length > 0) return token;
		}
	} catch {
		// Not authenticated via neonctl, or unreadable — fall through.
	}
	return undefined;
}
