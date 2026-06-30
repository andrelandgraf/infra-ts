import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineInfra } from "@infra-ts/core";
import { apply, checkout, destroy, plan, status } from "../src/lib/engine.js";
import { readState } from "../src/lib/state-file.js";
import { FakeEntity, fakeRemote, resetFakeRemote, tempDir } from "./helpers.js";

afterEach(resetFakeRemote);

describe("engine: apply", () => {
	test("creates entities, writes state + .env, and is idempotent", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const infra = defineInfra({
				entities: [new FakeEntity({ name: "a", value: "hello" })],
			});
			const report = await apply(infra, { rootDir: dir, environment: "test" });
			expect(report.environment).toBe("test");
			expect(report.changes[0]?.action).toBe("create");
			// state file
			expect(readState(dir, "test").entities.a).toEqual({ id: "a" });
			// env file (.env.test) with constantCase key
			expect(readFileSync(join(dir, ".env.test"), "utf8")).toContain(
				"VALUE=hello",
			);
			// idempotent
			const second = await apply(infra, { rootDir: dir, environment: "test" });
			expect(second.changes[0]?.action).toBe("noop");
		} finally {
			cleanup();
		}
	});

	test("resolves cross-entity refs in dependency order", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const a = new FakeEntity({ name: "a", value: "from-a" });
			const b = new FakeEntity({
				name: "b",
				value: a.env.value, // ref → resolved to a's value
				envNames: { value: "B_VALUE" }, // avoid collision with a's VALUE
			});
			const infra = defineInfra({ entities: [b, a] }); // declared out of order on purpose
			await apply(infra, { rootDir: dir, environment: "test" });
			// b was provisioned with a's resolved value
			expect(fakeRemote.get("b")).toBe("from-a");
			const dotenv = readFileSync(join(dir, ".env.test"), "utf8");
			expect(dotenv).toContain("VALUE=from-a");
			expect(dotenv).toContain("B_VALUE=from-a");
		} finally {
			cleanup();
		}
	});

	test("runs apply hooks (beforeApply/afterApply)", async () => {
		const { dir, cleanup } = tempDir();
		const calls: string[] = [];
		try {
			const infra = defineInfra({
				entities: [
					new FakeEntity({
						name: "a",
						hooks: {
							beforeApply: () => {
								calls.push("before");
							},
							afterApply: ({ env }) => {
								calls.push(`after:${env.value}`);
							},
						},
					}),
				],
			});
			await apply(infra, { rootDir: dir, environment: "test" });
			expect(calls).toEqual(["before", "after:v-a"]);
		} finally {
			cleanup();
		}
	});
});

describe("engine: plan / status / checkout / destroy", () => {
	test("plan reports creates without mutating", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const infra = defineInfra({ entities: [new FakeEntity({ name: "a" })] });
			const report = await plan(infra, { rootDir: dir, environment: "test" });
			expect(report.changes.some((c) => c.action === "create")).toBe(true);
			expect(fakeRemote.has("a")).toBe(false); // no mutation
		} finally {
			cleanup();
		}
	});

	test("checkout pulls env after apply (no drift)", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const infra = defineInfra({
				entities: [new FakeEntity({ name: "a", value: "v" })],
			});
			await apply(infra, { rootDir: dir, environment: "test" });
			const report = await checkout(infra, {
				rootDir: dir,
				environment: "test",
			});
			expect(report.drift).toHaveLength(0);
			expect(report.env.a?.value).toBe("v");
		} finally {
			cleanup();
		}
	});

	test("checkout errors on drift unless --ignore-diff", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const infra = defineInfra({ entities: [new FakeEntity({ name: "a" })] });
			// never applied → remote missing → drift
			await expect(
				checkout(infra, { rootDir: dir, environment: "test" }),
			).rejects.toThrow();
			const forced = await checkout(infra, {
				rootDir: dir,
				environment: "test",
				ignoreDiff: true,
			});
			expect(forced.drift.length).toBeGreaterThan(0);
		} finally {
			cleanup();
		}
	});

	test("status reports existence + pending drift", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const infra = defineInfra({ entities: [new FakeEntity({ name: "a" })] });
			const before = await status(infra, { rootDir: dir, environment: "test" });
			expect(before.entities[0]?.exists).toBe(false);
			await apply(infra, { rootDir: dir, environment: "test" });
			const after = await status(infra, { rootDir: dir, environment: "test" });
			expect(after.entities[0]?.exists).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("destroy tears down and clears state (reverse order)", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const a = new FakeEntity({ name: "a" });
			const b = new FakeEntity({
				name: "b",
				value: a.env.value, // ref → edge a → b, so destroy is b then a
				envNames: { value: "B_VALUE" },
			});
			const infra = defineInfra({ entities: [a, b] });
			await apply(infra, { rootDir: dir, environment: "test" });
			expect(fakeRemote.size).toBe(2);
			const report = await destroy(infra, {
				rootDir: dir,
				environment: "test",
			});
			expect(report.changes.map((c) => c.identifier)).toEqual(["b", "a"]); // reverse
			expect(fakeRemote.size).toBe(0);
			expect(Object.keys(readState(dir, "test").entities)).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	test("environment selects the state + env file", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const infra = defineInfra({
				entities: [new FakeEntity({ name: "a", value: "p" })],
			});
			await apply(infra, { rootDir: dir, environment: "production" });
			expect(readState(dir, "production").entities.a).toBeDefined();
			expect(readFileSync(join(dir, ".env.production"), "utf8")).toContain(
				"VALUE=p",
			);
		} finally {
			cleanup();
		}
	});
});

describe("engine: checkout + destroy hooks", () => {
	test("checkout runs before/after hooks (after only on success)", async () => {
		const { dir, cleanup } = tempDir();
		const calls: string[] = [];
		try {
			const infra = defineInfra({
				entities: [
					new FakeEntity({
						name: "a",
						value: "v",
						hooks: {
							beforeCheckout: () => {
								calls.push("before");
							},
							afterCheckout: ({ env }) => {
								calls.push(`after:${env.value}`);
							},
						},
					}),
				],
			});
			await apply(infra, { rootDir: dir, environment: "test" });
			await checkout(infra, { rootDir: dir, environment: "test" });
			expect(calls).toEqual(["before", "after:v"]);
		} finally {
			cleanup();
		}
	});

	test("destroy runs before/after hooks", async () => {
		const { dir, cleanup } = tempDir();
		const calls: string[] = [];
		try {
			const infra = defineInfra({
				entities: [
					new FakeEntity({
						name: "a",
						hooks: {
							beforeDestroy: () => {
								calls.push("before");
							},
							afterDestroy: () => {
								calls.push("after");
							},
						},
					}),
				],
			});
			await apply(infra, { rootDir: dir, environment: "test" });
			await destroy(infra, { rootDir: dir, environment: "test" });
			expect(calls).toEqual(["before", "after"]);
		} finally {
			cleanup();
		}
	});
});
