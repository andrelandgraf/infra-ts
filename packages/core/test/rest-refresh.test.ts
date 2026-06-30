import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../src/lib/entity.js";
import {
	createRestClient,
	type FetchLike,
	refreshOnUnauthorized,
} from "../src/lib/rest.js";

const ok: ExecResult = { stdout: "", stderr: "", code: 0 };

describe("refreshOnUnauthorized", () => {
	test("refreshes the cache via exec and returns fresh bearer auth", async () => {
		let cached = "old";
		const handler = refreshOnUnauthorized({
			exec: async () => {
				cached = "new";
				return ok;
			},
			refresh: ["neonctl", "me"],
			reread: () => cached,
			current: "old",
		});
		expect(handler).toBeDefined();
		expect(await handler?.()).toEqual({ type: "bearer", token: "new" });
	});

	test("no-op when the token is an explicit key (not the cached one)", () => {
		const handler = refreshOnUnauthorized({
			exec: async () => ok,
			refresh: ["neonctl", "me"],
			reread: () => "cache-token",
			current: "explicit-env-key",
		});
		expect(handler).toBeUndefined();
	});

	test("no-op without an exec capability", () => {
		expect(
			refreshOnUnauthorized({
				exec: undefined,
				refresh: ["neonctl", "me"],
				reread: () => "t",
				current: "t",
			}),
		).toBeUndefined();
	});

	test("returns undefined when refresh didn't change the token", async () => {
		const handler = refreshOnUnauthorized({
			exec: async () => ok,
			refresh: ["neonctl", "me"],
			reread: () => "same",
			current: "same",
		});
		expect(await handler?.()).toBeUndefined();
	});
});

describe("createRestClient 401 retry", () => {
	test("retries once with refreshed auth on 401", async () => {
		const seenAuth: (string | undefined)[] = [];
		const fakeFetch: FetchLike = async (_input, init) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			seenAuth.push(headers.Authorization);
			if (seenAuth.length === 1) {
				return new Response("unauthorized", { status: 401 });
			}
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		let refreshed = false;
		const client = createRestClient({
			provider: "test",
			baseUrl: "https://x.test",
			auth: { type: "bearer", token: "old" },
			fetch: fakeFetch,
			onUnauthorized: async () => {
				refreshed = true;
				return { type: "bearer", token: "new" };
			},
		});

		const res = await client.get<{ ok: boolean }>("/thing");
		expect(res).toEqual({ ok: true });
		expect(refreshed).toBe(true);
		expect(seenAuth).toEqual(["Bearer old", "Bearer new"]);
	});

	test("does not retry when onUnauthorized returns undefined", async () => {
		let calls = 0;
		const fakeFetch: FetchLike = async () => {
			calls++;
			return new Response("nope", { status: 401 });
		};
		const client = createRestClient({
			provider: "test",
			baseUrl: "https://x.test",
			auth: { type: "bearer", token: "old" },
			fetch: fakeFetch,
			onUnauthorized: async () => undefined,
		});
		await expect(client.get("/thing")).rejects.toThrow();
		expect(calls).toBe(1);
	});
});
