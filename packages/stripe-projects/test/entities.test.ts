import { afterEach, describe, expect, test } from "bun:test";
import {
	type Exec,
	type ExecResult,
	isInfraError,
	silentLogger,
} from "@infra-ts/core";
import {
	NeonPostgres,
	type StripeProjectsResource,
	StripeProjectsService,
	UpstashRedis,
} from "../src/lib/entities.js";

/**
 * Records `stripe projects …` invocations and answers `status --json` from a fixed resource list.
 * The CLI process is the test seam (same approach as the Vercel deployment tests) — no provider is
 * mocked, and no real Stripe CLI is required.
 */
function stubExec(resources: StripeProjectsResource[] = []): {
	exec: Exec;
	calls: string[][];
} {
	const calls: string[][] = [];
	const exec: Exec = async (command): Promise<ExecResult> => {
		calls.push(command);
		if (command.includes("status")) {
			return { stdout: JSON.stringify({ resources }), stderr: "", code: 0 };
		}
		return { stdout: "", stderr: "", code: 0 };
	};
	return { exec, calls };
}

function ctx(exec: Exec) {
	return {
		environment: "local",
		credentials: {},
		logger: silentLogger,
		state: null,
		exec,
	};
}

/** Was a `stripe projects <verb> …` command recorded? */
function called(calls: string[][], verb: string): string[] | undefined {
	return calls.find((c) => c[0] === "stripe" && c[2] === verb);
}

describe("StripeProjectsEntity (via NeonPostgres)", () => {
	const ENV_KEY = "DATABASE_URL";
	const prev = process.env[ENV_KEY];
	afterEach(() => {
		if (prev === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = prev;
	});

	test("requiredTools advertises the Stripe CLI + projects plugin", () => {
		const db = new NeonPostgres({ name: "db" });
		expect(db.requiredTools().map((t) => t.id)).toEqual([
			"stripe",
			"stripe-projects",
		]);
	});

	test("read resolves identity by name from `status --json`", async () => {
		const { exec } = stubExec([
			{ name: "other", provider: "neon", service: "postgres" },
			{ name: "db", provider: "neon", service: "postgres", tier: "launch" },
		]);
		const db = new NeonPostgres({ name: "db" });
		const remote = await db.read(ctx(exec));
		expect(remote).not.toBeNull();
		expect(remote?.name).toBe("db");
		expect(remote?.tier).toBe("launch");
	});

	test("read returns null when the resource is absent", async () => {
		const { exec } = stubExec([{ name: "other" }]);
		const db = new NeonPostgres({ name: "db" });
		expect(await db.read(ctx(exec))).toBeNull();
	});

	test("diff: create when absent, noop when present, update on tier drift", () => {
		const db = new NeonPostgres({ name: "db", tier: "launch" });
		expect(db.diff(null)[0]?.action).toBe("create");
		expect(db.diff({ name: "db", tier: "launch" })).toEqual([]);
		const drift = db.diff({ name: "db", tier: "free" });
		expect(drift[0]?.action).toBe("update");
		expect(drift[0]?.detail).toContain("free");
	});

	test("provision creates via `add`, then pulls env; persists no state", async () => {
		process.env[ENV_KEY] = "postgres://user:pw@host/db";
		const { exec, calls } = stubExec([]); // nothing exists yet
		const db = new NeonPostgres({ name: "db", tier: "launch" });
		const res = await db.provision(ctx(exec));

		expect(res.action).toBe("create");
		expect(res.id).toBe("db");
		expect(res.state).toEqual({}); // identity is the name — nothing persisted
		expect(res.env.databaseUrl).toBe("postgres://user:pw@host/db");

		const add = called(calls, "add");
		expect(add).toContain("neon/postgres");
		expect(add).toContain("--name");
		expect(add).toContain("db");
		expect(add).toContain("--tier");
		expect(add).toContain("launch");
		expect(add).toContain("--no-interactive");
		// env was synced from the Projects vault
		expect(calls.some((c) => c.includes("env") && c.includes("--pull"))).toBe(
			true,
		);
	});

	test("provision is a noop when the resource already exists at the desired tier", async () => {
		const { exec, calls } = stubExec([
			{ name: "db", provider: "neon", service: "postgres", tier: "launch" },
		]);
		const db = new NeonPostgres({ name: "db", tier: "launch" });
		const res = await db.provision(ctx(exec));
		expect(res.action).toBe("noop");
		expect(called(calls, "add")).toBeUndefined();
		expect(called(calls, "upgrade")).toBeUndefined();
	});

	test("provision upgrades on tier drift", async () => {
		const { exec, calls } = stubExec([{ name: "db", tier: "free" }]);
		const db = new NeonPostgres({ name: "db", tier: "launch" });
		const res = await db.provision(ctx(exec));
		expect(res.action).toBe("update");
		const upgrade = called(calls, "upgrade");
		expect(upgrade).toContain("db");
		expect(upgrade).toContain("launch");
	});

	test("pullEnv syncs and reads produced values by OS key", async () => {
		process.env[ENV_KEY] = "postgres://live";
		const { exec, calls } = stubExec([{ name: "db" }]);
		const db = new NeonPostgres({ name: "db" });
		const env = await db.pullEnv(ctx(exec));
		expect(env.databaseUrl).toBe("postgres://live");
		expect(calls.some((c) => c.includes("env") && c.includes("--pull"))).toBe(
			true,
		);
	});

	test("deprovision removes by name", async () => {
		const { exec, calls } = stubExec([{ name: "db" }]);
		const db = new NeonPostgres({ name: "db" });
		await db.deprovision(ctx(exec));
		const remove = called(calls, "remove");
		expect(remove).toContain("db");
		expect(remove).toContain("--auto-confirm");
	});

	test("throws a clear error without the exec capability", async () => {
		const db = new NeonPostgres({ name: "db" });
		const bare = {
			environment: "local",
			credentials: {},
			logger: silentLogger,
			state: null,
		};
		expect(db.read(bare)).rejects.toThrow(/exec capability/);
	});

	test("throws on malformed CLI JSON", async () => {
		const exec: Exec = async () => ({
			stdout: "not json",
			stderr: "",
			code: 0,
		});
		const db = new NeonPostgres({ name: "db" });
		try {
			await db.read(ctx(exec));
			throw new Error("expected read to throw");
		} catch (err) {
			expect(isInfraError(err)).toBe(true);
		}
	});
});

describe("env key mapping", () => {
	test("UpstashRedis reads both REST vars by their OS keys", async () => {
		const prevUrl = process.env.REDIS_REST_URL;
		const prevTok = process.env.REDIS_REST_TOKEN;
		process.env.REDIS_REST_URL = "https://redis";
		process.env.REDIS_REST_TOKEN = "tok";
		try {
			const { exec } = stubExec([{ name: "cache" }]);
			const cache = new UpstashRedis({ name: "cache" });
			const env = await cache.pullEnv(ctx(exec));
			expect(env).toEqual({
				redisRestUrl: "https://redis",
				redisRestToken: "tok",
			});
		} finally {
			if (prevUrl === undefined) delete process.env.REDIS_REST_URL;
			else process.env.REDIS_REST_URL = prevUrl;
			if (prevTok === undefined) delete process.env.REDIS_REST_TOKEN;
			else process.env.REDIS_REST_TOKEN = prevTok;
		}
	});

	test("envNames override changes the OS key that is read", async () => {
		const prev = process.env.PG_URL;
		process.env.PG_URL = "postgres://renamed";
		try {
			const { exec } = stubExec([{ name: "db" }]);
			const db = new NeonPostgres({
				name: "db",
				envNames: { databaseUrl: "PG_URL" },
			});
			const env = await db.pullEnv(ctx(exec));
			expect(env.databaseUrl).toBe("postgres://renamed");
		} finally {
			if (prev === undefined) delete process.env.PG_URL;
			else process.env.PG_URL = prev;
		}
	});
});

describe("StripeProjectsService (generic catalog entity)", () => {
	test("builds the provider/service ref and exposes declared env keys", async () => {
		const prevId = process.env.ALGOLIA_APP_ID;
		const prevKey = process.env.ALGOLIA_API_KEY;
		process.env.ALGOLIA_APP_ID = "app123";
		process.env.ALGOLIA_API_KEY = "key456";
		try {
			const { exec, calls } = stubExec([]);
			const search = new StripeProjectsService({
				name: "search",
				provider: "algolia",
				service: "application",
				exposes: ["algoliaAppId", "algoliaApiKey"],
			});
			const res = await search.provision(ctx(exec));
			expect(called(calls, "add")).toContain("algolia/application");
			expect(res.env).toEqual({
				algoliaAppId: "app123",
				algoliaApiKey: "key456",
			});
		} finally {
			if (prevId === undefined) delete process.env.ALGOLIA_APP_ID;
			else process.env.ALGOLIA_APP_ID = prevId;
			if (prevKey === undefined) delete process.env.ALGOLIA_API_KEY;
			else process.env.ALGOLIA_API_KEY = prevKey;
		}
	});

	test("exposes no env keys by default", () => {
		const svc = new StripeProjectsService({
			name: "x",
			provider: "sentry",
			service: "project",
		});
		expect(svc.envKeys).toEqual([]);
	});
});
