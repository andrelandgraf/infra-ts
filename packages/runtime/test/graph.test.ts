import { describe, expect, test } from "bun:test";
import {
	assertUniqueIds,
	collectEntities,
	type Ref,
	topoSort,
} from "@infra-ts/core";
import { FakeEntity } from "./helpers.js";

describe("graph", () => {
	test("collectEntities returns the listed entities", () => {
		const a = new FakeEntity({ name: "a" });
		const b = new FakeEntity({ name: "b" });
		const all = collectEntities([a, b])
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

describe("toEnv", () => {
	test("returns an OS-keyed ref bundle (default CONSTANT_CASE)", () => {
		const a = new FakeEntity({ name: "a" });
		expect(a.toEnv()).toEqual({
			VALUE: { __infraRef: true, entity: "a", kind: "env", field: "value" },
		});
	});

	test("applies envNames overrides", () => {
		const a = new FakeEntity({ name: "a", envNames: { value: "B_VALUE" } });
		expect(Object.keys(a.toEnv())).toEqual(["B_VALUE"]);
	});

	test("a ref from the bundle carries the dependency edge", () => {
		const a = new FakeEntity({ name: "a" });
		const ref = a.toEnv().VALUE;
		if (!ref) throw new Error("expected VALUE ref");
		const b = new FakeEntity({ name: "b", value: ref });
		const order = topoSort([b, a]).map((e) => e.name);
		expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
	});
});
