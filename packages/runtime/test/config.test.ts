import { describe, expect, test } from "bun:test";
import { defineInfra } from "@infra-ts/core";
import { FakeEntity } from "./helpers.js";

describe("defineInfra", () => {
	test("collects + orders entities", () => {
		const a = new FakeEntity({ name: "a" });
		const b = new FakeEntity({
			name: "b",
			value: a.env.value,
			envNames: { value: "B_VALUE" },
		});
		const infra = defineInfra({ entities: [b, a] });
		expect(infra.entities.map((e) => e.name).sort()).toEqual(["a", "b"]);
		expect(infra.ordered.map((e) => e.name).indexOf("a")).toBeLessThan(
			infra.ordered.map((e) => e.name).indexOf("b"),
		);
		expect(infra.defaultEnvironment).toBe("local");
	});

	test("rejects an empty entities array", () => {
		expect(() => defineInfra({ entities: [] })).toThrow();
	});

	test("rejects duplicate ids", () => {
		expect(() =>
			defineInfra({
				entities: [
					new FakeEntity({ name: "x" }),
					new FakeEntity({ name: "x" }),
				],
			}),
		).toThrow(/Duplicate entity id/);
	});

	test("rejects OS env-key collisions across entities", () => {
		// two FakeEntity both map `value` → VALUE
		expect(() =>
			defineInfra({
				entities: [
					new FakeEntity({ name: "a" }),
					new FakeEntity({ name: "b" }),
				],
			}),
		).toThrow(/collision/i);
	});

	test("collision is fixed by an env rename", () => {
		const infra = defineInfra({
			entities: [
				new FakeEntity({ name: "a" }),
				new FakeEntity({ name: "b", envNames: { value: "B_VALUE" } }),
			],
		});
		expect(infra.entities).toHaveLength(2);
	});

	test("carries defaultEnvironment + renames", () => {
		const infra = defineInfra({
			entities: [new FakeEntity({ name: "a" })],
			defaultEnvironment: "production",
			renames: [{ old: "old-a", new: "a" }],
		});
		expect(infra.defaultEnvironment).toBe("production");
		expect(infra.renames).toEqual([{ old: "old-a", new: "a" }]);
	});
});
