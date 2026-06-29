import { describe, expect, test } from "bun:test";
import { InfraError } from "@infra-ts/core";
import { runHook } from "../src/lib/hooks-runner.js";

describe("runHook", () => {
	test("no-op when undefined", async () => {
		await runHook(undefined, {});
	});
	test("awaits a function hook", async () => {
		let seen = "";
		await runHook(
			(ctx: { environment: string }) => {
				seen = ctx.environment;
			},
			{ environment: "prod" },
		);
		expect(seen).toBe("prod");
	});
	test("runs shell commands with injected env + CI=1", async () => {
		let out = "";
		await runHook('echo "v=$HOOK_VAR ci=$CI"', undefined, {
			env: { HOOK_VAR: "x" },
			onOutput: (c) => {
				out += c;
			},
		});
		expect(out).toContain("v=x");
		expect(out).toContain("ci=1");
	});
	test("runs a list sequentially", async () => {
		const chunks: string[] = [];
		await runHook(["echo one", "echo two"], undefined, {
			onOutput: (c) => chunks.push(c),
		});
		expect(chunks.join("")).toContain("one");
		expect(chunks.join("")).toContain("two");
	});
	test("throws InfraError(HookFailed) on non-zero exit", async () => {
		await expect(runHook("exit 3", undefined)).rejects.toBeInstanceOf(
			InfraError,
		);
	});
});
