import { describe, expect, test } from "bun:test";
import { mergeEnv } from "../src/lib/env-merge.js";
import { idRef } from "../src/lib/ref.js";

describe("mergeEnv", () => {
	test("merges disjoint maps (literals + refs)", () => {
		const ref = idRef("db");
		expect(mergeEnv({ A: "1" }, { B: ref })).toEqual({ A: "1", B: ref });
	});

	test("throws on an overlapping key, naming it", () => {
		expect(() =>
			mergeEnv({ DATABASE_URL: "x" }, { DATABASE_URL: "y" }),
		).toThrow(/DATABASE_URL/);
	});

	test("empty merge is empty", () => {
		expect(mergeEnv()).toEqual({});
	});
});
