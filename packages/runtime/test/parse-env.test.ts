import { describe, expect, test } from "bun:test";
import { defineInfra, InfraError, parseEnv } from "@infra-ts/core";
import { FakeEntity } from "./helpers.js";

describe("parseEnv", () => {
	const infra = defineInfra({
		entities: [
			new FakeEntity({ name: "a" }),
			new FakeEntity({ name: "b", envNames: { value: "B_VALUE" } }),
		],
	});

	test("returns typed env keyed by entity id, reading OS keys", () => {
		const env = parseEnv(infra, { VALUE: "x", B_VALUE: "y" });
		expect(env).toEqual({ a: { value: "x" }, b: { value: "y" } });
	});

	test("respects per-entity env renames (bijective round-trip)", () => {
		const env = parseEnv(infra, { VALUE: "x", B_VALUE: "renamed" });
		expect(env.b?.value).toBe("renamed");
	});

	test("throws listing every missing var", () => {
		try {
			parseEnv(infra, { VALUE: "x" });
			throw new Error("expected throw");
		} catch (error) {
			expect(error).toBeInstanceOf(InfraError);
			expect((error as InfraError).message).toContain("B_VALUE");
		}
	});
});
