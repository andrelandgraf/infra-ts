import { describe, expect, test } from "bun:test";
import {
	assertUniqueIds,
	collectEntities,
	type Ref,
	topoSort,
} from "@infra-ts/core";
import { FakeEntity } from "./helpers.js";

describe("graph", () => {
	test("collectEntities pulls in transitive deps", () => {
		const a = new FakeEntity({ name: "a" });
		const b = new FakeEntity({ name: "b", deps: [a] });
		const all = collectEntities([b])
			.map((e) => e.name)
			.sort();
		expect(all).toEqual(["a", "b"]);
	});

	test("assertUniqueIds throws on duplicate names", () => {
		expect(() =>
			assertUniqueIds([
				new FakeEntity({ name: "x" }),
				new FakeEntity({ name: "x" }),
			]),
		).toThrow(/Duplicate entity id/);
	});

	test("topoSort orders dependents after dependencies", () => {
		const a = new FakeEntity({ name: "a" });
		const b = new FakeEntity({ name: "b", value: a.env.value });
		const order = topoSort([b, a]).map((e) => e.name);
		expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
	});

	test("topoSort throws on a cycle", () => {
		const refTo = (entity: string): Ref<string> => ({
			__infraRef: true,
			entity,
			kind: "env",
			field: "value",
		});
		const a = new FakeEntity({ name: "a", value: refTo("b") });
		const b = new FakeEntity({ name: "b", value: refTo("a") });
		expect(() => topoSort([a, b])).toThrow(/cycle/i);
	});
});
