import type { Exec } from "./entity.js";
import { ErrorCode, InfraError } from "./errors.js";

/** Minimal `fetch` shape the REST client uses (the global `fetch` satisfies it; easy to fake). */
export type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

/** How a REST client authenticates: bearer token, HTTP basic, or a raw header. */
export type RestAuth =
	| { type: "bearer"; token: string }
	| { type: "basic"; username: string; password: string }
	| { type: "header"; name: string; value: string };

export interface RestClientOptions {
	/** Absolute base URL, e.g. `https://api.upstash.com/v2`. No trailing slash required. */
	baseUrl: string;
	/** How to authenticate every request. */
	auth: RestAuth;
	/** Extra default headers merged into every request (e.g. Resend's `User-Agent`). */
	headers?: Record<string, string>;
	/** Provider name, used to tag {@link InfraError} details. */
	provider: string;
	/** Injectable fetch (tests). Defaults to the global `fetch`. */
	fetch?: FetchLike;
	/**
	 * Called once when a request returns `401`. Return fresh auth to retry the request with it
	 * (e.g. after refreshing a CLI's cached OAuth token), or `undefined` to fail as usual. See
	 * {@link refreshOnUnauthorized}.
	 */
	onUnauthorized?: () => Promise<RestAuth | undefined>;
}

export interface RequestOptions {
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	/**
	 * Form body (`application/x-www-form-urlencoded`) instead of JSON. The caller passes an
	 * already-flattened map (e.g. Stripe's `enabled_events[0]` keys). Mutually exclusive with `body`.
	 */
	form?: Record<string, string>;
	headers?: Record<string, string>;
	/** Status codes to treat as `null` instead of throwing (e.g. `404` for existence probes). */
	allowStatuses?: number[];
}

export interface RestClient {
	get<T>(path: string, options?: RequestOptions): Promise<T>;
	post<T>(path: string, options?: RequestOptions): Promise<T>;
	patch<T>(path: string, options?: RequestOptions): Promise<T>;
	put<T>(path: string, options?: RequestOptions): Promise<T>;
	delete<T>(path: string, options?: RequestOptions): Promise<T>;
}

function authHeader(auth: RestAuth): { name: string; value: string } {
	switch (auth.type) {
		case "bearer":
			return { name: "Authorization", value: `Bearer ${auth.token}` };
		case "basic": {
			const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString(
				"base64",
			);
			return { name: "Authorization", value: `Basic ${encoded}` };
		}
		case "header":
			return { name: auth.name, value: auth.value };
	}
}

/**
 * A tiny, typed REST client — the thin wrapper every provider builds on. Owns base URL + auth
 * (bearer / basic / custom header) + JSON encoding + error normalization to {@link InfraError}.
 */
export function createRestClient(options: RestClientOptions): RestClient {
	const doFetch = options.fetch ?? globalThis.fetch;
	const base = options.baseUrl.replace(/\/$/, "");
	let currentAuth = options.auth;

	async function request<T>(
		method: string,
		path: string,
		reqOptions: RequestOptions = {},
		attempt = 0,
	): Promise<T> {
		const url = buildUrl(base, path, reqOptions.query);
		const auth = authHeader(currentAuth);
		const headers: Record<string, string> = {
			[auth.name]: auth.value,
			Accept: "application/json",
			...options.headers,
			...reqOptions.headers,
		};
		let bodyInit: string | undefined;
		if (reqOptions.form !== undefined) {
			headers["Content-Type"] = "application/x-www-form-urlencoded";
			bodyInit = new URLSearchParams(reqOptions.form).toString();
		} else if (reqOptions.body !== undefined) {
			headers["Content-Type"] = "application/json";
			bodyInit = JSON.stringify(reqOptions.body);
		}

		let response: Response;
		try {
			response = await doFetch(url, {
				method,
				headers,
				...(bodyInit !== undefined ? { body: bodyInit } : {}),
			});
		} catch (cause) {
			throw new InfraError(
				ErrorCode.RequestFailed,
				`${options.provider}: ${method} ${path} failed to connect: ${(cause as Error)?.message ?? String(cause)}`,
				{ cause, details: { provider: options.provider, method, path } },
			);
		}

		if (reqOptions.allowStatuses?.includes(response.status)) {
			return null as T;
		}

		// Self-heal a stale CLI-cache token: refresh once and retry with fresh auth.
		if (response.status === 401 && options.onUnauthorized && attempt === 0) {
			const refreshed = await options.onUnauthorized();
			if (refreshed) {
				currentAuth = refreshed;
				return request<T>(method, path, reqOptions, attempt + 1);
			}
		}

		const text = await response.text();
		const parsed = parseBody(text);
		if (!response.ok) {
			throw new InfraError(
				ErrorCode.RequestFailed,
				`${options.provider}: ${method} ${path} → ${response.status} ${response.statusText}: ${summarize(parsed, text)}`,
				{
					details: {
						provider: options.provider,
						method,
						path,
						status: response.status,
						body: parsed ?? text,
					},
				},
			);
		}
		return parsed as T;
	}

	return {
		get: (path, opts) => request("GET", path, opts),
		post: (path, opts) => request("POST", path, opts),
		patch: (path, opts) => request("PATCH", path, opts),
		put: (path, opts) => request("PUT", path, opts),
		delete: (path, opts) => request("DELETE", path, opts),
	};
}

/**
 * Build an {@link RestClientOptions.onUnauthorized} handler for a token sourced from a provider
 * CLI's cache (e.g. `neonctl`'s short-lived OAuth access token). On a `401` it runs the CLI's
 * refresh command via `exec` (which rewrites the cache), re-reads the token, and returns fresh
 * bearer auth so the request retries once.
 *
 * Gated to only fire when the **in-use token equals the cached token** — an explicit env-var key
 * (`reread() !== current`) or a missing `exec` returns `undefined`, so explicit credentials fail
 * fast instead of triggering a pointless refresh.
 */
export function refreshOnUnauthorized(opts: {
	/** The runtime exec capability (`ctx.exec`). */
	exec: Exec | undefined;
	/** Command that refreshes the CLI cache, e.g. `["neonctl", "me"]`. */
	refresh: string[];
	/** Re-read the (possibly refreshed) token from the CLI cache. */
	reread: () => string | undefined;
	/** The token currently in use. */
	current: string;
}): (() => Promise<RestAuth | undefined>) | undefined {
	const { exec, refresh, reread, current } = opts;
	if (!exec) return undefined;
	if (reread() !== current) return undefined; // explicit key — don't refresh
	return async () => {
		try {
			await exec(refresh);
		} catch {
			return undefined;
		}
		const fresh = reread();
		return fresh && fresh !== current
			? { type: "bearer", token: fresh }
			: undefined;
	};
}

function buildUrl(
	base: string,
	path: string,
	query: RequestOptions["query"],
): string {
	const url = new URL(path.startsWith("/") ? base + path : `${base}/${path}`);
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
	}
	return url.toString();
}

function parseBody(text: string): unknown {
	if (text.length === 0) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function summarize(parsed: unknown, raw: string): string {
	if (parsed && typeof parsed === "object") {
		const obj = parsed as Record<string, unknown>;
		const err = obj.error;
		if (err && typeof err === "object") {
			const message = (err as Record<string, unknown>).message;
			if (typeof message === "string") return message;
		}
		if (typeof obj.message === "string") return obj.message;
	}
	return raw.slice(0, 280) || "(empty body)";
}
